import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import type { ToolDef } from "../types.js";
import { asMeta, coerceNumber, sizeStockFromMeta } from "./inventoryHelpers.js";

const CheckInventoryArgs = z.object({
  sku: z.string().min(1).max(80),
  size: z.string().min(1).max(10).optional(),
});

/**
 * Read-only stock probe. Returns the same numbers `add_to_cart` would consult before merging
 * a new line, so the agent can answer "ei size ta ache?" without committing to a cart write.
 *
 * Lookup priority (Req 6.1, 10.1, 10.4):
 *   1. If `size` is supplied AND the catalog row carries per-size data, return that variant's
 *      stock.
 *   2. Otherwise return the aggregate `meta.stock` value.
 *
 * On unknown sku → `{ ok: false, error: "sku_not_found" }` (mirrors `verify_sku` / `add_to_cart`).
 *
 * Reads from `prisma.productMapping` scoped to the active tenant; never crosses tenants.
 */
export const inventoryTools: ToolDef[] = [
  {
    name: "check_inventory",
    description:
      "Read-only probe of catalog stock for a sku (optionally for a specific size). Returns " +
      "{ in_stock, stock, sku, size, is_active }. Variant-level (per-size) stock takes " +
      "precedence over the aggregate `stock` field when both are present. Use before answering " +
      "'ei size ta ache?' so the number you quote is the same number `add_to_cart` would see.",
    paramsSchema: CheckInventoryArgs,
    paramsHint: '{ "sku": string, "size"?: string }',
    examples: [
      {
        when: "Customer asks 'L size ache?' for the Argentina home kit shown in the previous turn",
        call: { tool: "check_inventory", args: { sku: "ARG-HOME-24", size: "L" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = CheckInventoryArgs.parse(rawArgs);

      const row = await prisma.productMapping.findUnique({
        where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: args.sku } },
      });
      if (!row) {
        return {
          ok: false,
          error: "sku_not_found",
          observation: `check_inventory: sku=${args.sku} not in catalog.`,
        };
      }

      const meta = asMeta(row.metadata);
      const isActive = meta["isActive"] !== false && meta["is_active"] !== false;

      // Variant-level lookup precedes aggregate stock — if `size` is supplied and per-size data
      // exists, return that; otherwise return aggregate `stock` (Req 10.4).
      const aggregateStock = coerceNumber(meta["stock"]);
      const sizeStock = args.size ? sizeStockFromMeta(meta, args.size) : undefined;
      const stock = sizeStock ?? aggregateStock ?? null;

      // `in_stock` is true only when the row is active AND we have a positive number to back it.
      // A null stock (catalog didn't record one) is treated as "unknown" → not in stock for the
      // purposes of this boolean, so the agent doesn't promise availability it can't verify.
      const inStock = isActive && typeof stock === "number" && stock > 0;

      const sizeNote = args.size ? ` size=${args.size}` : "";
      const stockNote = stock == null ? "stock=unknown" : `stock=${stock}`;
      const activeNote = isActive ? "" : " (INACTIVE)";

      return {
        ok: true,
        observation:
          `check_inventory: sku=${args.sku}${sizeNote} ${stockNote}${activeNote}, ` +
          `in_stock=${inStock}.`,
        data: {
          in_stock: inStock,
          stock,
          sku: args.sku,
          size: args.size ?? null,
          is_active: isActive,
        },
      };
    },
  },
];
