/**
 * Feature_Flag service (Multi-Tenant Commerce OS, task 6.3).
 *
 * Resolves a single boolean Feature_Flag for a tenant by walking the
 * three-layer lookup chain (R16.1):
 *
 *   1. tenant override on `Subscription.planLimitOverrides[flagKey]`
 *   2. `Plan.featureFlags[flagKey]` (the tenant's currently active plan)
 *   3. platform default `false`
 *
 * The lookup is intentionally permissive — `feature.*` flags are rolled
 * out plan-by-plan, so an unknown / missing key everywhere in the chain
 * MUST resolve to `false` so a freshly added flag never accidentally
 * unlocks a feature on existing tenants (R16.3).
 *
 * Caching (R16.5, R6.4):
 *   - per-`(tenantId, flagKey)` 30 s TTL
 *   - cache map is keyed by `${tenantId}:${flagKey}` so two tenants can
 *     never collide on the same flag and the same tenant's flags are
 *     evicted as a group on invalidation (R6.4 — Tenant Cache Key
 *     Isolation)
 *   - eviction is broadcast via `pg_notify('feature_flag_invalidate',
 *     tenantId)` so every Commerce_OS process drops the tenant's flags
 *     within a few hundred ms instead of waiting up to 30 s for the
 *     local TTL to tick (R16.5)
 *
 * The pg LISTEN connection is a dedicated `pg.Client` (not the Prisma
 * pool) and is started lazily on the first cache miss. It auto-reconnects
 * on disconnect and is silent in test environments where `DATABASE_URL`
 * is not set, so the tsx-runnable IIFE tests stay hermetic.
 *
 * Feature gating MUST be data-driven only — there are zero
 * `if (tenantId === '...')` checks anywhere in this file or its callers
 * (R16.4). New flags are added by appending to the `FEATURE_FLAG_KEYS`
 * tuple and updating the seeded plan rows in `planService.ts`.
 *
 * Maps to: R16.1, R16.2, R16.3, R16.4, R16.5.
 */

import pg from "pg";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";

// ─── Predefined flag keys ──────────────────────────────────────────────────

/**
 * The six platform-defined Feature_Flag keys (R16.2). Exported as named
 * constants so callers can reference them without scattering string
 * literals through the codebase.
 *
 * The `as const` ensures each constant has a literal-string type so the
 * compiler can narrow `FeatureFlagKey` to one of these values at every
 * call site that uses the constant directly.
 */
export const FEATURE_AI_POSTING = "feature.aiPosting" as const;
export const FEATURE_CONTENT_CALENDAR = "feature.contentCalendar" as const;
export const FEATURE_AUTOMATION_RULES = "feature.automationRules" as const;
export const FEATURE_MULTI_SOCIAL_ACCOUNTS =
  "feature.multiSocialAccounts" as const;
export const FEATURE_ADVANCED_ANALYTICS = "feature.advancedAnalytics" as const;
export const FEATURE_CUSTOM_CATEGORY_SCHEMA =
  "feature.customCategorySchema" as const;

/**
 * Tuple of every known Feature_Flag key. The order is stable so the
 * dashboard plan-comparison table can render flags in a predictable
 * sequence without needing its own ordering source.
 */
export const FEATURE_FLAG_KEYS = [
  FEATURE_AI_POSTING,
  FEATURE_CONTENT_CALENDAR,
  FEATURE_AUTOMATION_RULES,
  FEATURE_MULTI_SOCIAL_ACCOUNTS,
  FEATURE_ADVANCED_ANALYTICS,
  FEATURE_CUSTOM_CATEGORY_SCHEMA,
] as const;

/**
 * Union of the predefined Feature_Flag keys. `featureFlag()` accepts any
 * `string` so a future flag can be looked up before this tuple is
 * updated, but consumers that import the constants directly get full
 * compiler narrowing.
 */
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

// ─── Cache ─────────────────────────────────────────────────────────────────

/** R16.5 — propagation window. */
const CACHE_TTL_MS = 30_000;

/** pg LISTEN channel used to broadcast invalidations across processes. */
const INVALIDATE_CHANNEL = "feature_flag_invalidate";

interface CacheEntry {
  value: boolean;
  /** Wall-clock millis when the entry was written. */
  fetchedAt: number;
}

/**
 * Per-(tenantId, flagKey) cache. The composite key keeps tenants on
 * disjoint slots (R6.4) and lets us evict every flag for one tenant at
 * once by scanning the prefix.
 */
const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, flagKey: string): string {
  return `${tenantId}:${flagKey}`;
}

function readCache(
  tenantId: string,
  flagKey: string,
  now: number,
): boolean | null {
  const entry = cache.get(cacheKey(tenantId, flagKey));
  if (!entry) return null;
  if (now - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(cacheKey(tenantId, flagKey));
    return null;
  }
  return entry.value;
}

function writeCache(
  tenantId: string,
  flagKey: string,
  value: boolean,
  now: number,
): void {
  cache.set(cacheKey(tenantId, flagKey), { value, fetchedAt: now });
}

/**
 * Evict every cached flag for one tenant. Idempotent — calling on a
 * tenant with no cached entries is a no-op. Used by both the LISTEN
 * handler and the in-process publisher so a same-process write sees the
 * new value on the next read regardless of whether the NOTIFY round-trip
 * succeeds.
 */
export function invalidateFeatureFlagCache(tenantId: string): void {
  if (!tenantId) return;
  const prefix = `${tenantId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Drop the entire cache. Used by emergency operator action (an empty
 * `pg_notify` payload) and by tests between cases.
 *
 * @internal
 */
export function __resetFeatureFlagCacheForTests(): void {
  cache.clear();
}

// ─── Resolution ────────────────────────────────────────────────────────────

/**
 * Lenient boolean parser — strings `"true"` / `"false"` are accepted so
 * an override that came in via a JSON import which stringified everything
 * still resolves correctly. Anything else (including `null`, numbers,
 * empty strings) returns `null` so the caller can fall through to the
 * next layer.
 */
function pickBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  return null;
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Pure resolver — given the two JSON layers and a flag key, walk the
 * lookup chain and return the resolved boolean. Exposed for tests and
 * for callers that already have the rows in memory.
 */
export function resolveFeatureFlag(
  overrides: Record<string, unknown> | null | undefined,
  planFeatureFlags: Record<string, unknown> | null | undefined,
  flagKey: string,
): boolean {
  const fromOverride = pickBoolean(overrides?.[flagKey]);
  if (fromOverride !== null) return fromOverride;
  const fromPlan = pickBoolean(planFeatureFlags?.[flagKey]);
  if (fromPlan !== null) return fromPlan;
  // Platform default: any unknown / missing flag is OFF (R16.3).
  return false;
}

/**
 * Resolve a single Feature_Flag for `tenantId`. Returns `false` when the
 * tenant has no subscription row at all so the calling code path can
 * fail closed during onboarding races where the `startTrial` write
 * hasn't landed yet — higher layers (the Reasoning_Context builder /
 * suspension service) decide whether to deny outbound work outright
 * based on `subscription.isOperational`, not on this resolver.
 *
 * Reads `Subscription` joined with its active `Plan` once per cache
 * miss. The cache is per-(tenantId, flagKey), so toggling one flag
 * doesn't force a refetch for the others.
 */
export async function featureFlag(
  tenantId: string,
  flagKey: string,
): Promise<boolean> {
  if (!tenantId || !flagKey) return false;

  const now = Date.now();
  const cached = readCache(tenantId, flagKey, now);
  if (cached !== null) return cached;

  // First miss in this process triggers the LISTEN connection. Idempotent
  // — subsequent calls just return.
  ensureInvalidationListenerStarted();

  let value = false;
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { tenantId },
      select: {
        planLimitOverrides: true,
        plan: { select: { featureFlags: true } },
      },
    });
    if (subscription !== null) {
      value = resolveFeatureFlag(
        asJsonObject(subscription.planLimitOverrides),
        asJsonObject(subscription.plan?.featureFlags),
        flagKey,
      );
    }
    // No subscription row -> fail closed (`value` already `false`).
  } catch (err) {
    // If the DB read fails we still want to fail closed rather than
    // accidentally unlocking a paid feature. Log and serve `false` —
    // the caller's `subscription.isOperational` check will already
    // short-circuit outbound work when the DB is genuinely down.
    logger.warn(
      {
        event: "feature_flag_read_failed",
        tenantId,
        flagKey,
        err: serializeError(err),
      },
      "feature flag read failed; defaulting to false",
    );
    value = false;
  }

  writeCache(tenantId, flagKey, value, now);
  return value;
}

// ─── pg LISTEN/NOTIFY invalidation ─────────────────────────────────────────

let listenerClient: pg.Client | null = null;
let listenerStarting = false;
let listenerDisabled = false;

const LISTENER_RECONNECT_DELAY_MS = 5_000;
const LISTENER_RECONNECT_DELAY_MAX_MS = 30_000;

function getDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url.trim().length === 0) return null;
  return url;
}

/**
 * Start the LISTEN connection if it isn't running. No-op when the DB URL
 * is missing (tests) or when a previous fatal error disabled the
 * listener. Mirrors the pattern in `planLimitService.ts` and
 * `agentIdentityService.ts` so all three caches share the same
 * operational shape.
 */
export function ensureInvalidationListenerStarted(): void {
  if (listenerClient !== null || listenerStarting || listenerDisabled) return;
  const dbUrl = getDatabaseUrl();
  if (dbUrl === null) return;
  listenerStarting = true;
  void startInvalidationListener(dbUrl).catch((err) => {
    listenerStarting = false;
    logger.warn(
      {
        event: "feature_flag_listener_start_failed",
        err: serializeError(err),
      },
      "feature flag invalidation listener failed to start; cache will rely on TTL only",
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
      // Empty payload -> evict everything (emergency operator action).
      cache.clear();
      return;
    }
    invalidateFeatureFlagCache(tenantId);
  });

  client.on("error", (err) => {
    logger.warn(
      { event: "feature_flag_listener_error", err: serializeError(err) },
      "feature flag invalidation listener errored",
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
    { event: "feature_flag_listener_started", channel: INVALIDATE_CHANNEL },
    "feature flag invalidation listener started",
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
 * Permanently disable the LISTEN connection (tests). Safe to call
 * multiple times.
 *
 * @internal
 */
export async function __stopFeatureFlagListenerForTests(): Promise<void> {
  listenerDisabled = true;
  const client = listenerClient;
  listenerClient = null;
  if (client !== null) {
    try {
      await client.end();
    } catch {
      // Connection might already be closed; the disabled flag guarantees
      // we never try to reuse it.
    }
  }
}

/**
 * Re-enable the listener after `__stopFeatureFlagListenerForTests`. Used
 * by suites that explicitly verify the start/reconnect path.
 *
 * @internal
 */
export function __resetFeatureFlagListenerForTests(): void {
  listenerDisabled = false;
  listenerStarting = false;
  listenerClient = null;
}

/**
 * Publish a feature-flag invalidation across the cluster. Returns
 * silently when the DB URL is missing (tests). Used by admin /
 * subscription services after they mutate
 * `Subscription.planLimitOverrides` or `Plan.featureFlags`.
 *
 * The local cache is punched first so the calling process sees the new
 * value on its very next read regardless of whether the NOTIFY
 * round-trip succeeds.
 */
export async function notifyFeatureFlagInvalidate(
  tenantId: string,
): Promise<void> {
  if (!tenantId) return;
  invalidateFeatureFlagCache(tenantId);
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
        event: "feature_flag_invalidate_publish_failed",
        tenantId,
        err: serializeError(err),
      },
      "feature flag invalidation publish failed",
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
