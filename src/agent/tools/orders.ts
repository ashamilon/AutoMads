import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { computeAdvanceForCart } from "../advanceResolver.js";
import type { ToolDef } from "../types.js";

const Args = z.object({
  /** Optional order id (cuid OR sslcommerz tran id). When omitted, fetches THIS customer's latest order. */
  orderId: z.string().min(3).max(120).optional(),
});

type Item = {
  product?: string;
  size?: string;
  quantity?: number;
  unitPriceBdt?: number;
  unitAddOnBdt?: number;
  addOns?: Array<{ id?: string; label?: string; priceBdt?: number; value?: string }>;
};

function asObj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function asItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Item) : null))
    .filter((x): x is Item => x != null);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export const orderTools: ToolDef[] = [
  {
    name: "get_order_summary",
    description:
      "Read an existing order's authoritative totals (line items, add-on values, subtotal, advance, delivery charge, grand total, payment status). Use whenever the customer asks 'total koto', 'amar order er details', 'kotota dite hobe', or 'order id koi' AFTER confirm_order has run. Without `orderId` returns this customer's latest order.",
    paramsSchema: Args,
    paramsHint: '{ "orderId"?: string }',
    examples: [
      {
        when: "Customer asks 'total koto' or 'amar order er total' after confirming",
        call: { tool: "get_order_summary", args: {} },
      },
      {
        when: "Customer mentions an order id like 'TXN_xyz_123'",
        call: { tool: "get_order_summary", args: { orderId: "TXN_xyz_123" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = Args.parse(rawArgs);
      let order;
      if (args.orderId) {
        const id = args.orderId.trim();
        // Try internal id first, then sslcommerzTranId, then prefix match.
        order =
          (await prisma.order
            .findFirst({
              where: { tenantId: ctx.input.tenantId, id },
              orderBy: { createdAt: "desc" },
            })
            .catch(() => null)) ??
          (await prisma.order
            .findFirst({
              where: { tenantId: ctx.input.tenantId, sslcommerzTranId: id },
              orderBy: { createdAt: "desc" },
            })
            .catch(() => null)) ??
          (await prisma.order
            .findFirst({
              where: { tenantId: ctx.input.tenantId, id: { startsWith: id.slice(0, 12) } },
              orderBy: { createdAt: "desc" },
            })
            .catch(() => null));
      } else {
        order = await prisma.order
          .findFirst({
            where: { tenantId: ctx.input.tenantId, messengerPsid: ctx.input.psid },
            orderBy: { createdAt: "desc" },
          })
          .catch(() => null);
      }
      if (!order) {
        return {
          ok: false,
          error: "order_not_found",
          observation: args.orderId
            ? `No order with id starting "${args.orderId}". Tell the customer.`
            : "No prior order for this customer. They may not have confirmed yet — show_cart instead.",
        };
      }

      const tenant = await prisma.tenant
        .findUnique({ where: { id: ctx.input.tenantId }, select: { settings: true } })
        .catch(() => null);
      const settings = parseTenantSettings(tenant?.settings);
      const delivery = num(settings.deliveryChargeBdt);

      const sd = asObj(order.structuredData);
      const items = asItems(sd["items"]);
      const subtotal = num(order.totalAmount?.toString());

      // Prefer the advance breakdown captured at confirm time. If absent (legacy order),
      // recompute from the items + current settings.
      const sdAdvance = asObj(sd["advance"]);
      let advanceTotal = num(sdAdvance["totalBdt"]);
      let advanceBreakdown = Array.isArray(sdAdvance["breakdown"]) ? sdAdvance["breakdown"] : null;
      let advancePolicy = typeof sdAdvance["policy"] === "string" ? (sdAdvance["policy"] as string) : null;
      if (advanceTotal == null) {
        const recomputed = computeAdvanceForCart({
          tenantSettings: settings,
          cart: items.map((it) => ({
            quantity: num(it.quantity) ?? 1,
            addOns: Array.isArray(it.addOns) ? it.addOns : [],
          })),
        });
        advanceTotal = recomputed.totalBdt;
        advanceBreakdown = recomputed.breakdown as unknown as typeof advanceBreakdown;
        advancePolicy = recomputed.policyDescription;
      }
      const lineLines: string[] = [];
      if (items.length > 0) {
        for (const it of items) {
          const unit = num(it.unitPriceBdt) ?? 0;
          const addPerUnit = num(it.unitAddOnBdt) ?? 0;
          const qty = num(it.quantity) ?? 1;
          const lineTotal = (unit + addPerUnit) * qty;
          let l = `- ${it.product ?? "item"}${it.size ? ` (${it.size})` : ""} x${qty} @ ${unit} BDT = ${lineTotal} BDT`;
          if (it.addOns && it.addOns.length > 0) {
            const ao = it.addOns
              .map((a) => {
                const lbl = String(a.label ?? a.id ?? "addon");
                const p = num(a.priceBdt);
                const val = a.value ? ` "${a.value}"` : "";
                return `${lbl}${p === 0 ? " (FREE)" : p != null ? ` +${p} BDT` : ""}${val}`;
              })
              .join(", ");
            l += ` [add-ons: ${ao}]`;
          }
          lineLines.push(l);
        }
      } else {
        // Single-item legacy fallback.
        const product = String(sd["product"] ?? "");
        const size = String(sd["size"] ?? "");
        const qty = num(sd["quantity"]) ?? 1;
        if (product) lineLines.push(`- ${product}${size ? ` (${size})` : ""} x${qty}`);
      }

      const grandTotal = (subtotal ?? 0) + (delivery ?? 0);
      const summary = [
        `order_id=${order.id.slice(0, 12)}`,
        order.sslcommerzTranId ? `tran_id=${order.sslcommerzTranId}` : "",
        `status=${order.status}/${order.paymentStatus}`,
        `currency=${order.currency}`,
        `subtotal=${subtotal ?? "?"} BDT`,
        delivery != null ? `delivery_charge=${delivery} BDT` : "",
        advancePolicy ? `advance_policy=${advancePolicy}` : "",
        `advance_required=${advanceTotal} BDT`,
        `grand_total=${grandTotal} BDT`,
      ]
        .filter(Boolean)
        .join(" | ");

      const breakdownLines: string[] = [];
      if (Array.isArray(advanceBreakdown)) {
        for (const b of advanceBreakdown as Array<{ kind?: string; qty?: number; unitBdt?: number; subtotalBdt?: number }>) {
          const label =
            b.kind === "plain"
              ? "per plain product"
              : b.kind === "customised"
                ? "per customised product"
                : "fixed";
          breakdownLines.push(
            `  • ${label}: ${b.unitBdt} × ${b.qty} = ${b.subtotalBdt} BDT`,
          );
        }
      }

      return {
        ok: true,
        observation: [
          `Order details:`,
          summary,
          ...lineLines,
          ...breakdownLines,
          advanceTotal > 0 && order.paymentStatus === "PENDING"
            ? `Customer needs to pay ${advanceTotal} BDT advance now; rest (${grandTotal - advanceTotal} BDT) on delivery.`
            : `Total payable: ${grandTotal} BDT.`,
        ].join("\n"),
        data: {
          orderId: order.id,
          tranId: order.sslcommerzTranId,
          status: order.status,
          paymentStatus: order.paymentStatus,
          subtotal,
          deliveryCharge: delivery ?? null,
          advanceRequired: advanceTotal,
          advancePolicy,
          advanceBreakdown,
          grandTotal,
          items,
        },
      };
    },
  },
];
