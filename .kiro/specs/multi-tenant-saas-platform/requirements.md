# Requirements Document

## Introduction

This spec evolves the existing AI Facebook commerce platform (currently optimized for jersey businesses, codename "Sports Nation BD Returns") into a full **multi-tenant AI commerce operating system** that supports many business categories dynamically. The work is a refactor and extension of the running system, not a greenfield rebuild.

The Platform already provides a working AI sales agent on Ollama gemma4:31b-cloud, Facebook Messenger integration, PostgreSQL via Prisma 6, a legacy admin dashboard at `localhost:4000/admin`, a Next.js portal at `localhost:3000`, a product catalog, an order workflow service, content calendar, autonomous posting, tenant auth with `TenantSession`, per-tenant `botPersona`, payment gateways (SSLCommerz, AamarPay, bKash Tokenized, COD, manual), and a tool-loop agent. The current limitation is that business logic (size charts, jersey-specific attributes, sales reasoning) is hardcoded for jerseys.

The objective of this spec is to remove every hardcoded business assumption and replace it with **configuration-driven, category-driven, schema-driven, tenant-aware** behavior, while bolting on a complete subscription billing layer on top of SSLCommerz so the Platform becomes a real SaaS product.

This spec covers the 23 functional areas the user enumerated, grouped into 16 requirements:

- **Onboarding & category foundation** (Reqs 1–4): wizard, category registry, dynamic product attributes, category intelligence
- **Dynamic UI** (Reqs 5–6): dashboard composition and form builder
- **AI personalization & tenant awareness** (Reqs 7–9): agent identity, memory isolation, category-aware reasoning and prompts
- **Commerce operations** (Req 10): category-aware order structure
- **Subscription lifecycle** (Reqs 11–14): schema, SSLCommerz billing, plans + feature flags, overdue/grace handling
- **Operational surfaces** (Reqs 15–16): notifications, admin super control panel, modular architecture and future-readiness

### Non-Goals

The following are **explicitly out of scope** for this spec:

1. **No Prisma migrations.** The database is in drift state. All schema changes use `prisma db push` only. Migration history is not introduced in this spec.
2. **No parallel agent module.** All agent changes refactor in place under `src/agent/`. Creating `src/agent2/` or any sibling module is forbidden.
3. **No replacement of legacy admin UI.** The vanilla JS admin at `localhost:4000/admin` (the one the operator actually uses) and the Next.js admin at `localhost:3000/admin` continue to coexist. This spec extends the legacy UI for super-admin controls and adds tenant-facing screens to the Next.js portal; it does not consolidate them.
4. **WhatsApp, voice, multilingual, video marketing, Shopify, marketplace integrations are architecture-only.** This spec requires the Platform to expose extension points (channel adapters, prompt slots, schema hooks) for these surfaces but does not implement any of them.
5. **No customer-facing English copy.** All buyer-facing text remains Banglish. Internal vocabulary (`catalog`, `SKU`, `tenant`) MUST NOT leak into customer-facing replies regardless of category.
6. **No replacement of historical column names.** `sslcommerzTranId`, `sslcommerzSessionKey`, `pathaoConsignmentId`, `pathaoMerchantOrderId` continue to act as universal gateway/courier columns. Category-specific data follows the existing JSON-metadata pattern (as already used by `ProductMapping.metadata`).
7. **No Windows-incompatible native deps.** Continue using `bcryptjs` (pure JS), not `bcrypt`.
8. **No new model.** AI calls continue to use `gemma4:31b-cloud` (configured in `.env`). Switching the underlying model is out of scope.

### Existing Code Anchor Points

The design phase will hook the new behavior into these existing files:

- `prisma/schema.prisma` — new tables for categories, subscriptions, invoices, plan limits
- `src/agent/prompts.ts` — `buildAgentSystemPrompt(identity)` extended with category schema and brand voice
- `src/agent/loop.ts`, `src/agent/askRouter.ts`, `src/agent/tools/registry.ts` — tenant context and feature-flag enforcement on every cycle
- `src/agent/replyFilter.ts` — extended for category-specific banned-word and tone passes
- `src/services/orderWorkflowService.ts` (~5500 lines) — order structure becomes category-aware
- `src/services/catalogReplyService.ts` — product surfacing reads category schema
- `src/services/handoffPolicy.ts` — grace-window pattern reused for subscription grace period
- `src/routes/tenantPortalRoutes.ts` — onboarding endpoints, persona settings, plan info
- `client/src/app/portal/*` — dynamic dashboard widgets
- `client/src/app/portal/onboarding/*` — NEW onboarding wizard pages
- `public/admin/app.js` — legacy admin gets super-admin subscription/tenant management screens
- New: `src/services/categoryRegistry.ts`, `src/services/subscriptionService.ts`, `src/services/featureFlagService.ts`, `src/integrations/sslcommerz/subscription.ts`, `src/services/notificationService.ts`

## Glossary

- **Platform**: The full multi-tenant SaaS system (backend + portal + legacy admin + AI agent + subscription engine).
- **Tenant**: A single client business that owns its products, conversations, AI persona, orders, and subscription. Identified by `tenantId` (e.g. demo tenant `cmooz62gy0000v5gclycwq78p`).
- **Tenant_Context**: The runtime bundle `{ tenantId, businessCategory, categorySchema, agentIdentity, brandVoice, planLimits, featureFlags, workflowRules }` injected into every AI cycle and every business-logic call.
- **Business_Category**: A named class of business behavior, e.g. `jersey`, `clothing`, `undergarments`, `shoes`, `cosmetics`, `electronics`, `restaurant`, `grocery`, `jewelry`, `furniture`, `pet_shop`, `pharmacy`, `mobile_accessories`, `custom`.
- **Category_Registry**: The service (`src/services/categoryRegistry.ts`) that owns the canonical list of categories, their schemas, terminology, workflow hints, and dashboard template references.
- **Category_Schema**: A structured definition `{ category, subcategory?, attributes[], orderFields[], dashboardTemplate, terminology, workflows[] }` that drives forms, AI reasoning, dashboard composition, and order structure for a tenant.
- **Agent_Identity**: A tenant-scoped record `{ name, role, personality, tone, language, salesStyle, greetingStyle }` that personalizes the AI agent per tenant. Extends the existing `botPersona` setting.
- **Brand_Voice**: The tone-and-style portion of `Agent_Identity` consumed by `replyFilter.ts` and `prompts.ts`.
- **Onboarding_Wizard**: The first-login flow under `client/src/app/portal/onboarding/*` that collects category, subcategory, attributes, and persona.
- **Dashboard_Engine**: The Next.js portal subsystem that composes dashboard widgets dynamically from `Category_Schema.dashboardTemplate`.
- **Form_Builder**: The shared component layer that renders product, variant, order, and filter forms from `Category_Schema.attributes` and `Category_Schema.orderFields`.
- **Order_System**: `src/services/orderWorkflowService.ts` plus its callers, which produce and persist `Order` records whose shape varies by category.
- **AI_Agent**: The LangGraph-style tool loop in `src/agent/loop.ts` plus `prompts.ts` and tool registry.
- **Subscription_Service**: New service `src/services/subscriptionService.ts` that owns the subscription state machine, invoice generation, and grace-period bookkeeping.
- **Subscription_State**: One of `trial`, `active`, `overdue`, `suspended`, `cancelled`.
- **Plan**: One of `STARTER`, `PRO`, `AGENCY`, `ENTERPRISE`. A Plan has a row in `plan_limits` defining numeric and boolean caps.
- **Plan_Limit**: A numeric or boolean cap on a tenant capability (e.g. `maxProducts`, `maxMonthlyMessages`, `autonomousPostingEnabled`).
- **Feature_Flag_Service**: New service `src/services/featureFlagService.ts` that resolves `(tenantId, featureKey) → boolean | number` from Plan + tenant overrides.
- **SSLCommerz_Adapter**: `src/integrations/sslcommerz/subscription.ts` (new), wrapping the existing SSLCommerz payment integration for recurring subscription charges. Reuses `sslcommerzTranId` and `sslcommerzSessionKey` columns as universal gateway columns.
- **Invoice**: A row in the `invoices` table representing one billing cycle's charge for one tenant.
- **Payment_Transaction**: A row in `payment_transactions` representing one attempt to settle an invoice. Has a stable `gatewayTransactionId`.
- **Grace_Period**: A configured number of days (default 3) after `dueDate` during which the tenant is `overdue` but not yet `suspended`.
- **Notification_Service**: New service `src/services/notificationService.ts` that fans out to dashboard, email, Telegram (existing pipeline `sendTelegramMessage`), and architecture-only stubs for WhatsApp and Facebook.
- **Admin_Panel**: The legacy vanilla JS UI at `public/admin/app.js`, extended in this spec with subscription, tenant, payment, and category management screens.
- **Memory_Store**: The tenant-scoped conversation memory and AI working memory, today keyed by `tenantId` in agent storage.
- **Demo_Tenant**: The tenant with id `cmooz62gy0000v5gclycwq78p`, used as the canonical example for jersey behavior during refactor.

## Requirements

### Requirement 1: First-Login Onboarding Wizard

**User Story:** As a new tenant operator, I want a guided first-login wizard that captures my business category and product structure preferences, so that the Platform can configure my dashboard, AI agent, and product schema without manual setup.

#### Acceptance Criteria

1. WHEN a tenant logs in for the first time and the tenant has no `Business_Category` recorded, THE Onboarding_Wizard SHALL redirect the operator to `/portal/onboarding` before any other portal route renders.
2. THE Onboarding_Wizard SHALL present the following preset categories in step 1: `jersey`, `clothing`, `undergarments`, `shoes`, `cosmetics`, `electronics`, `restaurant`, `grocery`, `jewelry`, `furniture`, `pet_shop`, `pharmacy`, `mobile_accessories`, `custom`.
3. WHERE the operator selects `custom`, THE Onboarding_Wizard SHALL require a non-empty free-text category name of 1 to 64 characters and SHALL persist it as the tenant's `Business_Category`.
4. WHEN the operator advances past step 1, THE Onboarding_Wizard SHALL load the matching `Category_Schema` from the `Category_Registry` and SHALL pre-fill step 2 (subcategory, required attributes, dashboard template) from that schema.
5. THE Onboarding_Wizard SHALL allow the operator to add or remove attributes in step 2, and SHALL persist the operator-edited attribute list as the tenant's effective `Category_Schema`.
6. WHEN the operator advances past step 2, THE Onboarding_Wizard SHALL collect `Agent_Identity` fields (`name`, `role`, `personality`, `tone`, `language`, `salesStyle`, `greetingStyle`) with sensible defaults from the chosen category.
7. WHEN the operator submits the final step, THE Onboarding_Wizard SHALL persist `Business_Category`, effective `Category_Schema`, and `Agent_Identity` atomically in a single transaction.
8. IF persistence in step 7 fails, THEN THE Onboarding_Wizard SHALL roll back all three writes and SHALL display a retry prompt without marking onboarding complete.
9. WHEN onboarding completes successfully, THE Platform SHALL set a `tenant.onboardingCompletedAt` timestamp and SHALL never redirect that tenant to the wizard again unless an admin clears the timestamp.
10. WHILE the tenant has not completed onboarding, THE AI_Agent SHALL refuse to generate customer-facing replies for that tenant and SHALL log the refusal reason `onboarding_incomplete`.

#### Correctness Properties

- **Atomicity**: For any onboarding submission that returns success, all three target rows (`tenant.businessCategory`, `tenant.categorySchema`, `tenant.agentIdentity`) exist; for any submission that returns failure, none of the three are written.
- **One-shot redirect**: After `onboardingCompletedAt` is set, no number of subsequent logins triggers a redirect to `/portal/onboarding`.

### Requirement 2: Business Category Registry

**User Story:** As a Platform engineer, I want a single Category_Registry that owns all category definitions, so that adding a new category does not require code changes scattered across the agent, dashboard, and order system.

#### Acceptance Criteria

1. THE Category_Registry SHALL expose a function `getCategorySchema(category: string): CategorySchema` that returns a schema for every preset category listed in Requirement 1.2 and for `custom`.
2. THE Category_Registry SHALL define each `CategorySchema` with the fields `{ category, subcategories[], attributes[], orderFields[], dashboardTemplate, terminology, workflows[] }`.
3. THE Category_Registry SHALL be the only source of category data read by the AI_Agent, the Dashboard_Engine, the Form_Builder, and the Order_System.
4. WHEN a tenant's effective `Category_Schema` was customized during onboarding, THE Category_Registry SHALL return the merged schema (registry defaults overlaid with tenant overrides) for that tenant.
5. IF a caller requests a schema for an unknown category string, THEN THE Category_Registry SHALL fall back to the `custom` schema and SHALL log a `category_unknown` warning with the requested string.
6. THE Category_Registry SHALL expose `listCategories(): CategoryListing[]` so the Onboarding_Wizard and Admin_Panel can render the same list without duplicating it.

#### Correctness Properties

- **Single source of truth**: A grep across `src/agent/`, `src/services/orderWorkflowService.ts`, `src/services/catalogReplyService.ts`, and `client/src/app/portal/` finds zero hardcoded references to `jersey`, `chest`, `team`, `player_version`, or any other category-specific literal outside of `categoryRegistry.ts` (and its tests). This property is verified by a static check, not by execution at runtime.
- **Idempotent merge**: For any tenant override `O` and registry default `D`, `merge(D, merge(D, O)) === merge(D, O)`. Applying the same override twice produces the same effective schema.

### Requirement 3: Dynamic Product Attribute Schema

**User Story:** As a tenant operator, I want product attributes that match my business (e.g. spice level for restaurants, shade for cosmetics), so that I can describe products correctly without the Platform forcing jersey fields on me.

#### Acceptance Criteria

1. THE Platform SHALL store category-specific product attributes in the existing `ProductMapping.metadata` JSON column following the same pattern already used for `compareAtPrice`, `saleStartsAt`, `saleEndsAt`.
2. WHEN a product is created or updated, THE Platform SHALL validate the attributes payload against the tenant's effective `Category_Schema.attributes` and SHALL reject the request with an explicit field-level error list if any required attribute is missing.
3. THE Platform SHALL accept attribute values of type `string`, `number`, `boolean`, `enum`, and `string[]` as declared by `Category_Schema.attributes[].type`.
4. IF a write attempts to store an attribute key that is not declared in the tenant's `Category_Schema`, THEN THE Platform SHALL reject the write with error code `attribute_not_in_schema`.
5. WHEN a product is read, THE Platform SHALL return attributes in the order declared by `Category_Schema.attributes` regardless of their physical key order in the JSON column.
6. THE Platform SHALL NOT add or alter any column on `ProductMapping` to support category-specific fields. (Constraint: no Prisma migrations; reuse JSON metadata pattern.)

#### Correctness Properties

- **Schema round-trip**: For any product `P` written under `Category_Schema S`, reading `P` back and re-validating against `S` succeeds with zero errors. Specifically: `validate(read(write(P, S)), S) === ok`.
- **Schema rejection determinism**: For any product `P` and schema `S`, if `validate(P, S)` returns errors `E`, then attempting to write `P` under `S` returns the same error set `E` and persists nothing.
- **Type coverage**: For every attribute type in `{string, number, boolean, enum, string[]}`, there exists at least one round-trip test case.

### Requirement 4: Category Intelligence Engine

**User Story:** As a buyer chatting with the AI agent, I want the agent to ask the right follow-up questions for the products I'm shopping for (e.g. cup size for undergarments, spice level for food), so that the agent doesn't ask jersey-style questions about a curry.

#### Acceptance Criteria

1. WHEN the AI_Agent enters its reasoning loop for a tenant, THE AI_Agent SHALL load the tenant's effective `Category_Schema` via the Category_Registry and SHALL include `{ attributes, terminology, workflows }` in the system prompt.
2. THE AI_Agent SHALL prefer terminology defined in `Category_Schema.terminology` over generic terms in customer-facing text (e.g. "shade" instead of "color" for cosmetics tenants).
3. WHEN the buyer asks a clarifying question that maps to a `Category_Schema.attribute`, THE AI_Agent SHALL respond with values constrained to that attribute's declared `enum` or value range when one is declared.
4. WHERE `Category_Schema.workflows` declares a workflow keyed `delivery_window`, `size_recommendation`, `compatibility_check`, or `prescription_required`, THE AI_Agent SHALL invoke the corresponding tool from the tool registry before confirming an order.
5. IF a workflow declared in `Category_Schema.workflows` is not registered in the tool registry, THEN THE AI_Agent SHALL log a `workflow_missing` error, SHALL skip that workflow, and SHALL continue order confirmation without crashing.
6. THE AI_Agent SHALL continue to emit Banglish customer-facing text regardless of category, and SHALL NOT expose internal terms (`catalog`, `SKU`, `tenant`) in any reply.

### Requirement 5: Dynamic Client Dashboard

**User Story:** As a tenant operator, I want my portal dashboard to show the controls that match my business (size charts for jerseys, menu manager for restaurants, shade selector for cosmetics), so that I'm not staring at jersey widgets when I sell pet food.

#### Acceptance Criteria

1. WHEN a tenant operator opens any page under `/portal`, THE Dashboard_Engine SHALL fetch the tenant's effective `Category_Schema.dashboardTemplate` and SHALL compose the page from the widgets it declares.
2. THE Dashboard_Engine SHALL resolve every widget id in `dashboardTemplate.widgets[]` against a single widget registry; widgets SHALL NOT be hardcoded into route files.
3. WHERE `dashboardTemplate.widgets[]` includes a widget id that is not present in the widget registry, THE Dashboard_Engine SHALL render a placeholder card showing `Widget {id} not available` and SHALL log `widget_missing`.
4. WHEN the operator changes their `Category_Schema` from the portal, THE Dashboard_Engine SHALL re-render the affected pages on the next navigation without requiring a full page reload of the portal shell.
5. THE Dashboard_Engine SHALL render the same widget set for the same `Category_Schema` regardless of tenant identity, except where a widget is gated by a `Feature_Flag` (see Requirement 13).

#### Correctness Properties

- **Determinism**: For any two tenants `T1` and `T2` whose effective `Category_Schema` and `Plan` are equal, the rendered widget id list is identical.
- **No leakage**: No widget rendered for tenant `T1` ever queries data scoped to a different tenant `T2`, regardless of timing or user actions on the page.

### Requirement 6: Dynamic Form Builder

**User Story:** As a tenant operator, I want product, variant, and order forms to be generated from my category schema, so that I never see jersey-only fields when I'm not selling jerseys.

#### Acceptance Criteria

1. THE Form_Builder SHALL render product, variant, order, and filter forms from the tenant's effective `Category_Schema.attributes` and `Category_Schema.orderFields`.
2. THE Form_Builder SHALL render input controls based on attribute type: `string` → text input, `number` → number input, `boolean` → toggle, `enum` → select, `string[]` → multi-select chips.
3. WHEN the operator submits a form, THE Form_Builder SHALL run client-side validation against the same schema rules used server-side in Requirement 3.2.
4. IF an attribute declares `required: true` and the submitted value is empty, THEN THE Form_Builder SHALL block submission and SHALL display an inline error referencing the attribute label.
5. THE Form_Builder SHALL NOT contain category-specific control implementations. (E.g. there is no `<JerseySizePicker>` component; jersey size selection is realized as an `enum` attribute.)

#### Correctness Properties

- **Symmetric validation**: For any payload `P` and schema `S`, the client-side and server-side validators agree on accept/reject for `P` against `S`.

### Requirement 7: AI Agent Personalization

**User Story:** As a tenant operator, I want my own named AI agent with my chosen tone and style (e.g. "Sarah - Fashion Consultant", "ChefBot - Restaurant Order Manager"), so that buyers feel they're talking to my brand and not a generic bot.

#### Acceptance Criteria

1. THE Platform SHALL extend the existing `botPersona` setting to include `{ name, role, personality, tone, language, salesStyle, greetingStyle }` as the tenant's `Agent_Identity`.
2. THE AI_Agent SHALL pass `Agent_Identity` into `buildAgentSystemPrompt(identity)` in `src/agent/prompts.ts` on every reasoning cycle, and SHALL NOT call the legacy `AGENT_SYSTEM_PROMPT` constant in production paths.
3. WHEN a tenant operator updates `Agent_Identity` from the portal, THE AI_Agent SHALL use the updated identity on the next message processed for that tenant without a service restart.
4. THE replyFilter pipeline (`src/agent/replyFilter.ts`) SHALL apply the tenant's `Brand_Voice` in its tone-rewrite pass.
5. WHERE `Agent_Identity.greetingStyle` is set, THE AI_Agent SHALL use the configured greeting form for the first message in a conversation and SHALL NOT inject a generic platform greeting.
6. THE Agent_Identity of one tenant SHALL NOT influence the system prompt, persona, or replies of any other tenant.

### Requirement 8: Tenant Memory Isolation

**User Story:** As a tenant operator, I want absolute confidence that my conversations, products, prompts, and analytics never leak into another tenant's system or AI context, so that the SaaS is safe to sell to competing businesses.

#### Acceptance Criteria

1. THE Platform SHALL include `tenantId` as a required parameter on every read and write to: `Memory_Store`, conversations, products, prompts, agent identity, analytics, automation rules, orders, and notifications.
2. THE AI_Agent SHALL load context, memory, and tools scoped to a single `tenantId` per reasoning cycle and SHALL refuse to merge memory across tenants.
3. IF a database query is issued without a `tenantId` filter against any tenant-owned table, THEN the Platform SHALL reject the query at the data-access layer with error `tenant_scope_missing`.
4. THE Memory_Store SHALL key conversation memory by `(tenantId, conversationId)` such that two conversations with the same `conversationId` under different tenants are distinct records.
5. WHEN an admin acts on behalf of a tenant from the Admin_Panel, THE Platform SHALL still enforce single-tenant scope on every downstream call (admin context expands access to multiple tenants but every call still names exactly one).
6. THE Platform SHALL log every cross-tenant access attempt with the requested `tenantId`, the actor's allowed tenants, and the rejection reason.

#### Correctness Properties

- **Strict isolation invariant**: For any pair of distinct tenants `T1 ≠ T2`, no operation initiated under `T1` ever returns a row, embedding, or token whose `tenantId` field equals `T2`.
- **Query safety**: For any tenant-owned model `M`, every code path that constructs a query against `M` either applies a `tenantId` filter or is explicitly admin-scoped and audited.
- **Memory key separation**: For any `conversationId C`, `memory(T1, C)` and `memory(T2, C)` are stored, retrieved, and evicted independently.

### Requirement 9: Category-Aware AI Reasoning and Prompts

**User Story:** As a Platform engineer, I want the AI's reasoning loop and system prompt to always reflect the calling tenant's full context (category, schema, identity, plan), so that AI behavior is consistent, configurable, and never falls back to jersey defaults.

#### Acceptance Criteria

1. THE AI_Agent SHALL construct a `Tenant_Context` object containing `{ tenantId, businessCategory, categorySchema, agentIdentity, brandVoice, planLimits, featureFlags, workflowRules }` on every reasoning cycle.
2. THE AI_Agent SHALL pass `Tenant_Context` into `buildAgentSystemPrompt` and into every tool invocation in the registry.
3. THE prompt template SHALL include declared sections for: tenant category, business type, product schema, AI role, AI name, client tone, category rules.
4. WHEN any field of `Tenant_Context` changes between two consecutive cycles for the same conversation, THE AI_Agent SHALL rebuild the system prompt rather than reuse a cached prompt.
5. WHERE `planLimits.aiUsageRemaining` is zero or negative, THE AI_Agent SHALL refuse to start a new reasoning cycle and SHALL return a Banglish capacity-exhausted reply that does not expose the term `plan` or `quota` to the buyer.
6. THE AI_Agent SHALL NOT contain conditional branches keyed on a hardcoded category literal (e.g. `if (category === 'jersey')`); category-specific branching SHALL be expressed as schema-driven workflow lookups.

### Requirement 10: Dynamic Order System

**User Story:** As a tenant operator, I want orders to capture the data my category needs (size and color for fashion; spice level, toppings, delivery notes for food; warranty and accessories for electronics), so that my fulfillment process gets the right information.

#### Acceptance Criteria

1. THE Order_System SHALL persist category-specific order fields inside the existing `Order` JSON metadata column following the same pattern as `ProductMapping.metadata`. (No new columns; reuse JSON.)
2. WHEN an order is created, THE Order_System SHALL validate the order payload against `Category_Schema.orderFields` and SHALL reject creation with field-level errors if any required order field is missing.
3. THE Order_System SHALL continue to use `pathaoConsignmentId` and `pathaoMerchantOrderId` as universal courier columns for any courier integration regardless of category.
4. THE Order_System SHALL continue to use `sslcommerzTranId` and `sslcommerzSessionKey` as universal gateway columns for any payment gateway regardless of category.
5. WHEN `confirm_order` runs, THE Order_System SHALL pick the active payment gateway by the existing tenant priority order (SSLCommerz, AamarPay, bKash Tokenized, COD, manual) and SHALL NOT branch on category.
6. THE Order_System SHALL render order summary text to buyers in Banglish using terminology from the tenant's `Category_Schema.terminology`.

#### Correctness Properties

- **Order schema round-trip**: For any order `O` written under `Category_Schema S`, reading `O` back and re-validating against `S` produces no new errors.
- **Gateway column universality**: For any successful payment, the populated gateway columns are `sslcommerzTranId` and `sslcommerzSessionKey` regardless of which gateway settled the payment.

### Requirement 11: Subscription Schema and State Machine

**User Story:** As the Platform owner, I want a complete subscription lifecycle backed by a normalized schema, so that billing is auditable and tenant access is automatically gated by subscription status.

#### Acceptance Criteria

1. THE Platform SHALL add the following Postgres tables via `prisma db push`: `subscriptions`, `invoices`, `payment_transactions`, `subscription_logs`, `payment_failures`, `grace_period_tracking`, `plan_limits`.
2. THE `subscriptions` table SHALL include at minimum `{ id, tenantId, plan, state, startDate, currentPeriodStart, currentPeriodEnd, nextBillingDate, gracePeriodDays, cancelledAt, createdAt, updatedAt }`.
3. THE `Subscription_State` field SHALL take exactly one of `trial`, `active`, `overdue`, `suspended`, `cancelled` at any time.
4. THE Subscription_Service SHALL enforce the following allowed transitions, and SHALL reject all others with error `invalid_subscription_transition`:
   - `trial → active` (on first successful payment)
   - `trial → cancelled`
   - `active → overdue` (when `currentPeriodEnd` passes without a successful payment)
   - `overdue → active` (on successful payment within grace period)
   - `overdue → suspended` (when grace period ends without a successful payment)
   - `suspended → active` (on successful payment after suspension)
   - `active → cancelled`
   - `overdue → cancelled`
   - `suspended → cancelled`
5. WHEN a transition occurs, THE Subscription_Service SHALL append a row to `subscription_logs` recording `{ tenantId, fromState, toState, reason, actor, occurredAt }`.
6. THE Subscription_Service SHALL store all monetary values in the smallest currency unit (paisa for BDT) as integers.
7. WHILE a tenant's `Subscription_State` is `suspended`, THE Platform SHALL preserve all tenant data (products, conversations, orders, memory) without deletion.

#### Correctness Properties

- **State machine soundness**: For any sequence of transition requests, the Subscription_Service either applies the transition (if it is in the allowed set) or rejects it; no other state ever appears in `subscriptions.state`.
- **Log completeness**: For every accepted transition, exactly one matching row exists in `subscription_logs` with `toState` equal to the new state.
- **Suspension is non-destructive**: For any tenant `T` that enters `suspended`, the row counts of `T`'s products, conversations, orders, and memory entries are unchanged from the moment of suspension until reactivation, modulo writes the operator makes during suspension (which are blocked by Requirement 13).

### Requirement 12: SSLCommerz Subscription Billing

**User Story:** As the Platform owner, I want subscription charges to run automatically on SSLCommerz on the same day each month from the tenant's start date, so that I don't chase payments manually.

#### Acceptance Criteria

1. THE SSLCommerz_Adapter SHALL initiate a subscription charge for each tenant whose `subscriptions.nextBillingDate` is on or before today and whose state is `trial`, `active`, or `overdue`.
2. WHEN SSLCommerz reports a successful charge, THE Subscription_Service SHALL: insert a `payment_transactions` row with the gateway transaction id stored in `sslcommerzTranId`, mark the corresponding `invoice.status = paid`, advance `currentPeriodStart`, `currentPeriodEnd`, and `nextBillingDate` by one month, and apply the relevant state transition (e.g. `overdue → active`).
3. WHEN SSLCommerz reports a failed charge, THE Subscription_Service SHALL insert a `payment_failures` row with `{ tenantId, invoiceId, attemptNumber, gatewayCode, gatewayMessage, attemptedAt }` and SHALL NOT advance billing dates.
4. THE Subscription_Service SHALL be idempotent on `gatewayTransactionId`: receiving the same `gatewayTransactionId` twice SHALL result in exactly one `payment_transactions` row, exactly one billing-date advance, and exactly one state transition.
5. WHEN an invoice is paid, THE Notification_Service SHALL deliver an invoice copy to the tenant via dashboard and email channels (per Requirement 14).
6. IF a charge attempt encounters a non-retryable error code as defined by SSLCommerz, THEN THE Subscription_Service SHALL mark the invoice `status = failed_terminal` and SHALL NOT retry it automatically; the operator can retry manually from the Admin_Panel.
7. THE Platform SHALL NOT process recurring charges through any gateway other than SSLCommerz for subscriptions in this spec. (One-off product purchases continue to use the existing multi-gateway priority.)

#### Correctness Properties

- **Payment idempotency**: For any `gatewayTransactionId G` received `n ≥ 1` times, the resulting state is identical to receiving `G` exactly once: one `payment_transactions` row, one invoice transition, one billing-date advance.
- **Monotonic billing dates**: Across any sequence of successful charges, `currentPeriodStart`, `currentPeriodEnd`, and `nextBillingDate` are non-decreasing.
- **No silent loss**: Every webhook callback received from SSLCommerz produces either a `payment_transactions` row or a `payment_failures` row; none is dropped.

### Requirement 13: Plan System and Feature Flag Enforcement

**User Story:** As the Platform owner, I want each tenant's capabilities (message volume, AI usage, product count, social accounts, automation features, posting limits) to be controlled by their plan, so that paid tiers actually mean something.

#### Acceptance Criteria

1. THE Platform SHALL define exactly four plans: `STARTER`, `PRO`, `AGENCY`, `ENTERPRISE`, each with a row in `plan_limits` declaring at minimum `{ maxProducts, maxMonthlySocialPosts, maxMonthlyMessages, maxAiTokensPerMonth, maxSocialAccounts, autonomousPostingEnabled, contentCalendarEnabled, multiAgentEnabled, prioritySupport }`.
2. THE Feature_Flag_Service SHALL resolve `(tenantId, featureKey)` by reading the tenant's plan limits overlaid with any per-tenant override stored on the tenant row.
3. WHEN any code path is about to perform an action gated by a feature flag (creating a product, posting to social, sending an AI reply, enabling autonomous posting), THE caller SHALL consult the Feature_Flag_Service first and SHALL block the action if the flag resolves to `false` or if a numeric counter is exhausted.
4. THE Platform SHALL NOT contain conditional logic keyed on a hardcoded plan literal (e.g. `if (plan === 'PRO')`); plan-specific behavior SHALL be expressed as feature flag lookups.
5. WHILE a tenant's `Subscription_State` is `suspended`, THE Feature_Flag_Service SHALL resolve every action-gating flag to `false` regardless of plan, with the exception of read-only access to billing and the Admin_Panel-driven reactivation flow.
6. WHEN a numeric usage counter is decremented below zero (overage), THE Platform SHALL block the action and SHALL emit a Banglish capacity-exhausted reply if the action was AI-driven.

#### Correctness Properties

- **Plan enforcement invariant**: For any action `A` gated by feature flag `F` and any tenant `T`, if `Feature_Flag_Service(T, F) === false`, then no successful execution of `A` for `T` ever occurs.
- **Suspension override**: While `T.subscriptionState === 'suspended'`, every action-gating feature flag for `T` resolves to `false`.
- **No hardcoded plan branches**: A static check across `src/` and `client/src/` finds zero string-literal comparisons against `'STARTER' | 'PRO' | 'AGENCY' | 'ENTERPRISE'` outside of `featureFlagService.ts`, `subscriptionService.ts`, and tests.

### Requirement 14: Overdue and Grace Period Handling

**User Story:** As the Platform owner, I want a clear, automated overdue flow with three escalating warnings followed by suspension, so that delinquent tenants get fair notice and the Platform stops serving them when they don't pay.

#### Acceptance Criteria

1. WHEN `currentPeriodEnd` passes for a tenant whose latest invoice is unpaid, THE Subscription_Service SHALL transition the tenant from `active` to `overdue` and SHALL create a `grace_period_tracking` row recording the grace window start and configured length (default 3 days).
2. WHEN a tenant enters `overdue`, THE Notification_Service SHALL send the day-1 warning to the operator via dashboard and email.
3. WHEN 24 hours have elapsed in `overdue` without payment, THE Notification_Service SHALL send the day-2 warning to the operator via dashboard and email.
4. WHEN 48 hours have elapsed in `overdue` without payment, THE Notification_Service SHALL send the day-3 final warning to the operator via dashboard and email.
5. WHEN the configured grace period elapses without a successful payment, THE Subscription_Service SHALL transition the tenant to `suspended` and SHALL: disable AI replies, disable autonomous posting, disable Messenger send, and disable order capture.
6. THE Subscription_Service SHALL NOT delete tenant data when transitioning to `suspended`. (Re-stating Requirement 11.7 as an enforcement rule on this flow.)
7. WHEN a payment is captured for a `suspended` tenant, THE Subscription_Service SHALL transition the tenant to `active`, SHALL re-enable AI replies, autonomous posting, Messenger send, and order capture, and SHALL clear the `grace_period_tracking` row for that cycle.
8. THE grace period length SHALL be configurable per tenant on the `subscriptions.gracePeriodDays` column with a default of 3.

#### Correctness Properties

- **Warning ordering**: For any overdue cycle, day-1, day-2, and day-3 warnings are sent in strictly increasing time order; later warnings are never sent before earlier ones.
- **Grace boundary**: A tenant that pays at any moment before `gracePeriodTracking.endsAt` returns to `active`; a tenant that does not pay by `gracePeriodTracking.endsAt` is `suspended` no later than the next scheduler tick after that timestamp.
- **Reactivation completeness**: After reactivation, every capability that was disabled on suspension is re-enabled in the same operation.

### Requirement 15: Notification Delivery

**User Story:** As a tenant operator, I want subscription, billing, and operational notifications to reach me through multiple channels, so that I don't miss something critical.

#### Acceptance Criteria

1. THE Notification_Service SHALL support the following channels: `dashboard`, `email`, `telegram` (via the existing `sendTelegramMessage` and `sendTelegramDocument` pipeline), and architecture-only adapter slots for `whatsapp` and `facebook`.
2. WHEN a notification is dispatched, THE Notification_Service SHALL fan out to every channel enabled for that notification type in the tenant's notification preferences.
3. IF a delivery to one channel fails, THEN THE Notification_Service SHALL still attempt delivery on the remaining channels and SHALL record the per-channel result in a `notification_logs` row.
4. THE Notification_Service SHALL include the following notification types in this spec: `invoice_paid`, `invoice_failed`, `overdue_day_1`, `overdue_day_2`, `overdue_day_3`, `subscription_suspended`, `subscription_reactivated`, `subscription_cancelled`, `onboarding_completed`.
5. WHERE the `whatsapp` or `facebook` adapter is invoked, THE Notification_Service SHALL log a `channel_not_implemented` warning and SHALL succeed without failing the overall fan-out. (Architecture-only readiness.)
6. THE Notification_Service SHALL NOT couple subscription logic to any specific channel; new channels SHALL plug in via the adapter slot pattern.

### Requirement 16: Admin Super Control Panel, Modular Architecture, and Future-Readiness

**User Story:** As the Platform operator and Platform engineer, I want a single super-admin surface to manage subscriptions, tenants, payments, AI usage, analytics, categories, and schema templates, plus a modular architecture that lets me add new categories, channels, and integrations without rewrites.

#### Acceptance Criteria

1. THE Admin_Panel SHALL be extended at `public/admin/app.js` (the legacy vanilla JS UI the operator actually uses) with screens for: subscription management, tenant management, payment transactions, suspended stores, AI usage, analytics, category catalog, and schema templates.
2. THE Admin_Panel SHALL allow a super-admin to: change a tenant's plan, override individual feature flags for a tenant, force a state transition (with reason captured to `subscription_logs`), retry a failed invoice, and clear a tenant's `onboardingCompletedAt`.
3. THE Admin_Panel SHALL surface AI usage per tenant (tokens consumed in the current period, replies sent, posts made) and SHALL flag tenants approaching a Plan_Limit at 80% and 100%.
4. THE Platform SHALL be organized into independently configurable modules: `categoryRegistry`, `subscriptionService`, `featureFlagService`, `notificationService`, `agentLoop`, `formBuilder`, `dashboardEngine`. Each module SHALL expose a typed public surface and SHALL be replaceable without modifying the others.
5. THE Platform SHALL expose extension points for future surfaces: a channel adapter slot (already used by `telegram`, ready for `whatsapp`, `facebook`, `voice`), a prompt-slot system on `Tenant_Context` (ready for `multilingual`, `voice` directives), a schema hook on `Category_Registry` (ready for new categories or marketplace integrations like Shopify), and a media-generator slot (ready for AI ad and AI video generators).
6. THE Platform SHALL NOT implement WhatsApp, voice, multilingual, AI video, AI ad, Shopify, or marketplace integrations in this spec; the architecture-readiness requirement is satisfied by the extension points named in 16.5.
7. THE Admin_Panel and the tenant portal SHALL run independently: changes to one SHALL NOT require code changes in the other beyond schema and shared types.

#### Correctness Properties

- **Module replaceability**: Each module named in 16.4 has a single public-export file. Importing internals of one module from another module produces a lint error.
- **Extension parity**: For each future surface in 16.5, there is exactly one named slot in code, with a no-op or stub default implementation, and at least one unit test that verifies the slot is invoked.
