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
    cus_name: input.customerName,
    cus_email: input.customerEmail,
    cus_phone: input.customerPhone,
    cus_add1: input.customerAddress ?? "Dhaka",
    shipping_method: "Courier",
    product_name: "Order",
    product_profile: "general",
  });

  const res = await axios.post(initUrl(live), body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30_000,
  });
  const data = res.data as { status?: string; GatewayPageURL?: string; failedreason?: string };
  if (data.status !== "SUCCESS" || !data.GatewayPageURL) {
    logger.error({ data }, "SSLCommerz session init failed");
    throw new Error(data.failedreason ?? "SSLCommerz init failed");
  }
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
