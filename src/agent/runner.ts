import axios from "axios";
import { prisma } from "../db/prisma.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { sendMessengerText } from "../integrations/facebook/messengerService.js";
import { runAgentTurn } from "./loop.js";
import { ensureCustomerProfile } from "./customerProfile.js";
import { cancelPendingFollowUps } from "./followUp.js";
import { sanitizeCustomerReply } from "./replyFilter.js";
import { ABANDONED_CART_TIMEOUT_MS, loadSnapshot, type OrderFSMState } from "./state.js";
import { newTurnId } from "./trace.js";
import { buildReasoningContext } from "./context/reasoningContext.js";
import {
  MissingTenantScopeError,
  ReasoningContextIncompleteError,
} from "./context/reasoningContextErrors.js";
import { lockConversationAddress } from "./audience/persistConversationAddress.js";
import type { AgentSnapshot, AgentStepLog, AgentTurnInput } from "./types.js";

/**
 * Minimum idle gap before a "welcome back" preamble is rendered (task 9.2 — Req 13.4).
 *
 * Without a lower bound, a customer who replies within seconds of their last message
 * would still get a synthetic "you have a saved cart" line on every turn — annoying
 * and redundant. 30 minutes is a sensible default: long enough to read as "you came
 * back" rather than "you're still typing", short enough that the standard 1-hour
 * Messenger session boundary will trigger it for the typical abandoned-cart case.
 *
 * The upper bound is `ABANDONED_CART_TIMEOUT_MS` (24h) from `state.ts` — past that,
 * the snapshot is stale and the loop should treat the conversation as a fresh start
 * rather than try to resume.
 */
const RESUME_PREAMBLE_MIN_GAP_MS = 30 * 60 * 1000;

/**
 * FSM states where a saved cart is still considered "in-flight" (task 9.2 — Req 13.4).
 *
 * Mirrors the in-flight set from task 9.3's `reconcileAbandonedCartFollowUp`: these
 * are the states where the customer started building an order but didn't finish.
 * `BROWSING` / `PRODUCT_SELECTION` carry no commitment, and `ORDER_REVIEW` /
 * `FINAL_CONFIRMATION` / `ORDER_COMPLETE` either already showed a summary or
 * finished, so a "welcome back" preamble would be confusing rather than helpful.
 */
const RESUMABLE_FSM_STATES: ReadonlySet<OrderFSMState> = new Set<OrderFSMState>([
  "CART_BUILDING",
  "MISSING_INFO_COLLECTION",
  "ADDRESS_COLLECTION",
  "PAYMENT_SELECTION",
]);

export async function isAgentEnabledForTenant(tenantId: string): Promise<boolean> {
  const t = await prisma.tenant
    .findUnique({ where: { id: tenantId }, select: { settings: true } })
    .catch(() => null);
  const s = t?.settings;
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const ag = (s as Record<string, unknown>)["agent"];
  if (!ag || typeof ag !== "object" || Array.isArray(ag)) return false;
  return (ag as Record<string, unknown>)["enabled"] === true;
}

async function loadHistory(conversationId: string): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  if (!conversationId) return [];
  const recent = await prisma.messengerMessage
    .findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 16,
      select: { role: true, text: true },
    })
    .catch(() => []);
  return recent
    .reverse()
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", text: m.text }));
}

function summariseCartShort(snap: AgentSnapshot): string {
  if (!snap.cart || snap.cart.length === 0) return "";
  return snap.cart
    .slice(0, 6)
    .map((c) => {
      const ao = (c.addOns ?? [])
        .map((a) => `${a.label}${a.value ? `="${a.value}"` : ""}`)
        .join(", ");
      return `${c.product}${c.size ? ` ${c.size}` : ""}${c.quantity > 1 ? ` x${c.quantity}` : ""}${ao ? ` [${ao}]` : ""}`;
    })
    .join("; ");
}

/**
 * Decide whether the next turn should be primed with a "welcome back" preamble and,
 * if so, return the synthetic assistant line to prepend to `history` before invoking
 * `runAgentTurn` (task 9.2 — Req 13.4).
 *
 * Pure function: takes the loaded `snapshot`, the conversation's `lastUserMsgAt`
 * (or `pendingDraftJson.updatedAt`, whichever the caller plumbs through), and an
 * optional clock for tests. Returns `null` when no preamble is warranted, otherwise
 * a single string framed like
 *
 *     "Apnar age er order list ekhono ache — continue korte chan? [<cart summary>]"
 *
 * Decision rules (all must hold for a non-null result):
 *  - `snapshot.cart` has at least one line.
 *  - `snapshot.order_state` is one of `CART_BUILDING`, `MISSING_INFO_COLLECTION`,
 *    `ADDRESS_COLLECTION`, `PAYMENT_SELECTION` (the in-flight set — see
 *    `RESUMABLE_FSM_STATES`).
 *  - The idle gap (`now - lastUserMsgAt`) is between `RESUME_PREAMBLE_MIN_GAP_MS`
 *    (30 min) and `ABANDONED_CART_TIMEOUT_MS` (24h). Below 30 min the customer is
 *    effectively still in the same session and a preamble would be noise; past 24h
 *    the snapshot is treated as stale and the loop starts fresh.
 *
 * The string is intentionally short (one Banglish line plus a cart summary in
 * brackets) so it slots into `history` without dominating the router prompt budget.
 *
 * Exported so the integration test in `__tests__/abandonedCartResume.test.ts` can
 * pin the decision table without spinning up the full graph.
 */
export function buildResumePreamble(
  snapshot: AgentSnapshot,
  lastUserMsgAt: Date | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!snapshot || !Array.isArray(snapshot.cart) || snapshot.cart.length === 0) {
    return null;
  }
  if (!RESUMABLE_FSM_STATES.has(snapshot.order_state)) return null;

  // Prefer the explicit `lastUserMsgAt`; fall back to the newest reference timestamp
  // if the conversation row didn't carry one (rare but possible for legacy rows).
  const refTs = snapshot.recent_references[snapshot.recent_references.length - 1]?.ts;
  const refDate = refTs ? new Date(refTs) : null;
  const lastActivity =
    lastUserMsgAt instanceof Date && !Number.isNaN(lastUserMsgAt.getTime())
      ? lastUserMsgAt
      : refDate && !Number.isNaN(refDate.getTime())
        ? refDate
        : null;
  if (!lastActivity) return null;

  const gapMs = now.getTime() - lastActivity.getTime();
  if (gapMs < RESUME_PREAMBLE_MIN_GAP_MS) return null;
  if (gapMs > ABANDONED_CART_TIMEOUT_MS) return null;

  const summary = summariseCartShort(snapshot);
  // The summary is always non-empty here because we early-returned on empty cart.
  return `Apnar age er order list ekhono ache — continue korte chan? [${summary}]`;
}

async function safeFallbackReply(input: AgentTurnInput, lastObservation?: string): Promise<void> {
  // Try a one-shot candid Gemma reply that uses what we did learn this turn (the last tool obs)
  // AND the current cart so the customer hears about partial successes ("Spain Away (S) add hoyeche, ...").
  const snap = await loadSnapshot(input.conversationId).catch(() => null);
  const cartSummary = snap ? summariseCartShort(snap) : "";

  const generated = await generateCandidFallback(input, lastObservation, cartSummary);
  const text = sanitizeCustomerReply(
    generated ??
      (cartSummary
        ? `Etogula list-e add hoyeche: ${cartSummary}. Baki gula r jonno ektu por abar try korben please 🙏`
        : "Ami nije eta korte parchhi na ekhuni 🙏 ektu por abar try korben please."),
  );
  try {
    await sendMessengerText({
      pageAccessToken: input.pageAccessToken,
      psid: input.psid,
      text,
      within24hWindow: input.within24h,
    });
    await prisma.messengerMessage
      .create({ data: { conversationId: input.conversationId, role: "assistant", text } })
      .catch(() => undefined);
  } catch (e) {
    logger.warn({ e: String(e) }, "agent.runner fallback reply failed");
  }
}

async function generateCandidFallback(
  input: AgentTurnInput,
  lastObservation: string | undefined,
  cartSummary: string,
): Promise<string | null> {
  try {
    const url = `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`;
    const sys =
      "You are a Bangladeshi Messenger shop's AI assistant. Reply in ONE or TWO short Banglish/Bangla sentences. " +
      "RULES: " +
      "(1) Do NOT say 'admin ke janacchi' or 'admin ke bolchi' unless the customer explicitly asked for a human or you have no useful info at all. " +
      "(2) If the cart already has items, NAME them and ask the customer to confirm or to provide the next missing piece (size / name+number / phone+address). " +
      "(3) Be honest about your own limits but optimistic — say 'ektu por abar try korben' or 'ekta ekta kore bolun' instead of giving up. " +
      "(4) BANNED words: never write 'cart', 'checkout', 'select', 'selected', 'selection' (use 'list', 'order confirm', 'choose koren', 'basaye nin' instead).";
    const user = [
      `Customer's last message: "${input.userText.slice(0, 600)}"`,
      cartSummary ? `Items already in their list: ${cartSummary}` : "(list is empty)",
      lastObservation
        ? `Internal note (do NOT quote verbatim, use it to inform your reply): ${lastObservation.slice(0, 300)}`
        : "",
      "Reply with ONE or TWO short, warm Banglish lines. No JSON, no markdown.",
    ]
      .filter(Boolean)
      .join("\n");
    const res = await axios.post(
      url,
      {
        model: config.ollamaModel,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        stream: false,
        options: { temperature: 0.4, num_predict: 140 },
      },
      { timeout: Math.min(config.ollamaTimeoutMs, 25_000) },
    );
    const content: unknown = res.data?.message?.content;
    if (typeof content !== "string") return null;
    const cleaned = content.trim().replace(/^["'`]+|["'`]+$/g, "");
    return cleaned.length > 0 ? cleaned : null;
  } catch (e) {
    logger.warn({ e: String(e) }, "agent.runner candid fallback failed");
    return null;
  }
}

export type AgentRunResult = "handled" | "skipped" | "errored";

/**
 * Run a single inbound through the agent loop. Returns:
 *  - "handled" → agent replied; legacy must NOT run for this turn
 *  - "skipped" → agent declined (e.g. images present); fall back to legacy
 *  - "errored" → agent threw or hit max_iter without a reply; sent fallback text; legacy SHOULD NOT re-run
 */
export async function runAgentInbound(input: AgentTurnInput): Promise<AgentRunResult> {
  // Phase 1 keeps the surface tight: text-only, ignore image turns.
  if (input.imageUrls.length > 0) return "skipped";
  if (!input.userText.trim()) return "skipped";

  // Phase 2: ensure long-term customer record exists, and cancel any pending follow-ups
  // — the customer just replied, so reminders are no longer needed.
  await ensureCustomerProfile(input.tenantId, input.psid).catch(() => null);
  await cancelPendingFollowUps(input.tenantId, input.psid).catch(() => undefined);

  const history = await loadHistory(input.conversationId);

  // Task 9.2 (Req 13.4): if the snapshot carries a non-empty cart and the FSM is in
  // an in-flight state, prepend a "welcome back" preamble so the router has the
  // saved context in the same `history` channel it already reads. The FSM itself is
  // already restored by `loadSnapshot` inside the loop's `retrieveSession` step, so
  // no extra restore call is needed here — the preamble just frames the resumption
  // for the LLM tool selector.
  if (input.conversationId) {
    try {
      const convo = await prisma.messengerConversation
        .findUnique({
          where: { id: input.conversationId },
          select: { lastUserMsgAt: true, pendingDraftJson: true },
        })
        .catch(() => null);
      const snap = await loadSnapshot(input.conversationId);
      // Prefer `pendingDraftJson.updatedAt` (written by the previous turn's
      // `saveSnapshot`) over `lastUserMsgAt`, because the inbound webhook handler
      // upserts `lastUserMsgAt = now` BEFORE calling `runAgentInbound`, which would
      // make the gap appear to be ~0ms regardless of how long the customer was
      // away. `pendingDraftJson.updatedAt` is only touched by `saveSnapshot`, so it
      // genuinely reflects the last bot-side activity. We fall back to
      // `lastUserMsgAt` for tests / legacy rows that lack the JSON timestamp.
      const draftUpdatedAtRaw =
        convo?.pendingDraftJson &&
        typeof convo.pendingDraftJson === "object" &&
        !Array.isArray(convo.pendingDraftJson)
          ? (convo.pendingDraftJson as Record<string, unknown>)["updatedAt"]
          : undefined;
      const draftUpdatedAt =
        typeof draftUpdatedAtRaw === "string" ? new Date(draftUpdatedAtRaw) : null;
      const lastActivity =
        draftUpdatedAt && !Number.isNaN(draftUpdatedAt.getTime())
          ? draftUpdatedAt
          : (convo?.lastUserMsgAt ?? null);
      const preamble = buildResumePreamble(snap, lastActivity);
      if (preamble) {
        history.push({ role: "assistant", text: preamble });
      }
    } catch (e) {
      // Resume is best-effort: if the snapshot lookup fails for any reason, fall
      // through to a normal turn rather than blocking the customer.
      logger.warn(
        { e: String(e), conversationId: input.conversationId },
        "agent.runner resume preamble lookup failed",
      );
    }
  }

  const turnId = newTurnId();

  // Build the Reasoning_Context once per turn (Multi-Tenant Commerce OS
  // task 3.3). This consolidates tenant + categorySchema + agentIdentity +
  // planLimits + subscription resolution into a single frozen object that
  // every downstream stage reads. Refusal paths:
  //
  //   - `MissingTenantScopeError`         → `tenant_isolation_violation`,
  //                                         skip the loop entirely (R6.1, R6.3).
  //   - `ReasoningContextIncompleteError` → `reasoning_context_incomplete`,
  //                                         skip the loop entirely (R7.6).
  //   - `subscription.isOperational===false` → `subscription_not_operational`,
  //                                         skip the loop AND the legacy
  //                                         fallback so suspended tenants
  //                                         never message a customer (R12.4,
  //                                         R18.4). The runner returns
  //                                         "errored" so the webhook handler
  //                                         records the inbound but does not
  //                                         emit any outbound surface.
  //
  // We pre-build here (rather than letting `runAgentTurn` build it lazily)
  // so the suspension short-circuit can also gate the legacy fallback that
  // `runAgentInbound` would otherwise call on its error path.
  let reasoningContextInput: AgentTurnInput = input;
  try {
    const rc = await buildReasoningContext({
      tenantId: input.tenantId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    if (rc.subscription.isOperational === false) {
      logger.warn(
        {
          event: "agent_inbound_suspended_short_circuit",
          tenantId: rc.tenantId,
          conversationId: input.conversationId,
          subscriptionStatus: rc.subscription.status,
          turnId,
        },
        "agent.runner refusing inbound: subscription not operational",
      );
      // No outbound at all — not even the candid fallback. The customer
      // simply gets no reply for this turn; legacy SHOULD NOT re-run for
      // a suspended tenant either. Return "errored" because the inbound
      // was effectively dropped on the floor; the webhook handler treats
      // "errored" as a no-op for legacy.
      return "errored";
    }
    reasoningContextInput = { ...input, reasoningContext: rc };
    // Lock the resolved address style on the conversation so subsequent
    // turns stay consistent (R7.1). We only lock when the source is
    // `customer_cue` — i.e. the customer's latest message produced an
    // unambiguous cue. Tenant/category/platform defaults are NOT
    // persisted because they're already derivable on every turn from
    // the tenant config; persisting them would freeze a stale default
    // even after the operator changes the tenant default in Settings.
    if (
      input.conversationId &&
      rc.audience.address.source === "customer_cue" &&
      !rc.audience.address.lockedFromConversation
    ) {
      await lockConversationAddress(
        input.conversationId,
        rc.audience.address.style,
      ).catch(() => undefined);
    }
  } catch (e) {
    if (e instanceof MissingTenantScopeError) {
      logger.warn(
        {
          event: "tenant_isolation_violation",
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          turnId,
        },
        "agent.runner refusing inbound: tenant scope missing",
      );
      return "errored";
    }
    if (e instanceof ReasoningContextIncompleteError) {
      logger.warn(
        {
          event: "reasoning_context_incomplete",
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          missingKeys: e.missingKeys,
          turnId,
        },
        "agent.runner refusing inbound: reasoning context incomplete",
      );
      // Onboarding is still pending or the tenant has no businessCategory
      // — the legacy admin path will see the inbound and the operator can
      // finish onboarding. We do NOT emit any outbound here.
      return "errored";
    }
    // Any other error during context build: log and fall through to the
    // existing flow with no `reasoningContext`. `runAgentTurn` will
    // attempt to rebuild and surface a router_error if it also fails.
    logger.warn(
      { e: String(e), tenantId: input.tenantId, turnId },
      "agent.runner buildReasoningContext threw; proceeding without preloaded context",
    );
  }

  try {
    const outcome = await runAgentTurn({
      input: reasoningContextInput,
      history,
      turnId,
    });
    logger.info(
      {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        psid: input.psid,
        turnId,
        reason: outcome.reason,
        steps: outcome.steps.map((s: AgentStepLog) => ({
          iter: s.iter,
          tool: s.tool,
          ok: s.ok,
          llmMs: s.llmLatencyMs,
          toolMs: s.toolLatencyMs,
        })),
      },
      "AGENT_TURN_TRACE",
    );

    // Reasoning_Context refusal reasons (task 3.3): the loop already logged
    // and persisted the trace; the runner MUST NOT emit a fallback reply
    // for these. Returning "errored" tells the webhook handler to skip the
    // legacy path so no outbound surface fires.
    if (
      outcome.reason === "reasoning_context_incomplete" ||
      outcome.reason === "tenant_scope_missing" ||
      outcome.reason === "subscription_not_operational"
    ) {
      return "errored";
    }

    if (outcome.reason === "terminal" && outcome.reply != null) return "handled";
    if (outcome.steps.some((s: AgentStepLog) => s.tool === "reply" && s.ok)) return "handled";

    const lastObs = outcome.steps.length > 0 ? outcome.steps[outcome.steps.length - 1]?.observation : undefined;
    await safeFallbackReply(input, lastObs);
    return "errored";
  } catch (e) {
    logger.error(
      { e: String(e), tenantId: input.tenantId, conversationId: input.conversationId, turnId },
      "agent.runner threw",
    );
    await safeFallbackReply(input);
    return "errored";
  }
}
