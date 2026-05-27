# Requirements Document

## Introduction

This feature evolves the existing single-tenant AI Facebook commerce platform (currently optimized for jersey businesses) into a full **Multi-Tenant AI Commerce Operating System** capable of serving many different business types dynamically (Jerseys, Clothing, Undergarments, Shoes, Cosmetics, Electronics, Restaurant, Grocery, Jewelry, Furniture, Pet Shop, Pharmacy, Mobile Accessories, and Custom).

The evolution is **not a rewrite**. The existing AI sales agent (LangGraph-style tool loop on `gemma4:31b-cloud`), Facebook integration, PostgreSQL/Prisma data layer, admin dashboard, tenant dashboard, product catalog, order handling, content calendar, autonomous AI posting system, agent persona system, vision pipeline, payment integrations (AamarPay, bKash Tokenized Checkout, manual), Steadfast courier integration, and past-order handoff workflow MUST be preserved and extended.

The platform must become:

- **Multi-tenant** with strict isolation across data, memory, AI identity, products, prompts, workflows, analytics, and automation rules.
- **Category-driven** so that product attributes, dashboard modules, order fields, AI reasoning, and form schemas are all configured by business category instead of hardcoded.
- **Subscription-based SaaS** with SSLCommerz as the primary recurring gateway (alongside the existing AamarPay, bKash, and manual rails), automated billing, plan-based feature flags, and an overdue/grace lifecycle.
- **Future-ready** for Shopify, WhatsApp, voice, multilingual, marketplace, and AI-generated marketing extensions without architectural rework.

## Glossary

- **Commerce_OS**: The overall multi-tenant SaaS platform produced by this evolution.
- **Tenant**: A single client business account. Identified by `tenantId` (e.g. `cmooz62gy0000v5gclycwq78p` for Demo Shop).
- **Tenant_Owner**: The human user who owns and configures a Tenant via the tenant portal.
- **Super_Admin**: An operator of Commerce_OS itself, using the admin console to manage all Tenants.
- **End_Customer**: A Facebook (or future channel) user who chats with a Tenant's AI agent.
- **Onboarding_Wizard**: First-login flow that captures business category, subcategory, attribute preferences, and dashboard template selection for a Tenant.
- **Business_Category**: Top-level classification of a Tenant's business (Jerseys, Clothing, Undergarments, Shoes, Cosmetics, Electronics, Restaurant, Grocery, Jewelry, Furniture, Pet_Shop, Pharmacy, Mobile_Accessories, Custom).
- **Business_Subcategory**: Optional refinement under a Business_Category (e.g. "fast food" under Restaurant, "men's casual" under Clothing).
- **Category_Schema**: Versioned definition of fields, attributes, vocabulary, workflows, and dashboard modules for a Business_Category. Stored as JSON.
- **Category_Intelligence_Engine**: Service that resolves a Tenant's Category_Schema and exposes attributes/vocabulary/workflows to AI, dashboard, and forms.
- **Dashboard_Renderer**: Client-side component system (Next.js App Router) that renders dashboard modules based on Category_Schema.
- **AI_Agent_Persona**: Per-Tenant identity for the AI sales agent. Includes name, role, tone, language, sales style, greeting style. Default: "Karim, Moderator of this Page" stored in `tenant.settings.botPersona`.
- **Tenant_Memory_Store**: Per-Tenant isolated storage for conversations, embeddings, AI personality, prompts, automation rules, and analytics.
- **AI_Reasoning_Engine**: The agent loop in `src/agent/loop.ts` (refactored, in place — no parallel `src/agent2/`).
- **Prompt_Composer**: Module that injects tenant context, Category_Schema, AI_Agent_Persona, plan limits, and brand voice into every model prompt before reasoning.
- **Order_System**: Existing order module, extended so that order fields are derived from Category_Schema rather than hardcoded.
- **Form_Builder**: Service that generates product, variant, order, filter, and widget forms from Category_Schema.
- **Subscription**: A recurring billing relationship between a Tenant and Commerce_OS, governed by a Plan and a Subscription_State.
- **Plan**: One of `STARTER`, `PRO`, `AGENCY`, `ENTERPRISE`. Each plan defines limits and feature flags.
- **Plan_Limit**: A quota enforced per Tenant per Plan (e.g. message count, product count, social account count, AI token usage).
- **Feature_Flag**: A boolean capability gate evaluated per Tenant by combining Plan defaults and Super_Admin overrides.
- **Subscription_State**: One of `TRIAL`, `ACTIVE`, `OVERDUE`, `SUSPENDED`, `CANCELLED`.
- **Grace_Period**: A 3-day window after billing failure during which the Tenant remains operational with escalating warnings before suspension.
- **Payment_Gateway**: An external rail used to collect Tenant subscription payments. SSLCommerz is the primary recurring gateway. AamarPay, bKash Tokenized Checkout, and manual transfer remain available.
- **Universal_Gateway_Columns**: The historical Prisma columns `sslcommerzTranId` and `sslcommerzSessionKey` reused as gateway-agnostic transaction identifiers.
- **Universal_Courier_Columns**: The historical Prisma columns `pathaoConsignmentId` and `pathaoMerchantOrderId` reused as courier-agnostic identifiers.
- **Subscription_Engine**: Service that drives subscription state transitions, renewals, suspensions, and reactivations.
- **Overdue_Manager**: Component of Subscription_Engine that issues Day-1, Day-2, and Day-3 warnings and triggers suspension after grace period.
- **Notification_Service**: Multi-channel dispatcher with `dashboard`, `email`, `whatsapp` (future), and `facebook` (future) channels.
- **Admin_Console**: Super admin web UI (the existing legacy `localhost:4000/admin` and the new Next.js `localhost:3000/admin`) managing Tenants, subscriptions, payments, suspensions, AI usage, analytics, categories, and schema templates.
- **Tenant_Portal**: Tenant-facing dashboard at `dashboard.pipwarp.com`.
- **Backend_API**: Backend service at `api.pipwarp.com`.
- **Customer_Channel**: A messaging surface (Facebook Page today; WhatsApp, voice, marketplace future) bound to a Tenant.
- **Banglish**: Romanized Bengali. The required customer-facing language for End_Customer messages.
- **Past_Order_Handoff**: Existing workflow where after a customer places an order, the agent grants 48h grace and 10h conversation mute (must be preserved).
- **Content_Calendar**: Existing autonomous posting system (must be preserved and extended to be category-aware).
- **Vision_Pipeline**: Existing catalog-agnostic image classifier (`classifyImageContent`) (must remain catalog-agnostic and become category-aware).

## Requirements

---

### Requirement 1: Tenant Identity and Data Isolation

**User Story:** As a Tenant_Owner, I want my data, AI memory, and configuration completely isolated from other Tenants, so that no business information, conversations, or customers ever leak across accounts.

#### Acceptance Criteria

1. THE Commerce_OS SHALL persist a `tenantId` on every record in product, order, conversation, message, embedding, prompt, automation-rule, analytics, subscription, invoice, payment-transaction, and notification tables.
2. THE Backend_API SHALL reject any read or write request that does not resolve to exactly one authenticated `tenantId` scope, except endpoints explicitly marked Super_Admin or public webhook.
3. WHEN a Tenant_Owner authenticates against the Tenant_Portal, THE Backend_API SHALL bind the resulting session to a single `tenantId` and SHALL include that `tenantId` as a mandatory filter on every downstream query.
4. THE AI_Reasoning_Engine SHALL load conversation history, embeddings, prompts, automation rules, and AI_Agent_Persona only for the active `tenantId`.
5. IF a query, tool call, or AI prompt attempts to read or write data belonging to a different `tenantId` than the active session, THEN THE Backend_API SHALL block the operation and SHALL emit a tenant-isolation audit log entry.
6. THE Tenant_Memory_Store SHALL key all vector embeddings, summarized memory, and persona state by `tenantId` so that retrieval cannot return data from another Tenant.
7. WHEN Super_Admin operations require cross-tenant access, THE Admin_Console SHALL require an explicit Super_Admin role claim and SHALL record the access in an admin audit log including operator id, target `tenantId`, and operation.
8. THE Commerce_OS SHALL preserve the existing `cmooz62gy0000v5gclycwq78p` Demo Shop Tenant and its Facebook Page binding `659418713929142` without data loss during the multi-tenant rollout.

---

### Requirement 2: First-Login Onboarding Wizard

**User Story:** As a new Tenant_Owner, I want a guided first-login wizard that captures my business category, so that the platform configures itself for my exact business type without manual setup.

#### Acceptance Criteria

1. WHEN a Tenant_Owner logs in for the first time after activation, THE Onboarding_Wizard SHALL present a flow that captures Business_Category, optional Business_Subcategory, product structure preferences, required attributes, and dashboard template type.
2. THE Onboarding_Wizard SHALL offer the predefined Business_Category set: Jerseys, Clothing, Undergarments, Shoes, Cosmetics, Electronics, Restaurant, Grocery, Jewelry, Furniture, Pet_Shop, Pharmacy, Mobile_Accessories, Custom.
3. WHERE the Tenant_Owner selects `Custom`, THE Onboarding_Wizard SHALL accept a free-text category name and a list of custom attribute fields.
4. WHEN the Tenant_Owner submits the wizard, THE Onboarding_Wizard SHALL persist Business_Category, Business_Subcategory, product structure preferences, required attributes, and dashboard template type into the Tenant record.
5. WHEN the wizard completes, THE Category_Intelligence_Engine SHALL resolve a Category_Schema for the Tenant before the Tenant_Portal renders any category-dependent module.
6. IF the Tenant_Owner abandons the wizard before completion, THEN THE Tenant_Portal SHALL re-present the wizard on the next login until completion is recorded.
7. THE Onboarding_Wizard SHALL allow a Tenant_Owner to revisit and update Business_Category and attribute preferences after initial onboarding.
8. WHEN Business_Category changes after initial onboarding, THE Category_Intelligence_Engine SHALL re-resolve Category_Schema and SHALL preserve existing product, order, and conversation records by retaining unknown legacy fields under a category-migration JSON column.

---

### Requirement 3: Category Intelligence Engine

**User Story:** As a Tenant_Owner, I want the AI and dashboard to automatically understand my industry's vocabulary, attributes, and workflows, so that I do not have to teach the system what my products are.

#### Acceptance Criteria

1. THE Category_Intelligence_Engine SHALL maintain a Category_Schema for every supported Business_Category, including attribute fields, vocabulary, workflow rules, and dashboard module list.
2. WHEN a Tenant resolves its Category_Schema, THE Category_Intelligence_Engine SHALL return attribute fields, terminology, and workflow rules appropriate to the Tenant's Business_Category and Business_Subcategory.
3. THE Category_Intelligence_Engine SHALL ship initial schemas for at least: Jerseys (chest, length, team, version), Clothing (size, color, fit, gender), Undergarments (waist, fabric, cup), Shoes (size, gender, sole), Cosmetics (shade, skin type, volume), Electronics (model, warranty, specs, accessories), Restaurant (spice level, delivery time, food category), Grocery (weight, unit, expiry), Jewelry (material, weight, purity), Furniture (dimensions, material), Pet_Shop (animal type, age, weight), Pharmacy (dosage, prescription required), Mobile_Accessories (device compatibility, brand).
4. THE Category_Intelligence_Engine SHALL expose a stable typed contract for the AI_Reasoning_Engine, Dashboard_Renderer, Form_Builder, and Order_System to consume Category_Schema fields.
5. WHERE a Tenant uses Business_Category `Custom`, THE Category_Intelligence_Engine SHALL build a Category_Schema from the Tenant's custom attribute list while still satisfying the same typed contract.
6. THE Category_Intelligence_Engine SHALL version every Category_Schema with a `schemaVersion` integer that increments on edits, so that Tenants can be migrated forward without breaking existing records.
7. IF a Tenant's persisted product or order references a Category_Schema field that no longer exists in the current `schemaVersion`, THEN THE Category_Intelligence_Engine SHALL surface the unknown field as a read-only legacy attribute and SHALL NOT drop the data.

---

### Requirement 4: Dynamic Product Attribute System

**User Story:** As a Tenant_Owner, I want product attributes to match my industry exactly, so that I can store fit, shade, spice level, or warranty without writing any code.

#### Acceptance Criteria

1. THE Backend_API SHALL persist product attributes in a JSON column keyed by `category_attributes`, structured as `{ category, schemaVersion, fields: { name: value, ... } }`.
2. WHEN a product is created or updated, THE Form_Builder SHALL validate the submitted attributes against the Tenant's current Category_Schema fields, including required-field, type, and enumeration checks.
3. IF a submitted attribute fails validation, THEN THE Backend_API SHALL reject the request with a structured error identifying the offending field, expected type, and allowed values.
4. THE Backend_API SHALL allow searching, filtering, and faceting products by Category_Schema attributes within a Tenant's scope.
5. WHEN Category_Schema fields change versions, THE Backend_API SHALL preserve previously stored attribute values without modification and SHALL annotate them with their original `schemaVersion`.

---

### Requirement 5: Dynamic Client Dashboard System

**User Story:** As a Tenant_Owner, I want my dashboard to show controls relevant to my business (size charts for fashion, menu manager for restaurants, shade selector for cosmetics), so that I never see irrelevant fields.

#### Acceptance Criteria

1. THE Tenant_Portal SHALL render dashboard modules selected by the Tenant's Category_Schema rather than from a hardcoded layout.
2. THE Dashboard_Renderer SHALL support the following category-specific modules at minimum: size-chart manager (Clothing, Undergarments, Shoes, Jerseys), menu manager (Restaurant), shade selector (Cosmetics), warranty/specs editor (Electronics), prescription flag (Pharmacy), device-compatibility selector (Mobile_Accessories), unit/weight editor (Grocery), purity editor (Jewelry).
3. WHEN a Tenant changes Business_Category, THE Tenant_Portal SHALL update the visible module set on the next page load without requiring redeployment.
4. THE Dashboard_Renderer SHALL load each module via a category-keyed registry so that adding a new module requires only registering it, not editing layout code.
5. THE Tenant_Portal SHALL preserve existing global modules: orders, content calendar, conversations, automation rules, billing, and AI persona configuration, regardless of Business_Category.

---

### Requirement 6: AI Agent Personalization

**User Story:** As a Tenant_Owner, I want to configure my AI agent's name, role, personality, tone, language, and sales style, so that the agent represents my brand authentically.

#### Acceptance Criteria

1. THE Tenant_Portal SHALL allow a Tenant_Owner to configure AI_Agent_Persona with at minimum: agent name, role label, personality description, tone, language preference, sales style, and greeting style.
2. THE Backend_API SHALL persist AI_Agent_Persona under `tenant.settings.botPersona`, preserving the existing default `"Karim, Moderator of this Page"` for Tenants that have not customized it.
3. WHEN the AI_Reasoning_Engine composes a prompt, THE Prompt_Composer SHALL inject the active Tenant's AI_Agent_Persona into the system prompt before reasoning.
4. THE AI_Reasoning_Engine SHALL render End_Customer-facing messages in Banglish unless the Tenant_Owner explicitly enables a different customer-facing language under the Tenant's persona configuration.
5. THE AI_Reasoning_Engine SHALL NOT expose internal vocabulary such as "catalog", "schema", "tenant", or "embedding" in End_Customer-facing messages.
6. WHEN a Tenant_Owner updates AI_Agent_Persona, THE AI_Reasoning_Engine SHALL apply the new persona on the next inbound conversation turn without requiring a service restart.

---

### Requirement 7: Tenant Memory Isolation

**User Story:** As a Tenant_Owner, I want my AI memory and conversation history isolated from every other Tenant, so that the agent never references another business's data.

#### Acceptance Criteria

1. THE Tenant_Memory_Store SHALL store conversation transcripts, summarized memory, vector embeddings, AI_Agent_Persona snapshots, prompt templates, automation rules, and analytics events scoped strictly by `tenantId`.
2. WHEN the AI_Reasoning_Engine retrieves memory for a turn, THE Tenant_Memory_Store SHALL filter results by the active `tenantId` before returning.
3. IF a memory retrieval result lacks a `tenantId` or carries a different `tenantId` than the active session, THEN THE Tenant_Memory_Store SHALL drop the result and SHALL emit an isolation audit log entry.
4. THE Backend_API SHALL prevent any tool registered in `src/agent/tools/registry.ts` from receiving or returning data outside the active Tenant's scope.
5. THE Commerce_OS SHALL satisfy the property: for any two Tenants T1 and T2 and any operation issued under T1's session, no record persisted to or returned from the operation carries T2's `tenantId`.

---

### Requirement 8: Category-Specific AI Reasoning

**User Story:** As an End_Customer, I want the agent to reason like an expert in the specific business I am chatting with (delivery for restaurants, sizing for fashion, specs for electronics), so that I get accurate, relevant answers.

#### Acceptance Criteria

1. WHEN the AI_Reasoning_Engine begins a turn, THE Prompt_Composer SHALL include the Tenant's Business_Category, Category_Schema field summary, AI_Agent_Persona, brand voice, and active Plan_Limit summary in the prompt context.
2. THE AI_Reasoning_Engine SHALL select tool subsets and workflow rules from the Category_Schema such that Restaurant Tenants expose delivery-time and order-notes tools, Fashion Tenants expose size-recommendation and fit tools, Electronics Tenants expose spec/compatibility tools, and Pharmacy Tenants expose prescription-flag tools.
3. WHERE a category defines a workflow rule (e.g. "delivery time required before order confirm"), THE AI_Reasoning_Engine SHALL treat the rule as a hard precondition and SHALL NOT confirm the order without satisfying it.
4. THE AI_Reasoning_Engine SHALL preserve the existing Past_Order_Handoff behavior (48h grace, 10h conversation mute) for every Business_Category, applied uniformly at the Commerce_OS layer.
5. THE Vision_Pipeline SHALL remain catalog-agnostic in its base classifier and SHALL accept Category_Schema hints to bias its labels per Tenant.

---

### Requirement 9: Dynamic Order System

**User Story:** As a Tenant_Owner, I want orders to capture the fields my business actually needs (size/color for fashion, spice/toppings for food, warranty for electronics), so that no order is missing critical information.

#### Acceptance Criteria

1. WHEN an order is created, THE Order_System SHALL derive its required and optional fields from the Tenant's Category_Schema rather than from a hardcoded shape.
2. THE Order_System SHALL persist category-specific order fields in a JSON column tagged with `schemaVersion` so that schema evolution does not invalidate historical orders.
3. THE Order_System SHALL continue to support the existing universal courier identifiers `pathaoConsignmentId` and `pathaoMerchantOrderId` as gateway-agnostic columns for any courier provider, including the existing Steadfast integration.
4. IF an order is missing a Category_Schema-required field, THEN THE Order_System SHALL block confirmation and SHALL return a structured error naming the missing field.
5. WHEN the Order_System emits webhooks or admin notifications, THE Notification_Service SHALL include the Tenant's Business_Category and category-specific order fields in the payload.

---

### Requirement 10: Dynamic Form Builder

**User Story:** As a Tenant_Owner, I want product, variant, order, filter, and widget forms generated automatically from my category, so that I never need a developer to add a new field.

#### Acceptance Criteria

1. THE Form_Builder SHALL generate product creation, product edit, variant edit, order creation, order edit, filter, and dashboard widget forms from the Tenant's Category_Schema.
2. THE Form_Builder SHALL map Category_Schema field types to UI controls including text, number, enum (select), multi-enum (chips), boolean, date, decimal-with-unit, and image-reference.
3. WHEN a Category_Schema field changes, THE Form_Builder SHALL surface the new field on the next render without requiring a Tenant_Portal redeploy.
4. THE Form_Builder SHALL emit the same structured validation errors that the Backend_API enforces, so that client-side and server-side validation cannot disagree.

---

### Requirement 11: Subscription Lifecycle and States

**User Story:** As a Super_Admin, I want every Tenant's subscription to follow a predictable lifecycle, so that billing, access, and reactivation behavior is automated and auditable.

#### Acceptance Criteria

1. THE Subscription_Engine SHALL model Subscription_State as exactly one of: `TRIAL`, `ACTIVE`, `OVERDUE`, `SUSPENDED`, `CANCELLED`.
2. WHEN a new Tenant signs up, THE Subscription_Engine SHALL initialize the Subscription_State to `TRIAL` with a configured trial duration.
3. WHEN a successful payment is recorded against a `TRIAL` or `OVERDUE` subscription, THE Subscription_Engine SHALL transition Subscription_State to `ACTIVE` and SHALL set the next billing date to one month after the payment timestamp.
4. WHEN the current billing cycle expires without a successful payment, THE Subscription_Engine SHALL transition Subscription_State from `ACTIVE` to `OVERDUE` and SHALL start a 3-day Grace_Period.
5. WHEN the Grace_Period expires without a successful payment, THE Subscription_Engine SHALL transition Subscription_State from `OVERDUE` to `SUSPENDED`.
6. WHEN a Tenant_Owner cancels the subscription, THE Subscription_Engine SHALL transition Subscription_State to `CANCELLED` at the end of the current paid period and SHALL preserve all Tenant data.
7. THE Subscription_Engine SHALL satisfy the property: every Subscription_State transition is one of the allowed transitions { TRIAL→ACTIVE, TRIAL→CANCELLED, ACTIVE→OVERDUE, ACTIVE→CANCELLED, OVERDUE→ACTIVE, OVERDUE→SUSPENDED, OVERDUE→CANCELLED, SUSPENDED→ACTIVE, SUSPENDED→CANCELLED }.
8. IF a state transition request does not match the allowed set, THEN THE Subscription_Engine SHALL reject the transition and SHALL log it as an invalid-transition audit event.

---

### Requirement 12: Payment Automation

**User Story:** As a Tenant_Owner, I want my subscription payments to renew automatically and produce invoices, so that I never lose access due to manual billing work.

#### Acceptance Criteria

1. THE Subscription_Engine SHALL use SSLCommerz as the primary recurring Payment_Gateway and SHALL also support the existing AamarPay, bKash Tokenized Checkout, and manual transfer rails for subscription payments.
2. WHEN a Payment_Gateway webhook reports a successful subscription charge, THE Subscription_Engine SHALL create or update an invoice record, mark the invoice paid, advance the Tenant's `nextBillingAt`, and transition Subscription_State per Requirement 11.
3. THE Subscription_Engine SHALL persist gateway transaction identifiers using the Universal_Gateway_Columns `sslcommerzTranId` and `sslcommerzSessionKey`, regardless of which gateway produced the transaction.
4. WHEN an invoice transitions to paid, THE Notification_Service SHALL deliver an invoice notification on the dashboard channel and SHALL send an email invoice to the Tenant_Owner.
5. IF a Payment_Gateway webhook reports a failed charge, THEN THE Subscription_Engine SHALL record the failure in a payment-failure log including gateway, error code, and timestamp.
6. THE Subscription_Engine SHALL retry failed automatic charges according to a configured retry schedule before declaring the cycle overdue.
7. THE Subscription_Engine SHALL NOT charge a Tenant whose Subscription_State is `CANCELLED` or `SUSPENDED` until the Tenant_Owner explicitly reactivates.

---

### Requirement 13: Overdue and Grace Period Handling

**User Story:** As a Super_Admin, I want a defined dunning sequence with clear warnings and automatic suspension, so that delinquent Tenants are handled consistently and recoverably.

#### Acceptance Criteria

1. WHEN Subscription_State enters `OVERDUE`, THE Overdue_Manager SHALL send a Day-1 warning notification on the dashboard and email channels.
2. WHILE Subscription_State is `OVERDUE`, THE Overdue_Manager SHALL send a Day-2 second warning and a Day-3 final warning on the dashboard and email channels.
3. WHEN the Grace_Period (3 days) expires without a successful payment, THE Overdue_Manager SHALL transition Subscription_State to `SUSPENDED` and SHALL trigger automatic deactivation actions.
4. WHILE Subscription_State is `SUSPENDED`, THE Commerce_OS SHALL disable the Tenant's storefront, AI_Reasoning_Engine responses, autonomous content posting, and Customer_Channel messaging, and SHALL preserve all Tenant data including products, orders, conversations, and persona settings.
5. WHEN a successful payment is recorded for a `SUSPENDED` Tenant, THE Subscription_Engine SHALL transition Subscription_State to `ACTIVE` and THE Commerce_OS SHALL re-enable storefront, AI agent, content posting, and messaging within 5 minutes of payment confirmation.
6. THE Overdue_Manager SHALL record every warning, suspension, and reactivation event in a subscription audit log with `tenantId`, event type, and timestamp.

---

### Requirement 14: Plan System

**User Story:** As a Super_Admin, I want tiered plans (STARTER, PRO, AGENCY, ENTERPRISE) with enforced limits, so that pricing reflects actual usage and resources.

#### Acceptance Criteria

1. THE Plan_Manager SHALL define exactly four Plan tiers: `STARTER`, `PRO`, `AGENCY`, `ENTERPRISE`.
2. THE Plan_Manager SHALL associate each Plan with at minimum: maximum monthly customer messages, maximum AI token usage, maximum products, maximum connected social accounts, posting limit per day, and an enabled-feature set.
3. WHEN a Tenant operation would cause a Plan_Limit to be exceeded, THE Backend_API SHALL block the operation and SHALL return a structured error indicating the limit name, current count, and maximum.
4. THE Plan_Manager SHALL track per-Tenant counters for each Plan_Limit on a monthly billing-cycle basis.
5. WHEN a Tenant upgrades or downgrades Plan, THE Plan_Manager SHALL apply the new limits at the start of the next billing cycle and SHALL prorate billing per Subscription_Engine rules.
6. WHILE Subscription_State is `SUSPENDED`, THE Plan_Manager SHALL treat all Plan_Limits as zero except for read-only data export.

---

### Requirement 15: Feature Flag System

**User Story:** As a Super_Admin, I want features turned on or off per Tenant or per Plan without code changes, so that I can run experiments, grant exceptions, and manage rollouts.

#### Acceptance Criteria

1. THE Feature_Flag_Service SHALL evaluate every gated feature by combining Plan defaults with Super_Admin overrides per Tenant.
2. WHEN a feature is gated, THE Backend_API SHALL call Feature_Flag_Service before executing the feature and SHALL return a `feature-disabled` error if the flag resolves to false.
3. THE Admin_Console SHALL allow a Super_Admin to set per-Tenant feature flag overrides without redeploying code.
4. THE Feature_Flag_Service SHALL preserve a deny-by-default posture: a feature with no Plan default and no override SHALL resolve to false.
5. WHEN a Plan changes feature defaults, THE Feature_Flag_Service SHALL apply the new defaults immediately to all Tenants on that Plan unless an explicit per-Tenant override exists.

---

### Requirement 16: Subscription Database Design

**User Story:** As a developer, I want explicit subscription tables with clear ownership, so that billing data is auditable and queryable.

#### Acceptance Criteria

1. THE Backend_API SHALL persist subscription data using Prisma models for at minimum: `Subscription`, `Invoice`, `PaymentTransaction`, `SubscriptionLog`, `PaymentFailure`, `GracePeriodTracking`, and `PlanLimit`.
2. THE `Subscription` model SHALL reference `tenantId`, `plan`, `state`, `startedAt`, `currentPeriodStart`, `currentPeriodEnd`, `nextBillingAt`, `cancelledAt` (nullable), and `gateway`.
3. THE `Invoice` model SHALL reference `tenantId`, `subscriptionId`, `amount`, `currency`, `status`, `issuedAt`, `paidAt` (nullable), and a link to a `PaymentTransaction`.
4. THE `PaymentTransaction` model SHALL persist gateway identifiers using Universal_Gateway_Columns `sslcommerzTranId` and `sslcommerzSessionKey` regardless of source gateway.
5. THE Backend_API SHALL apply schema changes via `prisma db push` only and SHALL NOT introduce Prisma migration files, consistent with the project's drift-state policy.
6. THE Backend_API SHALL refactor in place under `src/agent/` and the existing Prisma layer and SHALL NOT create a parallel module such as `src/agent2/`.

---

### Requirement 17: Notification System

**User Story:** As a Tenant_Owner, I want subscription, payment, and operational notifications delivered through multiple channels, so that I never miss a critical event.

#### Acceptance Criteria

1. THE Notification_Service SHALL support at minimum the following channels: `dashboard`, `email`, `whatsapp`, and `facebook`.
2. THE Notification_Service SHALL implement `dashboard` and `email` channels in the initial release and SHALL stub `whatsapp` and `facebook` behind interfaces ready for future activation.
3. WHEN a notification is dispatched, THE Notification_Service SHALL persist a delivery record per channel with `tenantId`, channel, status, and timestamp.
4. IF a notification fails on a channel, THEN THE Notification_Service SHALL retry per a configurable backoff schedule and SHALL escalate to the dashboard channel after final failure.
5. THE Notification_Service SHALL emit notifications for at minimum: successful payment, failed payment, subscription state change, overdue warning (Day-1, Day-2, Day-3), suspension, reactivation, plan-limit threshold reached, and onboarding wizard incomplete reminder.

---

### Requirement 18: Admin Super Control Panel

**User Story:** As a Super_Admin, I want a single console to manage subscriptions, tenants, payments, AI usage, analytics, and category schemas, so that I can operate the SaaS at scale.

#### Acceptance Criteria

1. THE Admin_Console SHALL list all Tenants with `tenantId`, business name, Business_Category, Plan, Subscription_State, `nextBillingAt`, and last-activity timestamp.
2. THE Admin_Console SHALL allow a Super_Admin to view a Tenant's subscription history, invoices, payment transactions, payment failures, and subscription audit log.
3. THE Admin_Console SHALL allow a Super_Admin to suspend, reactivate, cancel, or manually adjust a Tenant's Plan, with each action recorded in the admin audit log per Requirement 1.
4. THE Admin_Console SHALL surface Tenant AI usage metrics including token usage, message count, and tool call counts on a monthly basis.
5. THE Admin_Console SHALL allow a Super_Admin to manage Category_Schema templates, including creating, versioning, and assigning templates to Business_Categories.
6. THE Commerce_OS SHALL preserve both existing admin UIs (legacy `localhost:4000/admin` and the new Next.js `localhost:3000/admin`) during the rollout and SHALL extend each with the new admin capabilities.

---

### Requirement 19: Modular Plugin-Capable SaaS Architecture

**User Story:** As a developer, I want every major capability shipped as an independently configurable, category-aware module, so that adding new categories, channels, or features does not require rewrites.

#### Acceptance Criteria

1. THE Commerce_OS SHALL organize each major capability (Onboarding_Wizard, Category_Intelligence_Engine, Dashboard_Renderer, AI_Reasoning_Engine, Order_System, Form_Builder, Subscription_Engine, Notification_Service, Feature_Flag_Service, Admin_Console) as an independently testable module.
2. THE Commerce_OS SHALL expose a plugin registration interface for new dashboard modules, AI tools, and notification channels, keyed by Business_Category where applicable.
3. THE Commerce_OS SHALL refactor the existing `src/agent/` tree in place and SHALL NOT introduce a parallel module path such as `src/agent2/`.
4. THE Commerce_OS SHALL preserve the existing `tsx`-runnable, IIFE-wrapped, `installStubs`/`restoreStubs` test pattern for all new test files.

---

### Requirement 20: AI System Refactor and Prompt Composition

**User Story:** As a developer, I want every AI reasoning cycle to load tenant context, business category, schema, persona, voice, plan limits, and workflow rules before reasoning, so that AI behavior is deterministic per tenant.

#### Acceptance Criteria

1. WHEN the AI_Reasoning_Engine starts a reasoning cycle, THE Prompt_Composer SHALL load and inject `tenantId`, Business_Category, Category_Schema summary, AI_Agent_Persona, brand voice, current Plan_Limit summary, and active workflow rules into the prompt context.
2. THE AI_Reasoning_Engine SHALL run on the `gemma4:31b-cloud` Ollama model and SHALL NOT silently downgrade to a smaller model.
3. THE Prompt_Composer SHALL omit any field whose source value is missing rather than emit placeholder text, and SHALL log a warning when required fields are missing.
4. THE Prompt_Composer SHALL keep customer-facing output in Banglish per Requirement 6 and SHALL strip internal vocabulary tokens before any End_Customer-facing message is sent.
5. WHEN tools are registered in `src/agent/tools/registry.ts`, THE AI_Reasoning_Engine SHALL filter the tool set per Tenant by Business_Category and Feature_Flag evaluations before exposing tools to the model.

---

### Requirement 21: Preservation of Existing Capabilities

**User Story:** As a Tenant_Owner already using the platform, I want all existing capabilities to keep working through the multi-tenant evolution, so that my live business is never disrupted.

#### Acceptance Criteria

1. THE Commerce_OS SHALL preserve the existing tenant authentication flow (email + password + activation) and SHALL extend it with multi-tenant onboarding without breaking existing sessions.
2. THE Commerce_OS SHALL preserve the existing AamarPay, bKash Tokenized Checkout, and manual payment integrations alongside the new SSLCommerz primary recurring rail.
3. THE Commerce_OS SHALL preserve the existing Steadfast courier integration and SHALL continue to use the Universal_Courier_Columns.
4. THE Commerce_OS SHALL preserve the existing content calendar with autonomous posting and SHALL extend it to be Category_Schema-aware.
5. THE Commerce_OS SHALL preserve the existing vision pipeline (`classifyImageContent`) as catalog-agnostic and SHALL extend it to accept Category_Schema hints.
6. THE Commerce_OS SHALL preserve the existing agent persona default `"Karim, Moderator of this Page"` for any Tenant that has not customized AI_Agent_Persona.
7. THE Commerce_OS SHALL preserve the existing Past_Order_Handoff (48h grace, 10h conversation mute) for every Tenant regardless of Business_Category.
8. THE Commerce_OS SHALL preserve the existing `compare price` feature and `sale countdown` feature.
9. THE Commerce_OS SHALL preserve the existing CORS configuration via `CORS_ALLOWED_ORIGINS` and the production cookie posture `SameSite=None; Secure`.

---

### Requirement 22: Future-Ready Extensibility

**User Story:** As a Super_Admin, I want the architecture to anticipate Shopify, WhatsApp, voice, multilingual, and marketplace integrations, so that we can add channels without re-architecting.

#### Acceptance Criteria

1. THE Commerce_OS SHALL define a Customer_Channel abstraction such that Facebook is one of multiple possible channels and adding WhatsApp, voice, or marketplace channels requires only registering a new channel adapter.
2. THE Commerce_OS SHALL define a product-source abstraction allowing future synchronization with Shopify and other marketplaces without modifying core product or order code paths.
3. THE AI_Reasoning_Engine SHALL accept a configurable customer-facing language per Tenant so that future multilingual rollouts only require enabling additional language packs.
4. THE Commerce_OS SHALL define interfaces for AI-generated product ads and AI-generated video marketing assets so that future image/video generation services can be plugged into the content calendar without changes to the calendar's scheduler.
5. THE Notification_Service SHALL keep `whatsapp` and `facebook` channel slots reserved per Requirement 17, so that activating them does not require schema changes.

---

### Requirement 23: Operational Safety and Constraint Conformance

**User Story:** As a developer, I want the rollout to honor the project's existing operational constraints, so that nothing breaks in development or production.

#### Acceptance Criteria

1. THE Commerce_OS SHALL apply schema changes via `prisma db push` only, consistent with the existing drift-state policy, and SHALL NOT generate Prisma migration files.
2. THE Commerce_OS SHALL use `bcryptjs` (pure JS) for password hashing and SHALL NOT introduce native `bcrypt` dependencies on Windows development environments.
3. THE Commerce_OS SHALL document the OneDrive lock recovery procedure (`Stop-Process -Name node ; Start-Sleep 3 ; npx prisma generate`) in onboarding docs for new contributors.
4. THE Commerce_OS SHALL keep `api.pipwarp.com` as the Backend_API origin and `dashboard.pipwarp.com` as the Tenant_Portal origin, with `PUBLIC_PORTAL_URL=https://dashboard.pipwarp.com`.
5. THE Commerce_OS SHALL not expose the strings "catalog", "schema", "tenant", "embedding", or other internal vocabulary in any End_Customer-facing message on any Customer_Channel.
6. THE Commerce_OS SHALL NOT modify the completed spec at `.kiro/specs/facebook-ai-agent-rebuild/`.

---

## Cross-Cutting Correctness Properties

The following properties MUST hold across the entire Commerce_OS and SHOULD be expressed as property-based or invariant tests during design:

1. **Tenant Isolation Invariant**: For any session bound to `tenantId = T`, no read or write executed during that session SHALL touch a record whose `tenantId ≠ T`. (Covers Requirements 1, 7.)
2. **Subscription State Transition Validity**: Every Subscription_State transition SHALL be a member of the allowed transition set defined in Requirement 11 acceptance criterion 7.
3. **Plan Limit Enforcement**: For any Tenant operation that increments a tracked counter, the post-operation counter SHALL be less than or equal to the active Plan_Limit value. (Covers Requirement 14.)
4. **Category Schema Round-Trip**: For any product, variant, or order whose attributes were saved under `schemaVersion = N`, reading them back SHALL produce a structure that the Form_Builder can render and the Backend_API can re-validate, even after the Tenant has migrated to `schemaVersion = N+1`. (Covers Requirements 3, 4, 9.)
5. **Persona Composition Idempotence**: For a fixed Tenant configuration, the Prompt_Composer applied twice to the same input SHALL produce the same prompt. (Covers Requirement 20.)
6. **Notification Delivery Logging**: Every notification dispatched SHALL produce exactly one delivery record per attempted channel, with terminal status `delivered`, `failed`, or `escalated`. (Covers Requirement 17.)
