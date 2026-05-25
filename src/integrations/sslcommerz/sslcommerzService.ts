import axios from "axios";
import crypto from "node:crypto";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

const SANDBOX_INIT = "https://sandbox.sslcommerz.com/gwprocess/v4/api.php";
const LIVE_INIT = "https://securepay.sslcommerz.com/gwprocess/v4/api.php";
const SANDBOX_VAL = "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php";
const LIVE_VAL = "https://securepay.sslcommerz.com/validator/api/validationserverAPI.php";

/** Per-tenant override wins over the global env. */
function isLiveMode(override: boolean | undefined): boolean {
  if (typeof override === "boolean") return override;
  return !config.sslcommerz.isSandbox;
}

function initUrl(isLive: boolean): string {
  return isLive ? LIVE_INIT : SANDBOX_INIT;
}

function valUrl(isLive: boolean): string {
  return isLive ? LIVE_VAL : SANDBOX_VAL;
}

export type InitPaymentInput = {
  tranId: string;
  totalAmount: string;
  currency: string;
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
  ipnUrl: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress?: string;
  storeId?: string;
  storePassword?: string;
  /** Per-tenant override; if omitted falls back to SSLCOMMERZ_IS_SANDBOX env. */
  isLive?: boolean;
};

export async function initiatePaymentSession(input: InitPaymentInput): Promise<{ gatewayUrl: string }> {
  const storeId = input.storeId ?? config.sslcommerz.storeId;
  const storePassword = input.storePassword ?? config.sslcommerz.storePassword;
  if (!storeId || !storePassword) throw new Error("SSLCommerz store credentials not configured");
  const live = isLiveMode(input.isLive);

  // SSLCommerz live gateway often returns HTTP 500 on the GatewayPageURL when the request payload
  // contains values that pass init validation but break the gateway page renderer. Two known
  // offenders: an unroutable email domain (e.g. `.local`) and a phone that isn't a real BD mobile.
  // We sanitise here so every caller benefits.
  const safeEmail = sanitizeCustomerEmail(input.customerEmail, storeId);
  const safePhone = sanitizeCustomerPhone(input.customerPhone);
  const safeAddress = (input.customerAddress?.trim() || "Dhaka").slice(0, 200);
  const safeName = (input.customerName?.trim() || "Customer").slice(0, 100);

  const body = new URLSearchParams({
    store_id: storeId,
    store_passwd: storePassword,
    total_amount: input.totalAmount,
    currency: input.currency,
    tran_id: input.tranId,
    success_url: input.successUrl,
    fail_url: input.failUrl,
    cancel_url: input.cancelUrl,
    ipn_url: input.ipnUrl,
    product_category: "general",
    cus_name: safeName,
    cus_email: safeEmail,
    cus_phone: safePhone,
    cus_add1: safeAddress,
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    shipping_method: "NO",
    product_name: "Order",
    product_profile: "general",
    num_of_item: "1",
  });

  const res = await axios.post(initUrl(live), body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30_000,
    validateStatus: () => true,
  });
  const data = res.data as {
    status?: string;
    GatewayPageURL?: string;
    failedreason?: string;
    sessionkey?: string;
  };
  if (data.status !== "SUCCESS" || !data.GatewayPageURL) {
    logger.error(
      {
        httpStatus: res.status,
        sslStatus: data.status ?? "unknown",
        failedReason: data.failedreason ?? null,
        live,
        storeId: storeId.slice(0, 4) + "…",
        tranId: input.tranId,
        amount: input.totalAmount,
      },
      "SSLCommerz session init failed — check storeId/password match the live/sandbox mode",
    );
    throw new Error(data.failedreason ?? `SSLCommerz init failed (status=${data.status ?? "unknown"})`);
  }
  logger.info(
    { live, tranId: input.tranId, sessionKey: data.sessionkey ?? null },
    "SSLCommerz session created",
  );
  return { gatewayUrl: data.GatewayPageURL };
}

/** Validates IPN / success callback payload with SSLCommerz validation API — only trust after this passes */
export async function validateTransaction(params: {
  valId: string;
  storeId?: string;
  storePassword?: string;
  isLive?: boolean;
}): Promise<{ amount: string; tranId: string; status: string; cardType?: string }> {
  const storeId = params.storeId ?? config.sslcommerz.storeId;
  const storePassword = params.storePassword ?? config.sslcommerz.storePassword;
  if (!storeId || !storePassword) throw new Error("SSLCommerz store credentials not configured");
  const live = isLiveMode(params.isLive);

  const query = new URLSearchParams({
    val_id: params.valId,
    store_id: storeId,
    store_passwd: storePassword,
    format: "json",
  });

  const res = await axios.get(`${valUrl(live)}?${query.toString()}`, { timeout: 30_000 });
  const data = res.data as {
    status?: string;
    tran_id?: string;
    amount?: string;
    card_type?: string;
  };
  if (data.status !== "VALID" && data.status !== "VALIDATED") {
    throw new Error(`SSLCommerz validation failed: ${data.status}`);
  }
  return {
    amount: String(data.amount ?? ""),
    tranId: String(data.tran_id ?? ""),
    status: String(data.status),
    cardType: data.card_type,
  };
}

export function verifyIpnSignature(body: Record<string, string>, receivedSign?: string): boolean {
  if (!receivedSign) return false;
  const storePass = config.sslcommerz.storePassword;
  if (!storePass) return false;
  const keys = Object.keys(body).sort();
  let concat = "";
  for (const k of keys) {
    concat += k + "=" + body[k] + "&";
  }
  concat += "verify_secret=" + storePass;
  const expected = crypto.createHash("md5").update(concat).digest("hex");
  return expected === receivedSign;
}


/**
 * Coerce any caller-supplied email into something the SSLCommerz live gateway will accept.
 *
 * Live SSLCommerz validates email syntax AND domain on the gateway page (not init), and reserved
 * TLDs like `.local`, `.internal`, `.invalid`, `.test`, `.example` cause HTTP 500 when the page
 * tries to render the receipt. Real shops generally don't have customer emails for Messenger
 * orders, so we synthesise a safe placeholder using the merchant's store id as the local part.
 */
function sanitizeCustomerEmail(raw: string | undefined, storeId: string): string {
  const candidate = (raw ?? "").trim().toLowerCase();
  const reserved = /\.(local|internal|invalid|test|example|home|lan)$/i;
  const looksValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(candidate);
  if (looksValid && !reserved.test(candidate)) return candidate.slice(0, 120);
  // Fallback: a routable example.com address keyed to the store. SSL accepts these on live;
  // they won't bounce because we never receive mail at this address.
  const slug = storeId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 24) || "shop";
  return `customer+${slug}@example.com`;
}

/**
 * Reduce any phone string to a clean Bangladesh mobile in `01XXXXXXXXX` form when possible,
 * otherwise return a benign placeholder. Live SSL rejects `"000"` and other obviously fake values.
 */
function sanitizeCustomerPhone(raw: string | undefined): string {
  const cleaned = (raw ?? "").replace(/[\s\-+]/g, "");
  // Strip a leading 880 country code so we end up with the 11-digit mobile form SSL prefers.
  const m11 = /(?:^|^880|^\+880)(01\d{9})$/.exec(cleaned);
  if (m11) return m11[1]!;
  if (/^01\d{9}$/.test(cleaned)) return cleaned;
  // Fallback to a syntactically-valid placeholder so the gateway page renders. SSL doesn't OTP this.
  return "01700000000";
}
