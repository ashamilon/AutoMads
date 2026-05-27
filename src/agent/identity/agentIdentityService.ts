/**
 * Agent_Identity service (Multi-Tenant Commerce OS, task 3.1).
 *
 * Builds a tenant's `AgentIdentity` for the Reasoning_Context. The identity is
 * the per-tenant {name, role, personality, tone, language, salesStyle,
 * greetingStyle} bundle injected into every AI_Reasoning_Cycle so the agent
 * speaks in the tenant's voice.
 *
 * Resolution chain (R5.2, R5.4):
 *   1. per-tenant `tenant.agentIdentity` JSON column (highest precedence)
 *   2. `categorySchema.agentIdentityDefaults` partial (per-category opinions)
 *   3. platform defaults (Karim / Moderator of this Page / warm Banglish)
 *
 * Resolution is per-key — a tenant may set only `name` and inherit the rest
 * from the category schema or platform defaults.
 *
 * Caching (R5.7, R6.4):
 *   - per-`tenantId` 30 s TTL
 *   - cache key is namespaced by `tenantId` so tenants never collide
 *   - eviction is driven by `pg_notify('agent_identity_invalidate', tenantId)`
 *     so any process that mutates `tenant.agentIdentity` can punch the cache
 *     across the cluster within a few hundred ms instead of waiting for the
 *     30 s clock to tick.
 *
 * The pg LISTEN connection is a separate dedicated `pg.Client` (not the Prisma
 * pool) and is started lazily on the first cache write. It auto-reconnects on
 * disconnect and is silent in test environments where `DATABASE_URL` is not
 * set so the tsx-runnable IIFE tests in `src/agent/__tests__/` stay hermetic.
 *
 * Pure function `resolve(tenantId, schema)` is the only thing tools need; the
 * cache + listener are operational concerns.
 *
 * Maps to: R5.1, R5.2, R5.4, R5.7, R6.4, R19.2, R21.2.
 */

import pg from "pg";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import {
  DEFAULT_PERSONA_NAME,
  DEFAULT_PERSONA_ROLE,
} from "../prompts.js";
import type { CategorySchema } from "../categoryEngine/types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Per-tenant agent voice. Every field is required at the runtime layer; the
 * resolver is responsible for filling each one from the tenant override,
 * category default, or platform default in that order.
 *
 * The platform default `language` is `bn-BD` (Bangla, Bangladesh) and the
 * default `tone` is `banglish_warm` — Banglish-only is the customer-facing
 * contract (R18.7), and `language` is also passed to the prompt builder so
 * a future multilingual adapter can route by locale (R21.2).
 */
export interface AgentIdentity {
  name: string;
  role: string;
  personality: string;
  tone: string;
  language: string;
  salesStyle: string;
  greetingStyle: string;
}

/**
 * Loose JSON shape of `tenant.agentIdentity`. We accept any subset of keys
 * with possibly-empty / non-string values and treat anything that isn't a
 * non-empty string as "not set" so a stray `""` in the column never silently
 * shadows the platform default.
 */
type TenantOverrides = Partial<Record<keyof AgentIdentity, unknown>>;

// ─── Defaults ──────────────────────────────────────────────────────────────

/**
 * Platform-wide defaults. `name` and `role` mirror the existing values in
 * `prompts.ts` so the legacy persona placeholders (`{{personaName}}`,
 * `{{personaRole}}`) keep their semantics for tenants that never customise
 * the bot (R5.2).
 */
export const PLATFORM_AGENT_IDENTITY_DEFAULTS: AgentIdentity = Object.freeze({
  name: DEFAULT_PERSONA_NAME,
  role: DEFAULT_PERSONA_ROLE,
  personality: "warm, concise, friendly",
  tone: "banglish_warm",
  language: "bn-BD",
  salesStyle: "consultative",
  greetingStyle: "casual",
});

const IDENTITY_KEYS: ReadonlyArray<keyof AgentIdentity> = [
  "name",
  "role",
  "personality",
  "tone",
  "language",
  "salesStyle",
  "greetingStyle",
];

// ─── Cache ─────────────────────────────────────────────────────────────────

/** Cache TTL in milliseconds. R5.7 mandates updates propagate within 30 s. */
const CACHE_TTL_MS = 30_000;

/** pg LISTEN channel used to broadcast invalidations across processes. */
const INVALIDATE_CHANNEL = "agent_identity_invalidate";

interface CacheEntry {
  identity: AgentIdentity;
  /** Wall-clock millis when the entry was written. */
  fetchedAt: number;
}

/**
 * Per-tenant cache. Keys are tenant ids prefixed for safety so a code path
 * that accidentally derefs the map without going through a helper still
 * produces a key namespaced by tenant rather than a bare cuid (R6.4).
 */
const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}

function readCache(tenantId: string, now: number): AgentIdentity | null {
  const entry = cache.get(cacheKey(tenantId));
  if (!entry) return null;
  if (now - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(cacheKey(tenantId));
    return null;
  }
  return entry.identity;
}

function writeCache(tenantId: string, identity: AgentIdentity, now: number): void {
  cache.set(cacheKey(tenantId), { identity, fetchedAt: now });
}

/**
 * Evict the cached identity for a tenant. Idempotent. Exposed so admin /
 * onboarding services can punch the cache directly when they mutate the
 * tenant row in the same process (avoids waiting for the LISTEN round-trip).
 */
export function invalidateAgentIdentityCache(tenantId: string): void {
  cache.delete(cacheKey(tenantId));
}

/**
 * Drop the entire cache. Used by tests between cases so cached entries from
 * one suite don't leak into another. Not exported to production callers.
 *
 * @internal
 */
export function __resetAgentIdentityCacheForTests(): void {
  cache.clear();
}

// ─── Resolution ────────────────────────────────────────────────────────────

/**
 * Treat empty / whitespace-only strings as "not set" so a blank value in the
 * JSON column doesn't shadow a meaningful default. Any non-string value is
 * also rejected — we never coerce numbers or booleans into identity strings.
 */
function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pure resolver — given the three layers, return a fully populated identity.
 * Exposed for tests and for callers that already have the tenant row in
 * memory and want to avoid the DB / cache round-trip.
 */
export function mergeAgentIdentity(
  tenantOverrides: TenantOverrides | null | undefined,
  categoryDefaults: Partial<AgentIdentity> | null | undefined,
): AgentIdentity {
  const result = { ...PLATFORM_AGENT_IDENTITY_DEFAULTS } as AgentIdentity;
  for (const key of IDENTITY_KEYS) {
    const fromTenant = pickString(tenantOverrides?.[key]);
    if (fromTenant !== null) {
      result[key] = fromTenant;
      continue;
    }
    const fromCategory = pickString(categoryDefaults?.[key]);
    if (fromCategory !== null) {
      result[key] = fromCategory;
      continue;
    }
    // result[key] already holds the platform default from the spread above.
  }
  return result;
}

function parseTenantAgentIdentity(json: unknown): TenantOverrides | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  return json as TenantOverrides;
}

/**
 * Resolve the AgentIdentity for `tenantId` against the supplied
 * `categorySchema`. Reads `tenant.agentIdentity` once per cache miss.
 *
 * The function never throws on a missing tenant — it falls back to the
 * category + platform defaults so the agent can still emit something sane
 * during boot races where the tenant row hasn't been refetched yet. Higher
 * layers (the Reasoning_Context builder) are responsible for validating that
 * `tenantId` exists at all (R6.1, R7.6).
 */
export async function resolve(
  tenantId: string,
  schema: CategorySchema,
): Promise<AgentIdentity> {
  if (!tenantId) {
    // Defensive: callers should never pass an empty tenantId, but if they do
    // we don't want to poison the cache with an empty key. Return the merge
    // of category + platform defaults directly.
    return mergeAgentIdentity(null, schema.agentIdentityDefaults ?? null);
  }

  const now = Date.now();
  const cached = readCache(tenantId, now);
  if (cached !== null) return cached;

  // First miss in this process triggers the LISTEN connection. Idempotent —
  // subsequent calls just return.
  ensureInvalidationListenerStarted();

  let tenantOverrides: TenantOverrides | null = null;
  try {
    const row = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { agentIdentity: true },
    });
    tenantOverrides = parseTenantAgentIdentity(row?.agentIdentity ?? null);
  } catch (err) {
    // If the DB read fails we still want to serve a reasonable identity
    // rather than blow up the whole turn. Log and fall through to defaults.
    logger.warn(
      { event: "agent_identity_read_failed", tenantId, err: serializeError(err) },
      "agent identity read failed; falling back to category + platform defaults",
    );
  }

  const identity = mergeAgentIdentity(
    tenantOverrides,
    schema.agentIdentityDefaults ?? null,
  );
  writeCache(tenantId, identity, now);
  return identity;
}

// ─── pg LISTEN/NOTIFY invalidation ─────────────────────────────────────────

/**
 * Module-level listener state. We keep at most one connection per process;
 * reconnects swap `listenerClient` in place after a backoff.
 */
let listenerClient: pg.Client | null = null;
let listenerStarting = false;
let listenerDisabled = false;

/**
 * Backoff for reconnect attempts after the LISTEN connection drops. Capped at
 * 30 s so we don't pile on if the DB is genuinely down.
 */
const LISTENER_RECONNECT_DELAY_MS = 5_000;
const LISTENER_RECONNECT_DELAY_MAX_MS = 30_000;

function getDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url.trim().length === 0) return null;
  return url;
}

/**
 * Start the LISTEN connection if it isn't running. No-op when already started,
 * when the DB URL is missing (tests), or when a previous fatal error disabled
 * the listener.
 *
 * The connection is intentionally separate from Prisma's pool because pg's
 * pool eagerly returns clients to the pool, but `LISTEN` requires a sticky
 * connection so the server can deliver async notifications.
 */
export function ensureInvalidationListenerStarted(): void {
  if (listenerClient !== null || listenerStarting || listenerDisabled) return;
  const dbUrl = getDatabaseUrl();
  if (dbUrl === null) return;
  listenerStarting = true;
  // Fire and forget — the listener runs for the lifetime of the process.
  void startInvalidationListener(dbUrl).catch((err) => {
    listenerStarting = false;
    logger.warn(
      { event: "agent_identity_listener_start_failed", err: serializeError(err) },
      "agent identity invalidation listener failed to start; cache will rely on TTL only",
    );
    scheduleListenerReconnect(LISTENER_RECONNECT_DELAY_MS);
  });
}

async function startInvalidationListener(dbUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: dbUrl });

  client.on("notification", (msg) => {
    if (msg.channel !== INVALIDATE_CHANNEL) return;
    const tenantId = (msg.payload ?? "").trim();
    if (tenantId.length === 0) {
      // Empty payload means "evict everything" — useful for emergency
      // operator action without targeting a specific tenant.
      cache.clear();
      return;
    }
    invalidateAgentIdentityCache(tenantId);
  });

  client.on("error", (err) => {
    logger.warn(
      { event: "agent_identity_listener_error", err: serializeError(err) },
      "agent identity invalidation listener errored",
    );
  });

  client.on("end", () => {
    if (listenerClient === client) listenerClient = null;
    scheduleListenerReconnect(LISTENER_RECONNECT_DELAY_MS);
  });

  await client.connect();
  await client.query(`LISTEN ${pg.escapeIdentifier(INVALIDATE_CHANNEL)}`);
  listenerClient = client;
  listenerStarting = false;
  logger.info(
    { event: "agent_identity_listener_started", channel: INVALIDATE_CHANNEL },
    "agent identity invalidation listener started",
  );
}

function scheduleListenerReconnect(delayMs: number): void {
  if (listenerDisabled) return;
  const wait = Math.min(delayMs, LISTENER_RECONNECT_DELAY_MAX_MS);
  setTimeout(() => {
    if (listenerClient !== null || listenerStarting) return;
    ensureInvalidationListenerStarted();
  }, wait).unref?.();
}

/**
 * Permanently disable the LISTEN connection (tests). Safe to call multiple
 * times.
 *
 * @internal
 */
export async function __stopAgentIdentityListenerForTests(): Promise<void> {
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
 * Publish an invalidation across the cluster. Returns silently when the DB
 * URL is missing (tests). Used by tenant settings / onboarding services
 * after they mutate `tenant.agentIdentity`.
 */
export async function publishAgentIdentityInvalidation(tenantId: string): Promise<void> {
  // Always punch the local cache so the same process sees the new value
  // immediately, regardless of whether the NOTIFY round-trip succeeds.
  invalidateAgentIdentityCache(tenantId);
  if (getDatabaseUrl() === null) return;
  try {
    await prisma.$executeRawUnsafe(
      `SELECT pg_notify($1, $2)`,
      INVALIDATE_CHANNEL,
      tenantId,
    );
  } catch (err) {
    logger.warn(
      { event: "agent_identity_invalidate_publish_failed", tenantId, err: serializeError(err) },
      "agent identity invalidation publish failed",
    );
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function serializeError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}
