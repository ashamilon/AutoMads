import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { parseTenantSettings } from "../types/tenant-settings.js";
import { verifyAamarPayTransaction } from "../integrations/aamarpay/aamarpayService.js";
import { confirmPaidAndDeliver } from "../services/orderWorkflowService.js";
import { logger } from "../utils/logger.js";

/**
 * Map a verified AamarPay tran_id back to our Order. The order's
 * `sslcommerzTranId` column is reused as the universal gateway-tran-id store
 * — naming is historical, semantics are "the gateway's tran reference".
 */
async function findOrderByGatewayTran(tranId: string) {
  if (!tranId) return null;
  return prisma.order.findFirst({ where: { sslcommerzTranId: tranId } });
}

/**
 * AamarPay IPN — POSTed as form-encoded with `mer_txnid`, `pay_status`, etc.
 * We MUST verify via the trxcheck endpoint before trusting the status.
 */
export async function aamarpayIpn(req: Request, res: Response): Promise<void> {
  try {
    const tranId = String(req.body?.mer_txnid ?? req.body?.tran_id ?? "").trim();
    if (!tranId) {
      res.status(400).send("missing_tran_id");
      return;
    }
    const order = await findOrderByGatewayTran(tranId);
    if (!order) {
      // Order not found — could be a cross-tenant tran or a duplicate IPN.
      logger.warn({ tranId }, "AamarPay IPN: no order matched tran_id");
      res.status(200).send("ok");
      return;
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: order.tenantId } });
    if (!tenant) {
      res.status(200).send("ok");
      return;
    }
    const settings = parseTenantSettings(tenant.settings);
    const ap = settings.aamarpay;
    if (!ap?.storeId || !ap?.signatureKey) {
      logger.warn({ tenantId: order.tenantId, tranId }, "AamarPay IPN: tenant has no aamarpay creds");
      res.status(200).send("ok");
      return;
    }
    const verified = await verifyAamarPayTransaction({
      tranId,
      storeId: ap.storeId,
      signatureKey: ap.signatureKey,
      ...(ap.isLive != null ? { isLive: ap.isLive } : {}),
    });
    if (verified.paid) {
      await confirmPaidAndDeliver(order.id, tranId);
      res.status(200).send("ok");
    } else {
      logger.warn(
        { orderId: order.id, tranId, payStatus: verified.payStatus },
        "AamarPay IPN: verify says not paid",
      );
      res.status(200).send("ok");
    }
  } catch (e) {
    logger.error({ e: String(e) }, "AamarPay IPN failed");
    res.status(500).send("FAIL");
  }
}

/**
 * AamarPay redirects the customer back to the success/fail/cancel URL after
 * the gateway page. We re-verify the transaction here so the order is marked
 * paid even if the IPN is delayed/blocked. Idempotent — `confirmPaidAndDeliver`
 * short-circuits if the order is already PAID.
 */
export async function aamarpayReturn(req: Request, res: Response): Promise<void> {
  const tranId = String(req.query.mer_txnid ?? req.body?.mer_txnid ?? req.query.tran_id ?? "").trim();
  const status = String(req.query.status ?? req.body?.status ?? "").toLowerCase();
  try {
    if (tranId && (status === "success" || status === "")) {
      const order = await findOrderByGatewayTran(tranId);
      if (order) {
        const tenant = await prisma.tenant.findUnique({ where: { id: order.tenantId } });
        const settings = parseTenantSettings(tenant?.settings);
        const ap = settings.aamarpay;
        if (ap?.storeId && ap?.signatureKey) {
          const verified = await verifyAamarPayTransaction({
            tranId,
            storeId: ap.storeId,
            signatureKey: ap.signatureKey,
            ...(ap.isLive != null ? { isLive: ap.isLive } : {}),
          });
          if (verified.paid) {
            await confirmPaidAndDeliver(order.id, tranId);
          }
        }
      }
    }
  } catch (e) {
    logger.error({ e: String(e), tranId }, "AamarPay return handler failed");
  }
  // Always show a friendly closing page so the customer doesn't see a 500.
  const subject =
    status === "success" ? "Payment Successful" : status === "fail" ? "Payment Failed" : "Payment Cancelled";
  res.status(200).send(
    `<html><body style="font-family:sans-serif;padding:32px;text-align:center;">` +
      `<h2>${subject}</h2><p>You can close this window and return to Messenger.</p></body></html>`,
  );
}
