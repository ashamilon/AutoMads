import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { resolveProductAddons } from "../addonResolver.js";
import { coerceNumber, sizeStockFromMeta } from "./inventoryHelpers.js";
import type { AgentCartItem, AgentSnapshot, ToolDef } from "../types.js";

/**
 * Stable failure codes returned in the `validate_order` result. Kept in sync with the
 * task spec (Req 6.6 — confirm_order refuses to run when validate_order fails) so the
 * router can react to specific reasons rather than free-form strings.
 */
export type ValidationFailureCode =
  | "sku_not_found"
  | "sku_inactive"
  | "insufficient_stock"
  | "price_drift"
  | "addon_not_allowed"
  | "addon_price_drift";

export type ValidationFailure = {
  line_id: string;
  code: ValidationFailureCode;
  detail: string;
};

export type ValidationResult = {
  ok: boolean;
  failures: ValidationFailure[];
  totals: { subtotal: number; line_count: number };
};

/**
 * Where the most recent `validate_order` result is parked on the snapshot. We piggy-back on
 * `confirmed_information` (already typed as `Record<string, Record<string, unknown>>`) and reserve
 * the dunder key `__validation` so it can never collide with a real per-line confirmed slot
 * (those are keyed by `line_id` cuids) or the order-level `"order"` bucket. Documenting the choice
 * here per task 7.2: we deliberately did NOT extend the typed `AgentSnapshot` with a new
 * `last_validation` field — keeping the data inside `confirmed_information` lets `state.ts`
 * round-trip the value through `pendingDraftJson` without any reader/writer changes.
 */
export const VALIDATION_KEY = "__validation";

function asMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

/**
 * Re-verify every line in `cart` against the live `productMapping` row plus the resolved
 * tenant add-on registry. Pure (apart from Prisma reads) and deterministic — no LLM, no I/O
 * other than catalog lookups.
 *
 * Failure accumulation rules:
 *   - `sku_not_found` and `sku_inactive` short-circuit downstream checks for the same line
 *     (price/stock/add-ons are meaningless without an active sku).
 *   - `price_drift`, `insufficient_stock`, and `addon_not_allowed` are independent and accumulate
 *     so the agent can surface every problem in one round-trip.
 *   - `totals.subtotal` always reflects the cart's stored prices; the per-line `detail` field
 *     carries any live-vs-cart discrepancy.
 */
export async function runValidation(
  tenantId: string,
  cart: AgentCartItem[],
): Promise<ValidationResult> {
  const failures: ValidationFailure[] = [];
  let subtotal = 0;

  // Tenant settings only fetched when at least one line carries add-ons (the only scenario where
  // resolveProductAddons is needed). Saves a Prisma round-trip on plain carts.
  const needsTenantSettings = cart.some((c) => Array.isArray(c.addOns) && c.addOns.length > 0);
  let tenantSettings: ReturnType<typeof parseTenantSettings> | null = null;
  if (needsTenantSettings) {
    const tenant = await prisma.tenant
      .findUnique({ where: { id: tenantId }, select: { settings: true } })
      .catch(() => null);
    tenantSettings = parseTenantSettings(tenant?.settings);
  }

  for (const line of cart) {
    const lineId = line.line_id;
    const unitPrice = typeof line.unitPriceBdt === "number" ? line.unitPriceBdt : 0;
    const addOnPerUnit = (line.addOns ?? []).reduce((s, a) => s + (a.priceBdt ?? 0), 0);
    subtotal += (unitPrice + addOnPerUnit) * line.quantity;

    const row = await prisma.productMapping
      .findUnique({ where: { tenantId_clientSku: { tenantId, clientSku: line.sku } } })
      .catch(() => null);
    if (!row) {
      failures.push({
        line_id: lineId,
        code: "sku_not_found",
        detail: `sku=${line.sku} no longer exists in the catalog`,
      });
      continue;
    }
    const meta = asMeta(row.metadata);

    // (1) active flag — explicit `false` only; missing/undefined is treated as active.
    if (meta["isActive"] === false || meta["is_active"] === false) {
      failures.push({
        line_id: lineId,
        code: "sku_inactive",
        detail: `sku=${line.sku} is currently inactive`,
      });
      continue;
    }

    // (2) price drift — only flagged when the cart line carries a stored unit price AND it
    // differs from the live catalog price. A cart line with no `unitPriceBdt` (legacy / pre-add)
    // is left alone here; confirm_order's own verifyCart still re-reads the price.
    const livePrice = coerceNumber(meta["price"] ?? meta["unitPriceBdt"]);
    if (
      typeof line.unitPriceBdt === "number" &&
      livePrice != null &&
      line.unitPriceBdt !== livePrice
    ) {
      failures.push({
        line_id: lineId,
        code: "price_drift",
        detail: `sku=${line.sku} price changed: cart=${line.unitPriceBdt} BDT, live=${livePrice} BDT`,
      });
    }

    // (3) per-size stock — variant-level lookup wins; falls back to aggregate `stock` when no
    // per-size data is available. Mirrors the same helper add_to_cart and check_inventory use.
    const aggregateStock = coerceNumber(meta["stock"]);
    const sizeStock = line.size ? sizeStockFromMeta(meta, line.size) : undefined;
    const effectiveStock = sizeStock ?? aggregateStock;
    if (effectiveStock != null && effectiveStock < line.quantity) {
      failures.push({
        line_id: lineId,
        code: "insufficient_stock",
        detail:
          `sku=${line.sku}${line.size ? ` size=${line.size}` : ""} ` +
          `stock=${effectiveStock}, need=${line.quantity}`,
      });
    }

    // (4) add-on opt-in + price drift — every cart-line add-on id must still be in the
    // resolved list for this sku (catches the case where the tenant disabled an add-on
    // after the cart was built), and the cart's per-add-on `priceBdt` must still match
    // the live override-aware tenant price (catches the case where the tenant nudged the
    // add-on price between cart build and confirm).
    if (line.addOns && line.addOns.length > 0) {
      const settings = tenantSettings ?? parseTenantSettings(undefined);
      const allowed = resolveProductAddons({
        productMetadata: row.metadata,
        tenantSettings: settings,
      });
      const allowedById = new Map(allowed.map((a) => [a.id, a] as const));
      const rejected: string[] = [];
      for (const a of line.addOns) {
        const def = allowedById.get(a.id);
        if (!def) {
          rejected.push(a.id);
          continue;
        }
        if (a.priceBdt !== def.priceBdt) {
          failures.push({
            line_id: lineId,
            code: "addon_price_drift",
            detail:
              `sku=${line.sku} add-on "${def.label}" (id=${a.id}) price changed: ` +
              `cart=${a.priceBdt} BDT, live=${def.priceBdt} BDT`,
          });
        }
      }
      if (rejected.length > 0) {
        const allowedIds = [...allowedById.keys()];
        failures.push({
          line_id: lineId,
          code: "addon_not_allowed",
          detail:
            `sku=${line.sku} no longer accepts add-on(s): ${rejected.join(", ")}. ` +
            `Allowed: ${allowedIds.join(", ") || "(none)"}`,
        });
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    totals: { subtotal, line_count: cart.length },
  };
}

/**
 * Persist the most recent validation result onto the snapshot under `confirmed_information.__validation`.
 * Best-effort: a save failure NEVER blocks the tool's return value (Req: "never block the tool result
 * on a save failure"). Any caller that wants the persistence side-effect should await this directly;
 * `runValidation` itself stays read-only so it can be called synchronously from `confirm_order`.
 */
export async function persistValidationResult(
  ctx: {
    snapshot: AgentSnapshot;
    saveSnapshot(next: AgentSnapshot): Promise<void>;
  },
  result: ValidationResult,
): Promise<void> {
  try {
    const next: AgentSnapshot = {
      ...ctx.snapshot,
      confirmed_information: {
        ...ctx.snapshot.confirmed_information,
        [VALIDATION_KEY]: {
          ok: result.ok,
          failures: result.failures,
          subtotal: result.totals.subtotal,
          line_count: result.totals.line_count,
          ts: new Date().toISOString(),
        },
      },
    };
    await ctx.saveSnapshot(next);
  } catch (e) {
    logger.warn(
      { e: String(e) },
      "agent.validate_order: failed to persist validation result onto snapshot — continuing",
    );
  }
}

/**
 * Read the most recent validation result back out of the snapshot. Returns `null` when nothing
 * has been recorded yet so callers (e.g. `confirm_order`) can decide whether to run the
 * validation synchronously.
 */
export function readLatestValidation(snapshot: AgentSnapshot): ValidationResult | null {
  const blob = snapshot.confirmed_information?.[VALIDATION_KEY];
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return null;
  const r = blob as Record<string, unknown>;
  if (typeof r["ok"] !== "boolean") return null;
  const failuresRaw = Array.isArray(r["failures"]) ? r["failures"] : [];
  const failures: ValidationFailure[] = [];
  for (const f of failuresRaw) {
    if (!f || typeof f !== "object" || Array.isArray(f)) continue;
    const fr = f as Record<string, unknown>;
    const lineId = String(fr["line_id"] ?? "").trim();
    const code = String(fr["code"] ?? "").trim();
    const detail = String(fr["detail"] ?? "").trim();
    if (!lineId || !code) continue;
    failures.push({ line_id: lineId, code: code as ValidationFailureCode, detail });
  }
  const subtotal = typeof r["subtotal"] === "number" ? (r["subtotal"] as number) : 0;
  const lineCount = typeof r["line_count"] === "number" ? (r["line_count"] as number) : 0;
  return { ok: r["ok"] as boolean, failures, totals: { subtotal, line_count: lineCount } };
}

const Args = z.object({}).strict();

export const validateOrderTools: ToolDef[] = [
  {
    name: "validate_order",
    description:
      "Re-verify every cart line against the live catalog: active flag, per-size stock, current unit price (drift), and allowed add-ons. Returns { ok, failures[], totals }. Result is stashed on the snapshot so confirm_order can refuse if anything regressed. Call before composing a confirmation reply when the cart has been sitting around or pricing/stock might have changed.",
    paramsSchema: Args,
    paramsHint: "{}",
    examples: [
      {
        when: "Customer says 'order confirm' after a long pause — re-check the cart before charging.",
        call: { tool: "validate_order", args: {} },
      },
    ],
    handler: async (_rawArgs, ctx) => {
      const cart = ctx.snapshot.cart;
      const result = await runValidation(ctx.input.tenantId, cart);
      // Persist transient validation state — best-effort; never block the tool result.
      await persistValidationResult(ctx, result);

      if (result.ok) {
        return {
          ok: true,
          observation:
            `Cart validation passed: ${result.totals.line_count} line(s), ` +
            `subtotal=${result.totals.subtotal} BDT.`,
          data: result,
        };
      }
      const reasons = result.failures
        .map((f) => `${f.code} (line=${f.line_id.slice(0, 8)}): ${f.detail}`)
        .join("; ");
      // ToolErr can't carry a `data` payload (see types.ts) — the structured `result` is already
      // persisted into `confirmed_information.__validation` above, so confirm_order and the router
      // can read the same data via `readLatestValidation`. The observation surfaces every reason.
      return {
        ok: false,
        error: "validation_failed",
        observation:
          `Cart validation FAILED: ${result.failures.length} issue(s) — ${reasons}. ` +
          `Tell the customer what changed and ask how they want to proceed before confirm_order.`,
      };
    },
  },
];
