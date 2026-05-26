/**
 * bKash Tokenized Checkout (merchant gateway).
 *
 * Flow:
 *   1. POST /token/grant with {app_key, app_secret, username, password headers}
 *      → { id_token } cached for ~1 hour.
 *   2. POST /tokenized/checkout/create with the id_token + payment payload
 *      → { paymentID, bkashURL } — redirect customer to bkashURL.
 *   3. After the customer pays, bKash redirects back to our success URL with
 *      `?paymentID=...&status=success`. We THEN call /tokenized/checkout/execute
 *      to actually finalise; followed by /tokenized/checkout/payment/status to
 *      verify before marking PAID.
 *
 * bKash does NOT push an IPN by default — verification is poll-based via the
 * status endpoint. Tokens cache per-tenant so we don't hammer the grant endpoint.
 *
 * Sandbox: https://tokenized.sandbox.bka.sh/v1.2.0-beta
 * Live:    https://tokenized.pay.bka.sh/v1.2.0-beta
 */

import axios from "axios";
import { logger } from "../../utils/logger.js";

const SANDBOX_BASE = "https://tokenized.sandbox.bka.sh/v1.2.0-beta";
const LIVE_BASE = "https://tokenized.pay.bka.sh/v1.2.0-beta";

function baseUrl(isLive: boolean | undefined): string {
  return isLive ? LIVE_BASE : SANDBOX_BASE;
}

// ─── Token cache (per credential set, in-memory) ─────────────────────────────

type CachedToken = { idToken: string; expiresAt: number };
const TOKEN_CACHE = new Map<string, CachedToken>();

function cacheKey(creds: BkashCreds): string {
  return `${creds.isLive ? "live" : "sbx"}:${creds.appKey}`;
}

export type BkashCreds = {
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
  isLive?: boolean;
};

async function grantToken(creds: BkashCreds): Promise<string> {
  const key = cacheKey(creds);
  const cached = TOKEN_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.idToken;

  const url = `${baseUrl(creds.isLive)}/tokenized/checkout/token/grant`;
  const res = await axios.post(
    url,
    { app_key: creds.appKey, app_secret: creds.appSecret },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        username: creds.username,
        password: creds.password,
      },
      timeout: 20_000,
    },
  );
  const idToken = res.data?.id_token;
  // Token TTL is reported in seconds. Cache slightly under it.
  const expiresInSec = Number(res.data?.expires_in) || 3300;
  if (typeof idToken !== "string" || !idToken) {
    logger.error({ data: res.data }, "bKash grant token failed");
    throw new Error(`bKash token grant failed: ${res.data?.statusMessage ?? "unknown"}`);
  }
  TOKEN_CACHE.set(key, { idToken, expiresAt: Date.now() + expiresInSec * 1000 });
  return idToken;
}

// ─── Create payment session ──────────────────────────────────────────────────

export type BkashCreatePaymentInput = {
  /** Our merchant tran id, unique per attempt. */
  tranId: string;
  amount: string; // formatted to 2dp
  currency: string; // "BDT"
  /** Where bKash redirects after success/fail/cancel. We pass paymentID via query. */
  callbackUrl: string;
  /** Free-form note shown on the gateway page (optional). */
  reference?: string;
  /** Customer phone for prefilling. */
  payerReference: string;
  creds: BkashCreds;
};

/**
 * Open a fresh bKash session and return both the redirect URL and the bKash-
 * issued paymentID. The paymentID must be persisted on the order so the IPN /
 * return handler can match.
 */
export async function createBkashPayment(input: BkashCreatePaymentInput): Promise<{
  paymentId: string;
  redirectUrl: string;
}> {
  const idToken = await grantToken(input.creds);
  const url = `${baseUrl(input.creds.isLive)}/tokenized/checkout/create`;
  const body = {
    mode: "0011", // Tokenized Checkout (URL-based) per bKash docs.
    payerReference: input.payerReference.slice(0, 11) || "01700000000",
    callbackURL: input.callbackUrl,
    amount: input.amount,
    currency: input.currency,
    intent: "sale",
    merchantInvoiceNumber: input.tranId,
  };
  const res = await axios.post(url, body, {
    headers: {
      Accept: "application/json",
      Authorization: idToken,
      "X-APP-Key": input.creds.appKey,
      "Content-Type": "application/json",
    },
    timeout: 20_000,
  });
  const data = res.data;
  if (data?.statusCode !== "0000" || typeof data?.paymentID !== "string" || typeof data?.bkashURL !== "string") {
    logger.error({ data, tranId: input.tranId }, "bKash create payment failed");
    throw new Error(`bKash create payment failed: ${data?.statusMessage ?? data?.statusCode ?? "unknown"}`);
  }
  logger.info(
    { paymentId: data.paymentID, tranId: input.tranId, live: !!input.creds.isLive },
    "bKash session created",
  );
  return { paymentId: data.paymentID, redirectUrl: data.bkashURL };
}

// ─── Execute + verify payment (called after the customer redirects back) ─────

export type BkashExecuteResult = {
  paid: boolean;
  paymentId: string;
  trxID: string | null;
  amount: string | null;
  /** "Completed" / "Cancelled" / etc. */
  transactionStatus: string;
};

/**
 * Finalise a bKash payment. Idempotent — if execute returns "Authorized" we
 * fall through to the status query. Marks `paid: true` only when bKash reports
 * a Completed status.
 */
export async function executeAndVerifyBkashPayment(args: {
  paymentId: string;
  creds: BkashCreds;
}): Promise<BkashExecuteResult> {
  const idToken = await grantToken(args.creds);
  const headers = {
    Accept: "application/json",
    Authorization: idToken,
    "X-APP-Key": args.creds.appKey,
    "Content-Type": "application/json",
  };

  // Step 1 — execute. May fail when the payment was never authorised.
  let executeData: Record<string, unknown> | null = null;
  try {
    const exRes = await axios.post(
      `${baseUrl(args.creds.isLive)}/tokenized/checkout/execute`,
      { paymentID: args.paymentId },
      { headers, timeout: 20_000 },
    );
    executeData = exRes.data ?? null;
  } catch (e) {
    logger.warn({ e: String(e), paymentId: args.paymentId }, "bKash execute call threw — continuing to status query");
  }

  // Step 2 — query payment status (the canonical truth).
  const statusRes = await axios.post(
    `${baseUrl(args.creds.isLive)}/tokenized/checkout/payment/status`,
    { paymentID: args.paymentId },
    { headers, timeout: 20_000 },
  );
  const statusData = statusRes.data ?? {};

  const transactionStatus = String(statusData?.transactionStatus ?? executeData?.transactionStatus ?? "").trim();
  const trxIdRaw = statusData?.trxID ?? executeData?.trxID;
  const amountRaw = statusData?.amount ?? executeData?.amount;
  const paid = transactionStatus.toLowerCase() === "completed";
  return {
    paid,
    paymentId: args.paymentId,
    trxID: typeof trxIdRaw === "string" ? trxIdRaw : trxIdRaw != null ? String(trxIdRaw) : null,
    amount: typeof amountRaw === "string" ? amountRaw : amountRaw != null ? String(amountRaw) : null,
    transactionStatus,
  };
}
