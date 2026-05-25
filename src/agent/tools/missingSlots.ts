/**
 * Per-line missing-slot tracking helpers (task 2.2).
 *
 * After every cart mutation (`add_to_cart`, `modify_cart_item`, `remove_from_cart`,
 * `set_line_addons`) the agent recomputes the per-line slots that are still missing
 * and mirrors them into `snapshot.missing_information` keyed by `line_id`. When a
 * slot becomes filled (size captured by add/modify, value captured by set_line_addons),
 * it moves into `snapshot.confirmed_information[line_id][slot] = value` in the same turn.
 *
 * Requirements: §8.1 (track missing slots), §8.2 (move to confirmed once filled),
 * §8.4 (don't ask again for confirmed slots), §8.6 (key per line_id).
 *
 * Defensive contract: only ever touches rows belonging to the affected `line_id`. Order-
 * level rows (rows without `line_id`) and slots belonging to OTHER lines are preserved
 * verbatim. The `attempts` counter on existing rows is preserved when the same slot key
 * stays missing across mutations — this keeps the Anti-Loop Guard (task 5.3) honest.
 */

import type { AgentCartAddOn, AgentCartItem, AgentMissingInfoSlot, AgentSnapshot } from "../types.js";

/**
 * Did the catalog row carry per-size variant data? We treat any non-empty
 * `sizeStocks` map / `stockBySize` map / `variants[]` array as "this SKU has variants",
 * which means a missing `size` slot needs to be tracked when the customer hasn't picked one.
 *
 * Mirrors the readers in `inventoryHelpers.ts` so cart.ts and check_inventory stay aligned.
 */
export function skuHasVariants(meta: Record<string, unknown> | undefined | null): boolean {
  if (!meta) return false;
  for (const key of ["sizeStocks", "size_stocks", "stockBySize", "stock_by_size"]) {
    const map = meta[key];
    if (
      map &&
      typeof map === "object" &&
      !Array.isArray(map) &&
      Object.keys(map as Record<string, unknown>).length > 0
    ) {
      return true;
    }
  }
  const variants = meta["variants"];
  if (Array.isArray(variants) && variants.length > 0) return true;
  return false;
}

/**
 * Returns true when an attached add-on requires a customer-supplied `value` (e.g.
 * "name + number" → "Limon 10"). We use a label/alias keyword heuristic rather than a
 * tenant-side boolean because tenant settings don't carry an explicit `requiresValue`
 * flag yet (see `src/types/tenant-settings.ts` addOns schema).
 *
 * Matches: `name`, `number`, `text`, `custom` anywhere in id/label/aliases.
 */
export function addonRequiresValue(addon: Pick<AgentCartAddOn, "id" | "label"> & { aliases?: string[] }): boolean {
  const blob = `${addon.id} ${addon.label} ${(addon.aliases ?? []).join(" ")}`.toLowerCase();
  return /\b(name|number|text|custom)\b/.test(blob);
}

/**
 * Given a single cart line and its product metadata, return the list of slot keys that
 * are CURRENTLY missing on the line. `quantity` is intentionally excluded — every line
 * always has a quantity (defaults to 1 in `add_to_cart`), so it's an implicit slot per
 * the task spec ("quantity always implicit, do not list").
 *
 * Slot keys returned:
 *   - `"size"`            — when `line.size` is unset AND the SKU has variants per metadata
 *   - the addon's `id`    — for any attached add-on that requires a value but has none
 */
export function computeMissingSlotsForLine(
  line: AgentCartItem,
  productMeta: Record<string, unknown> | undefined | null,
): string[] {
  const slots: string[] = [];
  if (!line.size && skuHasVariants(productMeta ?? undefined)) {
    slots.push("size");
  }
  if (line.addOns) {
    for (const ao of line.addOns) {
      if (!ao.value && addonRequiresValue(ao)) {
        slots.push(ao.id);
      }
    }
  }
  return slots;
}

/**
 * Read the current value of a slot off the cart line, or undefined when the slot has
 * no captured value. Used to ferry the resolved value into `confirmed_information`.
 */
function readSlotValueFromLine(line: AgentCartItem, slot: string): unknown {
  if (slot === "size") return line.size;
  // Add-on slots: id matches one of the line's add-ons.
  const ao = line.addOns?.find((a) => a.id === slot);
  if (ao) return ao.value;
  return undefined;
}

/**
 * Update `snapshot.missing_information` and `snapshot.confirmed_information` to reflect
 * the current state of ONE cart line. Other lines' rows are preserved verbatim.
 *
 * Handles three cases for the targeted line_id:
 *
 * 1. Line is no longer in the cart (removed) → drop every per-line slot row that belongs
 *    to it from `missing_information`, AND drop its key from `confirmed_information`. Other
 *    lines' confirmed/missing rows are untouched.
 * 2. Line exists with newly missing slots → append them with `attempts: 0`. If a row for
 *    the same `(line_id, slot)` existed already, its `attempts` counter is preserved (this
 *    keeps the Anti-Loop Guard counters honest across mutation cycles).
 * 3. Line exists with newly filled slots → drop their rows from `missing_information` and
 *    write the captured value into `confirmed_information[line_id][slot]`. Dropping the
 *    row IS the Anti-Loop Guard's reset signal (task 5.3 / Req 8.5): the next time the
 *    same slot becomes missing, a FRESH row with `attempts: 0` is created above. This is
 *    deliberate — the loop's verifyPreResponse stage looks up `attempts` on the live
 *    row and never on a stale value, so removing the row is functionally equivalent to
 *    "reset attempts to 0 once the slot moves to confirmed_information".
 *
 * Order-level rows (rows where `line_id` is undefined) are NEVER touched here.
 *
 * @param snapshot snapshot AFTER the cart mutation (caller has already updated `cart`)
 * @param lineId the line_id of the line that was added/modified/removed
 * @param productMeta metadata of the line's SKU (used to decide whether `size` is required);
 *                    pass `undefined` when the line was removed (no metadata needed)
 */
export function syncLineSlots(
  snapshot: AgentSnapshot,
  lineId: string,
  productMeta: Record<string, unknown> | undefined | null,
): AgentSnapshot {
  const line = snapshot.cart.find((c) => c.line_id === lineId);

  // Case 1: line was removed. Drop its rows entirely.
  if (!line) {
    const nextMissing = snapshot.missing_information.filter((r) => r.line_id !== lineId);
    const nextConfirmed = { ...snapshot.confirmed_information };
    if (lineId in nextConfirmed) delete nextConfirmed[lineId];
    return { ...snapshot, missing_information: nextMissing, confirmed_information: nextConfirmed };
  }

  // Case 2/3: line still present. Recompute its missing slots; preserve attempts counters.
  const desired = new Set<string>(computeMissingSlotsForLine(line, productMeta));

  const otherLineRows = snapshot.missing_information.filter((r) => r.line_id !== lineId);
  const thisLineExisting = snapshot.missing_information.filter((r) => r.line_id === lineId);

  const thisLineNext: AgentMissingInfoSlot[] = [];
  const matchedExistingSlots = new Set<string>();
  // Preserve every existing row whose slot is still missing, keeping its `attempts`.
  for (const row of thisLineExisting) {
    if (desired.has(row.slot)) {
      thisLineNext.push(row);
      matchedExistingSlots.add(row.slot);
    }
  }
  // Append new missing slots that didn't have an existing row.
  for (const slot of desired) {
    if (!matchedExistingSlots.has(slot)) {
      thisLineNext.push({ line_id: lineId, slot, attempts: 0 });
    }
  }

  // Defensive copy of confirmed_information: only mutate the entry for THIS line_id.
  const nextConfirmed: AgentSnapshot["confirmed_information"] = { ...snapshot.confirmed_information };
  const lineConfirmed: Record<string, unknown> = { ...(nextConfirmed[lineId] ?? {}) };

  // Slots that WERE missing for this line and are NOT missing anymore → captured value moves
  // into confirmed_information.
  const stillMissing = new Set(thisLineNext.map((r) => r.slot));
  for (const prev of thisLineExisting) {
    if (stillMissing.has(prev.slot)) continue;
    const v = readSlotValueFromLine(line, prev.slot);
    if (v !== undefined && v !== null && v !== "") {
      lineConfirmed[prev.slot] = v;
    }
  }
  // Also capture slots filled at FIRST sight (e.g. size supplied to add_to_cart on a
  // variant SKU — there was no "missing" row to clear, but we still want the value
  // recorded as confirmed).
  if (line.size && skuHasVariants(productMeta ?? undefined)) {
    lineConfirmed["size"] = line.size;
  }
  if (line.addOns) {
    for (const ao of line.addOns) {
      if (ao.value && addonRequiresValue(ao)) {
        lineConfirmed[ao.id] = ao.value;
      }
    }
  }

  if (Object.keys(lineConfirmed).length > 0) {
    nextConfirmed[lineId] = lineConfirmed;
  } else if (lineId in nextConfirmed) {
    // Nothing to confirm and we had no prior entry — leave as-is.
    // (We never DELETE here unless the line was removed, which is case 1 above.)
  }

  return {
    ...snapshot,
    missing_information: [...otherLineRows, ...thisLineNext],
    confirmed_information: nextConfirmed,
  };
}
