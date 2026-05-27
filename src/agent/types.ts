import type { z } from "zod";
import type { OrderFSMState } from "./state.js";
// `import type` (not a runtime import) keeps the dependency graph clean —
// `types.ts` is loaded by every tool module and the loop, while
// `context/reasoningContext.ts` pulls in Prisma, the Category Engine, the
// Agent_Identity service, plan limits, and subscription state. Going through
// the value side here would create an import cycle (loop → tools/registry →
// tools/* → types → context/reasoningContext → ... → loop). The type-only
// import is erased at compile time and stays cycle-free.
import type { ReasoningContext } from "./context/reasoningContext.js";

// Re-export for downstream consumers that import from "./types.js".
export type { OrderFSMState };
export type { ReasoningContext };

/** Per-turn input passed in from the webhook handler. */
export type AgentTurnInput = {
  tenantId: string;
  tenantSlug: string;
  psid: string;
  conversationId: string;
  userText: string;
  imageUrls: string[];
  pageAccessToken: string;
  within24h: boolean;
  /**
   * Resolved Reasoning_Context for this turn (Multi-Tenant Commerce OS task 3.3).
   *
   * When the runner / router has already built the context (the common case in
   * production — `runAgentInbound` calls `buildReasoningContext` once per turn
   * and passes the frozen object through here), the loop reuses it instead of
   * re-resolving. When absent, `runAgentTurn` builds one before `observe_input`
   * runs and short-circuits with `reasoning_context_incomplete` /
   * `tenant_scope_missing` if construction fails.
   *
   * Tools should read tenant-scoped data through `ToolHandlerCtx.reasoningContext`
   * rather than re-issuing their own tenant lookups.
   */
  reasoningContext?: ReasoningContext;
};

export type AgentCartAddOn = {
  id: string;
  label: string;
  priceBdt: number;
  /** Customer-supplied content for slot-filled add-ons (e.g. "Limon 10" for name+number). */
  value?: string;
};

export type AgentCartItem = {
  sku: string;
  product: string;
  quantity: number;
  /**
   * Stable per-line identifier (cuid-style; minted via `crypto.randomUUID()`).
   * REQUIRED — every cart line carries one. `add_to_cart` mints a new id when appending a fresh
   * line and preserves the existing id when merging on (sku, size). `loadSnapshot` mints one for
   * legacy lines that pre-date this field so downstream code (modify_cart_item, remove_cart_item,
   * Reference_Resolution, missing_information) can address each line uniquely.
   */
  line_id: string;
  size?: string;
  unitPriceBdt?: number;
  addOns?: AgentCartAddOn[];
  /**
   * Computed per-line total in BDT: `(unitPriceBdt + sum(addOns.priceBdt)) * quantity`.
   * Refreshed by `recomputeStructuredCart` (in `state.ts`) whenever a cart-write path
   * persists the snapshot, so the value on the snapshot always reflects the current line
   * state (Requirements §2.2, §2.3). Optional on the type because in-flight construction
   * sites (e.g. inside `add_to_cart` before the recompute step) build the bare line first
   * and the totaliser fills it in; once persisted, every line carries one.
   */
  line_total?: number;
};

export type AgentCustomerProfile = {
  name?: string;
  phone?: string;
  address?: string;
};

/** A single per-line (or per-order) slot the agent still needs to collect. */
export type AgentMissingInfoSlot = {
  /** When the slot belongs to a specific cart line, this is the line_id; omitted for order-level slots. */
  line_id?: string;
  /** Slot identifier, e.g. "size", "quantity", "name-number", "address", "phone". */
  slot: string;
  /** How many times the agent has already asked the customer for this slot in the current conversation. */
  attempts: number;
};

/** A single deterministic reference resolution emitted by the reference resolver. */
export type AgentRecentReference = {
  /** The customer phrase that was resolved, e.g. "prothom ta", "the red one". */
  phrase: string;
  /** What kind of entity the phrase resolved to. */
  target_kind: "line" | "product";
  /** `line_id` for line targets, `sku` / `product_id` for product targets. */
  target_id: string;
  /** ISO-8601 timestamp captured when the resolution happened. */
  ts: string;
};

/**
 * Order-level delivery slot the agent surfaces to the LLM and mirrors into
 * `MessengerConversation.pendingDraftJson` (Requirements §2.1).
 *
 * Currently a thin wrapper over the customer-supplied address; the cost field
 * is reserved for tenants that quote a per-area delivery price (the agent reads
 * the tenant default from `parseTenantSettings` and writes the resolved cost
 * here once the address is known). Empty/null values mean "not yet collected"
 * and the structured-cart recompute keeps them as `null` defaults so downstream
 * consumers can distinguish "missing" from "zero".
 */
export type AgentDeliveryInfo = {
  address?: string | null;
  /** Per-order delivery charge in BDT (tenant-defined). `null` = not yet computed. */
  delivery_charge_bdt?: number | null;
};

/**
 * Structured cart object persisted on the snapshot (Requirements §2.1, §2.5).
 *
 * Every cart-mutating tool calls {@link recomputeStructuredCart} (in `state.ts`) BEFORE
 * `saveSnapshot`, so the persisted blob always carries:
 *
 * - `items`         — the line array (post-mutation), with each line's `line_total`
 *                     filled in.
 * - `subtotal`      — `sum(items[].line_total)` in BDT. `0` for an empty cart.
 * - `delivery_info` — order-level delivery (address + computed charge). `null` until
 *                     captured / computed.
 * - `payment_method`— customer's chosen payment method (e.g. `"cod"`, `"bkash"`).
 *                     `null` until `confirmed_information.order.payment_method` is set.
 * - `order_status`  — coarse-grained order lifecycle stamp derived from the FSM
 *                     (`"draft" | "review" | "confirmed" | "completed"`). `null` for
 *                     fresh conversations.
 *
 * `show_cart` and downstream readers MUST read these structured fields rather than
 * re-deriving from the loose cart array (Req 2.5: confirmation summaries are rendered
 * from the structured cart, never re-synthesised by the LLM).
 */
export type AgentStructuredCart = {
  items: AgentCartItem[];
  subtotal: number;
  delivery_info: AgentDeliveryInfo | null;
  payment_method: string | null;
  order_status: "draft" | "review" | "confirmed" | "completed" | null;
};

/**
 * The mutable state the agent reads/writes during a turn.
 * Persisted into MessengerConversation.pendingDraftJson so legacy + agent share the same cart.
 */
export type AgentSnapshot = {
  cart: AgentCartItem[];
  profile: AgentCustomerProfile;
  /** SKUs we showed to the customer this conversation — gives the router stable references. */
  shownSkus: string[];
  /**
   * SKUs from the MOST RECENT search_catalog observation, in the same order the customer saw them.
   * When the customer says "ei ta nibo" / "prothom ta" / "1 ta", the router should map "1" → lastShown[0]
   * instead of running a fresh search. Cleared/replaced on every search_catalog call.
   */
  lastShown?: Array<{ sku: string; label: string }>;
  /** Short label of what the customer is currently trying to do, e.g. "buy_jersey". `null` when unset. */
  active_goal: string | null;
  /** Current OrderFSM state. Defaults to "BROWSING" for fresh conversations. */
  order_state: OrderFSMState;
  /** Per-line and order-level slots the agent still needs to collect. */
  missing_information: AgentMissingInfoSlot[];
  /**
   * Slots the agent has already confirmed, keyed by `line_id` for per-line slots or by the literal
   * "order" for order-level slots (delivery, payment, contact). Inner record holds slot→value pairs.
   */
  confirmed_information: Record<string, Record<string, unknown>>;
  /** Long-term customer preferences staged for write-back into CustomerProfile.preferences. */
  customer_preferences: Record<string, unknown>;
  /** Compact summary of the conversation so the LLM can skim it cheaply. Empty string by default. */
  conversation_summary: string;
  /** Composite confidence in the current turn's reasoning, in `[0, 1]`. Defaults to 1.0. */
  confidence_level: number;
  /** True when the loop wants the abandoned-cart follow-up scheduler to fire. */
  followup_needed: boolean;
  /** Last 5 deterministic reference resolutions, newest last. */
  recent_references: AgentRecentReference[];
  /**
   * Structured cart projection (Req 2.1, 2.5). Always reflects the current `cart` after
   * the most recent mutation: `recomputeStructuredCart` (in `state.ts`) is called from
   * every cart-write tool before `saveSnapshot`, so consumers can read totals and the
   * order-level slots without recomputing. Optional only because legacy snapshots and
   * fresh `loadSnapshot` calls without a prior cart write may not have it yet — readers
   * SHOULD prefer this field but fall back to recomputing on the fly when absent.
   */
  structured_cart?: AgentStructuredCart;
};

export type ToolOk = {
  ok: true;
  /** Short text fed back to the router on the next iteration. Keep < 600 chars. */
  observation: string;
  /** Optional structured payload (catalog rows, product cards, etc.). */
  data?: unknown;
  /** True for tools that end the turn (reply / escalate). */
  terminal?: boolean;
  /** Customer-facing text when terminal. */
  reply?: string;
};

export type ToolErr = {
  ok: false;
  error: string;
  observation: string;
};

export type ToolResult = ToolOk | ToolErr;

export interface ToolHandlerCtx {
  readonly input: AgentTurnInput;
  /** Snapshot at the moment the handler is invoked. Tools should read this once. */
  readonly snapshot: AgentSnapshot;
  /** Persist a new snapshot to DB and update the in-flight working copy. */
  saveSnapshot(next: AgentSnapshot): Promise<void>;
  /**
   * Tenant id for this turn (Multi-Tenant Commerce OS task 3.3, Req 6.1/6.2).
   *
   * Mirrors `input.tenantId` and is provided redundantly so the registry's
   * `tenant_isolation_violation` guard can read a single canonical key without
   * having to dig into `input`. Tools that build Prisma `where` clauses MUST
   * include this id (R6.2). The registry wrapper rejects calls where this is
   * falsy with a `MissingTenantScopeError` before the handler runs.
   */
  readonly tenantId?: string;
  /**
   * Resolved Reasoning_Context (Multi-Tenant Commerce OS task 3.3, Req 7.1).
   *
   * Optional only because legacy test fixtures construct `ToolHandlerCtx`
   * objects directly without going through the loop. Production call sites
   * (router → loop → tool registry wrapper) always populate this. Tools that
   * need category/identity/plan data should read it from here rather than
   * re-issuing DB lookups.
   */
  readonly reasoningContext?: ReasoningContext;
}

/** A single registered tool. params come in as `unknown` so the registry can hold heterogeneous tools. */
export type ToolDef = {
  name: string;
  description: string;
  paramsSchema: z.ZodTypeAny;
  /** Human-readable schema for the router prompt (e.g. JSON-Schema-like). */
  paramsHint: string;
  /** Optional few-shot examples to show the router. */
  examples?: Array<{ when: string; call: { tool: string; args: unknown } }>;
  /** Terminal tools end the turn after they run. */
  terminal?: boolean;
  /**
   * When set, this entry is an ALIAS for another tool (the canonical name in `aliasOf`).
   * Aliases share the canonical tool's `handler`, `paramsSchema`, `paramsHint`, and
   * `terminal` flag — they exist purely so `findTool` can resolve names that the
   * requirements specify differently from the codebase (e.g. Req 6.1 names
   * `update_cart` / `remove_cart_item` / `search_products` / `create_order` while the
   * primary handlers in this repo are `add_to_cart` / `remove_from_cart` /
   * `search_catalog` / `confirm_order`). Renderers that emit the tool catalog to the
   * LLM (`router.renderToolCatalog`) MUST skip alias entries to avoid prompting the
   * model with two identical tool descriptions.
   */
  aliasOf?: string;
  handler: (args: unknown, ctx: ToolHandlerCtx) => Promise<ToolResult>;
};

/**
 * The 10 named pipeline steps emitted by `runAgentTurn` per iteration (Requirements §5.1).
 * Tagging each `AgentStepLog` row with one of these values lets `persistTurnTrace`
 * (task 5.2) write distinct rows for deterministic vs. LLM stages without changing the
 * existing `AgentTrace` schema. Rows produced by the legacy single-tool path will not
 * carry a `step` value, which is why the field is optional.
 */
export type AgentLoopStep =
  | "observe_input"
  | "retrieve_session"
  | "retrieve_cart"
  | "detect_intent"
  | "detect_missing_info"
  | "choose_action"
  | "choose_tools"
  | "verify_pre_response"
  | "generate_response"
  | "save_memory";

/**
 * Confidence score triple recorded on every step row (task 5.2 / Req 11.6 / Req 15.1).
 *
 * Each score is in `[0, 1]`. `persistTurnTrace` merges this object into the `args`
 * JSON column on every `AgentTrace` row so replay tooling can chart per-step
 * confidence without joining auxiliary tables. Tasks 6.1 / 6.2 / 6.3 will replace
 * the placeholder values that `loop.ts` writes today with real per-step scores;
 * the shape is the seam.
 */
export type AgentStepConfidenceScores = {
  product_match: number;
  intent: number;
  order_completeness: number;
};

export type AgentStepLog = {
  iter: number;
  /**
   * Which of the 10 named pipeline steps produced this row. Optional so legacy callers
   * (and any test fixtures predating task 5.1) keep type-checking; the loop populates it
   * for every row it emits.
   */
  step?: AgentLoopStep;
  thought?: string;
  tool: string;
  args: unknown;
  ok: boolean;
  observation: string;
  llmLatencyMs: number;
  toolLatencyMs: number;
  /**
   * FSM state snapshot at the moment this step was emitted (Req 7.5, Req 15.1).
   * Persisted into the `args` JSON column under the `fsmState` key by
   * `persistTurnTrace`. Optional so legacy `AgentStepLog` constructions still type-check.
   */
  fsmState?: OrderFSMState;
  /**
   * Composite `confidence_level` value at the moment this step was emitted
   * (Req 11.6, Req 15.1). Mirrors `AgentSnapshot.confidence_level` once the
   * loop's `verifyPreResponse` step has computed `min(product_match, intent,
   * order_completeness)`. For the deterministic steps that run before
   * `verifyPreResponse`, this is the inbound snapshot's `confidence_level`.
   * Persisted into the `args` JSON column under the `confidenceLevel` key.
   */
  confidenceLevel?: number;
  /**
   * Per-step confidence triple (Req 11.6, Req 15.1). See `AgentStepConfidenceScores`.
   * Persisted into the `args` JSON column under `confidence_scores`.
   */
  confidence_scores?: AgentStepConfidenceScores;
};

export type AgentRunOutcome = {
  steps: AgentStepLog[];
  /**
   * Why the loop stopped:
   *   - `terminal`                       — a terminal tool (`reply` /
   *                                         `escalate_to_human`) ran successfully.
   *   - `max_iter`                       — the iteration cap was reached.
   *   - `router_error`                   — the router LLM threw or returned
   *                                         malformed output past retry.
   *   - `reasoning_context_incomplete`   — `buildReasoningContext` raised
   *                                         `ReasoningContextIncompleteError`
   *                                         before `observe_input` (Req 7.6).
   *   - `tenant_scope_missing`           — `buildReasoningContext` raised
   *                                         `MissingTenantScopeError` before
   *                                         `observe_input` (Req 6.1, 6.3).
   *   - `subscription_not_operational`   — outbound short-circuit when
   *                                         `reasoningContext.subscription.isOperational
   *                                         === false`. The inbound message
   *                                         is logged but no reply is sent
   *                                         (Req 12.4, 18.4).
   */
  reason:
    | "terminal"
    | "max_iter"
    | "router_error"
    | "reasoning_context_incomplete"
    | "tenant_scope_missing"
    | "subscription_not_operational";
  reply: string | null;
};
