/**
 * AamarPay (https://aamarpay.com) integration. Single-step redirect gateway:
 *   1. POST /jsonpost.php with cart + customer details + creds → response carries
 *      a `payment_url` we redirect the customer to.
 *   2. After payment AamarPay POSTs an IPN to our webhook with `pay_status` and
 *      a `mer_txnid` (our supplied tran id). We then call `/api/v1/trxcheck/request.php`
 *      to verify before marking the order PAID.
 *
 * Sandbox: https://sandbox.aamarpay.com
 * Live:    https://secure.aamarpay.com
 *
 * Credentials per tenant: `store_id` + `signature_key`. No OAuth.
 */

import axios from "axios";
import { logger } from "../../utils/logger.js";

const SANDBOX_BASE = "https://sandbox.aamarpay.com";
const LIVE_BASE = "https://secure.aamarpay.com";

function baseUrl(isLive: boolean | undefined): string {
  return isLive ? LIVE_BASE : SANDBOX_BASE;
}

export type AamarPayInitInput = {
  /** Our merchant tran id (must be unique per attempt). */
  tranId: string;
  totalAmount: string; // already formatted to 2dp
  currency: string; // "BDT"
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
  /** AamarPay sends IPN here as form-encoded POST. */
  ipnUrl: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  /** Single-line description shown on the gateway page. */
  description: string;
  /** Tenant-supplied creds. */
  storeId: string;
  signatureKey: string;
  isLive?: boolean;
};

/**
 * Open a fresh AamarPay session and return the gateway URL. Throws on init
 * failure (caller should fall back to manual payment).
 */
export async function initiateAamarPaySession(
  input: AamarPayInitInput,
): Promise<{ gatewayUrl: string }> {
  const live = Boolean(input.isLive);
  const url = `${baseUrl(live)}/jsonpost.php`;

  const body = {
    store_id: input.storeId,
    signature_key: input.signatureKey,
    cus_name: input.customerName.slice(0, 50) || "Customer",
    cus_email: input.customerEmail.slice(0, 50) || "noreply@example.com",
    cus_phone: input.customerPhone.slice(0, 30) || "01700000000",
    cus_add1: input.customerAddress.slice(0, 100) || "N/A",
    cus_add2: "N/A",
    cus_city: "Dhaka",
    cus_state: "Dhaka",
    cus_postcode: "1200",
    cus_country: "Bangladesh",
    amount: input.totalAmount,
    tran_id: input.tranId,
    currency: input.currency,
    desc: input.description.slice(0, 250) || "Order payment",
    success_url: input.successUrl,
    fail_url: input.failUrl,
    cancel_url: input.cancelUrl,
    // IPN URL is sometimes treated as a separate parameter, sometimes
    // configured in the dashboard. Send it just in case.
    opt_a: input.ipnUrl,
    type: "json",
  };

  const res = await axios.post(url, body, { timeout: 20_000 });
  const data = res.data;
  // AamarPay returns either { result, payment_url } on success or
  // { result: "false", message } on failure.
  if (
    data?.result === "true" ||
    data?.result === true
  ) {
    const gatewayUrl =
      typeof data.payment_url === "string" && data.payment_url.startsWith("http")
        ? data.payment_url
        : null;
    if (!gatewayUrl) {
      logger.error({ data }, "AamarPay init: missing payment_url despite success");
      throw new Error("AamarPay init returned no payment_url");
    }
    logger.info({ live, tranId: input.tranId }, "AamarPay session created");
    return { gatewayUrl };
  }
  const errMsg = String(data?.message ?? data?.result ?? "init_failed");
  logger.error({ live, tranId: input.tranId, data }, "AamarPay init failed");
  throw new Error(`AamarPay init failed: ${errMsg}`);
}

/**
 * Server-to-server verify a transaction after IPN / success-return arrives.
 * AamarPay's transaction-check endpoint returns the canonical pay_status which
 * is the only value we trust before marking PAID.
 */
export async function verifyAamarPayTransaction(params: {
  tranId: string;
  storeId: string;
  signatureKey: string;
  isLive?: boolean;
}): Promise<{ paid: boolean; amount: string | null; payStatus: string }> {
  const live = Boolean(params.isLive);
  const url = `${baseUrl(live)}/api/v1/trxcheck/request.php`;

  const body = new URLSearchParams({
    request_id: params.tranId,
    store_id: params.storeId,
    signature_key: params.signatureKey,
    type: "json",
  });

  const res = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20_000,
  });
  const data = res.data;
  const payStatus = String(data?.pay_status ?? data?.status ?? "").trim();
  const amount = typeof data?.amount === "string" ? data.amount : data?.amount != null ? String(data.amount) : null;
  const paid = payStatus.toLowerCase() === "successful" || payStatus.toLowerCase() === "success";
  if (!paid) {
    logger.warn({ tranId: params.tranId, payStatus, data }, "AamarPay verify: not paid");
  }
  return { paid, amount, payStatus };
}
