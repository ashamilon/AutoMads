/**
 * Steadfast (Packzy) courier integration.
 *
 * Auth: every request carries `Api-Key` + `Secret-Key` headers (no OAuth).
 *
 * Endpoints used:
 *   - POST /api/v1/create_order        — create a single consignment.
 *   - GET  /api/v1/status_by_cid/<id>  — poll delivery status by consignment id.
 *   - GET  /api/v1/get_balance         — used by the "Test connection" button.
 *
 * Status webhook (optional, must be registered with Steadfast support during
 * onboarding): they POST `{ consignment_id, tracking_code, status, … }` to
 * the URL you provide. We expose `/webhooks/steadfast/status` for that.
 *
 * Sandbox + live both use the same base URL; tenants have separate creds for
 * each. No `isLive` toggle on this integration — the credentials decide.
 */

import axios, { type AxiosInstance } from "axios";
import { logger } from "../../utils/logger.js";

const STEADFAST_BASE = "https://portal.packzy.com/api/v1";

export type SteadfastTenantConfig = {
  apiKey: string;
  secretKey: string;
};

function http(): AxiosInstance {
  return axios.create({
    baseURL: STEADFAST_BASE,
    timeout: 30_000,
    validateStatus: () => true,
  });
}

function authHeaders(cfg: SteadfastTenantConfig): Record<string, string> {
  return {
    "Api-Key": cfg.apiKey,
    "Secret-Key": cfg.secretKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// ─── Probe / test connection ────────────────────────────────────────────────

export type SteadfastProbeResult =
  | { ok: true; balance: number | null }
  | { ok: false; status: number; detail: string };

/**
 * Probe the Steadfast credentials by hitting `get_balance` — a cheap read-only
 * endpoint that returns the merchant's current balance. Used by the
 * "Test connection" button on the settings UI.
 */
export async function probeSteadfastConnection(cfg: SteadfastTenantConfig): Promise<SteadfastProbeResult> {
  const client = http();
  let res;
  try {
    res = await client.get("/get_balance", { headers: authHeaders(cfg) });
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status >= 200 && res.status < 300) {
    const data = res.data as { status?: number; current_balance?: number; message?: string };
    if (data?.status === 200) {
      return { ok: true, balance: typeof data.current_balance === "number" ? data.current_balance : null };
    }
    return { ok: false, status: res.status, detail: data?.message ?? "unexpected response" };
  }
  const detail =
    typeof res.data === "object" && res.data
      ? (res.data as { message?: string }).message ?? JSON.stringify(res.data).slice(0, 200)
      : String(res.data).slice(0, 200);
  return { ok: false, status: res.status, detail };
}

// ─── Create order ──────────────────────────────────────────────────────────

export type SteadfastCreateInput = {
  /** Our merchant order id — stored on `invoice` so Steadfast echoes it back. */
  merchantOrderId: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  /** Item description for the courier slip. */
  itemDescription: string;
  /** Cash on delivery amount (0 for prepaid). */
  cashAmount: number;
  /** Optional special instructions. */
  note?: string;
};

export type SteadfastCreateResult = {
  consignmentId: string;
  trackingCode: string;
  status: string;
};

/**
 * Book a single consignment with Steadfast. Throws when their API rejects the
 * payload or returns a non-success status.
 */
export async function createSteadfastOrder(
  cfg: SteadfastTenantConfig,
  input: SteadfastCreateInput,
): Promise<SteadfastCreateResult> {
  const client = http();
  const body = {
    invoice: input.merchantOrderId,
    recipient_name: input.recipientName.slice(0, 100) || "Customer",
    recipient_phone: input.recipientPhone.replace(/[^\d+]/g, "").slice(0, 15),
    recipient_address: input.recipientAddress.slice(0, 250),
    cod_amount: Math.max(0, Math.round(input.cashAmount)),
    note: (input.note ?? "").slice(0, 250),
  };
  const res = await client.post("/create_order", body, { headers: authHeaders(cfg) });
  if (res.status < 200 || res.status >= 300) {
    const detail =
      typeof res.data === "object" && res.data
        ? (res.data as { message?: string }).message ?? JSON.stringify(res.data).slice(0, 300)
        : String(res.data).slice(0, 300);
    logger.error(
      { status: res.status, detail, merchantOrderId: input.merchantOrderId },
      "Steadfast create_order failed",
    );
    throw new Error(`Steadfast create_order error: HTTP ${res.status} ${detail}`);
  }
  const data = res.data as {
    status?: number;
    message?: string;
    consignment?: {
      consignment_id?: number | string;
      tracking_code?: string;
      status?: string;
    };
  };
  if (data?.status !== 200 || !data?.consignment?.consignment_id) {
    logger.error({ data, merchantOrderId: input.merchantOrderId }, "Steadfast create_order: unexpected payload");
    throw new Error(`Steadfast create_order: ${data?.message ?? "no consignment id returned"}`);
  }
  return {
    consignmentId: String(data.consignment.consignment_id),
    trackingCode: data.consignment.tracking_code ?? "",
    status: data.consignment.status ?? "in_review",
  };
}

// ─── Status polling ────────────────────────────────────────────────────────

export type SteadfastStatus = {
  /** Steadfast's normalized status: in_review, pending, delivered_approval_pending, partial_delivered_approval_pending, cancelled_approval_pending, unknown_approval_pending, delivered, partial_delivered, cancelled, hold, in_transit, unknown */
  status: string;
  trackingCode: string | null;
};

export async function getSteadfastStatusByCid(
  cfg: SteadfastTenantConfig,
  consignmentId: string,
): Promise<SteadfastStatus> {
  const client = http();
  const res = await client.get(`/status_by_cid/${encodeURIComponent(consignmentId)}`, {
    headers: authHeaders(cfg),
  });
  if (res.status < 200 || res.status >= 300) {
    logger.warn({ status: res.status, consignmentId }, "Steadfast status_by_cid failed");
    return { status: "unknown", trackingCode: null };
  }
  const data = res.data as {
    status?: number;
    delivery_status?: string;
    tracking_code?: string;
  };
  return {
    status: data?.delivery_status ?? "unknown",
    trackingCode: typeof data?.tracking_code === "string" ? data.tracking_code : null,
  };
}

/**
 * Map a Steadfast delivery_status string to one of our `DeliveryStatus`
 * enum values. Steadfast has a long list of states; we collapse to:
 *   - DELIVERED for any "delivered" variant.
 *   - FAILED for cancelled / hold-until-cancellation.
 *   - IN_TRANSIT for in_transit / partial_delivered / pending.
 *   - BOOKED for in_review / unknown.
 */
export function mapSteadfastStatusToInternal(status: string): "DELIVERED" | "FAILED" | "IN_TRANSIT" | "BOOKED" {
  const s = status.toLowerCase();
  if (s.includes("delivered") && !s.includes("partial")) return "DELIVERED";
  if (s === "cancelled" || s.startsWith("cancelled_")) return "FAILED";
  if (s === "in_transit" || s === "pending" || s.startsWith("partial_") || s.startsWith("hold")) return "IN_TRANSIT";
  return "BOOKED";
}
