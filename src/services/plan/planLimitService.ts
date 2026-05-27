/**
 * Plan_Limit service (Multi-Tenant Commerce OS, task 6.2).
 *
 * Resolves the effective plan limits + boolean feature flags for a tenant
 * by walking the lookup chain `Subscription.planLimitOverrides[key]` →
 * `Plan.limits[key]` (or `Plan.featureFlags[key]` for booleans) → platform
 * default (R15.6, R16.1). Numeric `-1` is treated as "unlimited" by
 * `checkLimit` (R15.2 — Enterprise tier).
 *
 * Usage counters live on the `Subscription.usageCounters` JSON column in
 * the shape `{ messages, aiTokens, posts }`. Tools and controllers call:
 *
 *   - `checkLimit(tenantId, counterKey, delta?)` to gate a write before it
 *     happens (R15.3). Returns `{ ok:false, current, max }` when the
 *     prospective `current + delta` exceeds `max`. Tools/HTTP handlers
 *     translate that into the structured 402 envelope
 *     `{ error: 'plan_limit_exceeded', limitKey, current, max }`.
 *   - `incrementUsage(tenantId, counterKey, delta)` after the operation
 *     succeeds. Implemented as a single `UPDATE ... jsonb_set` so two
 *     concurrent writes can never lose a tick.
 *   - `resetUsageCounters(tenantId)` from `subscriptionService` whenever
 *     the billing period rolls over (R15.5).
 *
 * Caching (R5.7, R6.4 — Tenant Cache Key Isolation):
 *   - per-`tenantId` 30 s TTL on `resolve()` only; usage counters are
 *     always read fresh so we never serve a stale `current` from cache
 *     and let a tenant slip past the cap.
 *   - eviction is driven by `pg_notify('plan_limit_invalidate', tenantId)`
 *     so any process that mutates `Subscription.planLimitOverrides`,
 *     `Plan.limits`, or `Plan.featureFlags` can punch the cache across
 *     the cluster within a few hundred ms instead of waiting for the TTL
 *     to expire.
 *   - the listener mirrors `src/agent/identity/agentIdentityService.ts` —
 *     a dedicated `pg.Client` started lazily on the first cache write,
 *     auto-reconnect with capped backoff, suppressed entirely when
 *     `DATABASE_URL` is unset (tsx-runnable IIFE tests stay hermetic).
 *
 * Maps to: R15.3, R15.4, R15.5, R15.6, R16.1, R6.4.
 */

import pg from "pg";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Numeric Plan_Limits enforced by `checkLimit` and surfaced to the
 * Reasoning_Context. Unit semantics:
 *   - `maxMonthlyMessages`: messages handled per billing period
 *   - `maxAiTokensMonthly`: total AI tokens (in + out) per billing period
 *   - `maxProducts`: snapshot count of products owned by the tenant
 *   - `maxSocialAccounts`: snapshot count of connected pages/accounts
 *   - `maxPostingPerDay`: autonomous posts per rolling day
 *
 * `-1` means "unlimited" (R15.2, Enterprise plan).
 */
export interface PlanLimitNumeric {
  maxMonthlyMessages: number;
  maxAiTokensMonthly: number;
  maxProducts: number;
  maxSocialAccounts: number;
  maxPostingPerDay: number;
}

/**
 * Boolean Feature_Flags. Stored alongside numeric limits on
 * `Plan.featureFlags` and may be overridden per-tenant on
 * `Subscription.planLimitOverrides`. Naming mirrors the
 * `featureFlagService` lookup keys (R16.2).
 */
export interface PlanFeatureFlags {
  "feature.aiPosting": boolean;
  "feature.contentCalendar": boolean;
  "feature.automationRules": boolean;
  "feature.multiSocialAccounts": boolean;
  "feature.advancedAnalytics": boolean;
  "feature.customCategorySchema": boolean;
}

/**
 * Fully resolved limits (numeric + feature flags). This is the shape
 * exposed on `ReasoningContext.planLimits` and what `resolve()` returns.
 */
export type ResolvedPlanLimits = PlanLimitNumeric & PlanFeatureFlags;

/**
 * Counter keys that live on `Subscription.usageCounters` JSON. Only these
 * three are tracked through `incrementUsage`/`checkLimit`. Snapshot-style
 * limits like `maxProducts` are checked by callers querying the relevant
 * table directly and comparing against `resolve(tenantId).maxProducts`.
 */
export type UsageCounterKey = "messages" | "aiTokens" | "posts";

/** Strictly typed shape of the `usageCounters` JSON column. */
export type UsageCounters = Record<UsageCounterKey, number>;

/**
 * Mapping from a usage counter key to the corresponding numeric limit key
 * on `ResolvedPlanLimits`. Used by `checkLimit` so callers only have to
 * remember one set of identifiers.
 */
const COUNTER_TO_LIMIT_KEY: Record<UsageCounterKey, keyof PlanLimitNumeric> = {
  messages: "maxMonthlyMessages",
  aiTokens: "maxAiTokensMonthly",
  posts: "maxPostingPerDay",
};

const USAGE_COUNTER_KEYS: ReadonlyArray<UsageCounterKey> = [
  "messages",
  "aiTokens",
  "posts",
];

const NUMERIC_LIMIT_KEYS: ReadonlyArray<keyof PlanLimitNumeric> = [
  "maxMonthlyMessages",
  "maxAiTokensMonthly",
  "maxProducts",
  "maxSocialAccounts",
  "maxPostingPerDay",
];

const FEATURE_FLAG_KEYS: ReadonlyArray<keyof PlanFeatureFlags> = [
  "feature.aiPosting",
  "feature.contentCalendar",
  "feature.automationRules",
  "feature.multiSocialAccounts",
  "feature.advancedAnalytics",
  "feature.customCategorySchema",
];

/**
 * Platform defaults used as the last-resort fallback in the lookup chain.
 * Numeric defaults are `0` so a misconfigured plan never accidentally
 * grants quota; flag defaults are `false` so a misconfigured plan never
 * accidentally unlocks a feature.
 */
export const PLATFORM_DEFAULT_PLAN_LIMITS: ResolvedPlanLimits = Object.freeze({
  maxMonthlyMessages: 0,
  maxAiTokensMonthly: 0,
  maxProducts: 0,
  maxSocialAccounts: 0,
  maxPostingPerDay: 0,
  "feature.aiPosting": false,
  "feature.contentCalendar": false,
  "feature.automationRules": false,
  "feature.multiSocialAccounts": false,
  "feature.advancedAnalytics": false,
  "feature.customCategorySchema": false,
});

const ZERO_USAGE_COUNTERS: UsageCounters = Object.freeze({
  messages: 0,
  aiTokens: 0,
  posts: 0,
}) as UsageCounters;

// ─── Cache ─────────────────────────────────────────────────────────────────

/** R5.7 / R16.5 — propagation window. */
const CACHE_TTL_MS = 30_000;

/** pg LISTEN channel used to broadcast invalidations across processes. */
const INVALIDATE_CHANNEL = "plan_limit_invalidate";

interface CacheEntry {
  limits: ResolvedPlanLimits;
  /** Wall-clock millis when the entry was written. */
  fetchedAt: number;
}

/**
 * Per-tenant cache. Keys are namespaced by `tenant:` so a code path that
 * derefs the map without going through a helper still produces a key
 * scoped to the tenant rather than a bare cuid (R6.4).
 */
const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}

function readCache(tenantId: string, now: number): ResolvedPlanLimits | null {
  const entry = cache.get(cacheKey(tenantId));
  if (!entry) return null;
  if (now - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(cacheKey(tenantId));
    return null;
  }
  return entry.limits;
}

function writeCache(
  tenantId: string,
  limits: ResolvedPlanLimits,
  now: number,
): void {
  cache.set(cacheKey(tenantId), { limits, fetchedAt: now });
}

/**
 * Evict the cached limits for one tenant. Idempotent. Called by the LISTEN
 * handler and by callers that mutate the override JSON in-process.
 */
export function invalidatePlanLimitCache(tenantId: string): void {
  if (!tenantId) return;
  cache.delete(cacheKey(tenantId));
}

/**
 * Drop the entire cache. Used by emergency operator action (an empty
 * `pg_notify` payload) and by tests between cases.
 *
 * @internal
 */
export function __resetPlanLimitCacheForTests(): void {
  cache.clear();
}

// ─── Resolution ────────────────────────────────────────────────────────────

/**
 * Read a numeric value from a JSON map, returning `null` for non-finite,
 * non-numeric, or missing values so the caller can fall through to the
 * next layer. We accept both `number` and numeric strings (a defensive
 * choice for tenants whose overrides came in via JSON imports that
 * stringified everything).
 */
function pickNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Same lenient parsing for booleans — strings `"true"`/`"false"` allowed. */
function pickBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  return null;
}

function asJsonObject(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Pure resolver — given the three layers, build the merged plan limits.
 * Exposed for tests and for callers (e.g. `featureFlagService`) that
 * already have the rows in memory and want to avoid the DB round-trip.
 */
export function mergePlanLimits(
  overrides: Record<string, unknown> | null | undefined,
  planLimits: Record<string, unknown> | null | undefined,
  planFeatureFlags: Record<string, unknown> | null | undefined,
): ResolvedPlanLimits {
  const result = { ...PLATFORM_DEFAULT_PLAN_LIMITS } as ResolvedPlanLimits;

  for (const key of NUMERIC_LIMIT_KEYS) {
    const fromOverride = pickNumber(overrides?.[key]);
    if (fromOverride !== null) {
      result[key] = fromOverride;
      continue;
    }
    const fromPlan = pickNumber(planLimits?.[key]);
    if (fromPlan !== null) {
      result[key] = fromPlan;
      continue;
    }
    // result[key] already holds the platform default.
  }

  for (const key of FEATURE_FLAG_KEYS) {
    const fromOverride = pickBoolean(overrides?.[key]);
    if (fromOverride !== null) {
      result[key] = fromOverride;
      continue;
    }
    const fromPlan = pickBoolean(planFeatureFlags?.[key]);
    if (fromPlan !== null) {
      result[key] = fromPlan;
      continue;
    }
    // result[key] already holds the platform default.
  }

  return result;
}

/**
 * Resolve the effective `ResolvedPlanLimits` for `tenantId`.
 *
 * Reads `Subscription` (joined with its `Plan`) once per cache miss.
 * Falls back to platform defaults when the tenant has no subscription
 * row at all so the agent can still emit something sane during onboarding
 * races where the `startTrial` write hasn't landed yet — higher layers
 * (the Reasoning_Context builder) decide whether to abort the turn based
 * on `subscription.status`, not on whether limits resolved.
 */
export async function resolve(tenantId: string): Promise<ResolvedPlanLimits> {
  if (!tenantId) {
    // Defensive: callers should never pass an empty tenantId, but if they
    // do we don't want to poison the cache with an empty key.
    return { ...PLATFORM_DEFAULT_PLAN_LIMITS };
  }

  const now = Date.now();
  const cached = readCache(tenantId, now);
  if (cached !== null) return cached;

  // First miss in this process triggers the LISTEN connection. Idempotent —
  // subsequent calls just return.
  ensureInvalidationListenerStarted();

  let merged: ResolvedPlanLimits;
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { tenantId },
      select: {
        planLimitOverrides: true,
        plan: { select: { limits: true, featureFlags: true } },
      },
    });
    merged = mergePlanLimits(
      asJsonObject(subscription?.planLimitOverrides),
      asJsonObject(subscription?.plan?.limits),
      asJsonObject(subscription?.plan?.featureFlags),
    );
  } catch (err) {
    // If the DB read fails we still want to serve a reasonable default
    // rather than blow up the whole turn. Log and fall through to platform
    // defaults — the caller's `subscription.isOperational` check will
    // already short-circuit outbound work when the DB is genuinely down.
    logger.warn(
      { event: "plan_limit_read_failed", tenantId, err: serializeError(err) },
      "plan limit read failed; falling back to platform defaults",
    );
    merged = { ...PLATFORM_DEFAULT_PLAN_LIMITS };
  }

  writeCache(tenantId, merged, now);
  return merged;
}

// ─── checkLimit / incrementUsage / resetUsageCounters ──────────────────────

/**
 * Outcome of a `checkLimit` call. The shape mirrors the structured 402
 * response envelope exposed at the API edge: tools that get a `false`
 * result re-throw it as `{ error: 'plan_limit_exceeded', limitKey,
 * current, max }` (R15.3, R15.4).
 */
export type CheckLimitResult =
  | { ok: true }
  | {
      ok: false;
      /** The numeric Plan_Limit key (e.g. `maxMonthlyMessages`). */
      limitKey: keyof PlanLimitNumeric;
      /** Current usage counter (after applying `requestedDelta = 0`). */
      current: number;
      /** Effective cap from the lookup chain. `-1` is never returned — a
       *  cap of `-1` always yields `ok: true`. */
      max: number;
    };

/**
 * Check whether a tenant's prospective usage of `key` (current + delta)
 * would exceed the resolved plan limit. `requestedDelta` defaults to `1`
 * because the typical caller is "I'm about to send one message — am I
 * allowed?". Callers that want to ask "am I currently at the cap?" can
 * pass `0`.
 *
 * Reads the usage counter fresh from `Subscription.usageCounters` so we
 * never serve a stale value through the cache. Returns `{ ok: true }`
 * when:
 *   - the tenant has no subscription row (fresh signup, fail open
 *     because the trial bootstrap is racing); the caller's
 *     `subscription.isOperational` check is the authoritative gate
 *   - the resolved cap is `-1` (unlimited)
 *   - `current + delta <= max`
 *
 * Otherwise returns `{ ok: false, current, max }` and the caller is
 * responsible for surfacing the structured 402 envelope.
 */
export async function checkLimit(
  tenantId: string,
  key: UsageCounterKey,
  requestedDelta: number = 1,
): Promise<CheckLimitResult> {
  if (!tenantId) {
    // Defensive: never gate on an empty tenant — the tenant isolation
    // invariant will be checked elsewhere (R6.1, R6.3) and turning that
    // into a 402 here would mask the real bug.
    return { ok: true };
  }

  const limitKey = COUNTER_TO_LIMIT_KEY[key];
  const limits = await resolve(tenantId);
  const max = limits[limitKey];

  // Unlimited tier — never block.
  if (max === -1) return { ok: true };

  const subscription = await prisma.subscription.findUnique({
    where: { tenantId },
    select: { usageCounters: true },
  });

  // No subscription row yet — fail open. The `subscription.isOperational`
  // check on the Reasoning_Context will already deny outbound work for
  // tenants without a viable subscription.
  if (subscription === null) return { ok: true };

  const counters = parseUsageCounters(subscription.usageCounters);
  const current = counters[key];
  const delta = Number.isFinite(requestedDelta) ? requestedDelta : 0;
  const projected = current + delta;

  if (projected > max) {
    return { ok: false, limitKey, current, max };
  }
  return { ok: true };
}

/**
 * Atomically bump `Subscription.usageCounters[key]` by `delta`. Implemented
 * as a single `UPDATE ... jsonb_set(...)` so two concurrent writes
 * (Messenger webhook + scheduled post tick, say) can never lose a tick.
 *
 * `delta` may be negative (e.g. a refund-style adjustment) but the floor
 * is clamped at zero in the SQL so a misconfigured caller can't drive the
 * counter into negative territory and silently re-grant quota.
 */
export async function incrementUsage(
  tenantId: string,
  key: UsageCounterKey,
  delta: number,
): Promise<void> {
  if (!tenantId) return;
  if (!USAGE_COUNTER_KEYS.includes(key)) return;
  if (!Number.isFinite(delta) || delta === 0) return;

  // jsonb_set requires the path as a text[] of keys. We compute the new
  // value inline so the write is a single statement and atomic per row.
  // GREATEST(..., 0) clamps the floor — see the doc comment above.
  await prisma.$executeRaw`
    UPDATE "Subscription"
    SET "usageCounters" = jsonb_set(
          COALESCE("usageCounters", '{}'::jsonb),
          ARRAY[${key}]::text[],
          to_jsonb(
            GREATEST(
              COALESCE(("usageCounters" ->> ${key})::numeric, 0) + ${delta}::numeric,
              0::numeric
            )
          ),
          true
        ),
        "updatedAt" = NOW()
    WHERE "tenantId" = ${tenantId}
  `;
}

/**
 * Zero out `Subscription.usageCounters` to the canonical
 * `{ messages: 0, aiTokens: 0, posts: 0 }` shape. Called by
 * `subscriptionService` when it advances `currentPeriodStart` (R15.5).
 * Idempotent — calling on a missing tenant is a no-op.
 */
export async function resetUsageCounters(tenantId: string): Promise<void> {
  if (!tenantId) return;
  await prisma.subscription.updateMany({
    where: { tenantId },
    data: { usageCounters: { ...ZERO_USAGE_COUNTERS } },
  });
}

/**
 * Parse the `usageCounters` JSON column into a strict `UsageCounters`
 * shape, defaulting any missing or malformed key to `0`. Exposed so tools
 * that already have the row in memory can avoid an extra read.
 */
export function parseUsageCounters(value: unknown): UsageCounters {
  const result: UsageCounters = { ...ZERO_USAGE_COUNTERS };
  const obj = asJsonObject(value);
  if (obj === null) return result;
  for (const k of USAGE_COUNTER_KEYS) {
    const n = pickNumber(obj[k]);
    if (n !== null && n >= 0) result[k] = n;
  }
  return result;
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
 * listener. Mirrors `agentIdentityService.ts`.
 */
export function ensureInvalidationListenerStarted(): void {
  if (listenerClient !== null || listenerStarting || listenerDisabled) return;
  const dbUrl = getDatabaseUrl();
  if (dbUrl === null) return;
  listenerStarting = true;
  void startInvalidationListener(dbUrl).catch((err) => {
    listenerStarting = false;
    logger.warn(
      { event: "plan_limit_listener_start_failed", err: serializeError(err) },
      "plan limit invalidation listener failed to start; cache will rely on TTL only",
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
    invalidatePlanLimitCache(tenantId);
  });

  client.on("error", (err) => {
    logger.warn(
      { event: "plan_limit_listener_error", err: serializeError(err) },
      "plan limit invalidation listener errored",
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
    { event: "plan_limit_listener_started", channel: INVALIDATE_CHANNEL },
    "plan limit invalidation listener started",
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
export async function __stopPlanLimitListenerForTests(): Promise<void> {
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
 * Re-enable the listener after `__stopPlanLimitListenerForTests`. Used by
 * suites that explicitly verify the start/reconnect path.
 *
 * @internal
 */
export function __resetPlanLimitListenerForTests(): void {
  listenerDisabled = false;
  listenerStarting = false;
  listenerClient = null;
}

/**
 * Publish an invalidation across the cluster. Returns silently when the
 * DB URL is missing (tests). Used by admin / subscription services after
 * they mutate `Subscription.planLimitOverrides`, `Plan.limits`, or
 * `Plan.featureFlags`.
 */
export async function publishPlanLimitInvalidation(
  tenantId: string,
): Promise<void> {
  // Always punch the local cache first so the calling process sees the
  // new limits on the next read regardless of whether the round-trip
  // succeeds.
  invalidatePlanLimitCache(tenantId);
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
        event: "plan_limit_invalidate_publish_failed",
        tenantId,
        err: serializeError(err),
      },
      "plan limit invalidation publish failed",
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
