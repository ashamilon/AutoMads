import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { webhookIntegrationConfigSchema } from "../integrations/config-schemas.js";
import { logger } from "../utils/logger.js";

/** Generic inbound updates from client ecommerce systems (tenant-isolated) */
export async function receiveClientInbound(req: Request, res: Response): Promise<void> {
  const slug = String(req.params["tenantSlug"] ?? "");
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    include: { integration: true },
  });
  if (!tenant?.integration || tenant.integration.type !== "WEBHOOK") {
    res.status(404).json({ error: "not_found" });
    return;
  }

  let cfg: { inboundSecret?: string };
  try {
    cfg = webhookIntegrationConfigSchema.parse(tenant.integration.config);
  } catch {
    res.status(500).json({ error: "invalid_integration_config" });
    return;
  }

  const secret = req.header("x-webhook-secret");
  if (cfg.inboundSecret && secret !== cfg.inboundSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const body = req.body as {
    externalOrderId?: string;
    status?: string;
    trackingId?: string;
  };

  if (!body.externalOrderId) {
    res.status(400).json({ error: "externalOrderId_required" });
    return;
  }

  try {
    const order = await prisma.order.findFirst({
      where: { tenantId: tenant.id, externalOrderId: body.externalOrderId },
    });
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }

    const updates: {
      deliveryStatus?: "IN_TRANSIT" | "DELIVERED" | "FAILED";
      status?: "COMPLETED";
      pathaoConsignmentId?: string;
    } = {};

    if (body.trackingId) updates.pathaoConsignmentId = body.trackingId;
    if (body.status === "shipped") updates.deliveryStatus = "IN_TRANSIT";
    if (body.status === "delivered") {
      updates.deliveryStatus = "DELIVERED";
      updates.status = "COMPLETED";
    }
    if (body.status === "failed") updates.deliveryStatus = "FAILED";

    await prisma.order.update({
      where: { id: order.id },
      data: updates,
    });

    res.json({ ok: true });
  } catch (e) {
    logger.error({ e }, "Client inbound webhook failed");
    res.status(500).json({ error: "internal_error" });
  }
}
