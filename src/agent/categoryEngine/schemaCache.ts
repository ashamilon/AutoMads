/**
 * Per-tenant `CategorySchema` cache (Multi-Tenant Commerce OS, task 2.2).
 *
 * R2.6 mandates that schema updates propagate within 30 s. R6.4 mandates
 * that each tenant has an isolated cache key namespace so two tenants whose
 * slugs collide (e.g. `jersey` vs `jersey_v2`) cannot read each other's
 * schemas. Cache keys are therefore prefixed with the literal `tenant:` so
 * any code path that bypasses the helpers still produces a key namespaced
 * by tenant rather than a bare cuid.
 *
 * The cache is intentionally simple — one entry per tenant — but is capped
 * at `SCHEMA_CACHE_MAX_ENTRIES` to bound memory in environments with a long
 * tail of inactive tenants. When the cap is reached, the oldest entry by
 * insertion order is evicted (`Map` iteration is insertion order in JS, and
 * we re-insert on every `set` to keep the most-recently-written entry at
 * the back). This is good enough for a 30 s TTL — true LRU semantics aren't
 * worth the bookkeeping at this tier.
 *
 * The cache does NOT trigger Prisma reads on miss; resolution lives in
 * `index.ts` (task 2.3). Invalidation across processes is owned by
 * `invalidation.ts`'s LISTEN/NOTIFY listener.
 *
 * Maps to: R2.1, R2.6, R6.4.
 */

import type { CategorySchema } from "./types.js";

/** TTL aligned with the R2.6 propagation window. */
export const SCHEMA_CACHE_TTL_MS = 30_000;

/**
 * Hard cap on cached entries. The cache is FIFO-evicted when this is
 * exceeded — see the module docstring for the rationale.
 */
export const SCHEMA_CACHE_MAX_ENTRIES = 1000;

interface CacheEntry {
  schema: CategorySchema;
  /** Wall-clock millis when the entry was written. */
  fetchedAt: number;
}

/** Internal map keyed by `tenant:<tenantId>`. */
const cache = new Map<string, CacheEntry>();

/**
 * Build the namespaced cache key for a tenant id. Exported for tests and
 * for callers that want to assert key shape without poking at the Map.
 */
export function cacheKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * Read the cached schema for a tenant. Returns `null` on miss or expiry.
 * Expired entries are removed lazily on read — there is no background
 * sweeper, so a tenant that never reads after expiry simply lingers until
 * the FIFO cap kicks it out.
 */
export function get(tenantId: string): CategorySchema | null {
  if (!tenantId) return null;
  const k = cacheKey(tenantId);
  const entry = cache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > SCHEMA_CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }
  return entry.schema;
}

/**
 * Write the resolved schema for a tenant. Re-inserting an existing key
 * moves it to the back of insertion order so it isn't picked first by the
 * FIFO eviction.
 */
export function set(tenantId: string, schema: CategorySchema): void {
  if (!tenantId) return;
  const k = cacheKey(tenantId);
  if (cache.has(k)) cache.delete(k);
  cache.set(k, { schema, fetchedAt: Date.now() });

  if (cache.size > SCHEMA_CACHE_MAX_ENTRIES) {
    // Map iteration order is insertion order; the first key is the oldest.
    const oldest = cache.keys().next().value;
    if (typeof oldest === "string") cache.delete(oldest);
  }
}

/**
 * Evict a single tenant's entry. Idempotent — calling on a missing key is a
 * no-op. Used by the LISTEN handler in `invalidation.ts` and by callers
 * that mutate `CategorySchema` rows in-process.
 */
export function invalidate(tenantId: string): void {
  if (!tenantId) return;
  cache.delete(cacheKey(tenantId));
}

/**
 * Drop every entry. Used by emergency operator action (an empty
 * `pg_notify` payload) and by tests between cases.
 */
export function clear(): void {
  cache.clear();
}

/**
 * Reset the cache to an empty state. Aliased so tests can use the
 * conventional `__resetCacheForTests` name without depending on `clear()`'s
 * exact semantics.
 *
 * @internal
 */
export function __resetCacheForTests(): void {
  cache.clear();
}

/**
 * Current entry count. Exposed for assertions in tests.
 *
 * @internal
 */
export function __sizeForTests(): number {
  return cache.size;
}
