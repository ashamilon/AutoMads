import type { Request, Response } from "express";
import { validateTransaction } from "../integrations/sslcommerz/sslcommerzService.js";
import { confirmPaidAndDeliver, findOrderIdBySslTranId } from "../services/orderWorkflowService.js";
import { prisma } from "../db/prisma.js";
import { parseTenantSettings } from "../types/tenant-settings.js";
import { logger } from "../utils/logger.js";

/** SSLCommerz IPN — marks PAID only after validation API success */
export async function sslcommerzIpn(req: Request, res: Response): Promise<void> {
  try {
    const valId = String(req.body?.val_id ?? "");
    const tranId = String(req.body?.tran_id ?? "");
    if (!valId || !tranId) {
      res.status(400).send("INVALID");
      return;
    }

    const orderId = await findOrderIdBySslTranId(tranId);
    if (!orderId) {
      logger.warn({ tranId }, "IPN: unknown tran_id");
      res.status(404).send("UNKNOWN");
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { tenant: true },
    });
    if (!order) {
      res.status(404).send("UNKNOWN");
      return;
    }

    const settings = parseTenantSettings(order.tenant.settings);
    const validated = await validateTransaction({
      valId,
      storeId: settings.sslcommerz?.storeId,
      storePassword: settings.sslcommerz?.storePassword,
      isLive: settings.sslcommerz?.isLive,
    });

    if (validated.tranId !== tranId) {
      logger.error({ tranId, validated: validated.tranId }, "Tran id mismatch after validation");
      res.status(400).send("MISMATCH");
      return;
    }

    await confirmPaidAndDeliver(order.id, tranId);
    res.status(200).send("SUCCESS");
  } catch (e) {
    logger.error({ e }, "SSLCommerz IPN failed");
    res.status(500).send("FAIL");
  }
}

/**
 * SSLCommerz POSTs val_id + tran_id to the success URL when the customer completes
 * payment in the gateway. We validate the same way the IPN does so the order is
 * confirmed even if the IPN is delayed or blocked. Idempotent — `confirmPaidAndDeliver`
 * short-circuits if the order is already PAID.
 */
export async function sslcommerzReturn(req: Request, res: Response): Promise<void> {
  const status = String(req.query.status ?? req.body?.status ?? "");
  const valId = String(req.body?.val_id ?? req.query.val_id ?? "");
  const tranId = String(req.body?.tran_id ?? req.query.tran_id ?? "");

  let confirmed = false;
  if (status === "success" && valId && tranId) {
    try {
      const orderId = await findOrderIdBySslTranId(tranId);
      if (orderId) {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          include: { tenant: true },
        });
        if (order) {
          const settings = parseTenantSettings(order.tenant.settings);
          const validated = await validateTransaction({
            valId,
            storeId: settings.sslcommerz?.storeId,
            storePassword: settings.sslcommerz?.storePassword,
            isLive: settings.sslcommerz?.isLive,
          });
          if (validated.tranId === tranId) {
            await confirmPaidAndDeliver(order.id, tranId);
            confirmed = true;
          }
        }
      }
    } catch (e) {
      logger.warn({ e: String(e) }, "SSLCommerz return-side validation failed (IPN will retry)");
    }
  }

  const message =
    status === "success"
      ? confirmed
        ? "Payment confirmed. Returning to Messenger…"
        : "Payment received. Confirmation in a few seconds — you may close this window."
      : `Payment ${status || "ended"}. You may close this window and return to Messenger.`;

  res
    .status(200)
    .type("html")
    .send(`<html><body><p>${message}</p></body></html>`);
}
