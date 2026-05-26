import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { mapSteadfastStatusToInternal } from "../integrations/steadfast/steadfastService.js";

/**
 * Steadfast delivery-status webhook.
 *
 * They POST a JSON body like:
 *   {
 *     "consignment_id": "1234567",
 *     "invoice": "<our merchant order id>",
 *     "tracking_code": "ABCD12",
 *     "status": "delivered" | "in_transit" | "cancelled" | ...,
 *     "updated_at": "2026-05-25T16:08:30Z"
 *   }
 *
 * The URL has to be registered with Steadfast support during onboarding —
 * they don't have a self-service config page. This handler also accepts
 * POST/GET so manual probing during setup works.
 *
 * NOT signature-verified — Steadfast doesn't sign their webhook. We treat
 * the incoming status as a hint and re-poll `/status_by_cid` before marking
 * DELIVERED, but we trust the webhook for IN_TRANSIT / FAILED state changes
 * because those just update a column.
 */
export async function steadfastStatus(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const consignmentIdRaw = body.consignment_id ?? body.consignmentId;
    const invoice = typeof body.invoice === "string" ? body.invoice : "";
    const statusRaw = typeof body.status === "string" ? body.status : "";
    const consignmentId =
      typeof consignmentIdRaw === "string" || typeof consignmentIdRaw === "number"
        ? String(consignmentIdRaw)
        : "";

    if (!consignmentId && !invoice) {
      res.status(400).json({ ok: false, error: "missing_consignment_id_and_invoice" });
      return;
    }

    // Match by consignment id first (reliable), fall back to invoice (= our orderId).
    let order =
      (consignmentId
        ? await prisma.order.findFirst({ where: { pathaoConsignmentId: consignmentId } })
        : null) ??
      (invoice ? await prisma.order.findFirst({ where: { id: invoice } }) : null);

    if (!order) {
      logger.warn(
        { consignmentId, invoice, statusRaw },
        "Steadfast webhook: no order matched; ignoring",
      );
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const internal = mapSteadfastStatusToInternal(statusRaw);
    const data: {
      deliveryStatus?: "BOOKED" | "IN_TRANSIT" | "DELIVERED" | "FAILED";
      status?: "DELIVERY_SCHEDULED" | "COMPLETED" | "FAILED";
      pathaoMerchantOrderId?: string | null;
    } = {};

    if (internal === "DELIVERED") {
      data.deliveryStatus = "DELIVERED";
      data.status = "COMPLETED";
    } else if (internal === "FAILED") {
      data.deliveryStatus = "FAILED";
      // Don't downgrade status from COMPLETED back to FAILED — keep status as
      // whatever it already was; the deliveryStatus carries the failure detail.
    } else if (internal === "IN_TRANSIT") {
      data.deliveryStatus = "IN_TRANSIT";
    }

    // Persist tracking_code on the historical pathaoMerchantOrderId column if
    // we don't already have one.
    const trackingCode = typeof body.tracking_code === "string" ? body.tracking_code : "";
    if (trackingCode && !order.pathaoMerchantOrderId) {
      data.pathaoMerchantOrderId = trackingCode;
    }

    if (Object.keys(data).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data });
    }

    logger.info(
      { orderId: order.id, consignmentId, statusRaw, mapped: internal },
      "Steadfast webhook processed",
    );
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error({ e: String(e) }, "Steadfast webhook handler failed");
    res.status(500).json({ ok: false, error: "internal_error" });
  }
}
