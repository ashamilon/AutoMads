# Facebook AI Agent — Regression Analysis

## Background

The Messenger sales agent under `src/agent/` was built as an agentic commerce system: an LLM that picks tools (`search_catalog`, `add_to_cart`, `set_line_addons`, `confirm_order`, …) to drive a Bangladeshi customer through search → cart → address → payment → order. In practice it regressed into a chatbot — a thin LLM wrapper that re-greets the customer, forgets the cart between turns, asks for the same address twice, drops customisations, occasionally invents SKUs, and fails to resume after a 12-hour gap.

The regression is not one bug. It is seven correlated failure modes spread across `loop.ts`, `state.ts`, `types.ts`, `prompts.ts`, `router.ts`, `runner.ts`, and the cart / catalog / registry tool files. The rebuild defined in `.kiro/specs/facebook-ai-agent-rebuild/` does not start a parallel agent; it refactors these same files so deterministic TypeScript carries reliability (FSM, slot tracking, fuzzy match, cart math, anti-hallucination) and the LLM is reduced to a tool selector.

This document maps each regression category to the offending file, names the code-level cause, and points at the requirement(s) that fix it. Task 12.2 will append "Recommended X" sections covering prompt shape, schema extensions, error handling, and session memory.

## Root Causes by Category

### 1. Broken state logic

**Symptom.** The agent loses track of where the customer is in the order — it greets a returning customer who is mid-checkout, asks for an address before the cart has any lines, or jumps to "order confirmed" without a payment step. There is no way to forbid the model from skipping a state because no state machine exists.

**Offending files.**
- `src/agent/loop.ts` — the entire loop is a single `routeAndExecute` node (lines 42–172). `MAX_ITER` (line 16) caps iterations, but there is no per-step pipeline and no FSM gate.
- `src/agent/state.ts` — the snapshot loaders (`loadSnapshot` lines 96–106 of the original shape) round-trip only `cart`, `profile`, `shownSkus`, and `lastShown`. There is no `order_state` field.
- `src/agent/types.ts` — `AgentSnapshot` (original lines 41–55) has the same four-field shape; no `OrderFSMState` import, no transition table.

**Code-level cause.** The order state machine lives only as English prose in `prompts.ts` rules 18–22 ("the order list must be non-empty AND every line must have a size AND profile must have name+phone+address …"). The model is the only enforcer, and Gemma 3 1B routinely violates one of those clauses. There is no `ALLOWED_TRANSITIONS` table, no `canTransition(from, to, snapshot)` guard, no `nextSuggestedState` helper. When the LLM proposes `confirm_order` from a cart with missing slots, nothing in code blocks it.

**Requirements that address it.** 1.1, 1.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6.

### 2. Lost memory persistence

**Symptom.** Returning customers are treated as new ones — favourite team is forgotten, prior sizes are not pre-filled, abandoned carts never resume. Even within a single conversation, anything that does not live on the four-field snapshot is gone after the next inbound.

**Offending files.**
- `src/agent/state.ts` — the original `loadSnapshot`/`saveSnapshot` round-trip only `cartItems`, `customerProfile`, `agent.shownSkus`, and `agent.lastShown` (lines 96–143 of the pre-refactor shape). `customer_preferences`, `conversation_summary`, `recent_references`, `missing_information`, and `confirmed_information` are dropped on every read.
- `src/agent/types.ts` — `AgentSnapshot` does not declare any of those fields, so even an in-process change cannot survive a save/load round-trip.
- `src/agent/runner.ts` — there is no abandoned-cart resume path. `runAgentInbound` (lines 121–169) just calls `runAgentTurn` against whatever survived. The only "memory" is the message history fetched by `loadHistory` (lines 25–37), capped at the last 16 messages.
- `prisma/schema.prisma` — `CustomerProfile.preferences` (the long-term store) and `FollowUp` (the abandoned-cart trigger) already exist (schema lines 227–280), but nothing in `loop.ts` writes to either.

**Code-level cause.** The Snapshot is the only short-term store, and it is missing the columns long-term memory would ride in. There is no per-turn `saveMemory` step that diffs `customer_preferences` against `CustomerProfile.preferences` and merges. `FollowUp` is fired exactly once, inside `add_to_cart` (`tools/cart.ts` lines 271–278), so it is keyed to a behavioural event rather than to FSM state — when the FSM would later read "we're at `ADDRESS_COLLECTION` with a 12 h idle gap", that signal does not exist.

**Requirements that address it.** 1.2, 1.3, 1.5, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6.

### 3. Context window problems

**Symptom.** On long Banglish threads, the agent forgets product names mentioned six turns ago, mixes up which jersey the customer is referring to, or repeats the size question because earlier confirmations have scrolled out of the prompt.

**Offending files.**
- `src/agent/router.ts` — `renderHistory` (lines 36–42) hard-truncates to the last 16 messages and 280 chars per message; `renderSnapshot` (lines 44–80) does not surface `order_state`, `missing_information`, `confirmed_information`, or `recent_references` because those fields aren't on the Snapshot.
- `src/agent/prompts.ts` — `AGENT_SYSTEM_PROMPT` is 25 numbered rules (lines 1–46). On Gemma 3 1B that consumes the budget that should belong to the conversation summary and the verified tool results.
- `src/agent/state.ts` — there is no `conversation_summary` field, so the agent has no compressed long-term context to fall back on when raw history is truncated.

**Code-level cause.** The router's user block is built from raw history plus a 25-rule system prompt plus the full step trace (router.ts `askRouter` lines 89–116). On a five-product order with size, name+number, and address negotiation, the prompt routinely runs over the model's budget; what gets evicted first is the early product mentions. There is no rolling summary, no `recent_references` (last 5 resolved phrases), and no compact rendering of `missing_information` so the model could recover from truncation.

**Requirements that address it.** 1.1, 5.1, 8.1, 8.2, 8.3, 8.4, 9.6, 14.1, 14.2.

### 4. Prompting defects

**Symptom.** The model violates one of the 25 prose rules and produces a wrong-product `add_to_cart`, a "checkout" / "selected" leak in customer-facing text, or a confirmation phrase before `create_order` ran. Each rule is correct in isolation; reliability collapses because the LLM has to obey all 25 simultaneously, every turn.

**Offending files.**
- `src/agent/prompts.ts` — every line is a defect surface. Rules 4 ("ONE SEARCH PER PRODUCT LINE"), 5a ("REFERRING-BACK PHRASES"), 11a ("EMBEDDED CUSTOMISATION DETECTION"), and 18 ("Before confirm_order, the order list must be non-empty AND every line must have a size AND …") all encode business logic that should be deterministic TypeScript guards.
- `src/agent/router.ts` — the prompt is the only safety layer. There is no post-LLM filter that compares the proposed tool call against the FSM state, and `sanitizeCustomerReply` (called from `runner.ts` line 73 in the fallback path) only catches banned words on the fallback path, not on the happy path.

**Code-level cause.** Every rule that is enforced *only* in prose rather than in code is a violation waiting to happen. Specifically: the banned-word ("cart", "checkout", "select") block is rule 22, but no `replyFilter` strips them on the main path; the SKU-grounding rule is rule 5b, but `tools/cart.ts add_to_cart` does not check that the supplied SKU appeared in `snapshot.shownSkus` / `lastShown`; the order-completeness rule is rule 18, but the FSM that would enforce it does not exist.

**Requirements that address it.** 5.5, 6.1, 6.2, 6.3, 6.4, 7.4, 8.5, 10.1, 10.2, 10.3, 10.6, 14.1, 14.2, 14.3, 14.5, 14.6.

### 5. Cart architecture defects

**Symptom.** The customer asks "make the boot size 42" and the jersey line gets resized; or they ask for two distinct Argentina jerseys and only one line appears; or the customisation value ("Limon 10") attached to one line silently moves to another. Lines have no stable identity.

**Offending files.**
- `src/agent/types.ts` — `AgentCartItem` (lines 27–34) has `sku`, `product`, `quantity`, `size?`, `unitPriceBdt?`, `addOns?` — no `line_id`. There is no way to address one specific line.
- `src/agent/tools/cart.ts` — `add_to_cart` merges by `(sku, size)` (lines 217–222: `next.findIndex(c => c.sku === args.sku && (c.size ?? "") === (args.size ?? ""))`). Two distinct lines that share sku+size collapse. `remove_from_cart` keys by sku alone (lines 295–301), so the customer can't disambiguate "remove the second one". There is no `modify_cart_item` tool. `show_cart` (lines 308–334) recomputes `subtotal` from scratch on every read because the snapshot does not store `subtotal`, `line_total`, `delivery_info`, `payment_method`, or `order_status`.
- `src/agent/state.ts` — `readCart` (lines 18–60 of the original) does not mint a `line_id`; `saveSnapshot` (lines 116–143 of the original) does not persist per-line missing-slot tracking.
- `src/agent/types.ts` — there is no `AgentMissingInfoSlot { line_id, slot, attempts }` type, so per-line missing-slot tracking has nowhere to live.

**Code-level cause.** Without a `line_id`, the deterministic reference resolver from Req 9 cannot point at a specific line, every customisation has to be reattached by the (sku, size) tuple, and the merge-on-add behaviour silently destroys distinct lines that the customer wanted separate. Without a structured cart object on the snapshot, every confirmation summary is regenerated by the LLM rather than rendered from verified data — that is the Req 10.2 hallucination surface.

**Requirements that address it.** 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.1, 8.6.

### 6. Weak tool orchestration

**Symptom.** The model invents a SKU, the cart accepts it; the model proposes `confirm_order` from an incomplete state, the order is created; the same tool is called twice with the same args because the anti-loop guard fires after the side effect, not before.

**Offending files.**
- `src/agent/loop.ts` — the entire orchestrator is one node, `routeAndExecute` (lines 42–172). The duplicate-call guard (lines 109–157) detects `sameToolArgsCount >= 2` *after* the second tool has already executed; the snapshot has already been mutated. There is no pre-execution validation hook, no FSM transition check, no SKU-grounding check, no per-step `AgentTrace` row, and no separation between LLM steps (`detectIntent`, `chooseAction`, `chooseTools`, `generateResponse`) and deterministic steps.
- `src/agent/tools/registry.ts` — `TOOLS` (lines 19–35) registers the historic names: `add_to_cart`, `remove_from_cart`, `search_catalog`. The canonical names from Req 6.1 — `update_cart`, `remove_cart_item`, `search_products`, `resolve_product_name`, `check_inventory`, `modify_cart_item`, `save_session_state`, `retrieve_session_state`, `validate_order` — are not registered. `findTool` (lines 33–35) is a single-name lookup with no alias resolution.
- `src/agent/tools/catalog.ts` — the TF-IDF scorer (`scoreRow` lines 113–171, `buildDocumentBlobs` lines 95–104) exists and works, but it is consumed only inside `search_catalog` (lines 184–278). The score is not exported; no `confidence_score` is attached to returned cards; no shared `productScorer` module surfaces the score to other tools.
- `src/agent/tools/cart.ts` — `add_to_cart` (lines 161–290) goes straight to `prisma.productMapping.findUnique` with whatever sku the LLM supplied. There is no check that the sku appeared in `snapshot.shownSkus`, `snapshot.lastShown`, or any tool result earlier in the same turn. A hallucinated sku that happens to match an inactive row will get past line 168 and only fail at line 173's `is_active` check.
- `src/agent/runner.ts` — when the loop exits without a terminal reply (`outcome.reason !== "terminal"` at line 144), the runner calls `safeFallbackReply` (lines 60–88), which dispatches yet another LLM call (`generateCandidFallback` lines 90–119). Tool results from the failed turn are summarised into prose and the FSM state is lost.

**Code-level cause.** There is no 10-step pipeline (Req 5.1), no FSM transition enforcement inside the loop (Req 7.4), no anti-hallucination guard on cart-mutating tools (Req 10.1), no `validate_order` pre-confirmation step (Req 6.6), and no shared confidence score (Req 11). Tool selection, tool execution, and tool validation all happen in one block, so the only place to intercept a bad call is the duplicate-call guard, which is too late.

**Requirements that address it.** 4.1, 4.2, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6.

### 7. Improper session handling

**Symptom.** The customer sends a screenshot of their address; the agent ignores the message entirely. The customer comes back 12 hours later mid-checkout; the agent re-greets and re-asks for everything. The pendingDraft does carry the cart, but not the FSM state needed to know where to resume.

**Offending files.**
- `src/agent/runner.ts` — `runAgentInbound` short-circuits on images (line 124: `if (input.imageUrls.length > 0) return "skipped";`), so any turn with a photo bypasses the agent entirely and falls through to legacy. There is no abandoned-cart resume path: the runner does not inspect `snapshot.order_state` (or its timestamp) before invoking `runAgentTurn`, and it does not render a "welcome back" preamble. `loadHistory` (lines 25–37) just fetches the last 16 messages.
- `src/agent/state.ts` — `pendingDraftJson` round-tripping (the original `saveSnapshot` lines 116–143) does not include `order_state`, `missing_information`, `confirmed_information`, `confidence_level`, or `recent_references`. Even if a future runner wanted to resume from FSM state, the data wouldn't be there.
- `src/agent/types.ts` — without those fields on `AgentSnapshot`, no in-process code can read or write them.
- `src/agent/loop.ts` — `runAgentTurn` (lines 174–209) ignores how stale the snapshot is. There is no "this conversation was idle for 12 h, reset only `lastShown` but keep cart and FSM" path.

**Code-level cause.** Session state is the cart plus the profile plus a couple of UI hints; everything that would let the agent resume mid-flow (FSM state, missing slots, the most recent five resolved references, the conversation summary) is either missing from the type, missing from the persistence path, or both. Image turns are treated as "agent does not handle this" and dropped to legacy, which has its own (incompatible) state model — the customer sees the bot suddenly forget the cart whenever they send a photo.

**Requirements that address it.** 1.1, 1.2, 1.3, 1.4, 1.5, 13.1, 13.3, 13.4, 13.6, 15.2, 15.3.

## Findings → Requirements Mapping

| # | Category | File | Cause | Requirements |
|---|----------|------|-------|--------------|
| 1 | Broken state logic | `src/agent/loop.ts` (single `routeAndExecute` node, lines 42–172) | No 10-step pipeline; FSM transitions are not enforced in code | 5.1, 7.4 |
| 2 | Broken state logic | `src/agent/state.ts` (snapshot readers/writers) | No `order_state` field round-tripped on the Snapshot | 1.1, 1.4, 7.5 |
| 3 | Broken state logic | `src/agent/types.ts` (`AgentSnapshot`) | No `OrderFSMState` enum, no missing/confirmed slot types | 1.1, 7.1, 7.2 |
| 4 | Broken state logic | `src/agent/prompts.ts` rules 18–22 | FSM rules encoded only in prose, model is the sole enforcer | 7.3, 7.4, 7.6 |
| 5 | Lost memory persistence | `src/agent/state.ts` (`loadSnapshot` / `saveSnapshot`) | Drops `customer_preferences`, `recent_references`, `conversation_summary` on round-trip | 1.2, 1.3, 1.5, 13.1 |
| 6 | Lost memory persistence | `src/agent/types.ts` (`AgentSnapshot`) | No long-term-memory fields declared | 13.2, 13.5 |
| 7 | Lost memory persistence | `src/agent/runner.ts` (no resume path) | No diff/merge of `customer_preferences` into `CustomerProfile.preferences` per turn | 1.5, 13.2, 13.5 |
| 8 | Lost memory persistence | `src/agent/tools/cart.ts` (`scheduleFollowUp` inside `add_to_cart`, lines 271–278) | `FollowUp` triggered by add-event, not by FSM idle state | 13.3 |
| 9 | Context window problems | `src/agent/router.ts` `renderHistory` (lines 36–42) | Hard 16-message / 280-char truncation drops earlier product mentions | 1.1, 14.1 |
| 10 | Context window problems | `src/agent/router.ts` `renderSnapshot` (lines 44–80) | Does not surface `order_state`, `missing_information`, `confirmed_information`, `recent_references` | 8.1, 8.2, 8.3, 9.6 |
| 11 | Context window problems | `src/agent/prompts.ts` (25-rule system prompt) | Eats the prompt budget that should hold conversation summary + verified tool results | 5.5, 14.1, 14.2 |
| 12 | Prompting defects | `src/agent/prompts.ts` rules 1–25 | Business logic encoded in prose; one rule violation per turn corrupts the output | 5.5, 6.1, 6.2, 14.3 |
| 13 | Prompting defects | `src/agent/prompts.ts` rule 5b (SKU grounding) | No deterministic guard, hallucinated SKU reaches `add_to_cart` | 10.1, 10.5, 10.6 |
| 14 | Prompting defects | `src/agent/prompts.ts` rule 22 (banned words) | `replyFilter` only fires on the fallback path in `runner.ts`, not the happy path | 14.3, 14.6 |
| 15 | Prompting defects | `src/agent/prompts.ts` rule 18 (pre-confirm gate) | No FSM precondition check; `confirm_order` can run on incomplete state | 6.6, 7.3, 8.4 |
| 16 | Cart architecture defects | `src/agent/types.ts` `AgentCartItem` (lines 27–34) | No `line_id`; lines have no stable identity | 2.2, 3.3, 3.4 |
| 17 | Cart architecture defects | `src/agent/tools/cart.ts` `add_to_cart` merge (lines 217–222) | Merge by `(sku, size)` collapses lines the customer wanted distinct | 3.1, 3.2 |
| 18 | Cart architecture defects | `src/agent/tools/cart.ts` (no `modify_cart_item`) | Cannot target one line for size/qty change; no per-line missing-slot tracking | 3.3, 8.1, 8.6 |
| 19 | Cart architecture defects | `src/agent/tools/cart.ts` `add_to_cart` (lines 161–290) | No SKU-grounding check before Prisma lookup | 6.4, 10.1, 10.5 |
| 20 | Cart architecture defects | `src/agent/tools/cart.ts` `show_cart` (lines 308–334) | Recomputes `subtotal` every call; no structured `{ items, subtotal, delivery_info, payment_method, order_status }` on Snapshot | 2.1, 2.3, 2.5, 2.6 |
| 21 | Weak tool orchestration | `src/agent/tools/registry.ts` (lines 19–35) | Canonical names from Req 6.1 (`update_cart`, `resolve_product_name`, `validate_order`, `modify_cart_item`, `check_inventory`, `save_session_state`, `retrieve_session_state`) not registered | 6.1, 6.2, 6.3 |
| 22 | Weak tool orchestration | `src/agent/tools/catalog.ts` `scoreRow` (lines 113–171) | TF-IDF score not exposed as `confidence_score`; no shared `productScorer` module; no `resolve_product_name` tool | 4.1, 4.2, 4.4, 11.1 |
| 23 | Weak tool orchestration | `src/agent/loop.ts` duplicate-call guard (lines 109–157) | Anti-loop guard fires after the side effect; no pre-execution validation hook | 5.1, 6.4, 8.5 |
| 24 | Weak tool orchestration | `src/agent/loop.ts` (no `validate_order`) | `confirm_order` runs without a re-verification step | 6.6 |
| 25 | Weak tool orchestration | `src/agent/loop.ts` (no per-step `AgentTrace`) | One `AgentTrace` row per tool, not per loop step; no FSM state on the row | 5.2, 11.6, 15.1 |
| 26 | Improper session handling | `src/agent/runner.ts` line 124 (image short-circuit) | Image turns dropped to legacy; cart and FSM lost | 13.4 |
| 27 | Improper session handling | `src/agent/runner.ts` `runAgentInbound` (lines 121–169) | No abandoned-cart resume; no "welcome back" preamble; no FSM-aware staleness check | 13.3, 13.4 |
| 28 | Improper session handling | `src/agent/state.ts` `saveSnapshot` (original lines 116–143) | `pendingDraftJson` round-tripping lacks FSM, missing slots, confirmed slots, confidence | 1.2, 1.3, 13.1 |
| 29 | Improper session handling | `src/agent/runner.ts` `safeFallbackReply` (lines 60–88) | Fallback path summarises tool results into a fresh LLM call; FSM state and verified tool results are lost | 12.1, 12.3, 12.4 |

## Recommended Prompt Structure

The current `src/agent/prompts.ts` is a 25-rule monolith (lines 1–46 of `AGENT_SYSTEM_PROMPT`) that asks Gemma 3 1B to be the FSM, the SKU-grounder, the banned-word filter, the cart-line resolver, and the tool selector all at once. Reliability collapses because the model has to obey every rule simultaneously, every turn. The rebuild moves to a minimal **tool-selector-only** prompt and pushes every business rule into deterministic TypeScript.

Recommended structure (target: < 800 tokens):

1. **Identity** (~60 tokens) — "You are the order-taking sales agent for {tenantName}, replying in Banglish." No persona padding.
2. **Role** (~80 tokens) — "Pick the next tool. Do not answer in prose unless the tool is `final_reply`." One sentence per allowed FSM state describing the typical next action.
3. **Output schema** (~120 tokens) — the JSON shape the router parses (`tool`, `args`, `thought`, `confidence_level`). Mirror the Zod schema in `src/agent/router.ts` exactly.
4. **Grounding rule** (~60 tokens) — "Only call `add_to_cart` / `update_cart` with a SKU that appears in the most recent tool result or in `recent_references`." The deterministic check in `tools/cart.ts` is the actual enforcer; this line is the hint.
5. **Banned words** (~40 tokens) — list "cart", "checkout", "select" once. The deterministic stripper in `replyFilter.ts` enforces it.
6. **Tool-flow heuristics** (~200 tokens) — three or four short bullets ("if `order_state` is `CART_BUILDING` and the user supplied a size, call `update_cart`"). No long examples.

Deterministic guards carry the reliability load: the FSM in `state.ts` (`canTransition`, `nextSuggestedState`), the anti-loop guard in `loop.ts`, the SKU-grounding check in `tools/cart.ts`, and the banned-word stripper in `replyFilter.ts`. The prompt no longer needs to police every rule because the code rejects bad outputs before they cause side effects.

## Recommended Database Schema Extensions

**No Prisma migration is required.** The existing `prisma/schema.prisma` already covers every storage need the rebuild has; the rebuild is type-and-loop refactor, not a schema change.

Field-by-field mapping:

- `MessengerConversation.pendingDraftJson` (Json, `prisma/schema.prisma:109`) — carries the new `AgentSnapshot` shape: `cart`, `profile`, `order_state`, `missing_information`, `confirmed_information`, `customer_preferences`, `conversation_summary`, `confidence_level`, `followup_needed`, `recent_references`. The Json column is unstructured, so adding fields to the TypeScript type does not require a migration.
- `CustomerProfile.preferences` (Json, `prisma/schema.prisma:241`) — long-term memory store written by the `saveMemory` step. Holds `favorite_teams`, `recent_sizes`, `last_5_orders`, etc. The model already declares `preferences: Json?` for free-form key/values.
- `AgentTrace` (`prisma/schema.prisma:281–304`) — per-step audit trail. The rebuild's per-step fields (`step`, `confidenceLevel`) ride inside the existing `args` Json column rather than as new columns; `thought`, `tool`, `ok`, `observation`, `llmLatencyMs`, `toolLatencyMs`, `finalReason` are already first-class.
- `FollowUp` (`prisma/schema.prisma:259–280`) — abandoned-cart and resume triggers. The `kind` string already supports `"abandoned_cart"`; the `payload` Json holds the cart snapshot needed to resume.

Optional future indexes if turn-replay queries get slow: `AgentTrace(turnId, iter)` is already implied by the `turnId` index plus client-side sort, but if the admin replay panel becomes hot, an explicit `@@index([turnId, iter])` is cheap. The existing `@@index([tenantId, conversationId, createdAt])` already covers the most common replay-by-conversation path.

## Error Handling Strategy

Four failure modes, four deterministic responses. The rebuild does not introduce a new error subsystem; it reuses the existing `runner.ts` fallback path and the `loop.ts` anti-loop guard, but wires them to the new FSM and confidence signals.

1. **Tool exception** (Prisma error, network blip, schema validation in the tool body). The dispatcher in `loop.ts` retries once with the same args. On a second failure, control flows to `runner.ts safeFallbackReply` (lines 60–88), which dispatches the candid Gemma fallback (`generateCandidFallback` lines 90–119). The fallback summarises the last verified tool result rather than the failed call so the customer never sees a raw error.
2. **Schema validation failure on router output**. When the Zod parse in `src/agent/router.ts` rejects the LLM's JSON, the loop re-routes once with a corrective hint appended to the user block ("your previous output was not valid JSON; respond with `{tool, args, thought}` only"). This is already partly implemented in the existing router; the rebuild keeps it and adds the FSM state to the corrective hint so the model re-tries inside the allowed transitions.
3. **Anti-loop trigger**. When `loop.ts` detects the same `(tool, args)` pair repeating twice without snapshot progress (current guard at lines 109–157, moved pre-execution in the rebuild), the loop swaps the proposed call for `escalate_to_human` if the FSM is past `CART_BUILDING`, or renders a clarification fallback that summarises the cart from `snapshot.cart` (verified data, never re-generated by the LLM).
4. **FSM block**. When the LLM proposes a tool whose target state violates `canTransition(currentState, proposedState, snapshot)` in `state.ts`, the loop overrides to `nextSuggestedState(currentState, snapshot)` and writes an `AgentTrace` row with `errorCode = "fsm_override"` so overrides are queryable from the admin panel.

## Session Memory Strategy

Session state has three tiers, each with one storage location and one writer. The rebuild does not introduce a new store; it widens the type that round-trips through `pendingDraftJson` and adds a `saveMemory` step at the end of the loop.

- **Short-term snapshot** lives in `MessengerConversation.pendingDraftJson` (`prisma/schema.prisma:109`) and is the single source of truth for in-flight session state. `state.ts loadSnapshot` reads it, the 10-step loop in `loop.ts` mutates the in-memory copy, and `state.ts saveSnapshot` writes it back at the end of every turn. All FSM, slot, and confidence fields live here.
- **Long-term memory** lives in `CustomerProfile.preferences` (`prisma/schema.prisma:241`) and is written exclusively by the `saveMemory` step — the tenth and last step of the loop. `saveMemory` diffs `snapshot.customer_preferences` against the row, merges keys (favorite_teams, recent_sizes, last_5_orders), and updates `lastSeenAt`. Nothing else in the loop writes to `CustomerProfile`.
- **Abandoned-cart resume**. When `runner.ts` loads a snapshot with a non-empty `cart` and `Date.now() - lastActivity < ABANDONED_CART_TIMEOUT_MS`, the loop resumes at `snapshot.order_state` instead of starting at `GREETING`. Past the timeout the cart is preserved but the FSM resets to `CART_BUILDING` so the customer is re-asked to confirm before payment.
- **`FollowUp` rows** are scheduled when the loop ends in any in-flight FSM state (`CART_BUILDING`, `MISSING_INFO_COLLECTION`, `ADDRESS_COLLECTION`, `PAYMENT_SELECTION`) and cancelled by the `saveMemory` step when `order_state === ORDER_COMPLETE`. The `payload` Json (`prisma/schema.prisma:275`) carries the cart snapshot needed for the nudge.
- **Spread-merge writes**. `state.ts saveSnapshot` uses `{ ...existingPendingDraft, ...newSnapshotShape }` so unrelated keys in `pendingDraftJson` (legacy fields written by older code paths) are preserved. This makes the rebuild safe to roll out alongside the existing writers.

## Summary

The seven categories share one root cause: **deterministic logic was outsourced to the LLM**. The FSM lives as prompt rules instead of a transition table; the cart's per-line identity lives as `(sku, size)` tuples instead of a `line_id`; the anti-hallucination rule lives as rule 5b instead of a SKU-grounding check; the abandoned-cart resume lives as the *absence* of a check on `snapshot.order_state` plus a timestamp. Each one of those choices saves a few lines of TypeScript at the cost of a reliability layer.

The rebuild reverses the trade. Requirements 1, 2, 7, 8, and 13 lock structured state into the Snapshot and into `pendingDraftJson`. Requirements 4, 9, 10, and 11 turn fuzzy product matching, reference resolution, and confidence scoring into deterministic TypeScript that runs before any tool side effect. Requirements 5, 6, 12, and 15 reshape `loop.ts` into a 10-step pipeline with per-step `AgentTrace` rows, FSM transition enforcement, and explicit override logging. Requirements 14 and 16 prune the prompt to a tool selector and document the reasoning so the next regression has a baseline to be compared against.

When the rebuild is done, `prompts.ts` will be short, `loop.ts` will have ten named nodes, `state.ts` will round-trip the full Snapshot including FSM and slots, and `tools/cart.ts` lines will carry `line_id` plus per-line slot tracking. The LLM's job will be picking the next tool — nothing else — and Gemma 3 1B will be enough to do it.
