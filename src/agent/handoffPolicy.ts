/**
 * Post-connection grace handoff + per-conversation agent mute.
 *
 * Three behaviours, all defensive (one read + maybe one write per turn):
 *
 *   1. GRACE WINDOW — for the first 48 hours after `Tenant.facebookConnectedAt`,
 *      every inbound message is screened by `looksLikePastOrderQuestion()`.
 *      If the message looks like a returning customer asking about an order
 *      that we have no record of (because the SaaS only learned about this
 *      tenant's orders after they connected), the agent escalates to admin
 *      via Telegram + a short Banglish ack to the customer, and mutes the
 *      conversation for 10 hours.
 *
 *   2. PER-CONVERSATION MUTE — `MessengerConversation.agentMutedUntil`. While
 *      `now < agentMutedUntil`, the agent does NOT reply to ANY new inbound
 *      on that conversation. Customer messages are still recorded so the
 *      admin can see them when they take over. The mute auto-expires; we do
 *      NOT clear it on read.
 *
 *   3. SILENT RE-ENGAGEMENT — when the mute expires, the agent does NOT
 *      send a "back online" message. It re-engages on the NEXT inbound only.
 *      Implementation-wise: we just stop short-circuiting the turn, and the
 *      next inbound naturally runs through the agent loop.
 *
 * All helpers are pure / DB-only, no LLM calls.
 */

import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

// ─── Tunables ────────────────────────────────────────────────────────────────

/**
 * How long after Page connection we keep the past-order grace check active.
 * After this window the agent stops escalating "previous order" questions —
 * it'll either find the order in our DB (because by now most active orders
 * have flowed through the SaaS) or reply normally.
 */
export const GRACE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * How long the agent stays muted on a conversation after a handoff. 10h
 * matches a typical merchant working day — by morning the admin has either
 * resolved the question or the customer has moved on.
 */
export const HANDOFF_MUTE_MS = 10 * 60 * 60 * 1000;

// ─── Past-order question detector ────────────────────────────────────────────

/**
 * Curated Banglish + English regex set. Tuned for HIGH RECALL on
 * "the customer is asking about an order placed before" — even when the
 * past-tense cue is implicit ("amar order kobe pabo"). False positives are
 * filtered downstream by `hasInFlightOrder()`, so we lean broad here.
 *
 * Match shapes (each line is intentionally narrow but together they
 * recall the common patterns Bengali customers use):
 *
 *   - explicit past-marker phrases ("amar last/previous/purono order")
 *   - "where is my X" — amar order/parcel/product koi/kothay/kobe/where
 *   - "kobe pabo / kobe ashbe / aslo" — expecting something to arrive
 *   - "delivery koi / kothay / kobe / status / kemon / ki obostha"
 *   - tracking / consignment id references
 *   - past-tense order verbs ("order korechilam / disilam")
 *   - explicit refund / ferot / prior-payment status check
 *
 * Things we deliberately leave OUT (would fire mid-checkout):
 *   - bare "delivery koto din" (= how long for delivery; fresh question)
 *   - bare phone numbers / cuid-shaped tokens (false-match address fields)
 *   - bare "cancel/return" without a past qualifier (also a fresh policy q)
 */
const PAST_ORDER_PHRASES: ReadonlyArray<RegExp> = [
  // Explicit past-marker language ("amar last/previous/purono ... order")
  /\b(amar|amader|aamar)\s+(last|previous|purono|earlier|age\s+er|aage\s+er)\s+(order|booking|product|jersey|kit|parcel|delivery)\b/i,
  /\b(last|previous|purono|earlier|age\s+er|aage\s+er)\s+(order|booking|delivery|payment|parcel)\b/i,
  /\b(shei|sei|oi|oito)\s+(order|product|jersey|item|parcel)\b/i,
  /\bprev(ious)?\s+order\b/i,
  /\bage\s+er\s+order\b/i,
  /\baage\s+er\s+order\b/i,
  /\bpurono\s+order\b/i,

  // "Where's my order/product/parcel" — implicit past reference. Mid-checkout
  // these would fire too, but `hasInFlightOrder()` blocks the handoff in
  // that case so it's safe to be broad here.
  /\b(amar|amader|my)\s+(order|product|parcel|delivery|jersey|kit)\s+(koi|kothay|kothai|kobe|status|kemon|where)\b/i,
  /\b(amar|my)\s+(parcel|product)\s+(koi|kothay)\b/i,

  // "Kobe pabo / ashbe / aslo" — expecting an arrival.
  /\b(kobe|kokhon)\s+(pabo|paba|paabo|paaba|ashbe|aslo|ashlo|delivery)\b/i,

  // Delivery / courier status — narrowed to status verbs, NOT "koto din lagbe"
  // (which is a fresh "how-long" question).
  /\b(delivery|courier|parcel)\s+(koi|kothay|kobe|status|kemon|hoyeche|ki\s+obostha)\b/i,

  // Idiomatic "what's the status".
  /\bki\s+obostha\b/i,

  // Tracking / consignment id references.
  /\b(consignment|tracking)\s*(id|number|num|no)\b/i,
  /\btrack(ing)?\s+(korte|kor[a-z]*|number|id|chai|hobe)\b/i,

  // Past-tense order verbs — "I had ordered" in Banglish.
  /\border\s+kor(echilam|echi|echen|chilen|chilam|chilo|cilam|cilo|sci|chen)\b/i,
  /\border\s+(disilam|disi|diyechi|diyechilam)\b/i,

  // Explicit refund / ferot — strongly implies an existing order.
  /\b(refund|ferot)\b/i,

  // Prior-tx payment status check — past qualifier OR explicit trx-id mention.
  /\b(previous|age\s+er|last)\s+(payment|bkash|nagad|ssl)\s+(confirm|verify|received|hoyeche|hoise)\b/i,
  /\btrx\s*id\s+(diyechi|pathaisi|sent|disilam|disi)\b/i,

  // Order id explicitly tagged. Requires the prefix so we don't match
  // 11-digit phone numbers / Cumilla addresses.
  /\b(order\s+id|order\s+#|order\s+number|orderid|tracking\s+id|consignment\s+id)[\s:#]+[A-Za-z0-9-]{4,}\b/i,
];

/**
 * Quick deterministic check. Pure function — no DB, no LLM. Returns true if
 * the customer's text looks like a question about a previous order. False
 * negatives lean toward letting the agent handle it (which is fine — the
 * agent has its own escalation tools).
 */
export function looksLikePastOrderQuestion(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0) return false;
  for (const r of PAST_ORDER_PHRASES) {
    if (r.test(t)) return true;
  }
  return false;
}

/**
 * `true` when the conversation is already mid-flow with this tenant — the
 * customer has products in their cart, or the order FSM has moved past the
 * initial `BROWSING` state. We use this as a hard gate before the past-order
 * handoff can fire: if the agent is already engaged in a fresh order, a
 * customer phrase like "amar order koi" or a profile message containing a
 * phone number must not trigger an admin escalation.
 *
 * Pure on the snapshot — caller is responsible for loading it. Snapshot
 * shape comes from `loadSnapshot()` in `state.ts`.
 */
export function hasInFlightOrder(snapshot: {
  cart: ReadonlyArray<unknown>;
  order_state: string;
}): boolean {
  if (Array.isArray(snapshot.cart) && snapshot.cart.length > 0) return true;
  // States past BROWSING mean we already know the customer's intent + product;
  // the conversation is decisively a fresh order in progress.
  const inFlight = new Set([
    "PRODUCT_SELECTION",
    "CART_BUILDING",
    "MISSING_INFO_COLLECTION",
    "ADDRESS_COLLECTION",
    "PAYMENT_SELECTION",
    "FINAL_CONFIRMATION",
  ]);
  return inFlight.has(snapshot.order_state);
}

// ─── Tenant grace window ────────────────────────────────────────────────────

/**
 * `true` when the tenant connected their Page within the grace window.
 * Backfills `facebookConnectedAt` to "right now" the first time we see a
 * tenant with a configured `facebookPageId` but no timestamp — so existing
 * tenants don't get a 48h grace retroactively (they get it from "now").
 */
export async function isTenantInGraceWindow(tenantId: string): Promise<boolean> {
  const tenant = await prisma.tenant
    .findUnique({
      where: { id: tenantId },
      select: { facebookConnectedAt: true, facebookPageId: true },
    })
    .catch(() => null);
  if (!tenant) return false;
  if (!tenant.facebookPageId) return false;

  // Backfill: tenant has a page configured but no connection timestamp.
  // Stamp it "now" so the grace window starts from the next inbound. We do
  // this once and only once.
  if (!tenant.facebookConnectedAt) {
    await prisma.tenant
      .update({ where: { id: tenantId }, data: { facebookConnectedAt: new Date() } })
      .catch((e: unknown) => logger.warn({ e: String(e), tenantId }, "facebookConnectedAt backfill failed"));
    return true;
  }

  const elapsed = Date.now() - tenant.facebookConnectedAt.getTime();
  return elapsed >= 0 && elapsed < GRACE_WINDOW_MS;
}

/** Hours remaining in the tenant's grace window, or 0 once expired. */
export async function graceHoursRemaining(tenantId: string): Promise<number> {
  const tenant = await prisma.tenant
    .findUnique({
      where: { id: tenantId },
      select: { facebookConnectedAt: true },
    })
    .catch(() => null);
  if (!tenant?.facebookConnectedAt) return 0;
  const elapsed = Date.now() - tenant.facebookConnectedAt.getTime();
  const remainingMs = GRACE_WINDOW_MS - elapsed;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / (60 * 60 * 1000));
}

// ─── Per-conversation mute ─────────────────────────────────────────────────

/**
 * `true` when the agent should NOT reply to the next inbound on this
 * conversation. Reads `agentMutedUntil` only — does NOT touch any other
 * column. Cheap; safe to call on every inbound.
 */
export async function isAgentMuted(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  const row = await prisma.messengerConversation
    .findUnique({
      where: { id: conversationId },
      select: { agentMutedUntil: true },
    })
    .catch(() => null);
  if (!row?.agentMutedUntil) return false;
  return row.agentMutedUntil.getTime() > Date.now();
}

/**
 * Mute the agent on this conversation for HANDOFF_MUTE_MS. Idempotent — if
 * the conversation is already muted further into the future, this is a no-op
 * (we don't want a flurry of past-order questions to keep extending the mute
 * indefinitely). Returns the new (or preserved) `agentMutedUntil` value.
 */
export async function muteAgent(
  conversationId: string,
  durationMs: number = HANDOFF_MUTE_MS,
): Promise<Date> {
  const target = new Date(Date.now() + durationMs);
  const row = await prisma.messengerConversation
    .findUnique({
      where: { id: conversationId },
      select: { agentMutedUntil: true },
    })
    .catch(() => null);
  // If already muted further out, keep the existing value.
  if (row?.agentMutedUntil && row.agentMutedUntil.getTime() > target.getTime()) {
    return row.agentMutedUntil;
  }
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: { agentMutedUntil: target },
    })
    .catch((e: unknown) =>
      logger.warn({ e: String(e), conversationId }, "muteAgent update failed"),
    );
  return target;
}

/** Clear an active mute (admin-side override). Returns true if a mute was lifted. */
export async function unmuteAgent(conversationId: string): Promise<boolean> {
  const row = await prisma.messengerConversation
    .findUnique({
      where: { id: conversationId },
      select: { agentMutedUntil: true },
    })
    .catch(() => null);
  if (!row?.agentMutedUntil) return false;
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: { agentMutedUntil: null },
    })
    .catch(() => undefined);
  return true;
}

// ─── Telegram alert text builder ───────────────────────────────────────────

/**
 * Build the Telegram admin alert when we hand off a past-order question.
 * Caller is responsible for calling `sendTelegramMessage` — keeping this
 * pure makes it easy to unit test the wording later.
 */
export function buildHandoffTelegramText(args: {
  tenantSlug: string;
  psid: string;
  customerText: string;
  conversationUrl: string | null;
}): string {
  const lines = [
    "Past-order question — admin attention needed",
    `Tenant: ${args.tenantSlug}`,
    `Customer PSID: ${args.psid}`,
    `Message: ${args.customerText.slice(0, 280)}`,
    "",
    "Agent is muted on this conversation for 10h. Reply via Messenger directly; the customer will get your reply.",
  ];
  if (args.conversationUrl) lines.push(`Conversation: ${args.conversationUrl}`);
  return lines.join("\n");
}

/**
 * Customer-facing Banglish ack when we hand off a past-order question. Kept
 * short and warm; the admin will follow up directly via Messenger.
 */
export const HANDOFF_CUSTOMER_REPLY =
  "Apnar previous order er bepar e ami amader admin ke connect kore dichchi 🙏 Ektu wait korun, oni shoborkichu detail kore janabe.";
