import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import type {
  AgentCartItem,
  AgentCustomerProfile,
  AgentDeliveryInfo,
  AgentMissingInfoSlot,
  AgentRecentReference,
  AgentSnapshot,
  AgentStructuredCart,
} from "./types.js";

const MAX_CART_ITEMS = 30;
const MAX_SHOWN_SKUS = 12;
const MAX_RECENT_REFERENCES = 5;

/**
 * The 9 OrderFSM states required by the spec (Requirements §7).
 *
 * Defined here as a string-literal union to keep task 1.1 self-contained: this lets
 * `AgentSnapshot.order_state` type-check today without dragging in the full FSM machinery,
 * which task 1.2 will layer on top by adding `ALLOWED_TRANSITIONS`, `canTransition`, and
 * `nextSuggestedState` exports against this same union.
 */
export type OrderFSMState =
  | "BROWSING"
  | "PRODUCT_SELECTION"
  | "CART_BUILDING"
  | "MISSING_INFO_COLLECTION"
  | "ADDRESS_COLLECTION"
  | "PAYMENT_SELECTION"
  | "ORDER_REVIEW"
  | "FINAL_CONFIRMATION"
  | "ORDER_COMPLETE";

const ORDER_FSM_STATES: ReadonlySet<OrderFSMState> = new Set<OrderFSMState>([
  "BROWSING",
  "PRODUCT_SELECTION",
  "CART_BUILDING",
  "MISSING_INFO_COLLECTION",
  "ADDRESS_COLLECTION",
  "PAYMENT_SELECTION",
  "ORDER_REVIEW",
  "FINAL_CONFIRMATION",
  "ORDER_COMPLETE",
]);

/**
 * Confidence-score band thresholds (Requirements §11.3, §11.4, §11.5).
 *
 * Callers compute `Confidence_Score` values in the 0.0–1.0 range for product match,
 * intent detection, and order completeness, then compare against these bands:
 *
 * - `high` (0.8): minimum score required to commit any cart mutation, to confirm a
 *   reference resolution, or to advance from `FINAL_CONFIRMATION` to `ORDER_COMPLETE`.
 *   Below this at `FINAL_CONFIRMATION`, the loop rolls the FSM back to `ORDER_REVIEW`
 *   per Req 11.5.
 * - `medium` (0.55): below this on any of the three scores, the agent triggers the
 *   clarification flow (Req 11.4) instead of mutating cart or order state.
 * - `low` (0.3): below this is treated as an escalation signal — the agent stops
 *   guessing and falls back to a human-readable clarification or hands off.
 *
 * Consumed by tasks 5.3 (loop confidence gating), 6.4 (Reference_Resolution tie-break),
 * and 9.3 (clarification trigger). Exported so tests can pin the boundary values.
 */
export const CONFIDENCE_THRESHOLDS = {
  high: 0.8,
  medium: 0.55,
  low: 0.3,
} as const;

/**
 * Idle window after which a conversation with a non-empty cart is considered
 * abandoned and SHOULD have a `FollowUp` row scheduled for re-engagement
 * (Requirements §13.3).
 *
 * 24 hours, expressed in milliseconds so callers can compare directly against
 * `Date.now() - lastActivityTs`. Consumed by task 9.3 (abandoned-cart scheduler).
 */
export const ABANDONED_CART_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Anti-Loop Guard cap on how many times the agent may ask the same slot question
 * within one conversation before falling back to clarification or human handoff
 * (Requirements §8.5, §12.6).
 *
 * The guard increments `missing_information[i].attempts` per question per slot per
 * conversation; on the third attempt (i.e. once `attempts >= MAX_SLOT_ATTEMPTS`)
 * the loop escalates to the clarification fallback instead of repeating the
 * question. Consumed by tasks 5.3 (loop guard) and 12.6 (error-recovery fallback).
 */
export const MAX_SLOT_ATTEMPTS = 2;

function asObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function readCart(raw: unknown): AgentCartItem[] {
  const draft = asObject(raw);
  const items = draft["cartItems"];
  if (!Array.isArray(items)) return [];
  const out: AgentCartItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const r = it as Record<string, unknown>;
    const sku = String(r["sku"] ?? "").trim();
    const product = String(r["product"] ?? "").trim();
    const q = Number(r["quantity"] ?? 1);
    if (!sku || !product || !Number.isFinite(q) || q <= 0) continue;
    const priceRaw = r["unitPriceBdt"];
    // Mint a stable line_id for any legacy line that lacks one (Req 3.3, 3.4).
    // Persisting back to pendingDraftJson happens on the next saveSnapshot, so once a
    // conversation has been read it carries stable ids on every subsequent turn.
    const lineIdRaw = r["line_id"];
    const lineId =
      typeof lineIdRaw === "string" && lineIdRaw.trim().length > 0
        ? lineIdRaw.trim()
        : crypto.randomUUID();
    const item: AgentCartItem = {
      sku,
      product,
      quantity: q,
      line_id: lineId,
      size: String(r["size"] ?? "").trim() || undefined,
      unitPriceBdt: typeof priceRaw === "number" && Number.isFinite(priceRaw) ? priceRaw : undefined,
    };
    const ltRaw = r["line_total"];
    if (typeof ltRaw === "number" && Number.isFinite(ltRaw)) {
      item.line_total = ltRaw;
    }
    if (Array.isArray(r["addOns"])) {
      const addOns = (r["addOns"] as Array<unknown>)
        .map((a) => {
          if (!a || typeof a !== "object" || Array.isArray(a)) return null;
          const ar = a as Record<string, unknown>;
          const id = String(ar["id"] ?? "").trim();
          const label = String(ar["label"] ?? "").trim();
          const priceBdt = Number(ar["priceBdt"] ?? 0);
          if (!id || !label || !Number.isFinite(priceBdt) || priceBdt < 0) return null;
          const ao: AgentCartItem["addOns"] extends (infer T)[] | undefined ? T : never = {
            id,
            label,
            priceBdt,
          };
          const v = String(ar["value"] ?? "").trim();
          if (v) (ao as { value?: string }).value = v;
          return ao;
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
      if (addOns.length > 0) item.addOns = addOns;
    }
    out.push(item);
  }
  return out.slice(0, MAX_CART_ITEMS);
}

function readProfile(raw: unknown): AgentCustomerProfile {
  const draft = asObject(raw);
  const p = asObject(draft["customerProfile"]);
  const out: AgentCustomerProfile = {};
  const name = typeof p["name"] === "string" ? p["name"].trim() : "";
  const phone = typeof p["phone"] === "string" ? p["phone"].trim() : "";
  const address = typeof p["address"] === "string" ? p["address"].trim() : "";
  if (name) out.name = name;
  if (phone) out.phone = phone;
  if (address) out.address = address;
  return out;
}

function readShownSkus(raw: unknown): string[] {
  const draft = asObject(raw);
  const ag = asObject(draft["agent"]);
  const arr = ag["shownSkus"];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_SHOWN_SKUS);
}

function readLastShown(raw: unknown): Array<{ sku: string; label: string }> {
  const draft = asObject(raw);
  const ag = asObject(draft["agent"]);
  const arr = ag["lastShown"];
  if (!Array.isArray(arr)) return [];
  const out: Array<{ sku: string; label: string }> = [];
  for (const it of arr) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const r = it as Record<string, unknown>;
    const sku = String(r["sku"] ?? "").trim();
    const label = String(r["label"] ?? "").trim();
    if (sku) out.push({ sku, label: label || sku });
  }
  return out.slice(0, 10);
}

function readActiveGoal(rawAgent: Record<string, unknown>): string | null {
  const v = rawAgent["active_goal"];
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function readOrderState(rawAgent: Record<string, unknown>): OrderFSMState {
  const v = rawAgent["order_state"];
  if (typeof v === "string" && ORDER_FSM_STATES.has(v as OrderFSMState)) {
    return v as OrderFSMState;
  }
  return "BROWSING";
}

function readMissingInformation(rawAgent: Record<string, unknown>): AgentMissingInfoSlot[] {
  const arr = rawAgent["missing_information"];
  if (!Array.isArray(arr)) return [];
  const out: AgentMissingInfoSlot[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const r = it as Record<string, unknown>;
    const slot = String(r["slot"] ?? "").trim();
    if (!slot) continue;
    const attemptsRaw = Number(r["attempts"] ?? 0);
    const attempts = Number.isFinite(attemptsRaw) && attemptsRaw >= 0 ? Math.floor(attemptsRaw) : 0;
    const lineIdRaw = r["line_id"];
    const lineId = typeof lineIdRaw === "string" ? lineIdRaw.trim() : "";
    const slotRow: AgentMissingInfoSlot = { slot, attempts };
    if (lineId) slotRow.line_id = lineId;
    out.push(slotRow);
  }
  return out;
}

function readConfirmedInformation(
  rawAgent: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const obj = asObject(rawAgent["confirmed_information"]);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = { ...(value as Record<string, unknown>) };
    }
  }
  return out;
}

function readCustomerPreferences(rawAgent: Record<string, unknown>): Record<string, unknown> {
  const obj = asObject(rawAgent["customer_preferences"]);
  return { ...obj };
}

function readConversationSummary(rawAgent: Record<string, unknown>): string {
  const v = rawAgent["conversation_summary"];
  return typeof v === "string" ? v : "";
}

function readConfidenceLevel(rawAgent: Record<string, unknown>): number {
  const v = Number(rawAgent["confidence_level"]);
  if (!Number.isFinite(v)) return 1.0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function readFollowupNeeded(rawAgent: Record<string, unknown>): boolean {
  return rawAgent["followup_needed"] === true;
}

/**
 * Append a deterministic reference resolution to `snapshot.recent_references` and trim
 * FIFO-style to the most recent {@link MAX_RECENT_REFERENCES} (5) entries. Newest entry
 * is appended at the end of the array; once the array grows past 5, the OLDEST entries
 * (lowest indices) are dropped.
 *
 * Pure function — returns a NEW {@link AgentSnapshot} with a NEW `recent_references`
 * array. The input snapshot and its arrays are not mutated, so the loop can safely
 * compare old vs. new state when deciding whether to persist.
 *
 * Used by the loop's reference-resolution branch (task 4.3): when
 * `resolveReference` returns a result with `confidence_score >= CONFIDENCE_THRESHOLDS.high`,
 * the loop calls this helper, then `saveSnapshot` to persist the new snapshot. The
 * resolver itself stays pure and writes through an `onResolve` callback so the loop
 * remains the only writer (Requirements §9.6).
 *
 * @param snapshot - The current snapshot. Not mutated.
 * @param ref - The reference record to append. Caller should populate `ts` (ISO-8601
 *              timestamp) so ordering is deterministic across turns.
 * @returns A new snapshot whose `recent_references` array contains at most 5 entries,
 *          with `ref` as the newest (last) entry.
 */
export function appendRecentReference(
  snapshot: AgentSnapshot,
  ref: AgentRecentReference,
): AgentSnapshot {
  const next = [...snapshot.recent_references, ref];
  // FIFO trim: when length > 5, drop the oldest entries from the front so the newest
  // entry stays at the tail (matches the newest-last semantics used by readRecentReferences
  // and consumed by the router prompt in task 8.2).
  const trimmed =
    next.length > MAX_RECENT_REFERENCES ? next.slice(next.length - MAX_RECENT_REFERENCES) : next;
  return { ...snapshot, recent_references: trimmed };
}

function readRecentReferences(rawAgent: Record<string, unknown>): AgentRecentReference[] {
  const arr = rawAgent["recent_references"];
  if (!Array.isArray(arr)) return [];
  const out: AgentRecentReference[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const r = it as Record<string, unknown>;
    const phrase = String(r["phrase"] ?? "").trim();
    const targetId = String(r["target_id"] ?? "").trim();
    const targetKindRaw = String(r["target_kind"] ?? "").trim();
    const ts = String(r["ts"] ?? "").trim();
    if (!phrase || !targetId) continue;
    if (targetKindRaw !== "line" && targetKindRaw !== "product") continue;
    out.push({
      phrase,
      target_kind: targetKindRaw,
      target_id: targetId,
      ts: ts || new Date(0).toISOString(),
    });
  }
  return out.slice(-MAX_RECENT_REFERENCES);
}

/**
 * Compute a single line's total in BDT (Requirements §2.2, §2.3).
 *
 * Formula: `(unitPriceBdt + sum(addOns.priceBdt)) * quantity`. Values that aren't
 * finite numbers are coerced to 0 so a half-built line (e.g. unitPriceBdt missing
 * because the SKU's `price` field is null) still yields a numeric `line_total`
 * rather than `NaN`. Pure — does not mutate the input.
 */
export function computeLineTotal(line: AgentCartItem): number {
  const unit = Number.isFinite(line.unitPriceBdt as number) ? (line.unitPriceBdt as number) : 0;
  const addOnPerUnit = (line.addOns ?? []).reduce((s, a) => {
    const p = Number.isFinite(a.priceBdt) ? a.priceBdt : 0;
    return s + p;
  }, 0);
  const qty = Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
  return (unit + addOnPerUnit) * qty;
}

/**
 * Map an OrderFSM state to the coarse-grained `order_status` stamp persisted on the
 * structured cart (Req 2.1). Defaults to `"draft"` for in-flight cart-building states
 * so consumers always have a non-null status once a cart line exists; only fresh
 * `BROWSING` snapshots return `null`.
 */
function orderStatusFromFsm(state: OrderFSMState): AgentStructuredCart["order_status"] {
  switch (state) {
    case "BROWSING":
      return null;
    case "PRODUCT_SELECTION":
    case "CART_BUILDING":
    case "MISSING_INFO_COLLECTION":
    case "ADDRESS_COLLECTION":
    case "PAYMENT_SELECTION":
      return "draft";
    case "ORDER_REVIEW":
      return "review";
    case "FINAL_CONFIRMATION":
      return "confirmed";
    case "ORDER_COMPLETE":
      return "completed";
    default:
      return null;
  }
}

/**
 * Pull the order-level `delivery_info` slot out of `confirmed_information.order` if it
 * was already captured. Returns `null` when nothing is recorded (matches the structured
 * cart contract: `null` = "not yet collected").
 *
 * Reads from two sources, preferring the order-level confirmed bag (the canonical home
 * for slot-filled order data) and falling back to the customer profile's `address` field
 * which `collect_customer_field` writes for cross-conversation memory.
 */
function readDeliveryInfo(snapshot: AgentSnapshot): AgentDeliveryInfo | null {
  const order = snapshot.confirmed_information["order"];
  const orderObj = order && typeof order === "object" ? (order as Record<string, unknown>) : null;
  const confirmedAddress =
    orderObj && typeof orderObj["delivery_address"] === "string"
      ? (orderObj["delivery_address"] as string).trim()
      : "";
  const confirmedCharge =
    orderObj && typeof orderObj["delivery_charge_bdt"] === "number" && Number.isFinite(orderObj["delivery_charge_bdt"] as number)
      ? (orderObj["delivery_charge_bdt"] as number)
      : null;
  const profileAddress = (snapshot.profile.address ?? "").trim();
  const address = confirmedAddress || profileAddress;
  if (!address && confirmedCharge == null) return null;
  return {
    address: address || null,
    delivery_charge_bdt: confirmedCharge,
  };
}

/**
 * Pull the order-level `payment_method` from `confirmed_information.order`. Returns
 * `null` (not "" — the structured cart distinguishes "not yet collected" from any
 * possible truthy method label) when nothing is recorded.
 */
function readPaymentMethod(snapshot: AgentSnapshot): string | null {
  const order = snapshot.confirmed_information["order"];
  if (!order || typeof order !== "object") return null;
  const pm = (order as Record<string, unknown>)["payment_method"];
  if (typeof pm !== "string") return null;
  const trimmed = pm.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Refresh the snapshot's structured-cart projection (Requirements §2.1, §2.3, §2.5).
 *
 * Pure function. Returns a new snapshot whose `cart` carries an up-to-date `line_total`
 * on every line and whose `structured_cart` block is rebuilt from scratch with:
 *
 *   - `items`         = the post-mutation lines, each with a refreshed `line_total`.
 *   - `subtotal`      = `sum(items[].line_total)`.
 *   - `delivery_info` = `readDeliveryInfo(snapshot)` (address + computed charge or null).
 *   - `payment_method`= `readPaymentMethod(snapshot)` (string or null).
 *   - `order_status`  = `orderStatusFromFsm(snapshot.order_state)`.
 *
 * Called from every cart-mutating tool (`add_to_cart`, `remove_from_cart`,
 * `modify_cart_item`, `set_line_addons`, `confirm_order`-clear) BEFORE `saveSnapshot`,
 * so the persisted blob always carries totals that match the just-mutated cart. Readers
 * (e.g. `show_cart`, the router prompt) MUST prefer `snapshot.structured_cart` over
 * recomputing the totals from the loose `cart` array (Req 2.5).
 *
 * The function intentionally rebuilds `structured_cart` from scratch every call rather
 * than diffing — the math is cheap, and keeping it stateless removes a class of bugs
 * where stale totals leak across mutations.
 */
export function recomputeStructuredCart(snapshot: AgentSnapshot): AgentSnapshot {
  const items: AgentCartItem[] = snapshot.cart.map((line) => {
    const total = computeLineTotal(line);
    // Preserve insertion order; only stamp `line_total`.
    return { ...line, line_total: total };
  });
  const subtotal = items.reduce((s, l) => s + (Number.isFinite(l.line_total as number) ? (l.line_total as number) : 0), 0);
  const structured: AgentStructuredCart = {
    items,
    subtotal,
    delivery_info: readDeliveryInfo(snapshot),
    payment_method: readPaymentMethod(snapshot),
    order_status: orderStatusFromFsm(snapshot.order_state),
  };
  return { ...snapshot, cart: items, structured_cart: structured };
}

function readStructuredCart(
  rawAgent: Record<string, unknown>,
  cart: AgentCartItem[],
  fallback: AgentSnapshot,
): AgentStructuredCart | undefined {
  const obj = rawAgent["structured_cart"];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const r = obj as Record<string, unknown>;
  const subtotalRaw = Number(r["subtotal"]);
  const subtotal = Number.isFinite(subtotalRaw) ? subtotalRaw : 0;
  const orderStatus = (() => {
    const v = r["order_status"];
    if (v === "draft" || v === "review" || v === "confirmed" || v === "completed") return v;
    return null;
  })();
  const paymentMethod = (() => {
    const v = r["payment_method"];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  })();
  const deliveryInfo: AgentDeliveryInfo | null = (() => {
    const di = r["delivery_info"];
    if (!di || typeof di !== "object" || Array.isArray(di)) return null;
    const dr = di as Record<string, unknown>;
    const addr = typeof dr["address"] === "string" ? (dr["address"] as string).trim() : "";
    const chgRaw = dr["delivery_charge_bdt"];
    const chg = typeof chgRaw === "number" && Number.isFinite(chgRaw) ? chgRaw : null;
    if (!addr && chg == null) return null;
    return { address: addr || null, delivery_charge_bdt: chg };
  })();
  // The cart array on the structured object is authoritative for `line_total`, but
  // we re-derive `items` from the just-loaded `cart` (which carries any line_total
  // already roundtripped from the legacy `cartItems` reader) so the structured
  // block and the loose array stay in lockstep.
  return {
    items: cart,
    subtotal,
    delivery_info: deliveryInfo,
    payment_method: paymentMethod,
    order_status: orderStatus,
  };
  // (`fallback` is reserved for future use when we want to recompute on the fly
  // here — keeping the parameter so callers can pass the rest of the snapshot.)
  void fallback;
}

/**
 * Build an `AgentSnapshot` from an arbitrary `pendingDraftJson` blob using the same
 * defensive readers `loadSnapshot` uses. Pure: never touches Prisma. Useful for tests
 * and for reading snapshots out of cached payloads.
 */
export function parseSnapshot(raw: unknown): AgentSnapshot {
  const root = asObject(raw);
  const ag = asObject(root["agent"]);
  const partial: AgentSnapshot = {
    cart: readCart(raw),
    profile: readProfile(raw),
    shownSkus: readShownSkus(raw),
    lastShown: readLastShown(raw),
    active_goal: readActiveGoal(ag),
    order_state: readOrderState(ag),
    missing_information: readMissingInformation(ag),
    confirmed_information: readConfirmedInformation(ag),
    customer_preferences: readCustomerPreferences(ag),
    conversation_summary: readConversationSummary(ag),
    confidence_level: readConfidenceLevel(ag),
    followup_needed: readFollowupNeeded(ag),
    recent_references: readRecentReferences(ag),
  };
  // Hydrate structured_cart preferentially from the persisted blob so a fresh load
  // can render show_cart without re-running the recompute pipeline. When it's
  // missing (legacy snapshots) the loose `cart` array remains the source of truth
  // — every cart-mutating tool calls `recomputeStructuredCart` before persisting,
  // so the next save will populate this field.
  const structured = readStructuredCart(ag, partial.cart, partial);
  if (structured) {
    return { ...partial, structured_cart: structured };
  }
  return partial;
}

function emptySnapshot(): AgentSnapshot {
  return {
    cart: [],
    profile: {},
    shownSkus: [],
    lastShown: [],
    active_goal: null,
    order_state: "BROWSING",
    missing_information: [],
    confirmed_information: {},
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
  };
}

export async function loadSnapshot(conversationId: string): Promise<AgentSnapshot> {
  if (!conversationId) return emptySnapshot();
  const convo = await prisma.messengerConversation
    .findUnique({ where: { id: conversationId }, select: { pendingDraftJson: true } })
    .catch(() => null);
  return parseSnapshot(convo?.pendingDraftJson);
}

export async function saveSnapshot(conversationId: string, snap: AgentSnapshot): Promise<void> {
  if (!conversationId) return;
  const convo = await prisma.messengerConversation
    .findUnique({ where: { id: conversationId }, select: { pendingDraftJson: true } })
    .catch(() => null);
  const prev = asObject(convo?.pendingDraftJson);
  const prevAgent = asObject(prev["agent"]);
  const prevProfile = asObject(prev["customerProfile"]);
  // Persist `line_total` per line so re-loads can render show_cart without recomputing.
  // The structured_cart projection (below) is the canonical source of truth, but mirroring
  // line_total onto cartItems keeps the legacy reader path honest as well.
  const cartItems = snap.cart.slice(0, MAX_CART_ITEMS).map((line) => {
    const out: Record<string, unknown> = {
      sku: line.sku,
      product: line.product,
      quantity: line.quantity,
      line_id: line.line_id,
    };
    if (line.size != null) out["size"] = line.size;
    if (line.unitPriceBdt != null) out["unitPriceBdt"] = line.unitPriceBdt;
    if (line.addOns && line.addOns.length > 0) out["addOns"] = line.addOns;
    if (typeof line.line_total === "number" && Number.isFinite(line.line_total)) {
      out["line_total"] = line.line_total;
    }
    return out;
  });
  const next: Record<string, unknown> = {
    ...prev,
    cartItems,
    customerProfile: {
      ...prevProfile,
      ...(snap.profile.name ? { name: snap.profile.name } : {}),
      ...(snap.profile.phone ? { phone: snap.profile.phone } : {}),
      ...(snap.profile.address ? { address: snap.profile.address } : {}),
    },
    agent: {
      ...prevAgent,
      shownSkus: snap.shownSkus.slice(0, MAX_SHOWN_SKUS),
      lastShown: Array.isArray(snap.lastShown) ? snap.lastShown.slice(0, 10) : [],
      active_goal: snap.active_goal ?? null,
      order_state: snap.order_state,
      missing_information: snap.missing_information.map((s) => ({
        ...(s.line_id ? { line_id: s.line_id } : {}),
        slot: s.slot,
        attempts: s.attempts,
      })),
      confirmed_information: snap.confirmed_information,
      customer_preferences: snap.customer_preferences,
      conversation_summary: snap.conversation_summary,
      confidence_level: snap.confidence_level,
      followup_needed: snap.followup_needed,
      recent_references: snap.recent_references.slice(-MAX_RECENT_REFERENCES),
      // Round-trip the structured cart projection. We persist `subtotal`,
      // `delivery_info`, `payment_method`, and `order_status` only — `items`
      // would duplicate `cartItems` above, and `line_total` is already mirrored
      // onto each item there.
      ...(snap.structured_cart
        ? {
            structured_cart: {
              subtotal: snap.structured_cart.subtotal,
              delivery_info: snap.structured_cart.delivery_info,
              payment_method: snap.structured_cart.payment_method,
              order_status: snap.structured_cart.order_status,
            },
          }
        : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: { pendingDraftJson: next as Prisma.InputJsonValue },
    })
    .catch((e: unknown) => {
      logger.warn({ e: String(e), conversationId }, "agent.saveSnapshot failed");
    });
}

/**
 * Forward edges allowed by the OrderFSM (Requirements §7.2).
 *
 * Realistic forward graph: from any state you can advance to the NEXT logical
 * state(s) AND fall back to earlier in-flight states (so a customer can edit
 * their cart from PAYMENT_SELECTION, etc.). The deterministic preconditions in
 * `canTransition` (cart non-empty, profile complete, etc.) are the real safety
 * net — the structural table just blocks obvious skip-aheads.
 *
 * Forward-skip rules pinned by tests in `__tests__/state.fsm.test.ts`:
 *  - `BROWSING` cannot jump straight to `FINAL_CONFIRMATION` (must walk the FSM).
 *
 * Earlier iterations also blocked `PAYMENT_SELECTION → FINAL_CONFIRMATION`,
 * but `confirm_order` IS the review-and-finalise step — it runs validation,
 * profile checks, and creates the Order itself. The "must go via ORDER_REVIEW"
 * rule prevented every realistic checkout because the FSM never auto-advances
 * into `ORDER_REVIEW` (no tool targets it). The current shape lets
 * `confirm_order` run from `PAYMENT_SELECTION`; the deterministic preconditions
 * in `canTransition` (and inside the tool itself) reject when cart/profile
 * aren't ready.
 *
 * Real-world adjustment vs. the original paranoid table: `BROWSING` can now go
 * directly to `CART_BUILDING` because customers routinely say "rm jersey nibo
 * XXL" with no separate product-selection turn. The earlier table blocked this
 * and the customer was stuck in a loop forever.
 *
 * Each key includes the SELF-EDGE (the FSM intentionally stays in a state
 * across multiple agent turns while the customer supplies more info — e.g.
 * `MISSING_INFO_COLLECTION` → `MISSING_INFO_COLLECTION` while we ask for the
 * next slot).
 *
 * Used by:
 * - `canTransition` (below) for the structural check before precondition evaluation.
 * - `loop.ts` task 5.4 (FSM transition enforcement) to validate the LLM-proposed action.
 */
export const ALLOWED_TRANSITIONS: Record<OrderFSMState, OrderFSMState[]> = {
  BROWSING: [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
  ],
  PRODUCT_SELECTION: [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
  ],
  CART_BUILDING: [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
    "MISSING_INFO_COLLECTION",
    "ADDRESS_COLLECTION",
    "PAYMENT_SELECTION",
    "ORDER_REVIEW",
  ],
  MISSING_INFO_COLLECTION: [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
    "MISSING_INFO_COLLECTION",
    "ADDRESS_COLLECTION",
    "PAYMENT_SELECTION",
    "ORDER_REVIEW",
  ],
  ADDRESS_COLLECTION: [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
    "MISSING_INFO_COLLECTION",
    "ADDRESS_COLLECTION",
    "PAYMENT_SELECTION",
    "ORDER_REVIEW",
  ],
  PAYMENT_SELECTION: [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
    "MISSING_INFO_COLLECTION",
    "ADDRESS_COLLECTION",
    "PAYMENT_SELECTION",
    "ORDER_REVIEW",
    "FINAL_CONFIRMATION",
  ],
  ORDER_REVIEW: [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
    "MISSING_INFO_COLLECTION",
    "ADDRESS_COLLECTION",
    "PAYMENT_SELECTION",
    "ORDER_REVIEW",
    "FINAL_CONFIRMATION",
  ],
  FINAL_CONFIRMATION: ["FINAL_CONFIRMATION", "ORDER_COMPLETE", "ORDER_REVIEW"],
  ORDER_COMPLETE: ["BROWSING"],
};

/** Result type for `canTransition`. Carries a machine-readable `reason` on failure. */
export type CanTransitionResult = { ok: true } | { ok: false; reason: string };

function profileComplete(snapshot: AgentSnapshot): boolean {
  const { name, phone, address } = snapshot.profile;
  return Boolean(name && phone && address);
}

function hasPerLineMissingSlot(snapshot: AgentSnapshot): boolean {
  return snapshot.missing_information.some((s) => typeof s.line_id === "string" && s.line_id.length > 0);
}

function hasConfirmedPaymentMethod(snapshot: AgentSnapshot): boolean {
  const order = snapshot.confirmed_information["order"];
  if (!order) return false;
  const pm = order["payment_method"];
  return typeof pm === "string" ? pm.trim().length > 0 : Boolean(pm);
}

/**
 * Returns `{ ok: true }` iff the transition `from -> to` is structurally legal
 * (per `ALLOWED_TRANSITIONS`) AND the deterministic preconditions for the target
 * state are satisfied by the supplied `snapshot` (Requirements §7.2 + §7.3).
 *
 * On failure the `reason` is a stable string the loop can log into `AgentTrace`:
 * - `"transition_not_allowed"` — the edge is not in `ALLOWED_TRANSITIONS[from]`.
 * - `"<TARGET>_precondition_<name>"` — the edge is structurally legal but the
 *   target state's precondition is not satisfied (e.g.
 *   `"FINAL_CONFIRMATION_precondition_missing_info"`).
 *
 * Used by `loop.ts` task 5.4 to reject LLM-proposed actions that would skip ahead;
 * pair with `nextSuggestedState` to compute the override target.
 */
export function canTransition(
  from: OrderFSMState,
  to: OrderFSMState,
  snapshot: AgentSnapshot,
): CanTransitionResult {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    return { ok: false, reason: "transition_not_allowed" };
  }

  switch (to) {
    case "CART_BUILDING": {
      if (snapshot.cart.length < 1) {
        return { ok: false, reason: "CART_BUILDING_precondition_empty_cart" };
      }
      return { ok: true };
    }
    case "ADDRESS_COLLECTION": {
      if (hasPerLineMissingSlot(snapshot)) {
        return {
          ok: false,
          reason: "ADDRESS_COLLECTION_precondition_per_line_slots_remaining",
        };
      }
      return { ok: true };
    }
    case "PAYMENT_SELECTION": {
      if (!profileComplete(snapshot)) {
        return { ok: false, reason: "PAYMENT_SELECTION_precondition_profile_incomplete" };
      }
      return { ok: true };
    }
    case "ORDER_REVIEW": {
      if (!profileComplete(snapshot)) {
        return { ok: false, reason: "ORDER_REVIEW_precondition_profile_incomplete" };
      }
      if (snapshot.cart.length < 1) {
        return { ok: false, reason: "ORDER_REVIEW_precondition_empty_cart" };
      }
      return { ok: true };
    }
    case "FINAL_CONFIRMATION": {
      if (!profileComplete(snapshot)) {
        return { ok: false, reason: "FINAL_CONFIRMATION_precondition_profile_incomplete" };
      }
      if (snapshot.cart.length < 1) {
        return { ok: false, reason: "FINAL_CONFIRMATION_precondition_empty_cart" };
      }
      if (snapshot.missing_information.length !== 0) {
        return { ok: false, reason: "FINAL_CONFIRMATION_precondition_missing_info" };
      }
      return { ok: true };
    }
    // BROWSING, PRODUCT_SELECTION, MISSING_INFO_COLLECTION, ORDER_COMPLETE: no extra preconditions.
    default:
      return { ok: true };
  }
}

/**
 * Returns the FSM state the agent SHOULD be in next given the current `snapshot`.
 *
 * The loop calls this when `canTransition` rejects an LLM-proposed action: the
 * loop overrides the action by routing the conversation to this suggested state
 * (Requirements §7.4). The walk is intentionally simple and forward-only:
 *
 * 1. Empty cart → `BROWSING`.
 * 2. Cart has items with any per-line missing slot → `MISSING_INFO_COLLECTION`.
 * 3. Cart has items, no per-line slots, profile missing name/phone/address →
 *    `ADDRESS_COLLECTION`.
 * 4. Cart has items, profile complete, no confirmed `payment_method` on the
 *    order-level confirmed_information bag → `PAYMENT_SELECTION`.
 * 5. Already in `ORDER_REVIEW` with `missing_information` empty and profile
 *    complete → `FINAL_CONFIRMATION`.
 * 6. Cart has items, profile complete, payment confirmed, slots done →
 *    `ORDER_REVIEW`.
 * 7. Otherwise stay in `snapshot.order_state` (don't move).
 */
export function nextSuggestedState(snapshot: AgentSnapshot): OrderFSMState {
  if (snapshot.cart.length === 0) {
    return "BROWSING";
  }

  if (hasPerLineMissingSlot(snapshot)) {
    return "MISSING_INFO_COLLECTION";
  }

  if (!profileComplete(snapshot)) {
    return "ADDRESS_COLLECTION";
  }

  // Profile is complete and no per-line slots remain.
  if (!hasConfirmedPaymentMethod(snapshot)) {
    return "PAYMENT_SELECTION";
  }

  // All slots done. If we're already reviewing and there's nothing missing, advance to confirmation.
  if (
    snapshot.order_state === "ORDER_REVIEW" &&
    snapshot.missing_information.length === 0
  ) {
    return "FINAL_CONFIRMATION";
  }

  // Default ready-to-review state.
  if (snapshot.missing_information.length === 0) {
    return "ORDER_REVIEW";
  }

  return snapshot.order_state;
}

/**
 * Deterministic order-completeness `Confidence_Score` in `[0, 1]` (Requirements §11.1, §11.5).
 *
 * Pure function: reads only `snapshot`, never touches Prisma. The score is intended to be
 * combined with the product-match and intent-detection scores by `loop.ts` (task 6.4) via
 * `min(...)` and written into `Snapshot.confidence_level`.
 *
 * Scoring (each weight is documented so `AgentTrace` reviewers can recompute by hand):
 *
 * | Condition                                                      | Weight |
 * |----------------------------------------------------------------|--------|
 * | `cart.length === 0`                                            | → 0.0  |
 * | Cart is non-empty (base credit for having something to score)  | +0.2   |
 * | `missing_information.length === 0`                             | +0.2   |
 * | Full profile (`name && phone && address`)                      | +0.2   |
 * | `confirmed_information.order.payment_method` is a non-empty    |        |
 * | string                                                         | +0.1   |
 * | FSM has reached review: state ∈ {ORDER_REVIEW,                 |        |
 * | FINAL_CONFIRMATION, ORDER_COMPLETE}                            | +0.1   |
 * | FSM has advanced past review: state ∈ {FINAL_CONFIRMATION,     |        |
 * | ORDER_COMPLETE}                                                | +0.2   |
 *
 * Final value is clamped to `[0, 1]`. The FSM bumps are progressive thresholds, not mutually
 * exclusive: a snapshot at `FINAL_CONFIRMATION` collects both +0.1 and +0.2 so the maximum
 * achievable score sums to exactly `1.0`.
 *
 * Invariant (covered by unit tests in `__tests__/orderCompleteness.test.ts`): the score is
 * `1.0` if and only if the cart is non-empty, `missing_information` is empty, the profile
 * has all three of `name`/`phone`/`address`, `confirmed_information.order.payment_method`
 * is set, and `order_state` is `FINAL_CONFIRMATION` or `ORDER_COMPLETE`. This matches Req
 * 11.5: when this score is below the high-confidence threshold while the FSM is at
 * `FINAL_CONFIRMATION`, the loop rolls back to `ORDER_REVIEW` for re-confirmation.
 *
 * Intentionally simple — task 11.x may refine the weighting once we have telemetry on which
 * sub-conditions actually correlate with successful completion.
 */
export function computeOrderCompleteness(snapshot: AgentSnapshot): number {
  if (snapshot.cart.length === 0) return 0.0;

  let score = 0.2; // cart non-empty base credit

  if (snapshot.missing_information.length === 0) score += 0.2;
  if (profileComplete(snapshot)) score += 0.2;
  if (hasConfirmedPaymentMethod(snapshot)) score += 0.1;

  const reachedReview =
    snapshot.order_state === "ORDER_REVIEW" ||
    snapshot.order_state === "FINAL_CONFIRMATION" ||
    snapshot.order_state === "ORDER_COMPLETE";
  if (reachedReview) score += 0.1;

  const advancedPastReview =
    snapshot.order_state === "FINAL_CONFIRMATION" ||
    snapshot.order_state === "ORDER_COMPLETE";
  if (advancedPastReview) score += 0.2;

  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}
