import axios, { type AxiosInstance } from "axios";
import { logger } from "../../utils/logger.js";

export type PathaoTenantConfig = {
  baseUrl?: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  storeId: number;
};

/** Which token endpoint worked — determines which order-creation path to use. */
type PathaoApiStyle = "aladdin" | "legacy";

type CachedToken = {
  token: string;
  expiresAt: number;
  apiStyle: PathaoApiStyle;
  baseUrl: string;
};

const tokenCache = new Map<string, CachedToken>();

function http(baseUrl: string): AxiosInstance {
  return axios.create({
    baseURL: baseUrl.replace(/\/$/, ""),
    timeout: 30_000,
    validateStatus: () => true,
  });
}

/** Pathao has two API generations reachable on the same host. We probe in order:
 *   1. /aladdin/api/v1/issue-token (password grant, new Aladdin API)
 *   2. /aladdin/api/v1/external/login (client-credentials grant, official WooCommerce plugin style)
 *   3. /api/v1/users/issue-token (password grant, legacy Merchant API)
 *  The first that returns an access_token wins and the style is cached. */
const TOKEN_ATTEMPTS: ReadonlyArray<{
  path: string;
  style: PathaoApiStyle;
  /** true = send client credentials only; false = send password-grant body */
  clientCredentialsOnly: boolean;
}> = [
  { path: "/aladdin/api/v1/issue-token", style: "aladdin", clientCredentialsOnly: false },
  { path: "/aladdin/api/v1/external/login", style: "aladdin", clientCredentialsOnly: true },
  { path: "/api/v1/users/issue-token", style: "legacy", clientCredentialsOnly: false },
];

function extractToken(data: unknown): { token?: string; expiresIn?: number } {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  const topToken = typeof d.access_token === "string" ? (d.access_token as string) : undefined;
  const topExpiry = typeof d.expires_in === "number" ? (d.expires_in as number) : undefined;
  if (topToken) return { token: topToken, expiresIn: topExpiry };
  const nested = d.data && typeof d.data === "object" ? (d.data as Record<string, unknown>) : undefined;
  if (nested) {
    const t = typeof nested.access_token === "string" ? (nested.access_token as string) : undefined;
    const e = typeof nested.expires_in === "number" ? (nested.expires_in as number) : undefined;
    if (t) return { token: t, expiresIn: e };
  }
  return {};
}

export type ProbeTokenResult =
  | {
      ok: true;
      apiStyle: PathaoApiStyle;
      attemptedPath: string;
      attemptedBase: string;
      token: string;
      expiresIn?: number;
    }
  | { ok: false; attempts: Array<{ path: string; status: number; detail?: string }> };

const PATHAO_LIVE_HERMES = "https://api-hermes.pathao.com";
const PATHAO_LIVE_COURIER = "https://courier-api.pathao.com";
const PATHAO_SANDBOX = "https://courier-api-sandbox.pathao.com";

function candidateBases(preferred?: string): string[] {
  const ordered = [preferred, PATHAO_LIVE_HERMES, PATHAO_LIVE_COURIER, PATHAO_SANDBOX]
    .map((x) => (x ?? "").trim().replace(/\/$/, ""))
    .filter(Boolean);
  return Array.from(new Set(ordered));
}

/** Try every known token endpoint and return the first that yields an access_token.
 *  Used by both the real order workflow and the "Test connection" endpoint. */
export async function probePathaoToken(cfg: PathaoTenantConfig): Promise<ProbeTokenResult> {
  const bases = candidateBases(cfg.baseUrl);
  const attempts: Array<{ path: string; status: number; detail?: string }> = [];

  for (const base of bases) {
    const client = http(base);
    for (const a of TOKEN_ATTEMPTS) {
      const body = a.clientCredentialsOnly
        ? { client_id: cfg.clientId, client_secret: cfg.clientSecret }
        : {
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            username: cfg.username,
            password: cfg.password,
            grant_type: "password",
          };

      let res;
      try {
        res = await client.post(a.path, body, {
          headers: { "Content-Type": "application/json", Accept: "application/json" },
        });
      } catch (err) {
        attempts.push({
          path: `${base}${a.path}`,
          status: 0,
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        const { token, expiresIn } = extractToken(res.data);
        if (token) {
          return {
            ok: true,
            apiStyle: a.style,
            attemptedPath: a.path,
            attemptedBase: base,
            token,
            expiresIn,
          };
        }
        attempts.push({
          path: `${base}${a.path}`,
          status: res.status,
          detail: "200 without access_token",
        });
        continue;
      }

      const detail =
        typeof res.data === "object" && res.data
          ? (res.data as { message?: string }).message ?? JSON.stringify(res.data).slice(0, 200)
          : String(res.data).slice(0, 200);
      attempts.push({ path: `${base}${a.path}`, status: res.status, detail });
    }
  }

  return { ok: false, attempts };
}

async function getToken(cfg: PathaoTenantConfig): Promise<CachedToken> {
  const bases = candidateBases(cfg.baseUrl);
  for (const base of bases) {
    const cacheKey = `${base}:${cfg.clientId}:${cfg.username}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  }

  const probe = await probePathaoToken(cfg);
  if (!probe.ok) {
    const summary = probe.attempts
      .slice(0, 6)
      .map((a) => `${a.path} -> ${a.status}${a.detail ? ` (${String(a.detail).slice(0, 120)})` : ""}`)
      .join("; ");
    logger.error(
      { requestedBase: cfg.baseUrl, attempts: probe.attempts },
      "Pathao authentication failed across all known token endpoints",
    );
    throw new Error(`Pathao authentication failed: ${summary}`);
  }

  const expiresInMs = (probe.expiresIn ?? 3600) * 1000;
  const cacheKey = `${probe.attemptedBase}:${cfg.clientId}:${cfg.username}`;
  const entry: CachedToken = {
    token: probe.token,
    expiresAt: Date.now() + expiresInMs,
    apiStyle: probe.apiStyle,
    baseUrl: probe.attemptedBase,
  };
  tokenCache.set(cacheKey, entry);
  return entry;
}

export type CreateDeliveryInput = {
  merchantOrderId: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  itemDescription: string;
  itemQuantity: number;
  amountToCollect?: number;
};

/** Create Pathao parcel — only call after payment is confirmed */
export async function createPathaoOrder(cfg: PathaoTenantConfig, input: CreateDeliveryInput): Promise<{
  consignmentId: string;
}> {
  const { token, apiStyle, baseUrl } = await getToken(cfg);
  const base = baseUrl.replace(/\/$/, "");
  const client = http(base);
  const orderPath =
    apiStyle === "aladdin" ? "/aladdin/api/v1/orders" : "/api/v1/merchant/orders";
  const res = await client.post(
    orderPath,
    {
      store_id: cfg.storeId,
      merchant_order_id: input.merchantOrderId,
      recipient_name: input.recipientName,
      recipient_phone: input.recipientPhone,
      recipient_address: input.recipientAddress,
      delivery_type: 48,
      item_type: 2,
      item_quantity: input.itemQuantity,
      item_weight: 0.5,
      item_description: input.itemDescription,
      amount_to_collect: input.amountToCollect ?? 0,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    },
  );

  if (res.status >= 400) {
    logger.error({ status: res.status, data: res.data, orderPath }, "Pathao create order failed");
    throw new Error(`Pathao order error: HTTP ${res.status}`);
  }
  const data = res.data as { data?: { consignment_id?: string; order_id?: number } };
  const consignmentId = String(data.data?.consignment_id ?? data.data?.order_id ?? "");
  if (!consignmentId) throw new Error("Pathao did not return consignment id");
  return { consignmentId };
}
