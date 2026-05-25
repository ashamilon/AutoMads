# Requirements Document

## Introduction

This feature refactors the existing Facebook Messenger AI sales agent in place to fix a recent regression and turn it into a production-grade agentic commerce system. The system stays on TypeScript / Node 20 / Prisma / Postgres / Ollama / LangGraph and continues to use the existing modules under `src/agent/` (`loop.ts`, `prompts.ts`, `state.ts`, `router.ts`, `runner.ts`, and `tools/*`). No parallel agent module (no `src/agent2/`) is introduced.

The refactor is grounded in a model-agnostic design philosophy: deterministic TypeScript code (fuzzy matching, FSM transitions, slot validation, confidence scoring, cart math) carries reliability, while the LLM is reduced to picking the next tool. The system MUST work today on Gemma 3 1B and remain correct when swapped to a larger model. Persistent state extends existing tables: `MessengerConversation.pendingDraftJson` for in-flight session Snapshots, `CustomerProfile.preferences` for long-term memory, `FollowUp` for abandoned-cart triggers, and `AgentTrace` for audit. The current 15+ tool surface is preserved and extended with `resolve_product_name`, `validate_order`, and explicit memory tools registered in the same registry.

Requirements 1 through 15 map one-to-one to the user's explicit requirement list. Requirement 16 covers the regression root-cause analysis deliverable.

## Glossary

- **Agent**: The Messenger AI sales agent runtime that processes a single inbound customer message end-to-end.
- **AgentLoop**: The 10-step reasoning loop implemented in `src/agent/loop.ts`.
- **OrderFSM**: The deterministic order state machine defined in `src/agent/state.ts` covering `BROWSING`, `PRODUCT_SELECTION`, `CART_BUILDING`, `MISSING_INFO_COLLECTION`, `ADDRESS_COLLECTION`, `PAYMENT_SELECTION`, `ORDER_REVIEW`, `FINAL_CONFIRMATION`, and `ORDER_COMPLETE`.
- **FSM**: Synonym for OrderFSM; the order state machine.
- **CartManager**: The deterministic cart code path responsible for adding, modifying, and removing cart lines without overwriting prior lines.
- **ProductResolver**: The deterministic product identification engine that performs fuzzy matching, synonym expansion, and spelling normalization.
- **ToolRegistry**: The single registry in `src/agent/tools/registry.ts` that exposes every tool callable by the LLM.
- **MemoryStore**: The persistence layer composed of `MessengerConversation.pendingDraftJson` (short-term Snapshot), `CustomerProfile.preferences` (long-term memory), and `FollowUp` (abandoned-cart triggers).
- **Tracer**: The audit pipeline writing structured records into `AgentTrace`.
- **Snapshot**: The JSON object stored in `MessengerConversation.pendingDraftJson` that contains the full in-flight session state (active goal, FSM state, cart, missing slots, confirmed slots, summary, confidence).
- **Confidence_Score**: A numeric score in the range 0.0 to 1.0 produced by deterministic code for product match, intent detection, or order completeness.
- **Reference_Resolution**: The deterministic process that resolves pronouns and ordinal references (for example `add another one`, `the red one`, `first item`, `second ta`, `WC26 ta`) to specific cart lines or catalog items.
- **Banglish**: Bengali written using Latin characters, including casual mixed Bengali-English typed by customers.
- **Per_Line_Slot**: A required information slot tracked per cart line (for example size, quantity, customization).
- **Add_On_Slot_Filling**: The flow where the Agent fills missing per-line slots one cart line at a time without re-asking for already-confirmed values.
- **Anti_Loop_Guard**: A deterministic guard that blocks the Agent from asking the same clarification question more than a configured number of times within one conversation.
- **PendingDraft**: Synonym for Snapshot, named after the existing `MessengerConversation.pendingDraftJson` column.
- **CustomerPreferences**: The long-term memory blob stored in `CustomerProfile.preferences`.
- **AgentTrace**: The Postgres table storing per-turn audit records.
- **FollowUp**: The Postgres table storing scheduled follow-up triggers, including abandoned-cart messages.
- **Tool_First_Reasoning**: The pattern where the LLM's only job per turn is to choose the next tool from ToolRegistry; all data mutations happen inside tools.
- **Customer_Facing_Text**: The final reply string sent to the Messenger user.
- **Banned_Word**: A token that MUST NOT appear in Customer_Facing_Text. The initial banned set is `cart`, `checkout`, `select`.

## Requirements

### Requirement 1: Conversation State Management

**User Story:** As a store operator, I want every conversation to maintain a complete structured state object across turns, so that the Agent never loses track of what the customer is doing between messages.

#### Acceptance Criteria

1. THE Agent SHALL maintain, for every active conversation, a Snapshot containing the fields `active_goal`, `order_state`, `cart_items`, `missing_information`, `confirmed_information`, `customer_preferences`, `conversation_summary`, `confidence_level`, and `followup_needed`.
2. WHEN a turn completes, THE Agent SHALL write the updated Snapshot to `MessengerConversation.pendingDraftJson` before returning the reply.
3. WHEN a new inbound message is received, THE Agent SHALL load the Snapshot from `MessengerConversation.pendingDraftJson` and pass the loaded Snapshot into the AgentLoop before any tool call.
4. IF `MessengerConversation.pendingDraftJson` is empty or missing for an existing conversation, THEN THE Agent SHALL initialize a Snapshot with `order_state` set to `BROWSING`, an empty `cart_items` array, and an empty `missing_information` array.
5. THE Agent SHALL persist `customer_preferences` from the Snapshot into `CustomerProfile.preferences` at the end of every turn.
6. THE Agent SHALL include the active Snapshot identifier and `order_state` in every `AgentTrace` record written for that turn.

### Requirement 2: Structured Cart Memory

**User Story:** As a store operator, I want the cart to live in a structured persistent JSON object, so that the Agent never reconstructs cart contents from raw conversation text.

#### Acceptance Criteria

1. THE CartManager SHALL store cart data as a JSON object containing `items`, `subtotal`, `delivery_info`, `payment_method`, and `order_status`.
2. THE CartManager SHALL store every line of `items` with at least the fields `line_id`, `product_id`, `product_name`, `variant_id`, `size`, `quantity`, `unit_price`, and `line_total`.
3. WHEN the CartManager mutates the cart, THE CartManager SHALL recompute `subtotal` as the sum of all `line_total` values before persisting.
4. THE Agent SHALL read cart contents only from the structured cart object retrieved through ToolRegistry, and SHALL NOT infer cart contents from raw message history.
5. WHEN the Agent generates a confirmation summary, THE Agent SHALL render the summary from the structured cart object and SHALL NOT regenerate item details from prior LLM responses.
6. THE CartManager SHALL persist the cart object inside the Snapshot in `MessengerConversation.pendingDraftJson` after every mutation.

### Requirement 3: Multi-Item Order Handling

**User Story:** As a customer, I want to order several products with different quantities and sizes in a single message and later modify or remove individual lines, so that I do not have to start the order over.

#### Acceptance Criteria

1. WHEN an inbound message describes more than one product, THE Agent SHALL parse each product, quantity, and size into a separate cart line through `update_cart` calls.
2. WHEN the Agent adds a new line to a cart that already contains lines, THE CartManager SHALL append the new line and SHALL NOT remove or overwrite any existing line.
3. WHEN the customer asks to modify a specific line (for example change size or quantity), THE Agent SHALL call `modify_cart_item` with the resolved `line_id` and SHALL update only that line.
4. WHEN the customer asks to remove a specific line, THE Agent SHALL call `remove_cart_item` with the resolved `line_id` and SHALL delete only that line.
5. WHERE the customer's modification message does not specify a quantity or size, THE Agent SHALL preserve the prior values of those fields on the targeted line.
6. THE Agent SHALL pass the round-trip integration test where the input `I want 2 Real Madrid jerseys and 1 football boot size 42` results in exactly three cart lines with the specified product names, quantities, and sizes.

### Requirement 4: Product Identification Engine

**User Story:** As a customer, I want the Agent to correctly recognize products even when I use casual names, partial names, or misspellings, so that I do not have to type exact catalog titles.

#### Acceptance Criteria

1. THE ProductResolver SHALL be exposed as the tool `resolve_product_name` registered in ToolRegistry.
2. WHEN `resolve_product_name` is invoked with a customer string, THE ProductResolver SHALL apply fuzzy matching, synonym expansion, and spelling normalization against the active tenant catalog before returning candidates.
3. THE ProductResolver SHALL support Banglish input and SHALL normalize Banglish tokens to their catalog equivalents before matching.
4. THE ProductResolver SHALL return a list of zero or more candidate matches, each with `product_id`, `product_name`, and a `Confidence_Score` in the range 0.0 to 1.0.
5. IF no candidate has `Confidence_Score` greater than or equal to the high-confidence threshold defined in `src/agent/state.ts`, THEN THE Agent SHALL ask the customer a clarification question or present the available candidates instead of adding any line to the cart.
6. THE ProductResolver SHALL NOT return a `product_id` that does not exist in the active tenant catalog.

### Requirement 5: Agent Reasoning Loop

**User Story:** As a store operator, I want every customer message to go through a fixed reasoning loop, so that the Agent's behavior is predictable and debuggable.

#### Acceptance Criteria

1. THE AgentLoop in `src/agent/loop.ts` SHALL execute the following ten steps in order for every inbound message: observe input, retrieve session state, retrieve cart state, detect intent, detect missing information, choose next action, choose tools, verify pre-response state, generate response, save memory.
2. THE AgentLoop SHALL emit one `AgentTrace` row per step containing the step name, step inputs, step outputs, and elapsed milliseconds.
3. IF any step throws an exception, THEN THE AgentLoop SHALL halt remaining steps, write a failure `AgentTrace` row, and trigger the Error Recovery flow defined in Requirement 12.
4. THE AgentLoop SHALL NOT skip the verify pre-response step before generating Customer_Facing_Text.
5. THE AgentLoop SHALL NOT call the LLM for any step other than `detect intent`, `choose next action`, `choose tools`, and `generate response`.

### Requirement 6: Tool-First Reasoning

**User Story:** As a store operator, I want the LLM to act only as a tool selector, so that data mutations are handled by deterministic TypeScript code.

#### Acceptance Criteria

1. THE ToolRegistry SHALL expose at minimum the tools `search_products`, `resolve_product_name`, `check_inventory`, `update_cart`, `remove_cart_item`, `modify_cart_item`, `save_session_state`, `retrieve_session_state`, `create_order`, and `validate_order`.
2. THE Agent SHALL perform every read or write of cart, catalog, inventory, session, or order data through a tool call registered in ToolRegistry.
3. THE Agent SHALL NOT call any database client, Prisma model, or external API directly from inside the LLM prompt path; all such access MUST flow through ToolRegistry.
4. WHEN the LLM emits a tool call, THE Agent SHALL validate the tool name against ToolRegistry and the arguments against the tool's declared schema before invocation.
5. IF a tool call fails schema validation, THEN THE Agent SHALL reject the call, write a validation failure `AgentTrace` row, and ask the LLM to choose a different tool.
6. THE `validate_order` tool SHALL run before `create_order` is invoked, and `create_order` SHALL refuse to execute when `validate_order` returns a failure result.

### Requirement 7: Strict Order State Machine

**User Story:** As a store operator, I want the order to progress through a strict state machine, so that customers cannot skip required steps such as address collection.

#### Acceptance Criteria

1. THE OrderFSM SHALL define exactly the states `BROWSING`, `PRODUCT_SELECTION`, `CART_BUILDING`, `MISSING_INFO_COLLECTION`, `ADDRESS_COLLECTION`, `PAYMENT_SELECTION`, `ORDER_REVIEW`, `FINAL_CONFIRMATION`, and `ORDER_COMPLETE`.
2. THE OrderFSM SHALL define an explicit allowed-transition table, and the Agent SHALL reject any transition not listed in that table.
3. THE OrderFSM SHALL advance the state forward only when the deterministic preconditions for the next state are satisfied (for example `CART_BUILDING` requires at least one cart line, `ADDRESS_COLLECTION` requires no missing per-line slots).
4. WHEN the LLM proposes an action that would skip a state, THE Agent SHALL override the action and route the conversation to the correct next state.
5. THE Agent SHALL include the `order_state` value in every Snapshot write and every `AgentTrace` row.
6. WHEN the FSM reaches `ORDER_COMPLETE`, THE Agent SHALL clear the in-flight Snapshot's `cart_items` and reset `order_state` to `BROWSING` for the next conversation turn.

### Requirement 8: Missing Information Tracking

**User Story:** As a customer, I want the Agent to ask only for information it does not yet have, so that I am not asked the same question twice.

#### Acceptance Criteria

1. THE Agent SHALL maintain a `missing_information` list in the Snapshot, computed per cart line as Per_Line_Slots plus order-level slots (for example `delivery_address`, `payment_method`).
2. WHEN a slot value is captured, THE Agent SHALL move that slot from `missing_information` into `confirmed_information` within the same turn.
3. THE Agent SHALL ask the customer only about slots present in `missing_information`.
4. IF a slot is already present in `confirmed_information`, THEN THE Agent SHALL NOT ask the customer to provide that slot again.
5. THE Anti_Loop_Guard SHALL block the Agent from asking the same slot question more than two times within one conversation; on the third attempt the Agent SHALL escalate to a clarification fallback.
6. WHEN a new cart line is added with unfilled Per_Line_Slots, THE Agent SHALL append those slots to `missing_information` keyed by the line's `line_id`.

### Requirement 9: Context Retention and Reference Resolution

**User Story:** As a customer, I want to refer to prior items using natural references like `the red one` or `second ta`, so that I do not have to repeat product names.

#### Acceptance Criteria

1. THE Agent SHALL implement Reference_Resolution in deterministic TypeScript code under `src/agent/` and SHALL NOT delegate reference resolution to the LLM.
2. WHEN the customer message contains a pronoun or ordinal reference (for example `it`, `another one`, `the red one`, `first item`, `second ta`, `WC26 ta`), THE Agent SHALL resolve the reference to a specific `line_id` from the current Snapshot before any cart mutation tool is invoked.
3. WHEN the customer message uses a product code such as `WC26`, THE Agent SHALL resolve the code to a catalog `product_id` through the ProductResolver.
4. WHEN the customer says `make the boot size 42` while the cart contains both a jersey line and a boot line, THE Agent SHALL apply `modify_cart_item` to the boot line and SHALL NOT modify the jersey line.
5. IF Reference_Resolution cannot uniquely identify a target line or product with `Confidence_Score` greater than or equal to the high-confidence threshold, THEN THE Agent SHALL ask the customer to disambiguate before mutating the cart.
6. THE Agent SHALL persist the most recent five customer references and their resolved targets in the Snapshot to support follow-up turns.

### Requirement 10: Anti-Hallucination Layer

**User Story:** As a store operator, I want the Agent to never invent products, prices, stock, variants, or order confirmations, so that customers always receive verified information.

#### Acceptance Criteria

1. THE Agent SHALL source all product names, prices, variants, sizes, and stock counts from `check_inventory` or `search_products` tool results, and SHALL NOT generate these values from the LLM.
2. WHEN the LLM-proposed reply text contains a product attribute that is not present in the most recent verified tool result, THE Agent SHALL strip or replace that attribute before sending Customer_Facing_Text.
3. THE Agent SHALL NOT confirm an order to the customer until `create_order` returns a success result containing a persisted order identifier.
4. IF a tool result returns zero stock for a requested product or variant, THEN THE Agent SHALL inform the customer that the item is unavailable and SHALL NOT promise availability.
5. WHEN `Confidence_Score` for a product match falls below the high-confidence threshold, THE Agent SHALL ask a clarification question instead of asserting a product identity.
6. THE Agent SHALL log every anti-hallucination override into `AgentTrace` with the original LLM output and the corrected output.

### Requirement 11: Confidence Scoring

**User Story:** As a store operator, I want explicit confidence scores driving clarification behavior, so that the Agent asks for help instead of guessing.

#### Acceptance Criteria

1. THE Agent SHALL compute `Confidence_Score` values in the range 0.0 to 1.0 for product match, intent detection, and order completeness during every relevant turn.
2. THE Agent SHALL store `confidence_level` on the Snapshot containing the lowest of the three scores produced in the current turn.
3. THE Agent SHALL define configurable thresholds in `src/agent/state.ts` for high-confidence, medium-confidence, and low-confidence bands.
4. WHEN any of the three scores falls below the medium-confidence threshold, THE Agent SHALL trigger a clarification flow before any cart or order mutation.
5. WHEN the order completeness score is below the high-confidence threshold and the FSM is at `FINAL_CONFIRMATION`, THE Agent SHALL roll the FSM back to `ORDER_REVIEW` and re-confirm the cart.
6. THE Agent SHALL include all three `Confidence_Score` values in every `AgentTrace` row written for the turn.

### Requirement 12: Error Recovery

**User Story:** As a customer, I want the Agent to recover gracefully when something is unclear, so that I can continue my order without restarting.

#### Acceptance Criteria

1. WHEN clarification is required, THE Agent SHALL produce a natural-language clarification message that summarizes the items already understood from the current cart.
2. WHEN the FSM enters `ORDER_REVIEW`, THE Agent SHALL produce a confirmation summary of every cart line and the order totals before transitioning to `FINAL_CONFIRMATION`.
3. THE Agent SHALL render confirmation summaries verbatim from the structured cart object and SHALL NOT re-narrate cart contents from prior LLM outputs.
4. IF a tool invocation throws an exception, THEN THE Agent SHALL retry the tool once with the same arguments, and on a second failure SHALL produce a fallback reply that asks the customer to repeat the request.
5. IF Reference_Resolution is ambiguous, THEN THE Agent SHALL list the candidate lines or products with their identifiers and ask the customer to choose one.
6. THE Anti_Loop_Guard SHALL prevent the same clarification question from being asked more than two consecutive times for the same slot.

### Requirement 13: Memory Persistence

**User Story:** As a returning customer, I want the Agent to remember my preferences, sizes, and abandoned carts, so that future conversations feel personalized.

#### Acceptance Criteria

1. THE MemoryStore SHALL persist short-term session state in `MessengerConversation.pendingDraftJson` as the Snapshot.
2. THE MemoryStore SHALL persist long-term `CustomerPreferences` in `CustomerProfile.preferences`, including at minimum favorite teams, recent sizes, and last five purchased product identifiers.
3. WHEN a conversation is idle for the abandoned-cart timeout configured in `src/agent/state.ts` and the cart contains at least one line, THE Agent SHALL create a `FollowUp` row scheduled for re-engagement.
4. WHEN a customer returns after an abandoned cart, THE Agent SHALL load the prior Snapshot, restore `cart_items`, and resume the FSM at the previous `order_state`.
5. THE MemoryStore SHALL store the last five orders for the customer in `CustomerProfile.preferences` for use in future personalization.
6. THE Agent SHALL expose explicit memory tools (for example `save_session_state`, `retrieve_session_state`, plus a long-term memory read and write tool) through ToolRegistry, and these tools SHALL be the only path to read or write Snapshot and `CustomerPreferences` data.

### Requirement 14: Response Behavior

**User Story:** As a customer, I want the Agent's replies to feel natural, concise, and sales-oriented, so that the conversation does not feel robotic.

#### Acceptance Criteria

1. THE Agent SHALL produce Customer_Facing_Text that is conversational, concise, and sales-oriented in tone.
2. THE Agent SHALL NOT produce Customer_Facing_Text longer than the maximum-reply-length value configured in `src/agent/replyFilter.ts`.
3. THE Agent SHALL NOT include any Banned_Word in Customer_Facing_Text; the initial banned set is `cart`, `checkout`, and `select`.
4. WHEN the reply contains a list of items, THE Agent SHALL render the items as a structured list and SHALL NOT emit a single dense paragraph.
5. THE Anti_Loop_Guard SHALL prevent the Agent from repeating the same question text within three consecutive turns.
6. THE Agent SHALL ground every Customer_Facing_Text reply in the most recent verified tool results for the current turn.

### Requirement 15: Debugging and Regression Diagnostics

**User Story:** As a developer, I want every turn to be inspectable, so that I can diagnose regressions in state, memory, prompting, cart, tool orchestration, and session handling.

#### Acceptance Criteria

1. THE Tracer SHALL write an `AgentTrace` row for every step of the AgentLoop containing the step name, inputs, outputs, latency in milliseconds, FSM state, and the three `Confidence_Score` values.
2. THE Snapshot stored in `MessengerConversation.pendingDraftJson` SHALL be human-readable JSON suitable for direct inspection in the database.
3. WHEN a regression is suspected, THE Agent SHALL allow a developer to replay a conversation by reading prior `AgentTrace` rows in order and reconstructing the Snapshot at any turn.
4. THE Agent SHALL emit a structured log entry for every tool call containing the tool name, validated arguments, and result identifier.
5. THE Agent SHALL emit a structured log entry whenever the Anti_Loop_Guard or Anti-Hallucination Layer overrides an LLM decision.
6. THE Agent SHALL provide a developer command path that dumps the current Snapshot, the most recent ten `AgentTrace` rows, and the last verified tool results for a given conversation identifier.

### Requirement 16: Regression Root-Cause Analysis Deliverable

**User Story:** As a developer, I want a written root-cause analysis of the previous regression, so that the rebuild is grounded in the failure modes that caused it.

#### Acceptance Criteria

1. THE Agent rebuild SHALL include a root-cause analysis document at `docs/REGRESSION-ANALYSIS.md` in the repository.
2. THE root-cause analysis document SHALL cover at minimum the categories broken state logic, lost memory persistence, context window problems, prompting defects, cart architecture defects, weak tool orchestration, and improper session handling.
3. THE root-cause analysis document SHALL identify, for each category, the offending file paths under `src/agent/` and the specific code-level cause.
4. THE root-cause analysis document SHALL map each identified root cause to the requirement number in this document that addresses it.
5. THE root-cause analysis document SHALL include a recommended prompt structure section, a recommended database schema extensions section, an error handling strategy section, and a session memory strategy section.
6. THE Agent rebuild SHALL be considered incomplete until `docs/REGRESSION-ANALYSIS.md` exists, is referenced from the design document, and covers every category listed in this requirement.
