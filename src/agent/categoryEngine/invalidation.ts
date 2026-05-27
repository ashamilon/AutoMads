/**
 * Postgres `LISTEN/NOTIFY`-driven invalidation for the Category_Engine
 * schema cache (Multi-Tenant Commerce OS, task 2.2).
 *
 * Operational pattern mirrors
 * `src/agent/identity/agentIdentityService.ts`:
 *
 *   - one dedicated `pg.Client` per process, lazily started on first use
 *   - suppressed entirely when `DATABASE_URL` is missing so tsx-runnable
 *     hermetic tests under `src/agent/__tests__/` never try to open a real
 *     connection
 *   - auto-reconnect with capped backoff (5 s -> 30 s cap)
 *   - empty `NOTIFY` payload means "evict everything" so an operator can
 *     punch the whole cache without naming a tenant
 *
 * The publisher helper `publishCategorySchemaInvalidation(tenantId)` always
 * punches the local cache first (so the same process sees the new schema
 * immediately, regardless of the LISTEN round-trip) and then emits
 * `pg_notify('category_schema_invalidate', tenantId)` so peer processes
 * evict their copies as well. This is what task 2.3 calls after writing a
 * `CategorySchema` row, and what the admin/onboarding services will call
 * when they mutate tenant customizations.
 *
 * Maps to: R2.1, R2.6, R6.4.
 */

import pg from "pg";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import * as schemaCache from "./schemaCache.js";

/** Postgres `LISTEN` / `NOTIFY` channel name. */
const INVALIDATE_CHANNEL = "category_schema_invalidate";

/** Initial reconnect backoff after the LISTEN connection drops. */
const LISTENER_RECONNECT_DELAY_MS = 5_000;

/** Cap on the reconnect backoff so we don't pile on if the DB is down. */
const LISTENER_RECONNECT_DELAY_MAX_MS = 30_000;

// ─── Module-level listener state ──────────────────────────────────────────

/**
 * The single live LISTEN client for this process, or `null` when the
 * connection is not currently up. Reconnects swap this in place after a
 * backoff window.
 */
let listenerClient: pg.Client | null = null;

/** Guard so we never try to start two connections concurrently. */
let listenerStarting = false;

/**
 * Set by `__stopListenerForTests` so a disabled listener never spontaneously
 * resurrects via the reconnect timer.
 */
let listenerDisabled = false;

function getDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url.trim().length === 0) return null;
  return url;
}

function serializeError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}

// ─── LISTEN connection lifecycle ──────────────────────────────────────────

/**
 * Ensure the LISTEN connection is running. No-op when:
 *
 *   - the connection is already open,
 *   - a previous call is still completing the handshake,
 *   - `DATABASE_URL` is unset (tests),
 *   - a previous `__stopListenerForTests()` disabled the listener.
 *
 * The connection is intentionally separate from Prisma's pool: pg's pool
 * eagerly returns clients to the pool, but `LISTEN` requires a sticky
 * connection so the server can deliver async notifications.
 */
export function ensureCategorySchemaListenerStarted(): void {
  if (listenerClient !== null || listenerStarting || listenerDisabled) return;
  const dbUrl = getDatabaseUrl();
  if (dbUrl === null) return;

  listenerStarting = true;
  // Fire and forget — the listener runs for the lifetime of the process.
  void startListener(dbUrl).catch((err) => {
    listenerStarting = false;
    logger.warn(
      { event: "category_schema_listener_start_failed", err: serializeError(err) },
      "category schema invalidation listener failed to start; cache will rely on TTL only",
    );
    scheduleReconnect(LISTENER_RECONNECT_DELAY_MS);
  });
}

async function startListener(dbUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: dbUrl });

  client.on("notification", (msg) => {
    if (msg.channel !== INVALIDATE_CHANNEL) return;
    const payload = (msg.payload ?? "").trim();
    if (payload.length === 0) {
      // Empty payload means "evict everything" — useful for emergency
      // operator action without targeting a specific tenant.
      schemaCache.clear();
      return;
    }
    schemaCache.invalidate(payload);
  });

  client.on("error", (err) => {
    logger.warn(
      { event: "category_schema_listener_error", err: serializeError(err) },
      "category schema invalidation listener errored",
    );
  });

  client.on("end", () => {
    if (listenerClient === client) listenerClient = null;
    scheduleReconnect(LISTENER_RECONNECT_DELAY_MS);
  });

  await client.connect();
  await client.query(`LISTEN ${pg.escapeIdentifier(INVALIDATE_CHANNEL)}`);
  listenerClient = client;
  listenerStarting = false;
  logger.info(
    { event: "category_schema_listener_started", channel: INVALIDATE_CHANNEL },
    "category schema invalidation listener started",
  );
}

function scheduleReconnect(delayMs: number): void {
  if (listenerDisabled) return;
  const wait = Math.min(delayMs, LISTENER_RECONNECT_DELAY_MAX_MS);
  setTimeout(() => {
    if (listenerClient !== null || listenerStarting) return;
    ensureCategorySchemaListenerStarted();
  }, wait).unref?.();
}

// ─── Test hooks ───────────────────────────────────────────────────────────

/**
 * Permanently disable the LISTEN connection for the rest of the process
 * lifetime. Idempotent. Used by tsx-runnable test suites that import the
 * module incidentally and need to keep the test hermetic.
 *
 * @internal
 */
export async function __stopListenerForTests(): Promise<void> {
  listenerDisabled = true;
  const client = listenerClient;
  listenerClient = null;
  if (client !== null) {
    try {
      await client.end();
    } catch {
      // Connection might already be closed; the disabled flag guarantees we
      // never try to reuse it.
    }
  }
}

/**
 * Re-enable the listener after `__stopListenerForTests`. Used by suites
 * that explicitly verify the start/reconnect path.
 *
 * @internal
 */
export function __resetListenerForTests(): void {
  listenerDisabled = false;
  listenerStarting = false;
  listenerClient = null;
}

// ─── Publisher ────────────────────────────────────────────────────────────

/**
 * Publish a category-schema invalidation across the cluster.
 *
 * Always punches the local in-process cache first so the calling process
 * sees the new schema on its next read regardless of whether the
 * `pg_notify` round-trip succeeds. When `DATABASE_URL` is unset the function
 * returns silently after the local cache punch — there is no notion of a
 * cluster in tests.
 */
export async function publishCategorySchemaInvalidation(
  tenantId: string,
): Promise<void> {
  schemaCache.invalidate(tenantId);
  if (getDatabaseUrl() === null) return;
  try {
    await prisma.$executeRawUnsafe(
      `SELECT pg_notify($1, $2)`,
      INVALIDATE_CHANNEL,
      tenantId,
    );
  } catch (err) {
    logger.warn(
      {
        event: "category_schema_invalidate_publish_failed",
        tenantId,
        err: serializeError(err),
      },
      "category schema invalidation publish failed",
    );
  }
}
