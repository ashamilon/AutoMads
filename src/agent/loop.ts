/**
 * Agent loop — the 10-step reasoning pipeline (Requirements §5.1).
 *
 * Implemented as a real `@langchain/langgraph` `StateGraph` with one node per
 * pipeline stage. The first iteration of a turn flows linearly through ALL TEN
 * nodes; subsequent iterations within the same turn re-enter the graph at
 * `detect_intent` (stage 4), because stages 1–3 (`observe_input`,
 * `retrieve_session`, `retrieve_cart`) capture inbound text + session state
 * which never changes mid-turn.
 *
 * Stage inventory (in execution order, FIRST iteration):
 *   1.  observe_input          // deterministic
 *   2.  retrieve_session       // deterministic
 *   3.  retrieve_cart          // deterministic
 *   4.  detect_intent          // LLM (deterministic intent classifier today;
 *                                  router schema permits self-reported
 *                                  confidence and task 6.2 will swap in a real
 *                                  classifier)
 *   5.  detect_missing_info    // deterministic
 *   6.  choose_action          // LLM
 *   7.  choose_tools           // LLM (SHARES the same `askRouter` call as
 *                                  `choose_action` — one LLM round-trip per
 *                                  iteration produces TWO trace rows)
 *   8.  verify_pre_response    // deterministic (FSM gating + reference
 *                                  resolver overlay for cart-mutating tools —
 *                                  task 4.3)
 *   9.  generate_response      // LLM (executes the chosen tool; the terminal
 *                                  `reply` tool's text is the LLM-generated
 *                                  reply composed inside the router prompt)
 *  10.  save_memory            // deterministic
 *
 * Per Requirements §5.5, ONLY stages 4 / 6 / 7 / 9 may invoke the LLM. Code
 * comments mark each node `// LLM` or `// deterministic` so the boundary is
 * auditable at a glance.
 *
 * Anti-loop guards stay near the tool-execution stage:
 *   - The same-tool/same-args duplicate guard lives inside `generate_response`
 *     (it inspects `state.steps` from prior iterations).
 *   - `MAX_ITER` is enforced by the `save_memory → detect_intent` re-entry
 *     conditional edge.
 *
 * Future-task hooks (no behaviour today, called out so the next refactor is
 * mechanical):
 *   - task 5.3 (Anti-Loop Guard) → swap reply on the third repeated slot
 *     question; lives inside `verify_pre_response`.
 *   - task 5.4 (FSM enforcement) → run `canTransition` inside
 *     `verify_pre_response` and override the action when illegal.
 *   - task 6.4 (composite confidence) → write
 *     `min(product_match, intent, order_completeness)` into
 *     `snapshot.confidence_level` at the end of `verify_pre_response`.
 */

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { logger } from "../utils/logger.js";
import { mergePreferences } from "./customerProfile.js";
import { reconcileAbandonedCartFollowUp } from "./followUp.js";
import {
  resolveReference,
  type ReferenceResolution,
} from "./referenceResolver.js";
import { askRouter, type RouterOk } from "./router.js";
import {
  appendRecentReference,
  canTransition,
  CONFIDENCE_THRESHOLDS,
  computeOrderCompleteness,
  loadSnapshot,
  MAX_SLOT_ATTEMPTS,
  nextSuggestedState,
  saveSnapshot,
  type OrderFSMState,
} from "./state.js";
import {
  extractResultId,
  logOverride,
  logToolCall,
  type StructuredLogContext,
} from "./structuredLogs.js";
import { newTurnId, persistTurnTrace } from "./trace.js";
import { findTool, TOOLS } from "./tools/registry.js";
import type {
  AgentLoopStep,
  AgentMissingInfoSlot,
  AgentRecentReference,
  AgentRunOutcome,
  AgentSnapshot,
  AgentStepLog,
  AgentTurnInput,
  ToolHandlerCtx,
} from "./types.js";

export const MAX_ITER = 30;

/** Each iteration emits exactly 10 step records (one per pipeline stage). */
export const STEPS_PER_ITER = 10;

/**
 * Tool names that mutate the cart (or attach add-ons to a cart line) and
 * therefore MUST be screened by `resolveReference` before invocation
 * (task 4.3, Req 9.2). Includes both the canonical tool names registered today
 * (`add_to_cart`, `remove_from_cart`, `modify_cart_item`, `set_line_addons`)
 * and the alias names called out in the spec (`update_cart`, `remove_cart_item`)
 * so the wiring stays forward-compatible with task 7.1 (registry alias entries).
 */
const CART_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "add_to_cart",
  "update_cart",
  "modify_cart_item",
  "remove_from_cart",
  "remove_cart_item",
  "set_line_addons",
]);

/**
 * Tools that target a SPECIFIC EXISTING cart line (not a fresh add). The
 * reference resolver MUST resolve to a `kind: "line"` result for these — a
 * `kind: "product"` resolution is the wrong target type and should NOT silently
 * be accepted.
 */
const LINE_TARGETED_TOOLS: ReadonlySet<string> = new Set([
  "modify_cart_item",
  "remove_from_cart",
  "remove_cart_item",
]);

/**
 * Tools that target a SPECIFIC PRODUCT (sku) — `add_to_cart` / `update_cart`
 * always mint a new line for a freshly-resolved sku, and `set_line_addons`
 * looks up the line by sku internally. For these tools, a `kind: "product"`
 * resolution is the correct shape; a `kind: "line"` resolution is also
 * acceptable (we then look up the cart line and map back to its sku).
 */
const PRODUCT_TARGETED_TOOLS: ReadonlySet<string> = new Set([
  "add_to_cart",
  "update_cart",
  "set_line_addons",
]);

/** A router decision shared across `choose_action` and `choose_tools`. */
type RouterCall = {
  tool: string;
  args: Record<string, unknown>;
  thought: string;
  /** Latency of the (single) underlying `askRouter` call. */
  latencyMs: number;
  /** Set when the router returned an error (final, after retry). */
  error: string | null;
};

/** Per-iteration scratch carried between nodes. Reset on every re-entry. */
type IterContext = {
  /** Whether stages 1–3 have already executed for this turn. */
  bootstrapDone: boolean;
  /** Set by `detect_intent`. */
  detectedIntent: { intent: string; confidence_score: number };
  /** Whether a real classifier was wired (vs. the deterministic placeholder). */
  classifierAvailable: boolean;
  /** Set by `choose_action` / `choose_tools`. */
  router: RouterCall | null;
  /** Composite confidence + per-step triple, populated by `verify_pre_response`. */
  composite: number;
  confidenceScores: {
    product_match: number;
    intent: number;
    order_completeness: number;
  };
  /** Tool name to run, AFTER reference-resolution overlay. */
  effectiveTool: string;
  /** Tool args to run, AFTER reference-resolution overlay. */
  effectiveArgs: Record<string, unknown>;
  /** Working snapshot (`tool.handler` may mutate via `ctx.saveSnapshot`). */
  workingSnapshot: AgentSnapshot;
  /** Result of `tool.handler` invocation, set by `generate_response`. */
  lastToolResult:
    | { ok: true; observation: string; data?: unknown; terminal?: boolean; reply?: string }
    | { ok: false; error: string; observation: string }
    | null;
  /** Latency of the `tool.handler` invocation, set by `generate_response`. */
  lastToolLatencyMs: number;
};

type LoopState = {
  input: AgentTurnInput;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  snapshot: AgentSnapshot;
  steps: AgentStepLog[];
  reply: string | null;
  done: boolean;
  reason: AgentRunOutcome["reason"] | null;
  /** True when the previous router call returned bad JSON; enables a one-shot corrective retry. */
  needsRetry: boolean;
  /** Iteration counter for the outer loop (1-indexed). */
  iter: number;
  /**
   * Turn id used as the correlation key on every structured log line emitted by
   * the loop (`agent.tool_call` / `agent.override`). Allocated by `runAgentTurn`
   * and passed through the graph state so every node sees the same value.
   */
  turnId: string;
  /** Per-iter scratch shared across stages 4–10. */
  iterCtx: IterContext;
};

const State = Annotation.Root({
  input: Annotation<AgentTurnInput>(),
  history: Annotation<LoopState["history"]>(),
  snapshot: Annotation<AgentSnapshot>(),
  steps: Annotation<AgentStepLog[]>({ reducer: (a, b) => b ?? a, default: () => [] }),
  reply: Annotation<string | null>({ reducer: (a, b) => (b !== undefined ? b : a), default: () => null }),
  done: Annotation<boolean>({ reducer: (a, b) => b ?? a, default: () => false }),
  reason: Annotation<LoopState["reason"]>({ reducer: (a, b) => (b !== undefined ? b : a), default: () => null }),
  needsRetry: Annotation<boolean>({ reducer: (a, b) => b ?? a, default: () => false }),
  iter: Annotation<number>({ reducer: (a, b) => b ?? a, default: () => 0 }),
  turnId: Annotation<string>({ reducer: (a, b) => b ?? a, default: () => "" }),
  iterCtx: Annotation<IterContext>({ reducer: (a, b) => b ?? a, default: () => emptyIterCtx() }),
});

function emptyIterCtx(): IterContext {
  return {
    bootstrapDone: false,
    detectedIntent: { intent: "unknown", confidence_score: 0.5 },
    classifierAvailable: false,
    router: null,
    composite: 1.0,
    confidenceScores: { product_match: 1.0, intent: 0.5, order_completeness: 1.0 },
    effectiveTool: "",
    effectiveArgs: {},
    workingSnapshot: {
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
    },
    lastToolResult: null,
    lastToolLatencyMs: 0,
  };
}

/** Build a step row tagged with the named pipeline stage. */
function makeStepLog(args: {
  iter: number;
  step: AgentLoopStep;
  tool: string;
  argsPayload?: unknown;
  ok: boolean;
  observation: string;
  thought?: string;
  llmLatencyMs?: number;
  toolLatencyMs?: number;
  /** FSM state at the moment this row is emitted (Req 7.5 / 15.1). */
  fsmState?: AgentSnapshot["order_state"];
  /** Composite confidence at the moment this row is emitted (Req 11.6 / 15.1). */
  confidenceLevel?: number;
  /** Per-step confidence triple (Req 11.6 / 15.1). */
  confidenceScores?: {
    product_match: number;
    intent: number;
    order_completeness: number;
  };
}): AgentStepLog {
  return {
    iter: args.iter,
    step: args.step,
    tool: args.tool,
    args: args.argsPayload ?? {},
    ok: args.ok,
    observation: args.observation,
    llmLatencyMs: args.llmLatencyMs ?? 0,
    toolLatencyMs: args.toolLatencyMs ?? 0,
    ...(args.thought ? { thought: args.thought } : {}),
    ...(args.fsmState !== undefined ? { fsmState: args.fsmState } : {}),
    ...(args.confidenceLevel !== undefined ? { confidenceLevel: args.confidenceLevel } : {}),
    ...(args.confidenceScores !== undefined ? { confidence_scores: args.confidenceScores } : {}),
  };
}

/**
 * Build the correlation context shared by every structured log line emitted
 * during the loop (task 11.2). The same shape is consumed by
 * `logToolCall` / `logOverride` in `structuredLogs.ts`.
 */
function makeLogCtx(state: LoopState, iter: number): StructuredLogContext {
  return {
    tenantId: state.input.tenantId,
    conversationId: state.input.conversationId,
    turnId: state.turnId,
    iter,
  };
}

/**
 * Format a short customer-facing list of disambiguation candidates for the
 * clarification reply emitted when reference resolution falls below the
 * high-confidence threshold (Req 9.5, 12.5).
 *
 * Pulls candidates from `lastShown` first (the most recent search result the
 * customer saw), then from the cart so any in-flight item is also offered as
 * a possible target. Caps to 4 entries so the Messenger reply stays short.
 */
function buildDisambiguationReply(
  snapshot: AgentSnapshot,
  resolution: ReferenceResolution,
): string {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (label: string, key: string): void => {
    if (!label) return;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(label);
  };

  // Cart lines — prefer these because the customer's reference usually targets
  // an existing line ("the boot", "second one", "the red one").
  for (const line of snapshot.cart) {
    const sizePart = line.size ? ` (size ${line.size})` : "";
    const qtyPart = line.quantity > 1 ? ` x${line.quantity}` : "";
    pushCandidate(`${line.product}${sizePart}${qtyPart}`, `line:${line.line_id}`);
    if (candidates.length >= 4) break;
  }

  // Fall back to lastShown so a freshly-listed search result can be picked too.
  if (candidates.length < 4 && Array.isArray(snapshot.lastShown)) {
    for (const row of snapshot.lastShown) {
      pushCandidate(row.label || row.sku, `sku:${row.sku}`);
      if (candidates.length >= 4) break;
    }
  }

  if (candidates.length === 0) {
    // No candidates we can list — keep the reply generic but actionable.
    return "Kon ta bujhte parchi na 🙏 Product er nam ba code ta aktu likhben?";
  }

  const numbered = candidates.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const conf = resolution.confidence_score.toFixed(2);
  return (
    `Kon ta bujhte parchi na — confidence ${conf}. Niche theke select korben please:\n` +
    numbered
  );
}

/**
 * Map a `ReferenceResolution` produced by the deterministic resolver into the
 * tool-args overlay required by the chosen cart-mutating tool. Returns either:
 *
 *   - `{ ok: true, args }` — args ready to merge over the LLM-proposed args.
 *     The overlay carries `line_id` (for line-targeted tools) or `sku` (for
 *     product-targeted tools), or both when we can derive both from the
 *     snapshot.
 *   - `{ ok: false }` — the resolution shape does not match the tool's target
 *     type (e.g. `kind: "product"` for `modify_cart_item`). The caller MUST
 *     then either fall back to the LLM's args or short-circuit to
 *     clarification.
 *
 * Pure: never touches Prisma; only reads `snapshot.cart` to map a line→sku for
 * product-targeted tools that received a line resolution.
 */
function buildResolverArgsOverlay(
  toolName: string,
  resolution: ReferenceResolution,
  snapshot: AgentSnapshot,
):
  | { ok: true; args: Record<string, unknown>; targetSummary: string }
  | { ok: false; reason: string } {
  if (resolution.kind === "none") {
    return { ok: false, reason: "no_resolution" };
  }
  const isLineTool = LINE_TARGETED_TOOLS.has(toolName);
  const isProductTool = PRODUCT_TARGETED_TOOLS.has(toolName);

  if (isLineTool) {
    if (resolution.kind !== "line") {
      return { ok: false, reason: `wrong_kind_for_line_tool:${resolution.kind}` };
    }
    return {
      ok: true,
      args: { line_id: resolution.line_id },
      targetSummary: `line_id=${resolution.line_id}`,
    };
  }

  if (isProductTool) {
    if (resolution.kind === "product") {
      return {
        ok: true,
        args: { sku: resolution.product_id },
        targetSummary: `sku=${resolution.product_id}`,
      };
    }
    // Line resolution for a product-targeted tool — map the line back to its
    // sku so e.g. `set_line_addons` can locate the cart line by sku.
    if (resolution.kind === "line") {
      const line = snapshot.cart.find((c) => c.line_id === resolution.line_id);
      if (!line) {
        return { ok: false, reason: "line_not_in_cart" };
      }
      return {
        ok: true,
        args: { sku: line.sku },
        targetSummary: `sku=${line.sku} (via line_id=${resolution.line_id})`,
      };
    }
  }

  return { ok: false, reason: "unknown_tool_target" };
}

/**
 * Best-effort mapping from the chosen tool name to the FSM state it implies.
 * Used by `verify_pre_response` to log the implied target so task 5.4's
 * override has a clear seam to plug into. Returning `null` means we don't have
 * a confident mapping yet.
 */
export function inferImpliedFsmTarget(toolName: string): OrderFSMState | null {
  if (!toolName) return null;
  const t = toolName.toLowerCase();
  if (t === "search_catalog" || t === "search_products" || t === "resolve_product_name") {
    return "PRODUCT_SELECTION";
  }
  if (
    t === "add_to_cart" ||
    t === "update_cart" ||
    t === "modify_cart_item" ||
    t === "remove_from_cart" ||
    t === "remove_cart_item"
  ) {
    return "CART_BUILDING";
  }
  if (t === "set_line_addons") {
    return "MISSING_INFO_COLLECTION";
  }
  if (t === "set_customer_profile" || t === "ask_address") {
    return "ADDRESS_COLLECTION";
  }
  if (t === "set_payment_method" || t === "create_payment_link") {
    return "PAYMENT_SELECTION";
  }
  if (t === "show_cart" || t === "validate_order") {
    return "ORDER_REVIEW";
  }
  if (t === "confirm_order" || t === "create_order") {
    return "FINAL_CONFIRMATION";
  }
  return null;
}


/**
 * Compose a short Banglish clarification reply when the loop blocks the
 * `confirm_order` step (task 5.4). The reply is derived from
 * `nextSuggestedState(snapshot)` so the customer hears EXACTLY which step is
 * missing — payment method, address, etc. — instead of the generic "ektu wait
 * korun" that leaves the customer guessing.
 *
 * Falls back to a reason-based message for the rare cases where the suggested
 * state doesn't tell us anything new (e.g. a precondition error string we
 * don't recognise).
 */
function buildFsmBlockReply(
  reason: string,
  snapshot: AgentSnapshot,
): string {
  const suggested = nextSuggestedState(snapshot);

  // Per-state guidance — actionable in the customer's language.
  switch (suggested) {
    case "MISSING_INFO_COLLECTION": {
      const slots = snapshot.missing_information
        .map((s) => s.slot)
        .filter((s, i, a) => a.indexOf(s) === i)
        .slice(0, 4)
        .join(", ");
      return slots
        ? `Order confirm korar age aro kichu info lagbe: ${slots}. Eta ta din please 🙏`
        : "Order confirm korar age aro kichu info lagbe — bolun please.";
    }

    case "ADDRESS_COLLECTION": {
      const p = snapshot.profile;
      const missing: string[] = [];
      if (!p.name) missing.push("name");
      if (!p.phone) missing.push("phone");
      if (!p.address) missing.push("address");
      const list = missing.join(", ");
      return list
        ? `Order confirm korte apnar ${list} ta lagbe — please diye den 🙏`
        : "Order confirm korte apnar profile complete korte hobe — please bolun.";
    }

    case "PAYMENT_SELECTION": {
      // Profile + cart are ready, payment_method just hasn't been recorded.
      // After the FSM table change, `confirm_order` is allowed through from
      // PAYMENT_SELECTION (the tool itself picks the rail from tenant config),
      // so this branch is rarely reached. When it does fire it means the LLM
      // picked a different terminal tool that's still gated. Direct the
      // customer to confirm and let the tool handle rail selection.
      const subtotal = snapshot.structured_cart?.subtotal ?? 0;
      const totalLine = subtotal > 0 ? `Total ${subtotal} BDT. ` : "";
      return (
        `${totalLine}Order confirm korte raji thakle "OK / confirm" likhe den, ` +
        `ami payment link diye dichchi 🙏`
      );
    }

    case "ORDER_REVIEW": {
      // Cart + profile + payment all set, but FSM hasn't crossed into review
      // yet. Show what we've got and ask for an OK so the next turn can go
      // to FINAL_CONFIRMATION cleanly.
      const lineCount = snapshot.cart.length;
      return lineCount > 0
        ? `Apnar order list e ${lineCount} ta item ache. Sob thik thakle "OK / confirm" likhe den, amra order place kore dichchi 🙏`
        : "Order ekhono khali — kon product ta nite chan bolun please.";
    }

    case "BROWSING": {
      return "Apnar cart ekhono khali — kon product ta nite chan bolun?";
    }

    case "FINAL_CONFIRMATION":
    case "PRODUCT_SELECTION":
    case "CART_BUILDING":
    case "ORDER_COMPLETE":
    default: {
      // Reason-based fallback for the rare cases the per-state branch
      // doesn't cover. Mirrors the previous behaviour as a safety net.
      const m = reason.match(/precondition_(.+)$/);
      const tail = m ? m[1] ?? "" : "";
      if (tail === "profile_incomplete") {
        const p = snapshot.profile;
        const missing: string[] = [];
        if (!p.name) missing.push("name");
        if (!p.phone) missing.push("phone");
        if (!p.address) missing.push("address");
        const list = missing.join(", ");
        return list
          ? `Apnar ${list} ekhono nai — please ${list} ta din.`
          : "Apnar profile e kichu missing — please complete korun.";
      }
      if (tail === "empty_cart") {
        return "Apnar cart ekhono khali — kon product ta nite chan?";
      }
      if (tail === "missing_info") {
        return "Order confirm korar age aro kichu info lagbe — bolun please.";
      }
      // Last-ditch generic message; should rarely be hit because the
      // suggested-state branches cover the realistic scenarios.
      return "Ektu wait korun — order confirm korar age ekta step baki ache 🙏";
    }
  }
}


// ---------------------------------------------------------------------------
// Anti-Loop Guard helpers (task 5.3, Reqs 8.5, 12.6, 14.5).
//
// The guard runs inside `verify_pre_response` BEFORE the reference-resolver
// overlay. When the LLM has proposed a `reply` whose text reads as a question
// about a missing slot (e.g. "Apnar address ta din?"), we look up the
// corresponding row in `snapshot.missing_information`. If `attempts >=
// MAX_SLOT_ATTEMPTS` the question would be the third repeat — we swap the
// reply for an FSM-aware fallback that summarises what we already understand
// and either escalates or hands a different way to capture the slot. Otherwise
// we increment `attempts` so the same question can't recycle forever.
// ---------------------------------------------------------------------------

/**
 * Common slot keywords + their Banglish/English aliases. The guard looks for
 * any of these tokens inside a reply text to decide which slot the reply is
 * asking about. Order matters: the LONGEST/most-specific match wins (so e.g.
 * `name-number` is checked before `name`), with `slot.toLowerCase()` always
 * tried first so custom slot ids stay matchable.
 *
 * Keep this list small — Phase 1 covers the slots that actually exist in the
 * cart pipeline today (size, address, phone, name, payment method, name-number
 * customisation). New slots can be added without touching the guard's logic.
 */
const SLOT_KEYWORDS: Record<string, ReadonlyArray<string>> = {
  size: ["size", "shoz"],
  address: ["address", "thikana", "thikhana", "thikna"],
  phone: ["phone", "phone number", "mobile", "number ta", "phone ta"],
  name: ["name", "naam"],
  payment_method: ["payment", "payment method", "bkash", "nagad", "cod", "cash on delivery"],
  "name-number": ["name and number", "name number", "name-number", "naam number", "naam ar number"],
};

/**
 * Decide whether `text` reads as a customer-facing question about ANY slot
 * (heuristic). Used as a cheap gate before doing the per-slot keyword match.
 * A question-like reply contains either a `?` OR a recognisable Banglish
 * imperative ("din", "bolen", "lagbe", "diben") that the agent uses when
 * asking for a slot value.
 */
function isSlotQuestion(text: string): boolean {
  if (!text) return false;
  if (text.includes("?")) return true;
  // Common Banglish imperatives the agent uses to ask for a value.
  return /\b(din|diben|bolen|jananaben|lagbe|ki|kotha)\b/i.test(text);
}

/**
 * Return the index of the missing-information row that the reply text appears
 * to be asking about, or `null` when no slot keyword is found. Order-level
 * rows (no `line_id`) are matched the same way as per-line rows; the loop
 * doesn't currently distinguish them for guard purposes.
 *
 * Pure: never mutates `snapshot.missing_information`.
 */
function findAskedSlotIndex(
  snapshot: AgentSnapshot,
  replyText: string,
): number | null {
  if (!replyText) return null;
  const lower = replyText.toLowerCase();
  // Try each missing slot in order — the FIRST match wins. We match against
  // both the slot's literal id (e.g. a custom add-on id like "jersey-name")
  // and the curated keyword aliases above.
  for (let i = 0; i < snapshot.missing_information.length; i += 1) {
    const slotName = snapshot.missing_information[i]?.slot?.toLowerCase() ?? "";
    if (slotName && lower.includes(slotName)) return i;
    const aliases = SLOT_KEYWORDS[slotName] ?? [];
    for (const alias of aliases) {
      if (lower.includes(alias.toLowerCase())) return i;
    }
  }
  return null;
}

/**
 * Build the FSM-aware fallback reply emitted when `attempts >=
 * MAX_SLOT_ATTEMPTS`. Per Req 12.1 the reply summarises the items we already
 * understand (cart lines + confirmed slots) so the customer doesn't feel
 * stuck, then hands a fresh way to capture the troublesome slot.
 */
function buildAntiLoopFallbackReply(
  snapshot: AgentSnapshot,
  slot: AgentMissingInfoSlot,
): string {
  const understood: string[] = [];
  for (const line of snapshot.cart) {
    const sizePart = line.size ? ` (size ${line.size})` : "";
    const qtyPart = line.quantity > 1 ? ` x${line.quantity}` : "";
    understood.push(`${line.product}${sizePart}${qtyPart}`);
    if (understood.length >= 4) break;
  }
  // Surface confirmed order-level slots too (e.g. payment_method) so the
  // summary reflects everything we already captured.
  const orderConfirmed = snapshot.confirmed_information["order"];
  if (orderConfirmed && typeof orderConfirmed === "object") {
    for (const [k, v] of Object.entries(orderConfirmed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim().length > 0) {
        understood.push(`${k}: ${v}`);
        if (understood.length >= 6) break;
      }
    }
  }
  const summary =
    understood.length > 0
      ? `Ami ekhon porjonto bujhte perechi: ${understood.join(", ")}.`
      : "Apnar list ta ekhono khali.";
  return (
    `${summary} ${slot.slot} er bepar e onek bar jiggesh korlam — ` +
    `oi info ta different bhabe pathate parben? Othoba ami akhon ekjon admin er sathe connect kore dichchi 🙏`
  );
}


// ---------------------------------------------------------------------------
// Pipeline stage results + executor surface (task 5.1).
// ---------------------------------------------------------------------------

/**
 * Compact result of running ONE iteration through the 10 named pipeline stages
 * via {@link runIterPipeline}. White-box callers (tests, future replay tooling)
 * use this to assert on the per-iter shape WITHOUT going through the full
 * `StateGraph` runtime.
 */
export type IterResult = {
  steps: AgentStepLog[];
  snapshot: AgentSnapshot;
  reply: string | null;
  /**
   * `true` when this iteration ended the turn — either because the tool
   * executed in `generate_response` was terminal, or because the router
   * surfaced a hard error that the loop chose to stop on.
   */
  terminal: boolean;
  /** Set when `terminal === true`; mirrors `AgentRunOutcome["reason"]`. */
  reason: AgentRunOutcome["reason"] | null;
};


// ---------------------------------------------------------------------------
// Stage 1: observe_input — deterministic.
// Records the raw inbound text + image count so every later stage can reference
// what the customer actually said. Cheap; runs once per turn.
// ---------------------------------------------------------------------------
async function observeInput(state: LoopState): Promise<Partial<LoopState>> {
  // deterministic
  const iter = state.iter;
  const userText = state.input.userText.trim();
  const obs =
    `observed input: text="${userText.slice(0, 280)}"` +
    (state.input.imageUrls.length > 0 ? ` images=${state.input.imageUrls.length}` : "");
  const step = makeStepLog({
    iter,
    step: "observe_input",
    tool: "(step)",
    argsPayload: {
      userText: userText.slice(0, 600),
      imageCount: state.input.imageUrls.length,
    },
    ok: true,
    observation: obs,
    fsmState: state.snapshot.order_state,
    confidenceLevel: state.snapshot.confidence_level,
  });
  state.iterCtx.bootstrapDone = false;
  return { steps: [...state.steps, step] };
}

// ---------------------------------------------------------------------------
// Stage 2: retrieve_session — deterministic.
// Loads the persisted snapshot from `pendingDraftJson` (Req 5.1, 13.6) so the
// iteration sees whatever the previous turn wrote. The first iteration's
// snapshot is also seeded from the same call so a fresh conversation gets the
// `emptySnapshot()` defaults transparently.
// ---------------------------------------------------------------------------
async function retrieveSession(state: LoopState): Promise<Partial<LoopState>> {
  // deterministic
  const iter = state.iter;
  let next: AgentSnapshot = state.snapshot;
  let ok = true;
  let obs = "session loaded from in-memory state";
  if (state.input.conversationId) {
    try {
      const loaded = await loadSnapshot(state.input.conversationId);
      next = loaded;
      obs = `session loaded for conversationId=${state.input.conversationId} (cart=${loaded.cart.length}, fsm=${loaded.order_state})`;
    } catch (e) {
      ok = false;
      obs = `session load failed: ${String(e).slice(0, 160)}`;
    }
  }
  state.iterCtx.workingSnapshot = next;
  const step = makeStepLog({
    iter,
    step: "retrieve_session",
    tool: "(step)",
    argsPayload: { conversationId: state.input.conversationId || null },
    ok,
    observation: obs,
    fsmState: next.order_state,
    confidenceLevel: next.confidence_level,
  });
  return { steps: [...state.steps, step], snapshot: next };
}

// ---------------------------------------------------------------------------
// Stage 3: retrieve_cart — deterministic.
// The cart already lives on the snapshot; this stage emits an audit row that
// summarises it and stamps the per-iter `bootstrapDone` flag so re-entries
// from `save_memory` know the per-turn bootstrap (1–3) does NOT run again.
// ---------------------------------------------------------------------------
async function retrieveCart(state: LoopState): Promise<Partial<LoopState>> {
  // deterministic
  const iter = state.iter;
  const snap = state.iterCtx.workingSnapshot;
  const cartLen = snap.cart.length;
  const subtotal = snap.structured_cart?.subtotal ?? 0;
  const obs = `cart retrieved: ${cartLen} line(s), subtotal=${subtotal} BDT, fsm=${snap.order_state}`;
  state.iterCtx.bootstrapDone = true;
  const step = makeStepLog({
    iter,
    step: "retrieve_cart",
    tool: "(step)",
    argsPayload: { lines: cartLen, subtotal, fsm: snap.order_state },
    ok: true,
    observation: obs,
    fsmState: snap.order_state,
    confidenceLevel: snap.confidence_level,
  });
  return { steps: [...state.steps, step] };
}

// ---------------------------------------------------------------------------
// Stage 4: detect_intent — LLM-eligible (Req 5.5).
// Today this is a deterministic placeholder that emits a steady mid-band
// confidence; task 6.2 will swap in a real classifier here. The seam is the
// `iterCtx.detectedIntent` slot.
// ---------------------------------------------------------------------------
async function detectIntent(state: LoopState): Promise<Partial<LoopState>> {
  // LLM
  const iter = state.iter;
  const userText = state.input.userText.toLowerCase();
  // Cheap heuristics so the placeholder is at least mildly informative; a
  // proper classifier will replace this entirely.
  let intent = "unknown";
  if (/\b(order|kine|kinbo|nibo|nite|chai)\b/.test(userText)) intent = "purchase";
  else if (/\b(price|dam|kotha|koto)\b/.test(userText)) intent = "inquiry";
  else if (/\b(cancel|baad|bad|nay)\b/.test(userText)) intent = "cancel";
  else if (/\b(thanks|thank you|dhonnobad|tnx)\b/.test(userText)) intent = "thanks";
  state.iterCtx.detectedIntent = { intent, confidence_score: 0.7 };
  state.iterCtx.classifierAvailable = false;
  state.iterCtx.confidenceScores.intent = 0.7;
  const step = makeStepLog({
    iter,
    step: "detect_intent",
    tool: "(step)",
    argsPayload: { intent, confidence_score: 0.7 },
    ok: true,
    observation: `intent=${intent} (placeholder; classifier=disabled)`,
    fsmState: state.iterCtx.workingSnapshot.order_state,
    confidenceLevel: state.iterCtx.workingSnapshot.confidence_level,
    confidenceScores: state.iterCtx.confidenceScores,
  });
  return { steps: [...state.steps, step] };
}

// ---------------------------------------------------------------------------
// Stage 5: detect_missing_info — deterministic.
// Reads `snapshot.missing_information` and surfaces it as an observation. Real
// slot-detection logic lives in the cart/customer tools; this stage is a
// summariser only and DOES NOT mutate the slot list.
// ---------------------------------------------------------------------------
async function detectMissingInfo(state: LoopState): Promise<Partial<LoopState>> {
  // deterministic
  const iter = state.iter;
  const snap = state.iterCtx.workingSnapshot;
  const slots = snap.missing_information;
  // Deterministic order-completeness score (task 6.3, Req 11.1/11.5). Replaces
  // the earlier `1.0 - slots.length * 0.15` heuristic with the documented
  // weighting in `state.ts::computeOrderCompleteness` so the FINAL_CONFIRMATION
  // rollback (task 6.4 / Req 11.5) sees a meaningful score.
  const completeness = computeOrderCompleteness(snap);
  state.iterCtx.confidenceScores.order_completeness = completeness;
  const obs =
    slots.length === 0
      ? "no missing slots"
      : `missing slots: ${slots
          .map((s) => `${s.slot}${s.line_id ? `(line=${s.line_id})` : ""}`)
          .join(", ")}`;
  const step = makeStepLog({
    iter,
    step: "detect_missing_info",
    tool: "(step)",
    argsPayload: { slots: slots.map((s) => ({ slot: s.slot, line_id: s.line_id ?? null, attempts: s.attempts })) },
    ok: true,
    observation: obs,
    fsmState: snap.order_state,
    confidenceLevel: snap.confidence_level,
    confidenceScores: state.iterCtx.confidenceScores,
  });
  return { steps: [...state.steps, step] };
}

// ---------------------------------------------------------------------------
// Stage 6: choose_action — LLM (Req 5.5).
// Calls the router ONCE per iteration. The same RouterCall result is reused by
// `choose_tools` (stage 7) — one LLM round-trip produces TWO trace rows so the
// pipeline still emits ten rows per iteration without doubling LLM cost.
// ---------------------------------------------------------------------------
async function chooseAction(state: LoopState): Promise<Partial<LoopState>> {
  // LLM
  const iter = state.iter;
  const snap = state.iterCtx.workingSnapshot;
  const r = await askRouter({
    input: state.input,
    tools: TOOLS,
    snapshot: snap,
    history: state.history,
    steps: state.steps,
    retry: state.needsRetry,
  });
  const isOk = (resp: typeof r): resp is RouterOk => "decision" in resp;
  if (!isOk(r)) {
    // One-shot corrective retry: flag and try again on the very next iteration.
    state.iterCtx.router = {
      tool: "",
      args: {},
      thought: "",
      latencyMs: r.latencyMs,
      error: r.error,
    };
    const step = makeStepLog({
      iter,
      step: "choose_action",
      tool: "(router)",
      argsPayload: { error: r.error },
      ok: false,
      observation: `router error: ${r.error}`,
      llmLatencyMs: r.latencyMs,
      fsmState: snap.order_state,
      confidenceLevel: snap.confidence_level,
      confidenceScores: state.iterCtx.confidenceScores,
    });
    return { steps: [...state.steps, step], needsRetry: !state.needsRetry };
  }
  const dec = r.decision;
  state.iterCtx.router = {
    tool: dec.tool,
    args: { ...dec.args },
    thought: dec.thought,
    latencyMs: r.latencyMs,
    error: null,
  };
  state.iterCtx.effectiveTool = dec.tool;
  state.iterCtx.effectiveArgs = { ...dec.args };
  const step = makeStepLog({
    iter,
    step: "choose_action",
    tool: dec.tool,
    argsPayload: dec.args,
    ok: true,
    observation: `chose tool=${dec.tool}`,
    thought: dec.thought,
    llmLatencyMs: r.latencyMs,
    fsmState: snap.order_state,
    confidenceLevel: snap.confidence_level,
    confidenceScores: state.iterCtx.confidenceScores,
  });
  return { steps: [...state.steps, step], needsRetry: false };
}

// ---------------------------------------------------------------------------
// Stage 7: choose_tools — LLM (Req 5.5).
// Emits the SECOND trace row for the single router round-trip from stage 6.
// Behaviour comment per the task brief: this stage SHARES the router call and
// just records the chosen tool/args separately so replay tooling can split
// "what did the LLM decide to do" from "which tool was actually invoked".
// ---------------------------------------------------------------------------
async function chooseTools(state: LoopState): Promise<Partial<LoopState>> {
  // LLM
  const iter = state.iter;
  const snap = state.iterCtx.workingSnapshot;
  const r = state.iterCtx.router;
  if (!r || r.error) {
    const step = makeStepLog({
      iter,
      step: "choose_tools",
      tool: "(router)",
      argsPayload: { error: r?.error ?? "no_router_call" },
      ok: false,
      observation: r?.error ? `router error: ${r.error}` : "no router decision available",
      fsmState: snap.order_state,
      confidenceLevel: snap.confidence_level,
      confidenceScores: state.iterCtx.confidenceScores,
    });
    return { steps: [...state.steps, step] };
  }
  // Validate the chosen tool name against the registry.
  const exists = !!findTool(r.tool);
  const step = makeStepLog({
    iter,
    step: "choose_tools",
    tool: r.tool,
    argsPayload: r.args,
    ok: exists,
    observation: exists
      ? `tool resolved: ${r.tool}`
      : `unknown tool: ${r.tool}`,
    thought: r.thought || undefined,
    // llmLatencyMs intentionally 0 here — the LLM call was already accounted
    // for on the choose_action row. Marking the second row with 0 prevents
    // double-counting in any replay/aggregation tooling.
    llmLatencyMs: 0,
    fsmState: snap.order_state,
    confidenceLevel: snap.confidence_level,
    confidenceScores: state.iterCtx.confidenceScores,
  });
  return { steps: [...state.steps, step], needsRetry: state.needsRetry || !exists };
}

// ---------------------------------------------------------------------------
// Stage 8: verify_pre_response — deterministic (task 4.3, Req 9.2/9.5).
// Runs the reference resolver for cart-mutating tools, overlays the resolved
// line_id / sku onto the LLM's args, and downgrades to a clarification reply
// when confidence < CONFIDENCE_THRESHOLDS.high. Also stamps composite
// confidence + the implied FSM target for trace replay.
// ---------------------------------------------------------------------------
async function verifyPreResponse(state: LoopState): Promise<Partial<LoopState>> {
  // deterministic
  const iter = state.iter;
  const snap = state.iterCtx.workingSnapshot;
  const ctx = state.iterCtx;
  const tool = ctx.effectiveTool;
  let observation = `pre-check ok for tool=${tool || "(none)"}`;
  let argsOverlay: Record<string, unknown> | null = null;
  let overrideToReply: string | null = null;
  let antiLoopFired = false;

  // -------------------------------------------------------------------------
  // Anti-Loop Guard (task 5.3 / Reqs 8.5, 12.6, 14.5).
  //
  // Runs BEFORE the reference-resolver overlay so a slot question that is
  // about to recycle for the third time is intercepted regardless of which
  // path produced the reply (router-picked `reply` OR a clarification reply
  // we'll write ourselves below). When the chosen tool is `reply`, look at
  // its text — if it reads as a slot question AND that slot already has
  // `attempts >= MAX_SLOT_ATTEMPTS`, swap in the FSM-aware fallback. Otherwise
  // increment the slot's `attempts` so the same question can't recycle
  // forever. Slot-attempt RESET when a slot moves to `confirmed_information`
  // is handled in `tools/missingSlots.ts::syncLineSlots` — when the slot leaves
  // `missing_information`, its row (and its attempts counter) is dropped.
  // -------------------------------------------------------------------------
  if (tool === "reply") {
    const replyText = typeof ctx.effectiveArgs?.text === "string"
      ? (ctx.effectiveArgs.text as string)
      : "";
    if (isSlotQuestion(replyText) && snap.missing_information.length > 0) {
      const idx = findAskedSlotIndex(snap, replyText);
      if (idx !== null) {
        const slot = snap.missing_information[idx]!;
        if (slot.attempts >= MAX_SLOT_ATTEMPTS) {
          // Third repeat — swap the reply for the fallback summary.
          const fallback = buildAntiLoopFallbackReply(snap, slot);
          overrideToReply = fallback;
          antiLoopFired = true;
          observation =
            `anti-loop guard fired for slot=${slot.slot} (attempts=${slot.attempts}); ` +
            `swapped reply for FSM-aware fallback`;
          logOverride({
            ctx: makeLogCtx(state, iter),
            kind: "anti_loop",
            tool: "reply",
            args: ctx.effectiveArgs,
            reason: `slot_attempts_cap:${slot.slot}:${slot.attempts}`,
          });
          ctx.effectiveArgs = { text: fallback };
        } else {
          // Increment attempts so the next same-slot question hits the cap.
          // We mutate the working snapshot's row in place (the reducer pattern
          // `[...]` would also work; mutation is safe here because the
          // snapshot is owned by this iter context and saveMemory persists it).
          const nextMissing = snap.missing_information.map((row, i) =>
            i === idx ? { ...row, attempts: row.attempts + 1 } : row,
          );
          ctx.workingSnapshot = { ...snap, missing_information: nextMissing };
          observation =
            `slot ask detected (slot=${slot.slot}, attempts=${slot.attempts} → ${slot.attempts + 1}); ` +
            `incremented attempts counter`;
        }
      }
    }
  }

  if (!antiLoopFired && tool && CART_MUTATION_TOOLS.has(tool)) {
    // Reference resolution is a FALLBACK for ambiguous customer phrasing, not a
    // gate on every cart mutation. Skip it entirely when:
    //
    //   (a) The router already supplied a concrete grounded target — a
    //       `line_id` for line-targeted tools or a `sku` already in the
    //       grounding set (shownSkus / lastShown / cart). The grounding set is
    //       what `assertSkuGrounded` in `tools/cart.ts` checks, so if a sku is
    //       in it, the customer has SEEN this product earlier in the
    //       conversation and a direct add is fine.
    //   (b) The customer's message has no reference-like phrasing
    //       (no ordinals like "first/prothom/1 ta", no pronouns "ei/oi ta",
    //       no product code patterns). When the message is just a SKU,
    //       a size, or a product name the LLM already mapped, running the
    //       resolver against it returns `kind:"none"` and would clobber a
    //       perfectly valid action with a clarification loop.
    //
    // The resolver only fires when there's actually a reference to resolve.
    const args = ctx.effectiveArgs ?? {};
    const argLineId = typeof args["line_id"] === "string" ? (args["line_id"] as string).trim() : "";
    const argSku = typeof args["sku"] === "string" ? (args["sku"] as string).trim() : "";

    // (a) Grounded-target check.
    let argsAlreadyGrounded = false;
    if (LINE_TARGETED_TOOLS.has(tool)) {
      // Line-targeted tools need a line_id that exists on the cart.
      argsAlreadyGrounded =
        argLineId.length > 0 && snap.cart.some((c) => c.line_id === argLineId);
    } else if (PRODUCT_TARGETED_TOOLS.has(tool)) {
      // Product-targeted tools need a sku that's been shown / is in cart.
      const groundingPool = new Set<string>();
      for (const s of snap.shownSkus) groundingPool.add(s);
      for (const r of snap.lastShown ?? []) groundingPool.add(r.sku);
      for (const c of snap.cart) groundingPool.add(c.sku);
      argsAlreadyGrounded = argSku.length > 0 && groundingPool.has(argSku);
    }

    // (b) Reference-phrase check on the customer message.
    const userTextLower = state.input.userText.toLowerCase();
    // Anaphoric phrases the resolver knows how to handle. Conservative — when in
    // doubt, leave the action alone and let the tool's own grounding guard
    // surface a meaningful error.
    const hasReferencePhrase =
      // English ordinals / pronouns ("first", "second", "1st", "this one", "the red one", "another one")
      /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|this one|that one|the\s+\w+\s+one|another one|same one|it\b)/.test(
        userTextLower,
      ) ||
      // Banglish ordinals / demonstratives ("prothom", "ei ta", "ekta", "WC26 ta")
      /\b(prothom|dwitiyo|tritiyo|ei ta|oi ta|sei ta|ekta|onno ta|ek ta)\b/.test(userTextLower) ||
      // "1 ta" / "2 ta" patterns (numeric ordinal Banglish)
      /\b\d+\s*ta\b/.test(userTextLower) ||
      // "the <noun>" attribute reference ("the boot", "the jersey", "the red one")
      // — only counts when the noun matches a product or distinctive attribute
      // already on the cart, so a plain "the price" doesn't trigger.
      /\bthe\s+\w{3,}/.test(userTextLower) ||
      // Product-code phrasing ("WC26 ta")
      /\b[A-Z]{1,4}\d{1,4}\s*ta\b/i.test(state.input.userText) ||
      // Bare ordinal numeric ("1", "2") as the entire utterance
      /^\s*[1-9]\s*$/.test(userTextLower) ||
      // "make/change the X size Y" / Banglish equivalents — these target a cart line
      /\b(make|change|update|modify)\b/.test(userTextLower);

    const shouldRunResolver = !argsAlreadyGrounded && hasReferencePhrase;

    if (shouldRunResolver) {
      const resolution = resolveReference(snap, state.input.userText, {
        onResolve: (ref) => {
          // Persist the resolution into the working snapshot so the next stage
          // (and the next iteration's renderSnapshot) sees it.
          ctx.workingSnapshot = appendRecentReference(ctx.workingSnapshot, ref);
        },
      });
      if (
        resolution.kind === "none" ||
        resolution.confidence_score < CONFIDENCE_THRESHOLDS.high
      ) {
        // Below the high band — disambiguate instead of mutating.
        const text = buildDisambiguationReply(snap, resolution);
        overrideToReply = text;
        observation =
          `reference resolution below high threshold (kind=${resolution.kind}, conf=${resolution.confidence_score.toFixed(2)}); ` +
          `overriding to clarification reply`;
        logOverride({
          ctx: makeLogCtx(state, iter),
          kind: "anti_hallucination",
          tool,
          args: ctx.effectiveArgs,
          reason: `low_resolution_confidence:${resolution.kind}:${resolution.confidence_score.toFixed(2)}`,
        });
        ctx.effectiveTool = "reply";
        ctx.effectiveArgs = { text };
      } else {
        const overlay = buildResolverArgsOverlay(tool, resolution, ctx.workingSnapshot);
        if (overlay.ok) {
          argsOverlay = overlay.args;
          ctx.effectiveArgs = { ...ctx.effectiveArgs, ...overlay.args };
          observation = `resolver overlay: ${overlay.targetSummary} (conf=${resolution.confidence_score.toFixed(2)})`;
        } else {
          // Wrong target shape — fall back to clarification.
          const text = buildDisambiguationReply(snap, resolution);
          overrideToReply = text;
          observation = `resolver overlay failed (${overlay.reason}); overriding to clarification`;
          logOverride({
            ctx: makeLogCtx(state, iter),
            kind: "anti_hallucination",
            tool,
            args: ctx.effectiveArgs,
            reason: `overlay_${overlay.reason}`,
          });
          ctx.effectiveTool = "reply";
          ctx.effectiveArgs = { text };
        }
      }
    } else if (!argsAlreadyGrounded) {
      // Tool-mutation called without a grounded target AND no reference phrase
      // to resolve. Defer to the tool's own grounding guard (e.g.
      // `assertSkuGrounded` in `tools/cart.ts`) — that's where the right error
      // surface lives.
      observation = `cart-mutation pre-check: args.${LINE_TARGETED_TOOLS.has(tool) ? "line_id" : "sku"} not grounded and no reference phrase; deferring to tool guard`;
    } else {
      // Args already grounded and no reference phrase. Pass-through.
      observation = `cart-mutation pre-check: args already grounded (${LINE_TARGETED_TOOLS.has(tool) ? `line_id=${argLineId}` : `sku=${argSku}`}); resolver skipped`;
    }
  }

  // -------------------------------------------------------------------------
  // FSM transition enforcement (task 5.4 / Reqs 7.4, 7.5).
  //
  // Runs AFTER the anti-loop guard and the reference-resolver overlay so the
  // FSM check looks at the EFFECTIVE tool the loop is about to run.
  //
  // SCOPE — we ONLY gate "order-finalising" tools here (confirm/create/
  // validate_order). Cart-mutating tools like `add_to_cart` MUST NOT be gated
  // on `CART_BUILDING_precondition_empty_cart`: that's circular — the tool is
  // exactly what creates the precondition. The FSM auto-advance step in
  // `saveMemory` updates `order_state` AFTER the cart mutation lands, so the
  // next turn's gate sees the correct state. This matches Req 7.4 (only the
  // terminal confirmation step is gated by full preconditions).
  //
  // Skipped when the effective tool is `reply` / `escalate_to_human` (no FSM
  // implication) or when the tool isn't in the gated set.
  // -------------------------------------------------------------------------
  const FSM_GATED_TOOLS: ReadonlySet<string> = new Set([
    "confirm_order",
    "create_order",
    "validate_order",
  ]);
  let fsmBlocked = false;
  let fsmOverrideReason: string | null = null;
  if (
    !overrideToReply &&
    ctx.effectiveTool &&
    FSM_GATED_TOOLS.has(ctx.effectiveTool)
  ) {
    const implied = inferImpliedFsmTarget(ctx.effectiveTool);
    if (implied) {
      const check = canTransition(ctx.workingSnapshot.order_state, implied, ctx.workingSnapshot);
      if (!check.ok) {
        const suggested = nextSuggestedState(ctx.workingSnapshot);
        const text = buildFsmBlockReply(check.reason, ctx.workingSnapshot);
        const reasonLog = `illegal_transition_to_${implied}:${check.reason}`;
        logOverride({
          ctx: makeLogCtx(state, iter),
          kind: "fsm_block",
          tool: ctx.effectiveTool,
          args: ctx.effectiveArgs,
          reason: reasonLog,
        });
        fsmBlocked = true;
        fsmOverrideReason = reasonLog;
        observation =
          `fsm_block: ${ctx.effectiveTool} → ${implied} illegal from ${ctx.workingSnapshot.order_state} ` +
          `(${check.reason}); routing to clarification toward ${suggested}`;
        ctx.effectiveTool = "reply";
        ctx.effectiveArgs = { text };
        overrideToReply = text;
      }
    }
  }

  // Composite confidence per Req 11.6: min of the per-step triple.
  const tri = ctx.confidenceScores;
  ctx.composite = Math.min(tri.product_match, tri.intent, tri.order_completeness);
  ctx.workingSnapshot = { ...ctx.workingSnapshot, confidence_level: ctx.composite };

  // -------------------------------------------------------------------------
  // Composite confidence gating (task 6.4 / Reqs 11.4, 11.5).
  //
  // Two independent gates, applied AFTER the FSM check and AFTER composite is
  // written into the working snapshot:
  //
  //   (a) below medium  → route to a clarification reply ("Ektu confused —
  //       apnar last message ta arekbar bolben please?"). Skipped when an
  //       upstream guard (anti-loop / resolver / FSM) already overrode the
  //       action — those clarifications are more specific and we don't want
  //       to clobber them with the generic confused-reply.
  //
  //   (b) below high AND fsm === FINAL_CONFIRMATION → roll the FSM back to
  //       ORDER_REVIEW so the loop re-confirms the cart on the next iteration
  //       (Req 11.5). Mutates the working snapshot's `order_state` only;
  //       cart and other state are untouched. The next iteration's verify
  //       will see ORDER_REVIEW and not loop on this branch again.
  //
  // (a) and (b) are mutually exclusive: if (a) fires we skip (b), and if (b)
  // fires we don't also overlay (a).
  // -------------------------------------------------------------------------
  let confidenceBlock: "below_medium" | null = null;
  let confidenceRollback = false;
  // The medium-confidence gate (Req 11.4) is scoped to "before any cart or order
  // mutation" — when the chosen action is already `reply` / `escalate_to_human`
  // the router has effectively already routed to a non-mutating clarification or
  // handoff, and overlaying a generic "Ektu confused" message on top would be
  // double-asking. Tools that mutate cart/order state are the ones that need the
  // gate; replies are not.
  //
  // Comprehension score = `min(product_match, intent)` — i.e. "do I understand
  // what the customer is asking?". `order_completeness` is intentionally
  // excluded from the gating decision because it reflects "is the order ready
  // to checkout?" and is naturally low during normal CART_BUILDING. Gating
  // cart mutations on it would block legitimate flows. The full composite
  // (including order_completeness) still lands on `snapshot.confidence_level`
  // for telemetry and for the FINAL_CONFIRMATION rollback gate below, where
  // "is the order complete?" is exactly the question we're asking.
  const isMutationTool =
    ctx.effectiveTool && ctx.effectiveTool !== "reply" && ctx.effectiveTool !== "escalate_to_human";
  const comprehension = Math.min(tri.product_match, tri.intent);
  if (comprehension < CONFIDENCE_THRESHOLDS.medium && isMutationTool) {
    if (!overrideToReply) {
      const text =
        "Ektu confused — apnar last message ta arekbar bolben please?";
      logOverride({
        ctx: makeLogCtx(state, iter),
        kind: "anti_hallucination",
        tool: ctx.effectiveTool || "(none)",
        args: ctx.effectiveArgs,
        reason: `low_composite_confidence:${ctx.composite.toFixed(2)}`,
      });
      ctx.effectiveTool = "reply";
      ctx.effectiveArgs = { text };
      overrideToReply = text;
      confidenceBlock = "below_medium";
      observation =
        `composite confidence ${ctx.composite.toFixed(2)} < medium ` +
        `${CONFIDENCE_THRESHOLDS.medium.toFixed(2)}; routing to clarification reply`;
    }
  } else if (
    !overrideToReply &&
    ctx.composite < CONFIDENCE_THRESHOLDS.high &&
    ctx.workingSnapshot.order_state === "FINAL_CONFIRMATION"
  ) {
    logOverride({
      ctx: makeLogCtx(state, iter),
      kind: "fsm_block",
      tool: ctx.effectiveTool || "(none)",
      args: ctx.effectiveArgs,
      reason: `rollback_from_final_confirmation:${ctx.composite.toFixed(2)}`,
    });
    ctx.workingSnapshot = { ...ctx.workingSnapshot, order_state: "ORDER_REVIEW" };
    confidenceRollback = true;
    observation =
      `composite confidence ${ctx.composite.toFixed(2)} < high ` +
      `${CONFIDENCE_THRESHOLDS.high.toFixed(2)} at FINAL_CONFIRMATION; rolled back to ORDER_REVIEW`;
  }

  const impliedFsm = inferImpliedFsmTarget(ctx.effectiveTool);
  const step = makeStepLog({
    iter,
    step: "verify_pre_response",
    tool: ctx.effectiveTool || "(none)",
    argsPayload: {
      ...(argsOverlay ? { resolverOverlay: argsOverlay } : {}),
      ...(overrideToReply ? { overrideToReply: true } : {}),
      ...(antiLoopFired ? { antiLoop: true } : {}),
      ...(fsmBlocked ? { fsmBlocked: true } : {}),
      ...(fsmOverrideReason ? { fsmReason: fsmOverrideReason } : {}),
      ...(confidenceBlock ? { confidenceBlock } : {}),
      ...(confidenceRollback ? { confidenceRollback: true } : {}),
      impliedFsmTarget: impliedFsm,
    },
    ok: true,
    observation,
    fsmState: ctx.workingSnapshot.order_state,
    confidenceLevel: ctx.composite,
    confidenceScores: tri,
  });
  return { steps: [...state.steps, step] };
}

// ---------------------------------------------------------------------------
// Stage 9: generate_response — LLM (Req 5.5).
// Actually executes the chosen tool via `findTool(...).handler(...)`. The
// terminal `reply` tool's customer-facing text is the LLM-generated reply
// composed inside the router prompt (so the LLM-marker still applies even
// though this node only invokes a handler). Anti-loop guards live here:
//   - Same-tool/same-args duplicate guard nudges the router on its next call.
//   - Same-observation repeat guard surfaces a warning row but still runs.
// ---------------------------------------------------------------------------
async function generateResponse(state: LoopState): Promise<Partial<LoopState>> {
  // LLM
  const iter = state.iter;
  const ctx = state.iterCtx;
  const toolName = ctx.effectiveTool;
  if (!toolName) {
    const step = makeStepLog({
      iter,
      step: "generate_response",
      tool: "(none)",
      argsPayload: {},
      ok: false,
      observation: "no tool chosen this iteration",
      fsmState: ctx.workingSnapshot.order_state,
      confidenceLevel: ctx.composite,
      confidenceScores: ctx.confidenceScores,
    });
    ctx.lastToolResult = { ok: false, error: "no_tool", observation: "no tool" };
    return { steps: [...state.steps, step] };
  }
  const tool = findTool(toolName);
  if (!tool) {
    const step = makeStepLog({
      iter,
      step: "generate_response",
      tool: toolName,
      argsPayload: ctx.effectiveArgs,
      ok: false,
      observation: `unknown tool: ${toolName}`,
      fsmState: ctx.workingSnapshot.order_state,
      confidenceLevel: ctx.composite,
      confidenceScores: ctx.confidenceScores,
    });
    ctx.lastToolResult = { ok: false, error: "unknown_tool", observation: `unknown tool: ${toolName}` };
    return { steps: [...state.steps, step] };
  }

  // Anti-loop guard — count prior runs of (tool, JSON(args)).
  const argsKey = JSON.stringify(ctx.effectiveArgs ?? {});
  const sameToolArgsCount = state.steps.filter(
    (s) => s.step === "generate_response" && s.tool === toolName && JSON.stringify(s.args ?? {}) === argsKey,
  ).length;
  if (sameToolArgsCount >= 2) {
    logOverride({
      ctx: makeLogCtx(state, iter),
      kind: "anti_loop",
      tool: toolName,
      args: ctx.effectiveArgs,
      reason: `same_tool_args_count=${sameToolArgsCount}`,
    });
  }

  // Run the handler. Persistence inside `ctx.saveSnapshot` updates our working
  // copy so subsequent stages see the post-tool snapshot.
  const handlerCtx: ToolHandlerCtx = {
    input: state.input,
    snapshot: ctx.workingSnapshot,
    saveSnapshot: async (next: AgentSnapshot) => {
      ctx.workingSnapshot = next;
      if (state.input.conversationId) {
        try {
          await saveSnapshot(state.input.conversationId, next);
        } catch (e) {
          logger.warn(
            { e: String(e), conversationId: state.input.conversationId },
            "agent.loop tool saveSnapshot failed",
          );
        }
      }
    },
  };

  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof tool.handler>>;
  try {
    result = await tool.handler(ctx.effectiveArgs, handlerCtx);
  } catch (e) {
    result = {
      ok: false,
      error: "tool_threw",
      observation: `tool threw: ${String(e).slice(0, 200)}`,
    };
  }
  const toolLatencyMs = Date.now() - t0;
  ctx.lastToolResult = result;
  ctx.lastToolLatencyMs = toolLatencyMs;

  logToolCall({
    ctx: makeLogCtx(state, iter),
    tool: toolName,
    args: ctx.effectiveArgs,
    ok: result.ok,
    data: result.ok ? (result as { data?: unknown }).data : undefined,
    latencyMs: toolLatencyMs,
    ...(!result.ok ? { errorCode: (result as { error: string }).error } : {}),
  });

  // Same-observation repeat nudge.
  const sameObsCount = state.steps.filter(
    (s) => s.step === "generate_response" && s.observation === result.observation,
  ).length;
  if (sameObsCount >= 2) {
    logOverride({
      ctx: makeLogCtx(state, iter),
      kind: "anti_loop_nudge",
      tool: toolName,
      args: ctx.effectiveArgs,
      reason: `same_obs_count=${sameObsCount}`,
    });
  }

  const step = makeStepLog({
    iter,
    step: "generate_response",
    tool: toolName,
    argsPayload: ctx.effectiveArgs,
    ok: result.ok,
    observation: result.observation,
    toolLatencyMs,
    fsmState: ctx.workingSnapshot.order_state,
    confidenceLevel: ctx.composite,
    confidenceScores: ctx.confidenceScores,
  });

  let reply: string | null = state.reply;
  let done = state.done;
  let reason: LoopState["reason"] = state.reason;
  if (result.ok && (result as { terminal?: boolean }).terminal) {
    reply = (result as { reply?: string }).reply ?? reply;
    done = true;
    reason = "terminal";
  }
  return {
    steps: [...state.steps, step],
    reply,
    done,
    reason,
    snapshot: ctx.workingSnapshot,
  };
}

// ---------------------------------------------------------------------------
// Stage 10: save_memory — deterministic.
// Persists the working snapshot once per iteration and reconciles the
// abandoned-cart follow-up scheduler. Best-effort: failures here MUST NOT
// fail the user-visible reply.
// ---------------------------------------------------------------------------
async function saveMemory(state: LoopState): Promise<Partial<LoopState>> {
  // deterministic
  const iter = state.iter;
  const ctx = state.iterCtx;
  let snap = ctx.workingSnapshot;

  // -------------------------------------------------------------------------
  // FSM auto-advance (Req 7.4).
  //
  // After every iteration, snap `order_state` to whatever `nextSuggestedState`
  // says the snapshot should be in given its actual contents. This is the
  // counterpart to the `verify_pre_response` gate: the gate only blocks
  // confirm/create/validate_order, so cart mutators run freely and CHANGE the
  // snapshot's shape — this step is what makes `order_state` follow.
  //
  // ORDER ranking is used so we never DOWNGRADE the FSM mid-flow. Once a
  // snapshot has reached `ORDER_REVIEW` or `FINAL_CONFIRMATION`, we keep it
  // there even if `nextSuggestedState` would route somewhere earlier (e.g.
  // because a slot just got cleared). `ORDER_COMPLETE` is handled by the
  // dedicated reset block below.
  //
  // INHIBITION — auto-advance MUST NOT fire when this iteration was blocked
  // by any of the verify_pre_response gates (anti-hallucination, FSM block,
  // confidence rollback, anti-loop, resolver-overlay clarification). In those
  // cases the iteration ended in a clarification reply and the snapshot is
  // intentionally preserved as-is so the next turn re-evaluates from the
  // same starting point.
  // -------------------------------------------------------------------------
  const lastVerify = [...state.steps].reverse().find((s) => s.step === "verify_pre_response");
  const verifyArgs = (lastVerify?.args ?? {}) as Record<string, unknown>;
  const blockedByVerify =
    verifyArgs.overrideToReply === true ||
    verifyArgs.fsmBlocked === true ||
    verifyArgs.antiLoop === true ||
    verifyArgs.confidenceRollback === true ||
    typeof verifyArgs.confidenceBlock === "string";
  if (snap.order_state !== "ORDER_COMPLETE" && !blockedByVerify) {
    const FSM_RANK: Record<OrderFSMState, number> = {
      BROWSING: 0,
      PRODUCT_SELECTION: 1,
      CART_BUILDING: 2,
      MISSING_INFO_COLLECTION: 3,
      ADDRESS_COLLECTION: 4,
      PAYMENT_SELECTION: 5,
      ORDER_REVIEW: 6,
      FINAL_CONFIRMATION: 7,
      ORDER_COMPLETE: 8,
    };
    const suggested = nextSuggestedState(snap);
    const currentRank = FSM_RANK[snap.order_state] ?? 0;
    const suggestedRank = FSM_RANK[suggested] ?? 0;
    // Only advance forward. The suggestion may be lower-ranked than current
    // (e.g. cart became empty → BROWSING) and that IS a legitimate downgrade,
    // so allow that special case (cart empty / browsing reset). For other
    // downgrades, keep the current state.
    let advancedTo: OrderFSMState | null = null;
    if (suggested !== snap.order_state) {
      if (suggestedRank > currentRank) {
        advancedTo = suggested;
      } else if (suggested === "BROWSING" && snap.cart.length === 0) {
        // Cart got cleared (e.g. confirm_order succeeded and the line was
        // wiped). Downgrade to BROWSING to start a fresh shopping turn.
        advancedTo = "BROWSING";
      }
    }
    if (advancedTo) {
      logOverride({
        ctx: makeLogCtx(state, iter),
        kind: "fsm_block",
        tool: "(state)",
        reason: `fsm_auto_advance:${snap.order_state}->${advancedTo}`,
      });
      snap = { ...snap, order_state: advancedTo };
      ctx.workingSnapshot = snap;
    }
  }

  // ORDER_COMPLETE reset (task 5.4 / Req 7.6).
  // When the iteration leaves the snapshot in `ORDER_COMPLETE`, clear the cart
  // and reset the FSM back to `BROWSING` so the next inbound message starts
  // a fresh shopping turn. Logged informationally via the override channel so
  // operators can see the reset point in trace replay.
  if (snap.order_state === "ORDER_COMPLETE") {
    logOverride({
      ctx: makeLogCtx(state, iter),
      kind: "fsm_block",
      tool: "(state)",
      reason: "order_complete_reset",
    });
    snap = {
      ...snap,
      cart: [],
      order_state: "BROWSING",
      missing_information: [],
    };
    ctx.workingSnapshot = snap;
  }

  let ok = true;
  let obs = `snapshot persisted (cart=${snap.cart.length}, fsm=${snap.order_state})`;
  if (state.input.conversationId) {
    try {
      await saveSnapshot(state.input.conversationId, snap);
    } catch (e) {
      ok = false;
      obs = `saveSnapshot failed: ${String(e).slice(0, 160)}`;
    }
  } else {
    obs = "no conversationId — snapshot kept in memory only";
  }
  // Long-term memory write-back (Req 1.5, 13.2, 13.5; task 9.1). Diff
  // `snapshot.customer_preferences` against the prior `CustomerProfile.preferences`
  // and merge the result. Bounded list keys (`favorite_teams`, `recent_sizes`,
  // `last_5_orders`) are unioned and capped at 5; all other keys overwrite.
  // Best-effort: failures here MUST NOT fail saveMemory or the user-visible
  // reply — `mergePreferences` itself is no-op when the patch is empty and
  // logs+swallows DB errors internally; the try/catch here is a belt-and-
  // suspenders guard against unexpected throws.
  try {
    const prefs = snap.customer_preferences;
    if (prefs && typeof prefs === "object" && !Array.isArray(prefs)) {
      const patch = prefs as Record<string, unknown>;
      if (Object.keys(patch).length > 0) {
        await mergePreferences(state.input.tenantId, state.input.psid, patch);
      }
    }
  } catch (e) {
    logger.warn({ e: String(e) }, "agent.loop mergePreferences failed");
  }
  // Abandoned-cart reconciliation (Req 13.3, task 9.3). Best-effort.
  try {
    await reconcileAbandonedCartFollowUp({
      tenantId: state.input.tenantId,
      psid: state.input.psid,
      ...(state.input.conversationId ? { conversationId: state.input.conversationId } : {}),
      snapshot: snap,
    });
  } catch (e) {
    logger.warn({ e: String(e) }, "agent.loop reconcileAbandonedCartFollowUp failed");
  }

  // Bump iteration counter for the next loop.
  const nextIter = state.iter + 1;
  const overCap = nextIter > MAX_ITER;
  let done = state.done;
  let reason: LoopState["reason"] = state.reason;
  if (overCap && !done) {
    done = true;
    reason = "max_iter";
  }
  // Reset the per-iter scratch but preserve the bootstrapped snapshot so
  // re-entries skip the bootstrap stages.
  const nextCtx: IterContext = {
    ...emptyIterCtx(),
    bootstrapDone: true,
    workingSnapshot: snap,
  };
  const step = makeStepLog({
    iter,
    step: "save_memory",
    tool: "(step)",
    argsPayload: { cart: snap.cart.length, fsm: snap.order_state, persisted: ok },
    ok,
    observation: obs,
    fsmState: snap.order_state,
    confidenceLevel: snap.confidence_level,
  });
  return {
    steps: [...state.steps, step],
    snapshot: snap,
    iter: nextIter,
    done,
    reason,
    iterCtx: nextCtx,
  };
}

/**
 * Public seed type for {@link runIterPipeline}: same as `LoopState` but with
 * `iterCtx` and `turnId` optional, because callers (tests, replay tooling)
 * shouldn't have to construct the per-iter scratch by hand. The pipeline fills
 * a fresh `iterCtx` if absent.
 */
export type IterPipelineSeed = Omit<LoopState, "iterCtx" | "turnId"> & {
  iterCtx?: IterContext;
  turnId?: string;
};

/**
 * Drive ONE iteration through the 10 named pipeline stages, in the same order
 * the `StateGraph` would (observe_input → save_memory). Returns an
 * {@link IterResult} so white-box callers (tests, replay tooling) can assert on
 * the per-iter row shape WITHOUT spinning up the full graph runtime.
 *
 * The first call should pass `iter: 1`. Subsequent iterations within the same
 * turn should re-enter at `detectIntent` directly (stages 1–3 are once-per-turn
 * — see the `StateGraph` wiring below).
 */
export async function runIterPipeline(seed: IterPipelineSeed): Promise<IterResult> {
  let s: LoopState = {
    ...seed,
    turnId: seed.turnId ?? newTurnId(),
    iterCtx: seed.iterCtx ?? emptyIterCtx(),
  };
  const apply = (patch: Partial<LoopState>): void => {
    s = { ...s, ...patch } as LoopState;
  };
  apply(await observeInput(s));
  apply(await retrieveSession(s));
  apply(await retrieveCart(s));
  apply(await detectIntent(s));
  apply(await detectMissingInfo(s));
  apply(await chooseAction(s));
  apply(await chooseTools(s));
  apply(await verifyPreResponse(s));
  apply(await generateResponse(s));
  apply(await saveMemory(s));
  return {
    steps: s.steps,
    snapshot: s.snapshot,
    reply: s.reply,
    terminal: s.done,
    reason: s.reason,
  };
}

// ---------------------------------------------------------------------------
// StateGraph wiring (Req 5.1).
//
// First iteration: START → observe_input → retrieve_session → retrieve_cart →
//                  detect_intent → detect_missing_info → choose_action →
//                  choose_tools → verify_pre_response → generate_response →
//                  save_memory → [conditional]
// Subsequent iterations re-enter at `detect_intent` (stages 1–3 are
// once-per-turn). The conditional edge after `save_memory` ends the turn when
// `done` is set OR the iteration cap is exceeded; otherwise loops back.
// ---------------------------------------------------------------------------
function buildAgentGraph() {
  const g = new StateGraph(State);
  g.addNode("observe_input", observeInput);
  g.addNode("retrieve_session", retrieveSession);
  g.addNode("retrieve_cart", retrieveCart);
  g.addNode("detect_intent", detectIntent);
  g.addNode("detect_missing_info", detectMissingInfo);
  g.addNode("choose_action", chooseAction);
  g.addNode("choose_tools", chooseTools);
  g.addNode("verify_pre_response", verifyPreResponse);
  g.addNode("generate_response", generateResponse);
  g.addNode("save_memory", saveMemory);

  // Linear bootstrap path through the 10 stages.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ge = g as any;
  ge.addEdge(START, "observe_input");
  ge.addEdge("observe_input", "retrieve_session");
  ge.addEdge("retrieve_session", "retrieve_cart");
  ge.addEdge("retrieve_cart", "detect_intent");
  ge.addEdge("detect_intent", "detect_missing_info");
  ge.addEdge("detect_missing_info", "choose_action");
  ge.addEdge("choose_action", "choose_tools");
  ge.addEdge("choose_tools", "verify_pre_response");
  ge.addEdge("verify_pre_response", "generate_response");
  ge.addEdge("generate_response", "save_memory");

  // Conditional loop-back: save_memory → END when terminal OR over-cap, else
  // re-enter at detect_intent (stages 1–3 are once-per-turn).
  ge.addConditionalEdges(
    "save_memory",
    (s: LoopState) => {
      if (s.done) return "end";
      if (s.iter > MAX_ITER) return "end";
      return "loop";
    },
    { end: END, loop: "detect_intent" },
  );
  return g.compile();
}

let CACHED_GRAPH: ReturnType<typeof buildAgentGraph> | null = null;
function getAgentGraph(): ReturnType<typeof buildAgentGraph> {
  if (!CACHED_GRAPH) CACHED_GRAPH = buildAgentGraph();
  return CACHED_GRAPH;
}

/**
 * Run a complete agent turn through the compiled `StateGraph`. Persists the
 * collected trace via `persistTurnTrace` and returns the final outcome.
 *
 * The caller is responsible for actually delivering `outcome.reply` (the reply
 * tool's handler also sends to Messenger; this layer just surfaces the text).
 */
export async function runAgentTurn(args: {
  input: AgentTurnInput;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  turnId?: string;
}): Promise<AgentRunOutcome> {
  const turnId = args.turnId ?? newTurnId();
  const initial: LoopState = {
    input: args.input,
    history: args.history,
    snapshot: {
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
    },
    steps: [],
    reply: null,
    done: false,
    reason: null,
    needsRetry: false,
    iter: 1,
    turnId,
    iterCtx: emptyIterCtx(),
  };

  const graph = getAgentGraph();
  let final: LoopState;
  try {
    // The compiled graph returns the final accumulated state.
    final = (await graph.invoke(initial, {
      recursionLimit: MAX_ITER * STEPS_PER_ITER + 10,
    })) as LoopState;
  } catch (e) {
    logger.error({ e: String(e), turnId }, "agent.runAgentTurn graph.invoke failed");
    const outcome: AgentRunOutcome = {
      steps: initial.steps,
      reason: "router_error",
      reply: null,
    };
    await persistTurnTrace({ input: args.input, turnId, outcome });
    return outcome;
  }

  const outcome: AgentRunOutcome = {
    steps: final.steps,
    reason: final.reason ?? (final.done ? "terminal" : "max_iter"),
    reply: final.reply,
  };
  await persistTurnTrace({ input: args.input, turnId, outcome });
  return outcome;
}
