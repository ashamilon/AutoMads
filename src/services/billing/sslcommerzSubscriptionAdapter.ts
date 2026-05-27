/**
 * SSLCommerz Subscription Adapter — billing plane only.
 *
 * This adapter is the platform's *self-billing* surface. It is NOT the same
 * as `src/integrations/sslcommerz/sslcommerzService.ts`, which handles
 * tenant-customer payments (orders). Both flows talk to SSLCommerz, but
 * they use different store credentials and write to different tables.
 *
 * Storage convention (R11.1, R14.2): every gateway reuses
 * `sslcommerzTranId` and `sslcommerzSessionKey` as the universal tran-id /
 * session-key columns on `Invoice` and `PaymentTransaction`. No
 * gateway-specific physical columns are added.
 *
 * Public surface:
 *   - `initiateSubscriptionPayment(invoiceId)` — creates an SSLCommerz session
 *     for a `pending` invoice, persists the tran/session ids, and returns
 *     the redirect URL the dashboard sends the tenant to.
 *   - `handleWebhook(rawBody, headers)` — validates signature, parses the
 *     form-urlencoded body, and idempotently advances the linked
 *     `PaymentTransaction` + `Invoice` + `Subscription` rows. Generates the
 *     subscription invoice PDF and dispatches a multi-channel notification
 *     on success.
 *
 * Idempotency: once a `PaymentTransaction` is in a terminal state
 * (`success` or `failed`), replays return `200 idempotent` and write
 * nothing — no extra `SubscriptionLog` rows, no extra `PaymentFailure`
 * rows, no duplicate notifications.
 */

import axios from "axios";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import { applyTransitionWithClient } from "../subscription/subscriptionService.js";
import { dispatch } from "../notifications/dispatcher.js";
import type { NotificationChannelId } from "../notifications/types.js";
import { generateSubscriptionInvoicePdf } from "./invoiceService.js";
import { resolvePlatformBillingCreds } from "./platformBillingCreds.js";

/** SSLCommerz init endpoints. Subscription billing follows the same gateway. */
const SANDBOX_INIT = "https://sandbox.sslcommerz.com/gwprocess/v4/api.php";
const LIVE_INIT = "https://securepay.sslcommerz.com/gwprocess/v4/api.php";

/** Notification channels fanned out on payment success (per task spec). */
const PAYMENT_SUCCESS_CHANNELS: NotificationChannelId[] = [
  "dashboard",
  "email",
  "telegram",
];

/**
 * Resolves subscription-store credentials with a three-layer fallback chain
 * (DB platform_settings → env vars → tenant-customer creds for dev).
 * The implementation lives in `platformBillingCreds.ts` so the admin UI can
 * read & write the same source of truth.
 */
async function resolveSubscriptionCreds(): Promise<{ storeId: string; storePassword: string; isSandbox: boolean }> {
  const resolved = await resolvePlatformBillingCreds();
  if (!resolved) {
    throw new Error(
      "SSLCommerz subscription credentials not configured. Open Admin → Billing → Gateway and save your store id + secret.",
    );
  }
  return resolved;
}

function initUrl(isSandbox: boolean): string {
  return isSandbox ? SANDBOX_INIT : LIVE_INIT;
}

/**
 * Generate a unique subscription tran-id. Format: `SUB-<invoiceId>-<rand>`.
 * Random suffix prevents collisions on retried invoices and is wide enough
 * (96 bits) to never collide in practice.
 */
function generateTranId(invoiceId: string): string {
  const suffix = crypto.randomBytes(12).toString("hex");
  return `SUB-${invoiceId}-${suffix}`;
}

export type InitiateSubscriptionPaymentResult = {
  redirectUrl: string;
  tranId: string;
  sessionKey: string;
};

/**
 * Initiate a subscription payment session for a `pending` Invoice.
 *
 * Validates the invoice state, generates a unique tran-id, calls
 * SSLCommerz's session-init endpoint with the platform's subscription
 * credentials, then persists the universal `sslcommerzTranId` /
 * `sslcommerzSessionKey` columns on both the new `PaymentTransaction` row
 * and the linked `Invoice` row.
 */
export async function initiateSubscriptionPayment(
  invoiceId: string,
): Promise<InitiateSubscriptionPaymentResult> {
  if (!invoiceId) {
    throw new Error("invoiceId is required");
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { tenant: true },
  });
  if (!invoice) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }
  if (invoice.status !== "pending") {
    throw new Error(`Invoice ${invoiceId} is not pending (status=${invoice.status})`);
  }
  if (!invoice.tenantId) {
    throw new Error(`Invoice ${invoiceId} has no tenantId`);
  }

  const creds = await resolveSubscriptionCreds();
  const tranId = generateTranId(invoiceId);
  const amountString = Number(invoice.amountBdt).toFixed(2);
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const ipnUrl = `${base}/api/v1/billing/sslcommerz/webhook`;
  const successUrl = `${base}/api/v1/billing/sslcommerz/return?status=success`;
  const failUrl = `${base}/api/v1/billing/sslcommerz/return?status=fail`;
  const cancelUrl = `${base}/api/v1/billing/sslcommerz/return?status=cancel`;

  const tenantName = (invoice.tenant?.name ?? "Subscriber").slice(0, 100);
  const tenantEmail = invoice.tenant?.email ?? `billing+${invoice.tenantId}@example.com`;

  const body = new URLSearchParams({
    store_id: creds.storeId,
    store_passwd: creds.storePassword,
    total_amount: amountString,
    currency: invoice.currency,
    tran_id: tranId,
    success_url: successUrl,
    fail_url: failUrl,
    cancel_url: cancelUrl,
    ipn_url: ipnUrl,
    product_category: "subscription",
    cus_name: tenantName,
    cus_email: tenantEmail,
    cus_phone: "01700000000",
    cus_add1: "Dhaka",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    shipping_method: "NO",
    product_name: "Commerce_OS Subscription",
    product_profile: "non-physical-goods",
    num_of_item: "1",
  });

  const res = await axios.post(initUrl(creds.isSandbox), body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30_000,
    validateStatus: () => true,
  });
  const data = res.data as {
    status?: string;
    GatewayPageURL?: string;
    sessionkey?: string;
    failedreason?: string;
  };
  if (data.status !== "SUCCESS" || !data.GatewayPageURL) {
    logger.error(
      {
        event: "sslcommerz_subscription_init_failed",
        httpStatus: res.status,
        sslStatus: data.status ?? "unknown",
        failedReason: data.failedreason ?? null,
        invoiceId,
        tranId,
      },
      "SSLCommerz subscription session init failed",
    );
    throw new Error(
      data.failedreason ?? `SSLCommerz init failed (status=${data.status ?? "unknown"})`,
    );
  }

  const sessionKey = String(data.sessionkey ?? "");
  const redirectUrl = String(data.GatewayPageURL);
  const rawPayload = data as unknown as Prisma.InputJsonValue;

  // Persist the pending PaymentTransaction and mirror the universal tran/session
  // columns onto the Invoice in a single transaction so both rows are consistent.
  await prisma.$transaction(async (tx) => {
    await tx.paymentTransaction.create({
      data: {
        invoiceId: invoice.id,
        tenantId: invoice.tenantId,
        gateway: "sslcommerz",
        amountBdt: invoice.amountBdt,
        status: "pending",
        sslcommerzTranId: tranId,
        sslcommerzSessionKey: sessionKey || null,
        rawPayload,
      },
    });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        sslcommerzTranId: tranId,
        sslcommerzSessionKey: sessionKey || null,
      },
    });
  });

  logger.info(
    {
      event: "sslcommerz_subscription_session_created",
      invoiceId,
      tranId,
      sessionKey: sessionKey || null,
    },
    "sslcommerz_subscription_session_created",
  );

  return { redirectUrl, tranId, sessionKey };
}

export type WebhookResult = { statusCode: number; body: string };

/** Lower-cased header lookup so we tolerate any framework's header shape. */
function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lc = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lc) {
      const v = headers[key];
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

/** Parse SSLCommerz form-urlencoded webhook body into a flat string map. */
function parseFormBody(rawBody: Buffer | string): Record<string, string> {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

/**
 * SSLCommerz IPN signature: MD5( sorted "k=v&" pairs of all body fields
 * EXCEPT verify_sign / verify_sign_sha2 / verify_key + "verify_secret=<storePass>" )
 * compared to `verify_sign`. If `verify_key` is present it lists the keys
 * that participate in the signature; otherwise we sort all keys.
 *
 * We re-implement here (rather than calling the existing
 * `verifyIpnSignature` helper) so the secret used is the *subscription*
 * store secret, not the tenant-customer one.
 */
function verifySubscriptionSignature(
  body: Record<string, string>,
  storePassword: string,
): boolean {
  const receivedSign = body["verify_sign"];
  if (!receivedSign || !storePassword) return false;

  const verifyKey = body["verify_key"];
  // Excluded fields per SSLCommerz docs: verify_sign, verify_sign_sha2, verify_key.
  const excluded = new Set(["verify_sign", "verify_sign_sha2", "verify_key"]);
  const keys = verifyKey
    ? verifyKey
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0 && !excluded.has(k))
    : Object.keys(body).filter((k) => !excluded.has(k));

  keys.sort();
  let concat = "";
  for (const k of keys) {
    concat += k + "=" + (body[k] ?? "") + "&";
  }
  concat += "verify_secret=" + storePassword;

  const expected = crypto.createHash("md5").update(concat).digest("hex");
  // timingSafeEqual requires equal-length buffers — receivedSign is hex(32).
  if (receivedSign.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(receivedSign), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * SSLCommerz "success" indicators on the IPN body. Anything else is a
 * failure (CANCELLED, FAILED, INVALID_TRANSACTION, etc).
 */
function isSuccessStatus(status: string | undefined): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s === "VALID" || s === "VALIDATED" || s === "SUCCESS";
}

/**
 * Best-effort post-success side effects. These run AFTER the DB transaction
 * has committed: PDF generation and notification dispatch. Any failure is
 * logged but never rethrown — the webhook MUST return 200 to SSLCommerz.
 */
async function runPostSuccessSideEffects(input: {
  tenantId: string;
  invoiceId: string;
  tranId: string;
}): Promise<void> {
  const { tenantId, invoiceId, tranId } = input;
  let pdfPath: string | null = null;
  try {
    pdfPath = await generateSubscriptionInvoicePdf(invoiceId);
  } catch (err) {
    logger.error(
      {
        event: "subscription_invoice_pdf_failed",
        err: err instanceof Error ? err.message : String(err),
        invoiceId,
        tranId,
      },
      "subscription_invoice_pdf_failed",
    );
  }

  try {
    await dispatch({
      tenantId,
      channels: PAYMENT_SUCCESS_CHANNELS,
      type: "payment.success",
      payload: { invoiceId, tranId, pdfPath },
    });
  } catch (err) {
    logger.error(
      {
        event: "payment_success_notification_failed",
        err: err instanceof Error ? err.message : String(err),
        invoiceId,
        tranId,
      },
      "payment_success_notification_failed",
    );
  }
}

/**
 * Process a single SSLCommerz subscription IPN delivery.
 *
 * Always returns a `{ statusCode, body }` pair so the controller can echo
 * it back to SSLCommerz — the gateway treats anything other than 200 as a
 * retry signal, so we *only* return 400 for invalid signatures (per R11.6).
 * Unmatched tran-ids return 200 to prevent retry storms (R11.5).
 */
export async function handleWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookResult> {
  // Side-step unused-param lint when callers route only the body in tests.
  void readHeader(headers, "content-type");

  const creds = await resolveSubscriptionCreds();
  const body = parseFormBody(rawBody);

  if (!verifySubscriptionSignature(body, creds.storePassword)) {
    logger.warn(
      {
        event: "payment_webhook_signature_invalid",
        tranId: body["tran_id"] ?? null,
      },
      "payment_webhook_signature_invalid",
    );
    return { statusCode: 400, body: "invalid_signature" };
  }

  const tranId = body["tran_id"];
  if (!tranId) {
    logger.warn(
      { event: "payment_webhook_unmatched", reason: "missing_tran_id" },
      "payment_webhook_unmatched",
    );
    return { statusCode: 200, body: "unmatched" };
  }

  const transaction = await prisma.paymentTransaction.findUnique({
    where: { sslcommerzTranId: tranId },
  });
  if (!transaction) {
    logger.warn(
      { event: "payment_webhook_unmatched", tranId },
      "payment_webhook_unmatched",
    );
    return { statusCode: 200, body: "unmatched" };
  }

  // Idempotency guard — replays of an already-terminal transaction MUST NOT
  // write extra SubscriptionLog or PaymentFailure rows.
  if (transaction.status === "success" || transaction.status === "failed") {
    logger.info(
      {
        event: "payment_webhook_idempotent_replay",
        tranId,
        status: transaction.status,
      },
      "payment_webhook_idempotent_replay",
    );
    return { statusCode: 200, body: "idempotent" };
  }

  const status = body["status"];
  const valId = body["val_id"] ?? null;
  const reason = body["error"] ?? body["failedreason"] ?? body["status"] ?? "unknown";
  const rawPayload = body as unknown as Prisma.InputJsonValue;

  if (isSuccessStatus(status)) {
    let postSuccessTenantId: string | null = null;
    let postSuccessInvoiceId: string | null = null;

    try {
      // Single transaction spans PaymentTransaction + Invoice + SubscriptionLog
      // writes (R10.7, R11.2). `applyTransitionWithClient` is the
      // tx-aware variant of `applyTransition` so we don't open a nested txn.
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.paymentTransaction.findUnique({
          where: { id: transaction.id },
        });
        if (!fresh) {
          throw new Error(`PaymentTransaction vanished: ${transaction.id}`);
        }
        if (fresh.status === "success" || fresh.status === "failed") {
          // Lost the race — another worker handled it. Bail out cleanly.
          return;
        }

        await tx.paymentTransaction.update({
          where: { id: fresh.id },
          data: {
            status: "success",
            rawPayload,
          },
        });

        await tx.invoice.update({
          where: { id: fresh.invoiceId },
          data: { status: "paid" },
        });

        await applyTransitionWithClient(tx, fresh.tenantId, "payment_success", "system", {
          invoiceId: fresh.invoiceId,
          tranId,
          valId,
        });

        postSuccessTenantId = fresh.tenantId;
        postSuccessInvoiceId = fresh.invoiceId;
      });

      // Side effects — PDF generation + notification dispatch — run AFTER the
      // transaction commits. Both are best-effort: failures are logged but
      // never poison the webhook response (per task spec).
      if (postSuccessTenantId && postSuccessInvoiceId) {
        await runPostSuccessSideEffects({
          tenantId: postSuccessTenantId,
          invoiceId: postSuccessInvoiceId,
          tranId,
        });
      }
    } catch (err) {
      logger.error(
        {
          event: "payment_webhook_success_persist_failed",
          err: err instanceof Error ? err.message : String(err),
          tranId,
        },
        "payment_webhook_success_persist_failed",
      );
      // Even on persist failure we return 200 so SSLCommerz doesn't retry-storm.
      // The transaction will stay 'pending' and can be reconciled manually.
    }

    return { statusCode: 200, body: "ok" };
  }

  // Failure path — mark transaction failed, write a PaymentFailure row.
  // Do NOT call applyTransition — the grace-period scheduler owns status
  // changes on failure (R11.3).
  try {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.paymentTransaction.findUnique({
        where: { id: transaction.id },
      });
      if (!fresh) {
        throw new Error(`PaymentTransaction vanished: ${transaction.id}`);
      }
      if (fresh.status === "success" || fresh.status === "failed") {
        return;
      }

      await tx.paymentTransaction.update({
        where: { id: fresh.id },
        data: {
          status: "failed",
          rawPayload,
        },
      });

      await tx.paymentFailure.create({
        data: {
          tenantId: fresh.tenantId,
          transactionId: fresh.id,
          reason: String(reason).slice(0, 500),
          rawPayload,
        },
      });
    });
  } catch (err) {
    logger.error(
      {
        event: "payment_webhook_failure_persist_failed",
        err: err instanceof Error ? err.message : String(err),
        tranId,
      },
      "payment_webhook_failure_persist_failed",
    );
  }

  return { statusCode: 200, body: "failed" };
}
