import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import type { ToolDef } from "../types.js";

const Args = z.object({
  sku: z.string().min(1).max(80),
  size: z.string().min(1).max(10).optional(),
  quantity: z.number().int().min(1).max(20).optional().default(1),
});

function asMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read size-specific stock from various metadata shapes commonly seen in this project. */
function sizeStockFromMeta(meta: Record<string, unknown>, size: string): number | null {
  const upper = size.toUpperCase();
  const map = meta["sizeStocks"] ?? meta["size_stocks"];
  if (map && typeof map === "object" && !Array.isArray(map)) {
    const v = (map as Record<string, unknown>)[upper] ?? (map as Record<string, unknown>)[size];
    const n = coerceNumber(v);
    if (n != null) return n;
  }
  const variants = meta["variants"];
  if (Array.isArray(variants)) {
    for (const v of variants) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const r = v as Record<string, unknown>;
      if (String(r["size"] ?? "").toUpperCase() === upper) {
        const n = coerceNumber(r["stock"]);
        if (n != null) return n;
      }
    }
  }
  return null;
}

export const verifyTools: ToolDef[] = [
  {
    name: "check_stock",
    description:
      "Confirm a sku is active and has enough stock for a requested size+quantity by re-reading the product from the catalog. Use BEFORE add_to_cart when the customer specifies a size, and ALWAYS before confirm_order. Returns the current authoritative price too.",
    paramsSchema: Args,
    paramsHint: '{ "sku": string, "size"?: string, "quantity"?: int(1-20) }',
    examples: [
      {
        when: "Customer says 'M size ekta nibo' for SKU-1234",
        call: { tool: "check_stock", args: { sku: "SKU-1234", size: "M", quantity: 1 } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = Args.parse(rawArgs);
      const row = await prisma.productMapping.findUnique({
        where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: args.sku } },
      });
      if (!row) return { ok: false, error: "sku_not_found", observation: `sku=${args.sku} not in catalog.` };
      const meta = asMeta(row.metadata);
      if (meta["isActive"] === false || meta["is_active"] === false) {
        return { ok: false, error: "sku_inactive", observation: `sku=${args.sku} is inactive.` };
      }
      const price = coerceNumber(meta["price"] ?? meta["unitPriceBdt"]);
      const totalStock = coerceNumber(meta["stock"]);
      const sizeStock = args.size ? sizeStockFromMeta(meta, args.size) : null;
      const effectiveStock = sizeStock ?? totalStock;
      const sufficient = effectiveStock == null ? null : effectiveStock >= args.quantity;
      const status =
        sufficient === null
          ? "stock_unknown"
          : sufficient
            ? "in_stock"
            : "insufficient_stock";
      const observation = [
        `sku=${args.sku} status=${status}`,
        price != null ? `price=${price} BDT` : "price=unknown",
        args.size ? `size=${args.size.toUpperCase()}` : "",
        effectiveStock != null ? `stock=${effectiveStock}` : "stock=unknown",
        `requested_qty=${args.quantity}`,
      ]
        .filter(Boolean)
        .join(" ");
      const data = { sku: args.sku, price, sizeStock, totalStock, effectiveStock, sufficient };
      if (status === "insufficient_stock") {
        return { ok: false, error: "insufficient_stock", observation };
      }
      return { ok: true, observation, data };
    },
  },
];
