/**
 * Platform-billing credential resolver.
 *
 * Resolution order:
 *   1. `PlatformSettings.secrets.sslcommerzSubscription` — set via the
 *      legacy admin Billing → Gateway page. Lets the operator rotate
 *      credentials without touching env / restarting the server.
 *   2. `SSLCOMMERZ_SUBSCRIPTION_STORE_ID` / `_SECRET` env vars — the
 *      original deployment surface. Kept for backwards compatibility +
 *      bootstrap.
 *   3. Tenant-customer SSLCommerz creds (`config.sslcommerz.*`) as a
 *      *dev-only* fallback so a fresh dev DB doesn't crash on first
 *      payment attempt. Logged loudly when this branch fires.
 *
 * Never throws — callers should treat a `null` return as "not configured"
 * and refuse the action with a 503.
 */

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";

export interface SubscriptionGatewayCreds {
  storeId: string;
  storePassword: string;
  isSandbox: boolean;
}

const PLATFORM_SETTINGS_ID = "platform";
const GATEWAY_KEY = "sslcommerzSubscription";

interface CachedCreds {
  value: SubscriptionGatewayCreds | null;
  fetchedAt: number;
}

/** 30 second cache so every payment attempt doesn't hit the DB. Mirrors
 *  the platform's other 30s caches (R2.6, R16.5). */
const CACHE_TTL_MS = 30_000;
let cache: CachedCreds | null = null;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function readFromDb(): Promise<SubscriptionGatewayCreds | null> {
  try {
    const row = await prisma.platformSettings.findUnique({
      where: { id: PLATFORM_SETTINGS_ID },
    });
    if (!row || !isObject(row.secrets)) return null;
    const secrets = row.secrets as Record<string, unknown>;
    const gw = secrets[GATEWAY_KEY];
    if (!isObject(gw)) return null;
    const storeId = typeof gw.storeId === "string" ? gw.storeId.trim() : "";
    const storePassword = typeof gw.storePassword === "string" ? gw.storePassword.trim() : "";
    if (!storeId || !storePassword) return null;
    return {
      storeId,
      storePassword,
      isSandbox: gw.isSandbox === true,
    };
  } catch (err) {
    logger.warn(
      {
        event: "platform_settings_read_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "platform_settings_read_failed",
    );
    return null;
  }
}

function readFromEnv(): SubscriptionGatewayCreds | null {
  const storeId = (process.env.SSLCOMMERZ_SUBSCRIPTION_STORE_ID ?? "").trim();
  const storePassword = (process.env.SSLCOMMERZ_SUBSCRIPTION_STORE_SECRET ?? "").trim();
  if (!storeId || !storePassword) return null;
  return {
    storeId,
    storePassword,
    isSandbox: config.sslcommerz.isSandbox,
  };
}

function readFromTenantCustomerCredsAsFallback(): SubscriptionGatewayCreds | null {
  const storeId = config.sslcommerz.storeId.trim();
  const storePassword = config.sslcommerz.storePassword.trim();
  if (!storeId || !storePassword) return null;
  return {
    storeId,
    storePassword,
    isSandbox: config.sslcommerz.isSandbox,
  };
}

/**
 * Resolve the effective platform-billing creds. Returns `null` when no
 * source is configured. Cached for 30s.
 */
export async function resolvePlatformBillingCreds(): Promise<SubscriptionGatewayCreds | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  const fromDb = await readFromDb();
  if (fromDb) {
    cache = { value: fromDb, fetchedAt: Date.now() };
    return fromDb;
  }
  const fromEnv = readFromEnv();
  if (fromEnv) {
    cache = { value: fromEnv, fetchedAt: Date.now() };
    return fromEnv;
  }
  const fromFallback = readFromTenantCustomerCredsAsFallback();
  if (fromFallback) {
    logger.warn(
      {
        event: "sslcommerz_subscription_fallback_creds",
        storeId: fromFallback.storeId.slice(0, 4) + "…",
      },
      "platform billing creds: falling back to tenant-customer SSLCommerz creds (dev only)",
    );
    cache = { value: fromFallback, fetchedAt: Date.now() };
    return fromFallback;
  }
  cache = { value: null, fetchedAt: Date.now() };
  return null;
}

/**
 * Persist platform-billing creds to the DB. Used by the admin UI on
 * "Save credentials". Idempotent — re-saving the same values is a no-op
 * write. Invalidates the in-process cache so the next read sees the new
 * values immediately.
 */
export async function savePlatformBillingCreds(
  creds: SubscriptionGatewayCreds,
  actor: string,
): Promise<void> {
  const trimmed = {
    storeId: creds.storeId.trim(),
    storePassword: creds.storePassword.trim(),
    isSandbox: creds.isSandbox === true,
  };
  if (!trimmed.storeId || !trimmed.storePassword) {
    throw new Error("storeId and storePassword are required");
  }

  // Read existing secrets so we don't clobber other gateway entries (future
  // AamarPay / bKash subscription keys live in the same JSON blob).
  const existing = await prisma.platformSettings.findUnique({
    where: { id: PLATFORM_SETTINGS_ID },
  });
  const prevSecrets =
    existing && isObject(existing.secrets) ? (existing.secrets as Record<string, unknown>) : {};
  const nextSecrets = { ...prevSecrets, [GATEWAY_KEY]: trimmed };

  await prisma.platformSettings.upsert({
    where: { id: PLATFORM_SETTINGS_ID },
    create: {
      id: PLATFORM_SETTINGS_ID,
      secrets: nextSecrets as object,
      updatedBy: actor,
    },
    update: {
      secrets: nextSecrets as object,
      updatedBy: actor,
    },
  });

  // Bust the cache so the next call sees the new values within 0ms instead of
  // waiting up to 30s.
  cache = { value: trimmed, fetchedAt: Date.now() };
  logger.info(
    {
      event: "platform_billing_creds_saved",
      gateway: GATEWAY_KEY,
      isSandbox: trimmed.isSandbox,
      storeId: trimmed.storeId.slice(0, 4) + "…",
      actor,
    },
    "platform_billing_creds_saved",
  );
}

/**
 * Read the current credentials with the `storePassword` redacted so the
 * admin UI can render the form without ever surfacing the raw secret.
 */
export async function getRedactedPlatformBillingCreds(): Promise<{
  storeId: string;
  hasStorePassword: boolean;
  isSandbox: boolean;
  source: "db" | "env" | "fallback" | "none";
}> {
  // Prefer DB so the admin UI shows what's actually persisted, not what the
  // env vars would resolve to.
  const fromDb = await readFromDb();
  if (fromDb) {
    return {
      storeId: fromDb.storeId,
      hasStorePassword: fromDb.storePassword.length > 0,
      isSandbox: fromDb.isSandbox,
      source: "db",
    };
  }
  const fromEnv = readFromEnv();
  if (fromEnv) {
    return {
      storeId: fromEnv.storeId,
      hasStorePassword: fromEnv.storePassword.length > 0,
      isSandbox: fromEnv.isSandbox,
      source: "env",
    };
  }
  const fromFallback = readFromTenantCustomerCredsAsFallback();
  if (fromFallback) {
    return {
      storeId: fromFallback.storeId,
      hasStorePassword: fromFallback.storePassword.length > 0,
      isSandbox: fromFallback.isSandbox,
      source: "fallback",
    };
  }
  return { storeId: "", hasStorePassword: false, isSandbox: true, source: "none" };
}
