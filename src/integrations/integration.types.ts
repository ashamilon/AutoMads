import type { IntegrationType } from "@prisma/client";

export type PushOrderInput = {
  internalOrderId: string;
  structuredData: Record<string, unknown>;
  amount?: number;
  currency?: string;
};

export type StockDeductionInput = {
  clientSku?: string;
  productName?: string;
  size?: string;
  quantity: number;
};

export interface ClientIntegrationAdapter {
  readonly mode: IntegrationType;
  pushOrder(tenantId: string, input: PushOrderInput): Promise<{ externalOrderId: string }>;
  updateOrderStatus?(
    tenantId: string,
    externalOrderId: string,
    status: "paid" | "shipped" | "delivered" | "cancelled",
    meta?: Record<string, unknown>,
  ): Promise<void>;
  deductStock?(tenantId: string, input: StockDeductionInput): Promise<void>;
}
