import type { Request, Response } from "express";
import { handleWebhook } from "../services/billing/sslcommerzSubscriptionAdapter.js";
import { logger } from "../utils/logger.js";

/**
 * SSLCommerz subscription IPN endpoint.
 *
 * The route is mounted with `express.raw({ type: '*\/*' })` so we get the
 * untouched body bytes for signature verification. The adapter then parses
 * the form-urlencoded payload internally.
 *
 * Responds with whatever status + body the adapter dictates so SSLCommerz
 * sees the right idempotency / retry signal:
 *   - 400 invalid_signature  → SSL retries, we log signature failure
 *   - 200 unmatched          → tran_id not in our DB; ack to stop retries
 *   - 200 idempotent         → already-terminal transaction
 *   - 200 ok                 → success path
 *   - 200 failed             → failure recorded; no retry
 */
export async function sslcommerzSubscriptionWebhook(req: Request, res: Response): Promise<void> {
  try {
    // express.raw() lands the bytes on `req.body` as a Buffer. If something
    // else has parsed the body first (json/urlencoded middleware on a parent
    // router), fall back to `req.rawBody` which is set by the global
    // express.json verify hook in `app.ts`.
    const rawBody: Buffer | string =
      Buffer.isBuffer(req.body)
        ? req.body
        : req.rawBody ?? (typeof req.body === "string" ? req.body : "");

    const result = await handleWebhook(rawBody, req.headers);
    res.status(result.statusCode).type("text/plain").send(result.body);
  } catch (err) {
    logger.error(
      {
        event: "sslcommerz_subscription_webhook_handler_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "sslcommerz_subscription_webhook_handler_failed",
    );
    // Still return 200 so SSLCommerz doesn't retry-storm; the failure is logged.
    res.status(200).type("text/plain").send("error");
  }
}
