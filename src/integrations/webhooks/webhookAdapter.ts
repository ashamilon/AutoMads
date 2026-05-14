import axios from "axios";
import crypto from "node:crypto";
import type { IntegrationType } from "@prisma/client";
import type { ClientIntegrationAdapter, PushOrderInput } from "../integration.types.js";
import { webhookIntegrationConfigSchema } from "../config-schemas.js";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";

export class WebhookClientAdapter implements ClientIntegrationAdapter {
  readonly mode: IntegrationType = "WEBHOOK";

  async pushOrder(tenantId: string, input: PushOrderInput): Promise<{ externalOrderId: string }> {
    const row = await prisma.tenantIntegration.findUnique({ where: { tenantId } });
    if (!row || row.type !== "WEBHOOK") throw new Error("Tenant webhook integration not configured");
    const cfg = webhookIntegrationConfigSchema.parse(row.config);

    const payload = {
      event: "order.create",
      saasOrderId: input.internalOrderId,
      structuredData: input.structuredData,
      amount: input.amount,
      currency: input.currency ?? "BDT",
      occurredAt: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cfg.outboundSecret) {
      const sig = crypto.createHmac("sha256", cfg.outboundSecret).update(body).digest("hex");
      headers["X-Saas-Signature"] = sig;
    }

    const res = await axios.post(cfg.outboundUrl, payload, { headers, timeout: 30_000, validateStatus: () => true });
    if (res.status >= 400) {
      logger.error({ tenantId, status: res.status, data: res.data }, "Client webhook order failed");
      throw new Error(`Client webhook error: HTTP ${res.status}`);
    }
    const data = res.data as { externalOrderId?: string; id?: string };
    const externalOrderId = String(data.externalOrderId ?? data.id ?? input.internalOrderId);
    return { externalOrderId };
  }

  async updateOrderStatus(
    tenantId: string,
    externalOrderId: string,
    status: "paid" | "shipped" | "delivered" | "cancelled",
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const row = await prisma.tenantIntegration.findUnique({ where: { tenantId } });
    if (!row || row.type !== "WEBHOOK") return;
    const cfg = webhookIntegrationConfigSchema.parse(row.config);
    const payload = {
      event: "order.status",
      externalOrderId,
      status,
      meta: meta ?? {},
      occurredAt: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.outboundSecret) {
      headers["X-Saas-Signature"] = crypto.createHmac("sha256", cfg.outboundSecret).update(body).digest("hex");
    }
    await axios.post(cfg.outboundUrl, payload, { headers, timeout: 30_000 });
  }
}
