import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { parseTenantSettings } from "../types/tenant-settings.js";
import { executeAndVerifyBkashPayment } from "../integrations/bkash/bkashCheckoutService.js";
import { confirmPaidAndDeliver } from "../services/orderWorkflowService.js";
import { logger } from "../utils/logger.js";

/**
 * bKash redirects the customer back to our callbackURL with `paymentID` and
 * `status` query params. We then call execute + payment/status to verify
 * before marking the order PAID.
 *
 * Note: bKash does NOT push an IPN by default — the redirect is the trigger.
 * We persist `paymentID` on the order's `sslcommerzSessionKey` column (reused
 * as the universal gateway-session-id store) so we can locate the order here.
 */
export async function bkashReturn(req: Request, res: Response): Promise<void> {
  const paymentId = String(req.query.paymentID ?? req.body?.paymentID ?? "").trim();
  const status = String(req.query.status ?? req.body?.status ?? "").toLowerCase();

  try {
    if (paymentId && status === "success") {
      const order = await prisma.order.findFirst({
        where: { sslcommerzSessionKey: paymentId },
      });
      if (order) {
        const tenant = await prisma.tenant.findUnique({ where: { id: order.tenantId } });
        const settings = parseTenantSettings(tenant?.settings);
        const bk = settings.bkashCheckout;
        if (bk?.appKey && bk?.appSecret && bk?.username && bk?.password) {
          const verified = await executeAndVerifyBkashPayment({
            paymentId,
            creds: {
              appKey: bk.appKey,
              appSecret: bk.appSecret,
              username: bk.username,
              password: bk.password,
              ...(bk.isLive != null ? { isLive: bk.isLive } : {}),
            },
          });
          if (verified.paid) {
            // The order was matched on bKash paymentID; the canonical "tran id"
            // we stored on the order is `sslcommerzTranId`. confirmPaidAndDeliver
            // checks sslcommerzTranId so we pass that.
            await confirmPaidAndDeliver(order.id, order.sslcommerzTranId ?? paymentId);
            logger.info(
              { orderId: order.id, paymentId, trxID: verified.trxID },
              "bKash payment confirmed",
            );
          } else {
            logger.warn(
              { orderId: order.id, paymentId, transactionStatus: verified.transactionStatus },
              "bKash return: verify says not completed",
            );
          }
        } else {
          logger.warn(
            { tenantId: order.tenantId, paymentId },
            "bKash return: tenant has no bkashCheckout creds",
          );
        }
      } else {
        logger.warn({ paymentId }, "bKash return: no order matched paymentID");
      }
    }
  } catch (e) {
    logger.error({ e: String(e), paymentId }, "bKash return handler failed");
  }

  const subject =
    status === "success" ? "Payment Successful" : status === "failure" ? "Payment Failed" : "Payment Cancelled";
  res.status(200).send(
    `<html><body style="font-family:sans-serif;padding:32px;text-align:center;">` +
      `<h2>${subject}</h2><p>You can close this window and return to Messenger.</p></body></html>`,
  );
}
