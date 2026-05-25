import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { sendMessengerText, isWithinMessagingWindow } from "../integrations/facebook/messengerService.js";
import { ABANDONED_CART_TIMEOUT_MS, type OrderFSMState } from "./state.js";
import type { AgentSnapshot } from "./types.js";

export type FollowUpKind = "abandoned_cart" | "payment_reminder" | "delivery_review" | "custom";

/**
 * FSM states that signal an in-flight order — the customer started building a cart
 * but hasn't completed checkout. While the snapshot ends a turn in any of these states
 * with a non-empty cart, the agent SHALL have a scheduled `abandoned_cart` follow-up
 * pending so the post-scheduler tick (`processDueFollowUps`) can re-engage the
 * customer after `ABANDONED_CART_TIMEOUT_MS` of silence (Requirements §13.3).
 *
 * Excludes terminal / pre-cart states (`BROWSING`, `PRODUCT_SELECTION`,
 * `ORDER_REVIEW`, `FINAL_CONFIRMATION`, `ORDER_COMPLETE`) — those are either too
 * early (no cart yet / still browsing) or past the abandonment window (review /
 * confirmation has already taken over with `payment_reminder` follow-ups, see
 * `confirm.ts`).
 */
const IN_FLIGHT_FSM_STATES: ReadonlySet<OrderFSMState> = new Set<OrderFSMState>([
  "CART_BUILDING",
  "MISSING_INFO_COLLECTION",
  "ADDRESS_COLLECTION",
  "PAYMENT_SELECTION",
]);

export async function scheduleFollowUp(args: {
  tenantId: string;
  psid: string;
  conversationId?: string;
  kind: FollowUpKind;
  runAt: Date;
  payload?: Record<string, unknown>;
  /** When true, cancel any other scheduled follow-up of the same kind for this psid first. */
  replace?: boolean;
}): Promise<void> {
  if (args.replace) {
    await prisma.followUp
      .updateMany({
        where: {
          tenantId: args.tenantId,
          psid: args.psid,
          kind: args.kind,
          status: "scheduled",
        },
        data: { status: "cancelled" },
      })
      .catch(() => undefined);
  }
  await prisma.followUp.create({
    data: {
      tenantId: args.tenantId,
      psid: args.psid,
      conversationId: args.conversationId ?? null,
      kind: args.kind,
      status: "scheduled",
      runAt: args.runAt,
      payload: (args.payload ?? null) as Prisma.InputJsonValue,
    },
  }).catch((e: unknown) => logger.warn({ e: String(e) }, "scheduleFollowUp failed"));
}

/** Cancel any pending follow-ups for a psid. Called whenever the customer replies. */
export async function cancelPendingFollowUps(tenantId: string, psid: string): Promise<void> {
  await prisma.followUp
    .updateMany({
      where: { tenantId, psid, status: "scheduled" },
      data: { status: "cancelled" },
    })
    .catch(() => undefined);
}

/**
 * Cancel only the pending `abandoned_cart` follow-ups for a psid. Used when the FSM
 * advances to a state that no longer warrants an abandoned-cart nudge (e.g. the order
 * is reviewed / confirmed / complete, or the cart is empty). Leaves `payment_reminder`
 * and other follow-up kinds intact — those have their own lifecycle (see `confirm.ts`).
 */
export async function cancelAbandonedCartFollowUps(tenantId: string, psid: string): Promise<void> {
  await prisma.followUp
    .updateMany({
      where: { tenantId, psid, kind: "abandoned_cart", status: "scheduled" },
      data: { status: "cancelled" },
    })
    .catch(() => undefined);
}

/**
 * Drive abandoned-cart `FollowUp` scheduling from the FSM state at the END of a turn
 * (Requirements §13.3, task 9.3). Single decision point — replaces the inline
 * `scheduleFollowUp` calls that previously lived inside individual cart tools so the
 * scheduling rules for abandonment are not split across the codebase.
 *
 * Decision table:
 *
 * | snapshot.order_state         | snapshot.cart  | Action                                       |
 * |------------------------------|----------------|----------------------------------------------|
 * | CART_BUILDING                | non-empty      | (re)schedule abandoned_cart in 24h           |
 * | MISSING_INFO_COLLECTION      | non-empty      | (re)schedule abandoned_cart in 24h           |
 * | ADDRESS_COLLECTION           | non-empty      | (re)schedule abandoned_cart in 24h           |
 * | PAYMENT_SELECTION            | non-empty      | (re)schedule abandoned_cart in 24h           |
 * | ORDER_COMPLETE               | any            | cancel any pending abandoned_cart row        |
 * | any in-flight state          | empty          | cancel any pending abandoned_cart row        |
 * | BROWSING / PRODUCT_SELECTION | any            | leave existing rows alone (no decision)      |
 * | ORDER_REVIEW                 | any            | leave existing rows alone (review handled    |
 * |                              |                | separately by confirm flow)                  |
 * | FINAL_CONFIRMATION           | any            | leave existing rows alone (confirm flow      |
 * |                              |                | schedules `payment_reminder` instead)        |
 *
 * `replace: true` is used on every schedule so a single in-flight conversation never
 * carries multiple stacked abandoned_cart rows — the most recent FSM-end-of-turn wins.
 *
 * Best-effort: failures inside `scheduleFollowUp` / `cancelAbandonedCartFollowUps` are
 * already swallowed and logged at WARN level. We do NOT throw out of this helper so a
 * follow-up scheduling glitch can never fail an agent turn.
 *
 * @param args.tenantId         The tenant the conversation belongs to.
 * @param args.psid             The customer's Facebook PSID.
 * @param args.conversationId   The MessengerConversation id (optional — passed through to
 *                              the FollowUp row for join-back convenience).
 * @param args.snapshot         The snapshot AS PERSISTED at the END of the turn. The
 *                              caller MUST have already written this via `saveSnapshot`
 *                              before calling here so an external worker reading the
 *                              FollowUp row can rely on the snapshot reflecting the
 *                              same FSM state.
 * @param args.now              Optional clock injection for tests.
 */
export async function reconcileAbandonedCartFollowUp(args: {
  tenantId: string;
  psid: string;
  conversationId?: string;
  snapshot: AgentSnapshot;
  now?: Date;
}): Promise<void> {
  const { tenantId, psid, conversationId, snapshot } = args;
  if (!tenantId || !psid) return;

  const cartLen = Array.isArray(snapshot.cart) ? snapshot.cart.length : 0;
  const inFlight = IN_FLIGHT_FSM_STATES.has(snapshot.order_state);

  // ORDER_COMPLETE → unconditional cancel (Req 13.3 + Req 7.6 — cart is cleared at
  // ORDER_COMPLETE; any pending abandoned_cart row is now meaningless).
  if (snapshot.order_state === "ORDER_COMPLETE") {
    await cancelAbandonedCartFollowUps(tenantId, psid);
    return;
  }

  // In-flight FSM with a non-empty cart → (re)schedule the 24h nudge.
  if (inFlight && cartLen > 0) {
    const now = args.now ?? new Date();
    await scheduleFollowUp({
      tenantId,
      psid,
      ...(conversationId ? { conversationId } : {}),
      kind: "abandoned_cart",
      runAt: new Date(now.getTime() + ABANDONED_CART_TIMEOUT_MS),
      payload: { cartSize: cartLen, fsm: snapshot.order_state },
      replace: true,
    });
    return;
  }

  // In-flight FSM but empty cart (e.g. the customer cleared everything) → cancel.
  if (inFlight && cartLen === 0) {
    await cancelAbandonedCartFollowUps(tenantId, psid);
    return;
  }

  // BROWSING / PRODUCT_SELECTION / ORDER_REVIEW / FINAL_CONFIRMATION → no-op. The
  // confirm flow (`confirm.ts`) handles ORDER_REVIEW/FINAL_CONFIRMATION transitions by
  // scheduling a `payment_reminder` of its own and cancelling any prior nudges.
}

export async function processDueFollowUps(now: Date = new Date()): Promise<void> {
  const due = await prisma.followUp
    .findMany({
      where: { status: "scheduled", runAt: { lte: now } },
      take: 10,
      orderBy: { runAt: "asc" },
      include: { tenant: true },
    })
    .catch(() => []);

  for (const f of due) {
    try {
      const text = composeFollowUpText(f.kind, f.payload);
      if (!text || !f.tenant?.facebookPageAccessToken) {
        await prisma.followUp.update({
          where: { id: f.id },
          data: { status: "cancelled", lastError: "no_text_or_token" },
        });
        continue;
      }
      // Only send if we're still inside the 24h messaging window — Meta requires a tag otherwise.
      const convo = await prisma.messengerConversation
        .findUnique({ where: { tenantId_psid: { tenantId: f.tenantId, psid: f.psid } } })
        .catch(() => null);
      const within24h = convo ? isWithinMessagingWindow(convo.lastUserMsgAt) : false;
      if (!within24h) {
        await prisma.followUp.update({
          where: { id: f.id },
          data: { status: "cancelled", lastError: "outside_24h_window" },
        });
        continue;
      }
      await sendMessengerText({
        pageAccessToken: f.tenant.facebookPageAccessToken,
        psid: f.psid,
        text,
        within24hWindow: within24h,
      });
      if (convo?.id) {
        await prisma.messengerMessage
          .create({ data: { conversationId: convo.id, role: "assistant", text } })
          .catch(() => undefined);
      }
      await prisma.followUp.update({
        where: { id: f.id },
        data: { status: "sent", attempts: f.attempts + 1 },
      });
      logger.info({ followUpId: f.id, kind: f.kind, tenantId: f.tenantId }, "FOLLOW_UP_SENT");
    } catch (e) {
      const next = f.attempts + 1;
      await prisma.followUp
        .update({
          where: { id: f.id },
          data: {
            status: next >= 3 ? "failed" : "scheduled",
            attempts: next,
            lastError: String(e).slice(0, 400),
            // Back off ~10 min between retries.
            runAt: new Date(Date.now() + 10 * 60 * 1000),
          },
        })
        .catch(() => undefined);
      logger.warn({ followUpId: f.id, e: String(e) }, "FOLLOW_UP_RETRY");
    }
  }
}

function composeFollowUpText(kind: string, payload: unknown): string | null {
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  if (typeof p["text"] === "string" && p["text"].trim()) return String(p["text"]).trim();
  switch (kind) {
    case "abandoned_cart":
      return "Hi 👋 Apnar order list e ekta jersey rakhte dekhechi 🙂 Confirm korte chaile janaben — ektu help korte parbo.";
    case "payment_reminder":
      return "Apnar order er payment ekhono baki ache 🙂 Link er madhdhome ba bKash/Nagad e advance pathiye order confirm kore felun.";
    case "delivery_review":
      return "Order ki bhalo received holo? 🙏 Apnar feedback amader help korbe — short kore likhte parben.";
    default:
      return null;
  }
}
