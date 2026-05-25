import { z } from "zod";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { resolveProductAddons } from "../addonResolver.js";
import { computeAdvanceForCart } from "../advanceResolver.js";
import { bumpLeadScore } from "../customerProfile.js";
import type { AgentCartItem, AgentSnapshot, ToolDef } from "../types.js";
import { recomputeStructuredCart } from "../state.js";
import { syncLineSlots } from "./missingSlots.js";
import { asMeta, coerceNumber, sizeStockFromMeta } from "./inventoryHelpers.js";

const AddArgs = z.object({
  sku: z.string().min(1).max(80),
  quantity: z.number().int().min(1).max(20).optional().default(1),
  size: z.string().min(1).max(10).optional(),
  /**
   * Optional add-on selection for this line. ids must come from list_addons or
   * get_product_details for THIS sku — unknown ids are rejected. Use `set_line_addons`
   * later to update or attach name+number values.
   */
  addOnIds: z.array(z.string().min(1).max(64)).max(10).optional(),
});

/**
 * `remove_from_cart` accepts EITHER a `sku` (legacy/back-compat) OR a `line_id` (preferred,
 * required when the cart has duplicate skus that differ only in size/add-ons). Validation enforces
 * "exactly one of": neither and we don't know what to remove; both and the caller is ambiguous.
 *
 * Exported so adjacent tools/tests can share the schema without redeclaring the mutex rule.
 */
export const RemoveArgs = z
  .object({
    sku: z.string().min(1).max(80).optional(),
    line_id: z.string().min(1).max(80).optional(),
  })
  .refine((v) => Boolean(v.sku) !== Boolean(v.line_id), {
    message: "remove_from_cart requires exactly one of `sku` or `line_id` (not both, not neither).",
  });

/**
 * `modify_cart_item` updates a single line addressed by its stable `line_id`. At least one of
 * `quantity`, `size`, or `unitPriceBdt` MUST be supplied (otherwise the call is a no-op and we
 * surface a validation error so the router can re-think). Fields not supplied keep their prior
 * values on the targeted line — this is the "preserve unchanged slots" requirement (Req 3.5).
 */
const ModifyArgs = z
  .object({
    line_id: z.string().min(1).max(80),
    quantity: z.number().int().min(1).max(20).optional(),
    size: z.string().min(1).max(10).optional(),
    unitPriceBdt: z.number().optional(),
  })
  .refine(
    (v) => v.quantity !== undefined || v.size !== undefined || v.unitPriceBdt !== undefined,
    {
      message:
        "modify_cart_item requires at least one of `quantity`, `size`, or `unitPriceBdt` to be supplied.",
    },
  );

const ShowArgs = z.object({}).strict();

function fmtCart(
  cart: Array<{
    product: string;
    sku: string;
    quantity: number;
    size?: string;
    unitPriceBdt?: number;
    addOns?: Array<{ id: string; label: string; priceBdt: number; value?: string }>;
  }>,
): string {
  if (cart.length === 0) return "(cart empty)";
  return cart
    .map((c, i) => {
      const head = `${i + 1}. ${c.product} [sku=${c.sku}]${c.size ? ` size=${c.size}` : ""} x${c.quantity}${
        c.unitPriceBdt != null ? ` @ ${c.unitPriceBdt} BDT` : ""
      }`;
      if (!c.addOns || c.addOns.length === 0) return head;
      const aos = c.addOns
        .map(
          (a) =>
            `${a.label}${a.priceBdt === 0 ? " (FREE)" : ` +${a.priceBdt} BDT`}${
              a.value ? ` value="${a.value}"` : ""
            }`,
        )
        .join(", ");
      return `${head}\n     add-ons: ${aos}`;
    })
    .join("\n");
}

/**
 * Anti-hallucination grounding predicate (Reqs 6.4, 10.1, 10.5).
 *
 * A sku is "grounded" — i.e. safe to feed into a cart mutation — when it has been
 * surfaced to the customer somewhere earlier in this conversation, OR is already a
 * line on the cart (re-adding / modifying an existing line is by definition grounded
 * in a prior decision the customer already saw). The four accepted paths are:
 *
 *  1. `snapshot.shownSkus` — the running union of every catalog-derived sku the
 *     customer has been exposed to (extended on every `search_catalog` /
 *     `get_product_details` observation).
 *  2. `snapshot.lastShown[*].sku` — the most-recent ordered list of cards from
 *     `search_catalog`. We need this distinct from `shownSkus` because the loop
 *     consults it for ordinal references ("prothom ta") and tests sometimes seed
 *     only one of the two.
 *  3. `snapshot.recent_references` with `target_kind === "product"` and matching
 *     `target_id` — the deterministic reference resolver writes a row here every
 *     time it pins a customer phrase ("the red one") to a sku, and we should treat
 *     that resolution as grounding for follow-up cart actions.
 *  4. `snapshot.cart[*].sku` — modifying or re-adding an existing line is fine,
 *     because that sku already passed this guard at first add.
 *
 * Pure: takes only the snapshot and the sku, no I/O — so the cart-mutating tools
 * can call it BEFORE any Prisma lookup.
 */
function isSkuGrounded(snapshot: AgentSnapshot, sku: string): boolean {
  if (snapshot.shownSkus.includes(sku)) return true;
  if (snapshot.lastShown?.some((row) => row.sku === sku)) return true;
  if (
    snapshot.recent_references?.some(
      (r) => r.target_kind === "product" && r.target_id === sku,
    )
  )
    return true;
  if (snapshot.cart.some((c) => c.sku === sku)) return true;
  return false;
}

/**
 * Anti-hallucination guard for cart-mutating tools (Reqs 6.4, 10.1, 10.5).
 *
 * Invariant: a cart-mutating tool that takes an explicit `sku` argument MUST refuse to
 * mutate the cart — and MUST refuse before doing any Prisma lookup — unless that sku is
 * grounded per `isSkuGrounded`. The guard exists because the LLM — even with a tight
 * prompt — can synthesise a plausible-looking sku from prior turns or training data;
 * without this gate `add_to_cart` would silently invent a product the customer never
 * asked about. Tools that key off `line_id` (`modify_cart_item`, `remove_from_cart` by
 * line_id, `set_line_addons` which scopes to an in-cart sku via `cart.findIndex`) are
 * implicitly grounded: a `line_id` / in-cart `sku` can only enter the snapshot via a
 * prior successful `add_to_cart` that itself ran this guard.
 *
 * On refusal we return `{ ok: false, error: "sku_not_grounded", observation: "sku_not_grounded: ..." }`.
 * The `sku_not_grounded:` prefix on the observation is intentional: `persistTurnTrace`
 * (in `trace.ts`) extracts `errorCode` from `observation.split(":")[0]`, so prefixing
 * matches the contract that every refusal lands in `AgentTrace` with
 * `errorCode = "sku_not_grounded"`.
 *
 * TODO(task 10.2): once `recordOverride` lands in `trace.ts`, route this refusal
 * through it directly with `kind: "anti_hallucination"` and drop the colon-prefix
 * trick — the observation can then be plain customer/operator-facing text and the
 * errorCode will be set explicitly on the override row.
 */
function assertSkuGrounded(
  sku: string,
  snapshot: AgentSnapshot,
  toolName: string,
): { ok: true } | { ok: false; observation: string } {
  if (isSkuGrounded(snapshot, sku)) return { ok: true };
  return {
    ok: false,
    observation:
      `sku_not_grounded: Cannot ${toolName} sku=${sku}: it has not been shown to the customer ` +
      `in this conversation. Call search_catalog or resolve_product_name first.`,
  };
}

export const cartTools: ToolDef[] = [
  {
    name: "add_to_cart",
    description:
      "Add a product line to the customer's cart. The sku MUST come from a previous search_catalog or get_product_details result this conversation. Re-verifies stock & active status before adding.",
    paramsSchema: AddArgs,
    paramsHint: '{ "sku": string, "quantity"?: int(1-20), "size"?: string }',
    examples: [
      {
        when: "After search returned [SKU-9] Argentina Home Kit, customer says 'M size ekta nibo'",
        call: { tool: "add_to_cart", args: { sku: "SKU-9", quantity: 1, size: "M" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = AddArgs.parse(rawArgs);
      // Anti-hallucination guard (Reqs 6.4, 10.1, 10.5): refuse BEFORE the Prisma lookup
      // when the supplied sku has never been shown to the customer this conversation.
      // See `assertSkuGrounded` JSDoc for the full invariant.
      const grounded = assertSkuGrounded(args.sku, ctx.snapshot, "add_to_cart");
      if (!grounded.ok) {
        return { ok: false, error: "sku_not_grounded", observation: grounded.observation };
      }
      const row = await prisma.productMapping.findUnique({
        where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: args.sku } },
      });
      if (!row) {
        return { ok: false, error: "sku_not_found", observation: `Cannot add: sku=${args.sku} not in catalog.` };
      }
      const meta = asMeta(row.metadata);
      if (meta["isActive"] === false || meta["is_active"] === false) {
        return { ok: false, error: "sku_inactive", observation: `Cannot add: sku=${args.sku} is inactive.` };
      }
      const stock = coerceNumber(meta["stock"]);
      // Per-size stock takes precedence when the customer specified a size and the catalog
      // has variant-level data — otherwise fall back to aggregate stock.
      const sizeStock = args.size ? sizeStockFromMeta(meta, args.size) : undefined;
      const effectiveStock = sizeStock ?? stock;
      if (effectiveStock != null && effectiveStock < args.quantity) {
        return {
          ok: false,
          error: "insufficient_stock",
          observation:
            `Cannot add: sku=${args.sku}${args.size ? ` size=${args.size}` : ""} stock=${effectiveStock}, ` +
            `requested_qty=${args.quantity}. Tell the customer this size/qty isn't available.`,
        };
      }
      const unitPriceBdt = coerceNumber(meta["price"] ?? meta["unitPriceBdt"]);
      const product = row.facebookLabel ?? String(meta["name"] ?? row.clientSku);

      // Resolve add-ons against this product (per-product opt-in + overrides). Reject unknowns.
      let resolvedAddOns: Array<{ id: string; label: string; priceBdt: number }> = [];
      if (args.addOnIds && args.addOnIds.length > 0) {
        const tenant = await prisma.tenant
          .findUnique({ where: { id: ctx.input.tenantId }, select: { settings: true } })
          .catch(() => null);
        const settings = parseTenantSettings(tenant?.settings);
        const allowed = resolveProductAddons({ productMetadata: row.metadata, tenantSettings: settings });
        const allowedById = new Map(allowed.map((a) => [a.id, a] as const));
        // Same alias resolution as set_line_addons — tolerate canonical names ("name-number")
        // even when the tenant's actual id is an auto-generated slug like "addon-mowxbj8d-c93q".
        function resolveAlias(idOrAlias: string): typeof allowed[number] | null {
          const direct = allowedById.get(idOrAlias);
          if (direct) return direct;
          const needle = idOrAlias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (!needle) return null;
          const wantsNameNumber = /\bname\s*number\b|\bnam\s*number\b/.test(needle);
          const wantsOfficialFont = /\bofficial\s*font\b|\bpremium\s*font\b/.test(needle);
          const wantsPatch = /\bpatch(?:es)?\b/.test(needle);
          for (const a of allowed) {
            const blob = `${a.label} ${(a.aliases ?? []).join(" ")}`.toLowerCase();
            if (wantsNameNumber && /\b(name\s*\+?\s*number|nam\s*\+?\s*number|name\s*number|nam\s*number)\b/.test(blob))
              return a;
            if (wantsOfficialFont && /\b(official\s*font|premium\s*font)\b/.test(blob)) return a;
            if (wantsPatch && /\bpatch/.test(blob)) return a;
            const tokens = needle.split(/\s+/).filter((t) => t.length >= 3);
            if (tokens.length > 0 && tokens.every((t) => blob.includes(t))) return a;
          }
          return null;
        }
        const rejected: string[] = [];
        for (const id of args.addOnIds) {
          const def = resolveAlias(id);
          if (!def) {
            rejected.push(id);
            continue;
          }
          resolvedAddOns.push({ id: def.id, label: def.label, priceBdt: def.priceBdt });
        }
        if (rejected.length > 0) {
          return {
            ok: false,
            error: "addon_not_allowed",
            observation:
              `Add-on(s) not available for sku=${args.sku}: ${rejected.join(", ")}. ` +
              `Allowed: ${allowed.map((a) => a.id).join(", ") || "(none)"}. Use list_addons to check.`,
          };
        }
      }

      const next = ctx.snapshot.cart.slice();
      const existingIdx = next.findIndex(
        (c) => c.sku === args.sku && (c.size ?? "") === (args.size ?? ""),
      );
      let mutatedLineId: string;
      if (existingIdx >= 0) {
        const cur = next[existingIdx]!;
        next[existingIdx] = { ...cur, quantity: Math.min(20, cur.quantity + args.quantity) };
        mutatedLineId = cur.line_id;
      } else {
        const newLineId = crypto.randomUUID();
        const item: AgentCartItem = {
          line_id: newLineId,
          sku: args.sku,
          product,
          quantity: args.quantity,
        };
        if (args.size) item.size = args.size;
        if (unitPriceBdt != null) item.unitPriceBdt = unitPriceBdt;
        if (resolvedAddOns.length > 0) item.addOns = resolvedAddOns;
        next.push(item);
        mutatedLineId = newLineId;
      }
      // Recompute per-line missing slots BEFORE persisting, so the snapshot we save
      // already reflects what's still needed for this line (Req §8.1, §8.6).
      const withSlots = syncLineSlots({ ...ctx.snapshot, cart: next }, mutatedLineId, meta);
      // Refresh structured-cart totals (subtotal, line_total, order-level slots) so
      // downstream readers see the up-to-date projection without recomputing (Req §2.3, §2.5).
      const withTotals = recomputeStructuredCart(withSlots);
      await ctx.saveSnapshot(withTotals);

      // Bridge to legacy: write `lastCatalogSku` into the conversation draft so if a later
      // turn falls through to legacy handlers (image-only screenshots etc.) they see the
      // SKU the agent actually chose, not a stale one.
      try {
        const convo = await prisma.messengerConversation.findUnique({
          where: { id: ctx.input.conversationId },
          select: { pendingDraftJson: true },
        });
        const prev =
          convo?.pendingDraftJson && typeof convo.pendingDraftJson === "object" && !Array.isArray(convo.pendingDraftJson)
            ? (convo.pendingDraftJson as Record<string, unknown>)
            : {};
        await prisma.messengerConversation.update({
          where: { id: ctx.input.conversationId },
          data: {
            pendingDraftJson: {
              ...prev,
              lastCatalogSku: args.sku,
              catalogOptionSkus: [],
              updatedAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
      } catch {
        // Best-effort — never fail an add_to_cart over snapshot bookkeeping.
      }

      // Behavioural signals: bump lead score. Abandoned-cart follow-up scheduling moved
      // out of the cart tool — it's now driven by the FSM at end of turn (task 9.3) via
      // `reconcileAbandonedCartFollowUp` in `loop.ts` so the schedule/cancel decision lives
      // in one place. We still bump the lead score here because that's a per-add behavioural
      // signal, not an end-of-turn FSM decision.
      await bumpLeadScore(ctx.input.tenantId, ctx.input.psid, 5);

      return {
        ok: true,
        observation:
          `Added ${args.quantity} x ${product}${args.size ? ` (${args.size})` : ""} to cart ` +
          `(line_id=${mutatedLineId}). Cart now:\n${fmtCart(next)}`,
      };
    },
  },
  {
    name: "remove_from_cart",
    description:
      "Remove a line from the cart. Prefer `line_id` (stable per-line key) when the cart has duplicate skus that differ only in size or add-ons; `sku` is accepted for back-compat.",
    paramsSchema: RemoveArgs,
    paramsHint: '{ "sku"?: string, "line_id"?: string }',
    handler: async (rawArgs, ctx) => {
      const args = RemoveArgs.parse(rawArgs);
      const target = args.line_id
        ? ctx.snapshot.cart.find((c) => c.line_id === args.line_id)
        : ctx.snapshot.cart.find((c) => c.sku === args.sku);
      if (!target) {
        const tag = args.line_id ? `line_id=${args.line_id}` : `sku=${args.sku}`;
        return { ok: false, error: "not_in_cart", observation: `${tag} not in cart.` };
      }
      const removedLineId = target.line_id;
      const next = ctx.snapshot.cart.filter((c) => c.line_id !== removedLineId);
      // Sync slots: line removal drops both its missing rows and its confirmed entry.
      // No metadata lookup needed — `syncLineSlots` short-circuits when the line is gone.
      const withSlots = syncLineSlots({ ...ctx.snapshot, cart: next }, removedLineId, undefined);
      // Refresh structured-cart totals so subtotal reflects the removed line (Req §2.3).
      const withTotals = recomputeStructuredCart(withSlots);
      await ctx.saveSnapshot(withTotals);
      return {
        ok: true,
        observation: `Removed ${target.product} [sku=${target.sku}]. Cart now:\n${fmtCart(next)}`,
      };
    },
  },
  {
    name: "modify_cart_item",
    description:
      "Update one cart line addressed by its stable `line_id`. Pass any subset of `quantity`, `size`, `unitPriceBdt` — fields you don't pass keep their prior values on that line. Refuses on unknown line_id.",
    paramsSchema: ModifyArgs,
    paramsHint: '{ "line_id": string, "quantity"?: int(1-20), "size"?: string, "unitPriceBdt"?: number }',
    examples: [
      {
        when: "Customer says 'second item M size kore dao' on the second cart line",
        call: { tool: "modify_cart_item", args: { line_id: "line-uuid-2", size: "M" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = ModifyArgs.parse(rawArgs);
      const idx = ctx.snapshot.cart.findIndex((c) => c.line_id === args.line_id);
      if (idx < 0) {
        return {
          ok: false,
          error: "line_not_found",
          observation: `line_id=${args.line_id} not in cart.`,
        };
      }
      const cur = ctx.snapshot.cart[idx]!;

      // Compute the post-update slot values BEFORE persisting so we can re-verify stock against
      // the EFFECTIVE size/quantity (not just the args). Fields the caller omitted keep their
      // prior values (Req 3.5).
      const effectiveQty = args.quantity ?? cur.quantity;
      const effectiveSize = args.size !== undefined ? args.size : cur.size;

      // Look up the catalog row once: needed both for stock re-verification and for the
      // downstream syncLineSlots call that decides whether `size` is still a required slot.
      const row = await prisma.productMapping
        .findUnique({
          where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: cur.sku } },
        })
        .catch(() => null);
      const meta = asMeta(row?.metadata);

      // Re-verify stock when size or quantity changed (Req 3.5). Use the SAME per-size stock
      // logic as add_to_cart so behaviour is consistent: per-size stock takes precedence when
      // the line has a size and the catalog has variant-level data, else fall back to aggregate.
      const sizeOrQtyChanged = args.size !== undefined || args.quantity !== undefined;
      if (sizeOrQtyChanged) {
        if (meta["isActive"] === false || meta["is_active"] === false) {
          return {
            ok: false,
            error: "sku_inactive",
            observation: `Cannot modify: sku=${cur.sku} is inactive.`,
          };
        }
        const aggregateStock = coerceNumber(meta["stock"]);
        const sizeStock = effectiveSize ? sizeStockFromMeta(meta, effectiveSize) : undefined;
        const effectiveStock = sizeStock ?? aggregateStock;
        if (effectiveStock != null && effectiveStock < effectiveQty) {
          return {
            ok: false,
            error: "insufficient_stock",
            observation:
              `Cannot modify: sku=${cur.sku}${effectiveSize ? ` size=${effectiveSize}` : ""} ` +
              `stock=${effectiveStock}, requested_qty=${effectiveQty}. Tell the customer this size/qty isn't available.`,
          };
        }
      }

      const updated: AgentCartItem = { ...cur };
      if (args.quantity !== undefined) updated.quantity = args.quantity;
      if (args.size !== undefined) updated.size = args.size;
      if (args.unitPriceBdt !== undefined) updated.unitPriceBdt = args.unitPriceBdt;
      const next = ctx.snapshot.cart.slice();
      next[idx] = updated;

      const next2: AgentSnapshot = syncLineSlots({ ...ctx.snapshot, cart: next }, args.line_id, meta);
      // Refresh structured-cart totals after the modification so subtotal/line_total
      // reflect the new size/quantity/price on the targeted line (Req §2.3).
      const withTotals = recomputeStructuredCart(next2);
      await ctx.saveSnapshot(withTotals);
      return {
        ok: true,
        observation: `Modified line ${args.line_id} (${cur.product}). Cart now:\n${fmtCart(next)}`,
      };
    },
  },
  {
    name: "show_cart",
    description:
      "Read the current cart with running totals (subtotal, line totals, add-ons) and a preview of the advance amount that confirm_order would charge. Use before composing a confirmation reply or when the customer asks 'cart koi', 'total koto', 'kemon dam holo'.",
    paramsSchema: ShowArgs,
    paramsHint: "{}",
    handler: async (_rawArgs, ctx) => {
      // Prefer the persisted structured-cart projection (Req §2.5) — every cart-mutating
      // tool calls `recomputeStructuredCart` before saving, so this is the authoritative
      // source of `subtotal` / `line_total` for the current cart. Fall back to recomputing
      // on the fly when the snapshot pre-dates this field (legacy `pendingDraftJson` blobs).
      const structured = ctx.snapshot.structured_cart ?? recomputeStructuredCart(ctx.snapshot).structured_cart!;
      const cart = structured.items;
      if (cart.length === 0) {
        return { ok: true, observation: "Cart: (empty)" };
      }
      const subtotal = structured.subtotal;
      const lines = cart.map((c, i) => {
        const unit = c.unitPriceBdt ?? 0;
        const lineTotal = c.line_total ?? 0;
        const head = `${i + 1}. ${c.product} [sku=${c.sku}]${c.size ? ` size=${c.size}` : ""} x${c.quantity} @ ${unit} BDT`;
        if (!c.addOns || c.addOns.length === 0) return `${head}  =  ${lineTotal} BDT`;
        const ao = c.addOns
          .map(
            (a) =>
              `${a.label}${a.priceBdt === 0 ? " (FREE)" : ` +${a.priceBdt} BDT`}${a.value ? ` "${a.value}"` : ""}`,
          )
          .join(", ");
        return `${head}\n     add-ons: ${ao}  →  line total ${lineTotal} BDT`;
      });

      const tenant = await prisma.tenant
        .findUnique({ where: { id: ctx.input.tenantId }, select: { settings: true } })
        .catch(() => null);
      const settings = parseTenantSettings(tenant?.settings);
      const advance = computeAdvanceForCart({
        tenantSettings: settings,
        cart: cart.map((c) => ({ quantity: c.quantity, addOns: c.addOns })),
      });
      // Prefer the captured delivery charge on the structured cart (set once the address
      // is known); fall back to the tenant default for a preview. `null` for "not set yet".
      const delivery =
        structured.delivery_info?.delivery_charge_bdt ??
        (typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : null);
      const grandTotal = subtotal + (delivery ?? 0);

      const advanceLines: string[] = [];
      if (advance.totalBdt > 0) {
        advanceLines.push(`Advance to pay now: ${advance.totalBdt} BDT (${advance.policyDescription})`);
        for (const b of advance.breakdown) {
          const label =
            b.kind === "plain"
              ? "per plain product"
              : b.kind === "customised"
                ? "per customised product"
                : "fixed";
          advanceLines.push(`  • ${label}: ${b.unitBdt} × ${b.qty} = ${b.subtotalBdt} BDT`);
        }
      }

      return {
        ok: true,
        observation: [
          `Cart:`,
          ...lines,
          `— subtotal=${subtotal} BDT${delivery != null ? `, delivery=${delivery} BDT` : ""}, grand_total=${grandTotal} BDT`,
          ...advanceLines,
        ].join("\n"),
        data: {
          subtotal,
          deliveryCharge: delivery,
          grandTotal,
          advance: advance,
          items: cart.length,
        },
      };
    },
  },
];
