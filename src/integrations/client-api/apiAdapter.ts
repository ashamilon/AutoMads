import axios, { type AxiosInstance } from "axios";
import type { IntegrationType } from "@prisma/client";
import type { ClientIntegrationAdapter, PushOrderInput } from "../integration.types.js";
import { apiIntegrationConfigSchema, type ApiIntegrationConfig } from "../config-schemas.js";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";

function clientFor(cfg: ApiIntegrationConfig): AxiosInstance {
  return axios.create({
    baseURL: cfg.baseUrl.replace(/\/$/, ""),
    timeout: 30_000,
    headers: {
      "Content-Type": "application/json",
      ...(cfg.headers ?? {}),
    },
    validateStatus: () => true,
  });
}

export class ApiClientAdapter implements ClientIntegrationAdapter {
  readonly mode: IntegrationType = "API";

  async pushOrder(tenantId: string, input: PushOrderInput): Promise<{ externalOrderId: string }> {
    const row = await prisma.tenantIntegration.findUnique({ where: { tenantId } });
    if (!row || row.type !== "API") throw new Error("Tenant API integration not configured");
    const cfg = apiIntegrationConfigSchema.parse(row.config);

    const http = clientFor(cfg);
    const path = cfg.paths.createOrder;
    const items = Array.isArray(input.structuredData.items) ? input.structuredData.items : [];
    const firstItem = items.length > 0 ? (items[0] as Record<string, unknown> | undefined) : undefined;
    const lineItems =
      items.length > 0
        ? items.map((it: unknown) => {
            const r = it as Record<string, unknown>;
            return {
              product: r.product ?? input.structuredData.product,
              size: r.size ?? input.structuredData.size,
              quantity: r.quantity ?? input.structuredData.quantity ?? 1,
            };
          })
        : [
            {
              product: input.structuredData.product,
              size: input.structuredData.size ?? firstItem?.size,
              quantity: input.structuredData.quantity ?? 1,
            },
          ];
    const body = {
      saasOrderId: input.internalOrderId,
      customer: {
        name: input.structuredData.name,
        phone: input.structuredData.phone,
        address: input.structuredData.address,
      },
      lineItems,
      amount: input.amount,
      currency: input.currency ?? "BDT",
    };

    const res = await http.post(path, body);
    if (res.status >= 400) {
      logger.error({ tenantId, status: res.status, data: res.data }, "Client API createOrder failed");
      throw new Error(`Client API error: HTTP ${res.status}`);
    }
    const data = res.data as { id?: string; orderId?: string; externalId?: string };
    const externalOrderId = String(data.id ?? data.orderId ?? data.externalId ?? "");
    if (!externalOrderId) {
      throw new Error("Client API did not return order id");
    }
    return { externalOrderId };
  }

  async updateOrderStatus(
    tenantId: string,
    externalOrderId: string,
    status: "paid" | "shipped" | "delivered" | "cancelled",
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const row = await prisma.tenantIntegration.findUnique({ where: { tenantId } });
    if (!row || row.type !== "API") return;
    const cfg = apiIntegrationConfigSchema.parse(row.config);
    const http = clientFor(cfg);
    const path = cfg.paths.updateStock?.replace(":orderId", externalOrderId) ?? `/orders/${externalOrderId}/status`;
    await http.patch(path, { status, ...meta });
  }
}
