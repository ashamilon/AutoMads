import type { ToolDef } from "../types.js";
import { aliasTools } from "./aliases.js";
import { catalogTools } from "./catalog.js";
import { cartTools } from "./cart.js";
import { confirmTools } from "./confirm.js";
import { customerTools } from "./customer.js";
import { deliveryTools } from "./delivery.js";
import { inventoryTools } from "./inventory.js";
import { lineAddonTools } from "./lineAddons.js";
import { memoryTools } from "./memory.js";
import { orderTools } from "./orders.js";
import { paymentTools } from "./payment.js";
import { paymentLinkTools } from "./paymentLink.js";
import { photoTools } from "./photos.js";
import { policyTools } from "./policy.js";
import { replyTools } from "./reply.js";
import { resolveTools } from "./resolve.js";
import { sessionTools } from "./session.js";
import { sizeChartTools } from "./sizeChart.js";
import { validateOrderTools } from "./validate.js";
import { verifyTools } from "./verify.js";

export const TOOLS: ToolDef[] = [
  ...memoryTools,
  ...sessionTools,
  ...catalogTools,
  ...resolveTools,
  ...sizeChartTools,
  ...photoTools,
  ...policyTools,
  ...verifyTools,
  ...cartTools,
  ...inventoryTools,
  ...lineAddonTools,
  ...customerTools,
  ...validateOrderTools,
  ...confirmTools,
  ...orderTools,
  ...paymentTools,
  ...paymentLinkTools,
  ...deliveryTools,
  ...replyTools,
  // Canonical-name aliases (task 7.1 — Reqs 6.1–6.5). Registered LAST so the
  // primary entries are what `renderToolCatalog` lists first when alias filtering
  // is bypassed for any reason.
  ...aliasTools,
];

export function findTool(name: string): ToolDef | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}
