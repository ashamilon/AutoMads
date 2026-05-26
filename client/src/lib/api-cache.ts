/**
 * Tiny in-memory GET response cache for the portal.
 *
 * Keyed by the path. Default TTL 30s — long enough that re-visiting Orders
 * or Catalog within a normal click-around session shows the previous result
 * INSTANTLY while a background re-fetch runs.
 *
 * Pages opt in via `useApiCache`. They get back `{ data, isStale, refresh }`
 * — render whatever data is cached immediately, fire a soft re-fetch in the
 * background, and update when the new payload arrives. This is the
 * stale-while-revalidate pattern; no external dep needed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";

type CacheEntry<T> = { data: T; ts: number };

const cache = new Map<string, CacheEntry<unknown>>();

const DEFAULT_TTL_MS = 30_000;

export function readApiCache<T>(path: string): T | null {
  const hit = cache.get(path);
  if (!hit) return null;
  return hit.data as T;
}

export function writeApiCache<T>(path: string, data: T): void {
  cache.set(path, { data, ts: Date.now() });
}

/** Drop a cache entry — call after mutations that invalidate a list. */
export function invalidateApiCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) {
    if (k === prefix || k.startsWith(prefix)) cache.delete(k);
  }
}

export type UseApiCacheResult<T> = {
  data: T | null;
  isStale: boolean;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/**
 * Stale-while-revalidate fetch with an in-memory cache.
 *
 * - Returns cached data IMMEDIATELY if a recent entry exists (< ttlMs old).
 * - Always kicks off a background refresh so the UI eventually shows fresh data.
 * - On mutate / refresh / invalidate, the next `useApiCache` call refetches.
 *
 * Use for read-only list pages where seeing slightly-stale data for a few
 * hundred ms is fine. Don't use for things you must always pull fresh
 * (e.g. payment status).
 */
export function useApiCache<T>(
  path: string,
  opts?: { ttlMs?: number; enabled?: boolean },
): UseApiCacheResult<T> {
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const enabled = opts?.enabled ?? true;
  const [data, setData] = useState<T | null>(() => readApiCache<T>(path));
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(() => {
    if (!enabled) return false;
    return readApiCache<T>(path) === null;
  });
  const [isStale, setIsStale] = useState(false);
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    setError(null);
    const p = (async () => {
      try {
        const fresh = await apiFetch<T>(path);
        writeApiCache(path, fresh);
        setData(fresh);
        setIsStale(false);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setIsLoading(false);
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  }, [path]);

  useEffect(() => {
    if (!enabled) return;
    const hit = cache.get(path);
    const fresh = hit && Date.now() - hit.ts < ttl;
    if (fresh) {
      setData(hit.data as T);
      setIsLoading(false);
      setIsStale(false);
      return;
    }
    if (hit) {
      // Have stale cached data — show it immediately and revalidate.
      setData(hit.data as T);
      setIsStale(true);
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }
    void refresh();
  }, [path, ttl, enabled, refresh]);

  return { data, isStale, isLoading, error, refresh };
}
