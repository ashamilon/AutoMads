# Requirements Document

## Introduction

This feature transforms the existing AI-powered Facebook commerce platform (currently optimized for jersey businesses) into a full Multi-Tenant AI Commerce Operating System ("Commerce_OS") that supports many different business categories dynamically, including Jerseys, Clothing, Undergarments, Shoes, Cosmetics, Electronics, Restaurant, Grocery, Jewelry, Furniture, Pet Shop, Pharmacy, Mobile Accessories, and tenant-defined Custom categories.

The transformation is driven by one architectural principle: no business logic is hardcoded for any specific category. All category-specific behavior — product attributes, AI reasoning, dashboard layout, order forms, prompt content, workflow rules — is expressed as configuration loaded per tenant. The existing jersey behavior is preserved as a built-in category configuration, not as code paths in the agent or UI.

The system additionally introduces a SaaS subscription layer (plans, billing through SSLCommerz, grace period handling, suspension and reactivation), tenant-isolated AI memory and identity, a dynamic form builder, a feature-flag system tied to plan limits, and an admin super control panel.

The existing tenant `cmooz62gy0000v5gclycwq78p` (Facebook Page `659418713929142`), all existing products, orders, prompt templates, persona settings, payment gateway integrations (SSLCommerz, AamarPay, bKash), courier integrations (Pathao, Steadfast), Telegram alerts, vision pipeline, handoff policy (48h grace + 10h mute), and reply filter overrides MUST continue to function unchanged after the transformation. Migration is backward-compatible and uses `prisma db push` only (no migrations folder).

## Glossary

- **Commerce_OS**: The multi-tenant SaaS platform produced by this feature. Encompasses the AI sales agent, dashboards, subscription system, and admin control panel.
- **Tenant**: A paying business customer of Commerce_OS. Identified by `tenantId`. Owns its own catalog, conversations, persona, settings, and AI memory.
- **Tenant_Admin**: A human user authenticated against `TenantSession` who manages a single tenant's store from the dashboard.
- **Super_Admin**: A platform operator with access to the Admin Super Control Panel across all tenants.
- **Customer**: An end-user (Facebook Messenger user) who chats with a tenant's AI agent. Customer-facing text is Banglish-only.
- **Business_Category**: A classification of a tenant's business (e.g. `jersey`, `restaurant`, `cosmetics`, `custom`). Determines which Category_Schema, prompt rules, dashboard modules, and order workflow apply.
- **Category_Schema**: A JSON document declaring a category's product attribute fields, variant fields, order fields, filter fields, terminology, and dashboard module list.
- **Category_Engine**: The runtime component that loads a tenant's Category_Schema and exposes it to the agent, dashboards, form builder, and order pipeline.
- **Form_Builder**: The runtime component that renders product forms, variant forms, order forms, filters, and dashboard widgets from a Category_Schema.
- **Agent_Identity**: The per-tenant configuration `{ name, role, personality, tone, language, salesStyle, greetingStyle }` injected into every reasoning cycle. Backward-compatible with the existing `{{personaName}}`/`{{personaRole}}` placeholders rendered by `buildAgentSystemPrompt()`.
- **AI_Reasoning_Cycle**: One pass of the agent loop in `src/agent/loop.ts`. Receives a Reasoning_Context containing tenant, category, schema, identity, plan limits, and workflow rules.
- **Tenant_Memory**: The per-tenant store of conversations, summaries, embeddings, customer profiles, and learned behavior. MUST be isolated per `tenantId`.
- **Onboarding_Wizard**: The first-login multi-step flow that captures business category, subcategory, attribute preferences, and dashboard template choice for a new tenant.
- **Subscription**: A row in the `subscriptions` table tracking a tenant's plan, billing cycle, status, current period start/end, and grace period.
- **Plan**: A row in the `plans` table (Starter, Pro, Agency, Enterprise) describing limits and feature flags.
- **Plan_Limit**: A numeric or boolean cap enforced from a Plan (e.g. `maxProducts`, `maxMonthlyMessages`, `aiPostingEnabled`).
- **Feature_Flag**: A boolean derived from the tenant's current Plan that gates a feature at runtime (e.g. `feature.aiPosting`, `feature.contentCalendar`).
- **Subscription_Status**: One of `trial`, `active`, `overdue`, `suspended`, `cancelled`.
- **Grace_Period**: The window after an unsuccessful renewal during which the tenant remains active but receives warnings. Default 3 days.
- **Billing_Gateway**: SSLCommerz, used as the subscription billing processor for Commerce_OS itself (separate from tenants' own customer-facing payment gateways).
- **Invoice**: A row in `invoices` representing one billable period for one Subscription.
- **Payment_Transaction**: A row in `payment_transactions` recording one payment attempt against an Invoice. Reuses `sslcommerzTranId` and `sslcommerzSessionKey` as universal gateway tran-id columns.
- **Notification_Channel**: One of `dashboard`, `email`, `whatsapp` (future), `facebook` (future).
- **Admin_Panel**: The Super_Admin control panel for managing tenants, subscriptions, payments, suspended stores, schemas, and analytics.
- **Legacy_Admin_UI**: The existing vanilla-JS admin at `localhost:4000/admin`. MUST be preserved.
- **Next_Admin_UI**: The Next.js dashboard at `localhost:3000/admin` and `dashboard.pipwarp.com`. MUST be preserved.
- **Reply_Filter**: The existing post-generation filter with five override kinds (`banned_word`, `tone_rewrite`, `capability_confession`, `anti_hallucination`, `confirmation_block`). MUST be preserved per-tenant.
- **Handoff_Policy**: The existing rule that mutes the AI for 10 hours when a human reply is detected, within a 48-hour grace window. MUST be preserved per-tenant.

## Requirements

### Requirement 1: First-Login Onboarding Wizard

**User Story:** As a new Tenant_Admin, I want a guided first-login wizard that captures my business category and product structure preferences, so that the platform configures itself for my business without me writing schemas.

#### Acceptance Criteria

1. WHEN a Tenant_Admin authenticates for the first time and the tenant has no `onboardingCompletedAt` timestamp, THE Commerce_OS SHALL redirect the Tenant_Admin to the Onboarding_Wizard before any other dashboard route loads.
2. THE Onboarding_Wizard SHALL present a Welcome step that displays the tenant's business name and the configured Agent_Identity defaults.
3. THE Onboarding_Wizard SHALL present a Category_Selection step listing the predefined Business_Categories: `jersey`, `clothing`, `undergarments`, `shoes`, `cosmetics`, `electronics`, `restaurant`, `grocery`, `jewelry`, `furniture`, `pet_shop`, `pharmacy`, `mobile_accessories`, and `custom`.
4. WHEN the Tenant_Admin selects `custom` in the Category_Selection step, THE Onboarding_Wizard SHALL present a Custom_Category step that accepts a free-text category name, an optional subcategory, and a starting Category_Schema based on the closest predefined template the Tenant_Admin chooses.
5. WHEN the Tenant_Admin selects a predefined Business_Category, THE Onboarding_Wizard SHALL present a Schema_Preferences step listing the default attribute fields for that category and SHALL allow the Tenant_Admin to enable, disable, rename, or add fields before saving.
6. WHEN the Tenant_Admin completes the final wizard step, THE Commerce_OS SHALL persist `tenant.businessCategory`, `tenant.businessSubcategory`, `tenant.categorySchemaId`, `tenant.dashboardTemplate`, and `tenant.onboardingCompletedAt` in a single transaction.
7. IF the Tenant_Admin closes the browser before completing the Onboarding_Wizard, THEN THE Commerce_OS SHALL resume the wizard at the last completed step on next login.
8. WHERE the tenant is the existing demo tenant `cmooz62gy0000v5gclycwq78p`, THE Commerce_OS SHALL set `businessCategory=jersey`, `categorySchemaId` to the built-in jersey schema, and `onboardingCompletedAt` to the migration timestamp without requiring the wizard to run.

### Requirement 2: Category Intelligence Engine

**User Story:** As a Tenant_Admin, I want the AI to understand what attributes, terminology, and workflows apply to my business category, so that conversations and recommendations sound native to my industry.

#### Acceptance Criteria

1. THE Category_Engine SHALL load the tenant's Category_Schema from `tenant.categorySchemaId` once per AI_Reasoning_Cycle and SHALL expose it on the Reasoning_Context as `categorySchema`.
2. THE Category_Engine SHALL expose `categorySchema.attributes`, `categorySchema.variantAttributes`, `categorySchema.orderAttributes`, `categorySchema.filterAttributes`, `categorySchema.terminology`, `categorySchema.dashboardModules`, and `categorySchema.workflowRules`.
3. WHEN no `categorySchema` is found for a tenant, THE Category_Engine SHALL fall back to the built-in `jersey` schema and SHALL log a `category_schema_fallback` event tagged with `tenantId`.
4. THE Category_Engine SHALL ship built-in schemas for all predefined Business_Categories listed in Requirement 1.3, including: `jersey` with attributes `chest, length, sleeve, version, team, season`; `undergarments` with attributes `waist, fabric, fit, cup_size`; `shoes` with attributes `shoe_size, gender, sole_type, width`; `restaurant` with attributes `spice_level, portion_size, food_category, prep_time`; `cosmetics` with attributes `shade, skin_type, ingredients, volume`.
5. THE Category_Engine SHALL expose a `terminology` map per category that the Reply_Filter and prompt builder use to translate internal vocabulary to customer-facing Banglish.
6. WHEN a tenant updates its Category_Schema, THE Category_Engine SHALL invalidate the cached schema for that `tenantId` within 30 seconds across all Commerce_OS processes.

### Requirement 3: Dynamic Product Attribute System

**User Story:** As a Tenant_Admin, I want product fields to come from my category schema rather than fixed jersey columns, so that I can describe my products accurately.

#### Acceptance Criteria

1. THE Commerce_OS SHALL store category-specific product attributes in a JSON column on the existing product table rather than adding new physical columns per category.
2. WHEN a product is created or updated, THE Commerce_OS SHALL validate the submitted attributes against the tenant's `categorySchema.attributes`, rejecting unknown keys and missing required fields.
3. WHERE a product belongs to a tenant whose `businessCategory=jersey`, THE Commerce_OS SHALL accept the historical attribute keys `chest`, `length`, `sleeve`, `version`, `team`, and `season` and SHALL preserve all existing values for the demo tenant.
4. THE Commerce_OS SHALL expose a Category_Engine API `validateProductAttributes(tenantId, attributes)` that returns `{ ok, errors[] }` and is the single validation entry point for legacy admin UI, Next admin UI, and import scripts.
5. WHEN a Tenant_Admin renames or removes an attribute in the Category_Schema, THE Commerce_OS SHALL preserve existing product attribute values in the JSON column and SHALL flag affected products in the dashboard until the Tenant_Admin reviews them.
6. THE Commerce_OS SHALL NOT introduce any new hardcoded category-specific columns in Prisma models for product attributes.

### Requirement 4: Dynamic Client Dashboard System

**User Story:** As a Tenant_Admin, I want my dashboard to show category-relevant modules (e.g. menu manager for restaurants, size charts for shoes), so that the UI matches how I run my business.

#### Acceptance Criteria

1. WHEN the Next_Admin_UI loads the dashboard for a tenant, THE Commerce_OS SHALL render the dashboard modules listed in `categorySchema.dashboardModules` in the declared order.
2. THE Commerce_OS SHALL ship dashboard modules for at minimum: `size_chart`, `team_filter`, `player_filter` (jersey); `menu_manager`, `delivery_zones`, `food_variants` (restaurant); `shade_selector`, `skin_type_filter`, `ingredients_panel` (cosmetics); `shoe_size_chart`, `gender_filter` (shoes); `product_grid`, `orders_table`, `conversations_panel`, `analytics_panel` (universal).
3. WHEN a module declared in `dashboardModules` is not registered in the dashboard module registry, THE Commerce_OS SHALL skip that module, render the remaining modules, and log a `dashboard_module_missing` warning tagged with `tenantId` and `moduleId`.
4. THE Legacy_Admin_UI SHALL continue to render its existing pages for tenants with `businessCategory=jersey` and SHALL gain a category banner indicating which schema is active.
5. WHEN a Tenant_Admin's plan does not include a feature module (per Requirement 16), THE Commerce_OS SHALL hide that module from the dashboard and SHALL replace it with an upgrade prompt linking to the plan management page.
6. THE Commerce_OS SHALL render the same module set on `localhost:3000/admin` and `dashboard.pipwarp.com` so that the development and production dashboards remain feature-parity.

### Requirement 5: Per-Tenant AI Agent Personalization

**User Story:** As a Tenant_Admin, I want my AI agent to have its own name, role, personality, tone, language, sales style, and greeting style, so that customers feel they are talking to my brand.

#### Acceptance Criteria

1. THE Commerce_OS SHALL store Agent_Identity per tenant with fields `name`, `role`, `personality`, `tone`, `language`, `salesStyle`, `greetingStyle`.
2. THE Commerce_OS SHALL preserve the existing `{{personaName}}` and `{{personaRole}}` placeholder semantics in `prompts.ts` such that `personaName` resolves to `agentIdentity.name` and `personaRole` resolves to `agentIdentity.role`.
3. WHEN `buildAgentSystemPrompt()` is invoked, THE Commerce_OS SHALL inject `agentIdentity.personality`, `agentIdentity.tone`, `agentIdentity.language`, `agentIdentity.salesStyle`, and `agentIdentity.greetingStyle` into the rendered prompt in addition to `personaName` and `personaRole`.
4. WHERE a tenant has not customized Agent_Identity fields, THE Commerce_OS SHALL apply category-default values from the tenant's Category_Schema before falling back to platform defaults.
5. THE Commerce_OS SHALL allow a Tenant_Admin to set Agent_Identity values such as "Sarah - Fashion Consultant", "Alex - Sports Store Assistant", or "ChefBot - Restaurant Order Manager" via the dashboard.
6. WHEN a Customer messages tenant A, THE AI agent SHALL only use tenant A's Agent_Identity in its replies and SHALL never reference tenant B's identity, name, role, or persona settings.
7. WHEN the Tenant_Admin updates Agent_Identity, THE Commerce_OS SHALL apply the new values to the next AI_Reasoning_Cycle for that tenant within 30 seconds without restarting the server.

### Requirement 6: Tenant Memory and Data Isolation

**User Story:** As a Tenant_Admin, I want my conversations, AI memory, products, prompts, workflows, analytics, and automation rules to be invisible to every other tenant, so that my business data stays private.

#### Acceptance Criteria

1. THE Commerce_OS SHALL scope every read and write of conversations, AI memory, customer profiles, products, prompts, workflows, content calendar entries, analytics, and automation rules by `tenantId`.
2. WHEN any AI tool in `src/agent/tools/registry.ts` queries the database, THE tool SHALL include `tenantId` in the where clause and SHALL reject calls that do not have a `tenantId` in the Reasoning_Context.
3. IF a query is constructed without a `tenantId` filter on a tenant-scoped table, THEN THE Commerce_OS SHALL throw a `MissingTenantScopeError` and SHALL log a `tenant_isolation_violation` event before any rows are returned.
4. THE Commerce_OS SHALL include `tenantId` as part of every cache key for tenant-scoped caches, including Category_Schema cache, Agent_Identity cache, Plan_Limit cache, and Reply_Filter cache.
5. WHEN a Super_Admin views tenant data in the Admin_Panel, THE Commerce_OS SHALL pass an explicit `tenantId` filter and SHALL log the access in `subscription_logs` or an equivalent audit log table.
6. THE Commerce_OS SHALL ensure Telegram alerts, Facebook page webhooks, courier callbacks, and payment gateway callbacks resolve to a single `tenantId` before any tenant-scoped read or write occurs.

### Requirement 7: Category-Specific AI Reasoning

**User Story:** As a Customer, I want the AI to reason about my request using rules that fit the business I'm shopping in, so that recommendations and answers feel correct.

#### Acceptance Criteria

1. THE AI_Reasoning_Cycle SHALL receive a Reasoning_Context containing `tenantId`, `businessCategory`, `categorySchema`, `agentIdentity`, `brandVoice`, `planLimits`, and `workflowRules`.
2. WHERE `businessCategory=restaurant`, THE AI agent SHALL apply the restaurant workflow rules including order-time delivery estimates, food category recommendations, and spice level clarification.
3. WHERE `businessCategory in {jersey, clothing, undergarments, shoes}`, THE AI agent SHALL apply the fashion workflow rules including size recommendation and fit clarification, using the attribute keys defined in the tenant's Category_Schema.
4. WHERE `businessCategory=electronics`, THE AI agent SHALL apply the electronics workflow rules including specification lookup, compatibility checks, and warranty disclosure.
5. THE AI agent SHALL NOT reference jersey-specific concepts (chest, length, team, version) when serving a tenant whose `businessCategory` is not `jersey`.
6. WHEN the Reasoning_Context is missing any of `tenantId`, `businessCategory`, or `categorySchema`, THE AI_Reasoning_Cycle SHALL abort with a `reasoning_context_incomplete` error rather than producing a reply.

### Requirement 8: Dynamic Order System

**User Story:** As a Customer, I want the order form and confirmation flow to capture the details that matter for the product I am buying, so that the tenant has everything they need to fulfill it.

#### Acceptance Criteria

1. THE Commerce_OS SHALL store category-specific order attributes in a JSON column on the existing order table.
2. WHEN an order is created, THE Commerce_OS SHALL validate the submitted order attributes against `categorySchema.orderAttributes`, rejecting unknown keys and missing required fields.
3. WHERE `businessCategory=restaurant`, THE Commerce_OS SHALL accept order attributes including `spice_level`, `toppings`, and `delivery_notes` and SHALL include them in courier dispatch metadata.
4. WHERE `businessCategory in {jersey, clothing, shoes}`, THE Commerce_OS SHALL accept order attributes including `size`, `color`, and `fit`.
5. WHERE `businessCategory=electronics`, THE Commerce_OS SHALL accept order attributes including `model`, `warranty_choice`, and `accessories`.
6. THE Commerce_OS SHALL continue to use `sslcommerzTranId` and `sslcommerzSessionKey` as universal gateway tran-id columns for all payment gateways, and `pathaoConsignmentId` and `pathaoMerchantOrderId` as universal courier-id columns for all couriers.
7. THE Commerce_OS SHALL preserve the existing 48-hour past-order handoff grace window and 10-hour conversation mute behavior for every tenant regardless of `businessCategory`.

### Requirement 9: Dynamic Form Builder

**User Story:** As a Tenant_Admin, I want product forms, variant forms, order forms, filters, and dashboard widgets to be generated from my category schema, so that I do not have to wait for engineering work when my schema changes.

#### Acceptance Criteria

1. THE Form_Builder SHALL render product forms from `categorySchema.attributes`, variant forms from `categorySchema.variantAttributes`, order forms from `categorySchema.orderAttributes`, filters from `categorySchema.filterAttributes`, and dashboard widgets from `categorySchema.dashboardModules`.
2. THE Form_Builder SHALL support field types `string`, `number`, `boolean`, `enum`, `multi_enum`, `date`, `currency`, and `image_ref`.
3. WHEN a field is marked `required=true` in the schema, THE Form_Builder SHALL render a required indicator and THE backend SHALL reject submissions missing that field.
4. WHEN a field is marked `customerVisible=true` in the schema, THE Commerce_OS SHALL include the field's value (translated through `categorySchema.terminology`) in customer-facing AI replies and product detail panels.
5. THE Form_Builder SHALL be rendered in both the Legacy_Admin_UI and the Next_Admin_UI.
6. WHEN the schema changes, THE Form_Builder SHALL re-render forms on the next page load without requiring a server restart.

### Requirement 10: Subscription System

**User Story:** As a Super_Admin, I want each tenant to have a subscription tracked from signup through renewal, grace, suspension, and cancellation, so that billing and access are automated.

#### Acceptance Criteria

1. THE Commerce_OS SHALL maintain a `subscriptions` row per tenant with fields including `tenantId`, `planId`, `status`, `trialEndsAt`, `currentPeriodStart`, `currentPeriodEnd`, `gracePeriodEndsAt`, `cancelledAt`, `nextBillingAt`, `billingCycle`.
2. THE Subscription_Status SHALL be one of `trial`, `active`, `overdue`, `suspended`, `cancelled`.
3. WHEN a new tenant completes the Onboarding_Wizard, THE Commerce_OS SHALL create a subscription with `status=trial` and `trialEndsAt` set to the configured trial length from the chosen Plan, defaulting to 14 days WHERE the Plan does not specify a trial length.
4. WHEN `currentPeriodEnd` is reached and a renewal payment succeeds, THE Commerce_OS SHALL set `status=active`, advance `currentPeriodStart` and `currentPeriodEnd` by one billing cycle, and clear `gracePeriodEndsAt`.
5. WHEN `currentPeriodEnd` is reached and no successful renewal payment exists, THE Commerce_OS SHALL set `status=overdue` and SHALL set `gracePeriodEndsAt` to `currentPeriodEnd + 3 days`.
6. WHEN `gracePeriodEndsAt` is reached without a successful payment, THE Commerce_OS SHALL set `status=suspended` and SHALL trigger the suspension actions defined in Requirement 12.
7. WHEN a Tenant_Admin cancels the subscription, THE Commerce_OS SHALL set `status=cancelled` and `cancelledAt`, SHALL keep `status=active` until `currentPeriodEnd`, and SHALL transition to `cancelled` access at `currentPeriodEnd`.

### Requirement 11: Payment Automation via SSLCommerz

**User Story:** As a Super_Admin, I want successful subscription payments to activate access automatically and failed payments to be tracked, so that I do not manage billing by hand.

#### Acceptance Criteria

1. THE Commerce_OS SHALL initiate subscription payments through SSLCommerz using the existing `sslcommerzTranId` and `sslcommerzSessionKey` storage convention.
2. WHEN SSLCommerz reports a successful payment via webhook, THE Commerce_OS SHALL mark the corresponding `payment_transactions` row `status=success`, mark the linked `invoices` row `status=paid`, and call the Subscription renewal handler defined in Requirement 10.4.
3. WHEN SSLCommerz reports a failed payment via webhook, THE Commerce_OS SHALL mark the `payment_transactions` row `status=failed`, write a `payment_failures` row with the failure reason, and SHALL NOT change Subscription_Status by itself.
4. WHEN a Subscription transitions to `active` after payment, THE Commerce_OS SHALL generate a PDF invoice, store its reference on the `invoices` row, and queue an email notification to the Tenant_Admin.
5. IF a webhook is received for a `tranId` that does not match any known `payment_transactions` row, THEN THE Commerce_OS SHALL log a `payment_webhook_unmatched` event and SHALL respond `200 OK` to SSLCommerz to prevent retry storms.
6. WHERE the SSLCommerz signature validation fails, THE Commerce_OS SHALL reject the webhook with a `400` response and SHALL log a `payment_webhook_signature_invalid` event.

### Requirement 12: Overdue Handling and Suspension

**User Story:** As a Super_Admin, I want tenants who fail to pay to be warned, then suspended, then automatically reactivated on payment, so that the platform protects revenue without losing tenant data.

#### Acceptance Criteria

1. WHEN a Subscription enters `status=overdue` (Day 0), THE Commerce_OS SHALL send a first overdue warning to the Tenant_Admin via the Notification_System within 1 hour.
2. WHEN 24 hours have elapsed since `status=overdue` was entered (Day 1), THE Commerce_OS SHALL send a second overdue warning.
3. WHEN 48 hours have elapsed since `status=overdue` was entered (Day 2), THE Commerce_OS SHALL send a final overdue warning.
4. WHEN `gracePeriodEndsAt` is reached without payment (Day 3), THE Commerce_OS SHALL set `status=suspended`, deactivate the tenant's storefront, disable the AI agent for that tenant's Facebook page, disable autonomous AI posting, and pause outbound messaging.
5. WHILE `status=suspended`, THE Commerce_OS SHALL preserve all tenant data including products, conversations, AI memory, and Category_Schema and SHALL NOT delete or anonymize any tenant-scoped row.
6. WHEN a successful payment is recorded for a suspended tenant, THE Commerce_OS SHALL set `status=active`, re-enable the AI agent, AI posting, and outbound messaging within 5 minutes, and notify the Tenant_Admin of reactivation.
7. THE Commerce_OS SHALL record every status transition in `subscription_logs` with `tenantId`, `fromStatus`, `toStatus`, `reason`, and `actor` (`system` or Super_Admin id).

### Requirement 13: Notification System

**User Story:** As a Tenant_Admin, I want to receive billing, suspension, and reactivation notifications across multiple channels, so that I never miss a critical platform event.

#### Acceptance Criteria

1. THE Commerce_OS SHALL deliver Tenant_Admin notifications through the Notification_Channels `dashboard` and `email` at minimum.
2. THE Commerce_OS SHALL define WhatsApp and Facebook as future Notification_Channels by exposing a `NotificationChannelAdapter` interface so that adapters can be added without changing notification call sites.
3. WHEN a notification is dispatched, THE Commerce_OS SHALL persist it in a `notifications` table with `tenantId`, `channel`, `type`, `payload`, `status`, and `createdAt`.
4. WHEN a Tenant_Admin views the dashboard, THE Commerce_OS SHALL show unread `dashboard` notifications in a notification center sorted by `createdAt` descending.
5. IF an email notification fails to send, THEN THE Commerce_OS SHALL retry up to 3 times with exponential backoff and SHALL mark the row `status=failed` after the final attempt.
6. THE existing Telegram alert pipeline (Confirm/Reject inline buttons + invoice PDF doc) SHALL continue to operate per-tenant and SHALL be exposed as a separate channel adapter.

### Requirement 14: Subscription Database Schema

**User Story:** As a backend engineer, I want a clear set of subscription tables with stable column names, so that billing logic is auditable and reusable.

#### Acceptance Criteria

1. THE Commerce_OS SHALL define Prisma models for `subscriptions`, `invoices`, `payment_transactions`, `subscription_logs`, `payment_failures`, `grace_period_tracking`, and `plan_limits`.
2. THE `payment_transactions` model SHALL expose `sslcommerzTranId` and `sslcommerzSessionKey` columns reused as universal gateway tran-id columns and SHALL accept transactions from SSLCommerz, AamarPay, and bKash without adding gateway-specific columns.
3. THE Commerce_OS SHALL apply schema changes through `prisma db push` only and SHALL NOT create files in `prisma/migrations`.
4. WHERE the `EPERM` OneDrive lock is hit during `prisma generate`, THE engineer SHALL run `Stop-Process -Name node -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; npx prisma generate` as the documented workaround, and the codebase SHALL NOT depend on any other generation strategy.
5. THE Commerce_OS SHALL preserve the existing `tenants` and `TenantSession` tables and SHALL NOT rename or drop existing columns used by the legacy admin UI or the Next admin UI.
6. THE Commerce_OS SHALL store category-specific extension data in JSON columns rather than introducing new physical columns per category.

### Requirement 15: Plan System

**User Story:** As a Super_Admin, I want multiple plans (Starter, Pro, Agency, Enterprise) with distinct limits, so that I can monetize the platform tier-by-tier.

#### Acceptance Criteria

1. THE Commerce_OS SHALL define at least four plans: `starter`, `pro`, `agency`, `enterprise`.
2. THE Commerce_OS SHALL store per-plan Plan_Limits including `maxMonthlyMessages`, `maxAiTokensMonthly`, `maxProducts`, `maxSocialAccounts`, `aiPostingEnabled`, `contentCalendarEnabled`, `automationRulesEnabled`, `maxPostingPerDay`.
3. WHEN a tenant attempts to exceed a numeric Plan_Limit, THE Commerce_OS SHALL block the offending operation, return a structured `plan_limit_exceeded` error including `limitKey`, `current`, and `max`, and SHALL display an upgrade prompt in the Next_Admin_UI.
4. WHEN a tenant attempts to use a feature whose corresponding boolean Plan_Limit is `false`, THE Commerce_OS SHALL hide the feature in the dashboard and SHALL refuse the operation if invoked through an API.
5. THE Commerce_OS SHALL count messages and AI tokens against the current billing period and SHALL reset counters at `currentPeriodStart` of each new period.
6. THE Commerce_OS SHALL allow Super_Admins to override Plan_Limits per tenant for support cases, persisting the override on the `subscriptions` row and SHALL log the override in `subscription_logs`.

### Requirement 16: Feature Flag System

**User Story:** As a Super_Admin, I want features to be gated by Feature_Flags derived from the tenant's plan, so that I never need to hardcode permissions in feature code.

#### Acceptance Criteria

1. THE Commerce_OS SHALL expose a `featureFlag(tenantId, flagKey)` API that resolves to a boolean by reading the tenant's current Plan and any per-tenant Plan_Limit override.
2. THE Commerce_OS SHALL define Feature_Flags including `feature.aiPosting`, `feature.contentCalendar`, `feature.automationRules`, `feature.multiSocialAccounts`, `feature.advancedAnalytics`, `feature.customCategorySchema`.
3. WHEN a Feature_Flag resolves to `false`, THE Commerce_OS SHALL prevent the corresponding code path from executing and SHALL NOT throw uncaught errors in the AI loop or dashboard.
4. THE Commerce_OS SHALL NOT contain any hardcoded `if (tenantId === '...')` permission checks for feature gating.
5. WHEN a Super_Admin changes a Plan_Limit or per-tenant override, THE `featureFlag` resolver SHALL reflect the new value within 30 seconds across all Commerce_OS processes.

### Requirement 17: Modular SaaS Architecture

**User Story:** As a backend engineer, I want every major feature to be modular, plugin-capable, and category-aware, so that the platform scales to new categories without rewrites.

#### Acceptance Criteria

1. THE Commerce_OS SHALL refactor in place under `src/agent/` and SHALL NOT introduce a parallel module such as `src/agent2/`.
2. THE Commerce_OS SHALL expose a category plugin interface `CategoryPlugin` with methods for `getSchema()`, `getDashboardModules()`, `getWorkflowRules()`, and `getPromptFragments()` so that adding a new category is a matter of registering a plugin.
3. THE Commerce_OS SHALL expose a notification adapter interface, a payment gateway adapter interface, and a courier adapter interface so that SSLCommerz, AamarPay, bKash, Pathao, and Steadfast are concrete adapters rather than special cases in core code.
4. THE Commerce_OS SHALL keep the legacy admin UI at `localhost:4000/admin` and the Next.js admin UI at `localhost:3000/admin` operational throughout the refactor.
5. THE Commerce_OS SHALL keep the production deployment shape unchanged: backend on `api.pipwarp.com`, dashboard on `dashboard.pipwarp.com`, CORS via `CORS_ALLOWED_ORIGINS`, production cookies `SameSite=None; Secure`, activation host from `PUBLIC_PORTAL_URL`.
6. WHERE a `NEXT_PUBLIC_*` env var is changed, THE engineer SHALL rebuild the Next app, and the codebase SHALL NOT rely on runtime mutation of `NEXT_PUBLIC_*` values.

### Requirement 18: AI System Refactor

**User Story:** As an AI engineer, I want every reasoning cycle to receive a fully populated, tenant-scoped, category-aware context, so that the agent never falls back to jersey assumptions.

#### Acceptance Criteria

1. THE AI_Reasoning_Cycle SHALL build a Reasoning_Context per turn containing `tenantId`, `businessCategory`, `categorySchema`, `agentIdentity`, `brandVoice`, `planLimits`, and `workflowRules`.
2. THE production caller path through `askRouter` SHALL fetch tenant settings and build the prompt per turn using `buildAgentSystemPrompt()` with the existing `{{personaName}}`/`{{personaRole}}` placeholders.
3. THE Commerce_OS SHALL continue to use the model `gemma4:31b-cloud` configured in `.env` and SHALL NOT silently downgrade to a smaller model.
4. THE Commerce_OS SHALL preserve the existing tool loop in `src/agent/loop.ts` and SHALL pass `tenantId` to every tool registered in `src/agent/tools/registry.ts`.
5. THE Commerce_OS SHALL preserve the existing test pattern: tsx-runnable, IIFE-wrapped, Prisma stubs in `installStubs`/`restoreStubs`, axios stub before `loop.ts` import, and `psid: "SIM_..."` to short-circuit Messenger sends.
6. WHERE the existing Reply_Filter overrides apply (`banned_word`, `tone_rewrite`, `capability_confession`, `anti_hallucination`, `confirmation_block`), THE Commerce_OS SHALL continue to load them per tenant and SHALL apply them after the LLM response is generated and before the message is sent to the Customer.
7. THE AI agent SHALL produce customer-facing text in Banglish only and SHALL NOT expose internal vocabulary such as "catalog" to Customers.

### Requirement 19: Prompt Engineering System

**User Story:** As an AI engineer, I want prompts to assemble dynamically from tenant context and category schema, so that no prompt content is hardcoded for jerseys.

#### Acceptance Criteria

1. THE prompt builder SHALL include `tenant.businessCategory`, `tenant.businessSubcategory`, `categorySchema.terminology`, `agentIdentity.name`, `agentIdentity.role`, `agentIdentity.tone`, and active `categorySchema.workflowRules` in the system prompt for each AI_Reasoning_Cycle.
2. THE prompt builder SHALL render the existing `{{personaName}}` and `{{personaRole}}` placeholders with values from Agent_Identity.
3. WHERE a Category_Schema declares `promptFragments`, THE prompt builder SHALL append the fragments after the persona section in the order declared by the schema.
4. THE prompt builder SHALL NOT inject jersey-specific content (chest, length, team, version) for tenants whose `businessCategory` is not `jersey`.
5. WHEN a tenant updates Agent_Identity, Category_Schema, or workflow rules, THE prompt builder SHALL pick up the new values on the next AI_Reasoning_Cycle without restart.

### Requirement 20: Admin Super Control Panel

**User Story:** As a Super_Admin, I want a single panel to manage subscriptions, tenants, payments, suspended stores, AI usage, analytics, categories, and schema templates, so that I run the platform from one place.

#### Acceptance Criteria

1. THE Admin_Panel SHALL list all tenants with `tenantId`, business name, `businessCategory`, `planId`, `subscriptionStatus`, `currentPeriodEnd`, and last payment status.
2. THE Admin_Panel SHALL allow a Super_Admin to view, create, edit, suspend, reactivate, or cancel any subscription and SHALL log every action in `subscription_logs`.
3. THE Admin_Panel SHALL display a payments dashboard showing `payment_transactions` and `payment_failures` filterable by tenant, gateway, and date.
4. THE Admin_Panel SHALL display suspended stores and SHALL provide a one-click reactivation that records a `manual_reactivation` event in `subscription_logs`.
5. THE Admin_Panel SHALL display per-tenant AI usage including monthly messages and tokens against Plan_Limits.
6. THE Admin_Panel SHALL allow a Super_Admin to manage Business_Categories and Category_Schemas, including viewing built-in schemas, creating custom schema templates, and assigning a schema to a tenant.
7. WHEN a Super_Admin signs in, THE Commerce_OS SHALL authenticate against a Super_Admin role distinct from Tenant_Admin (`TenantSession`) and SHALL deny tenant-scoped operations that lack an explicit `tenantId` filter.

### Requirement 21: Future-Ready Integrations

**User Story:** As a product owner, I want the architecture to anticipate Shopify, WhatsApp agents, AI voice agents, multilingual AI, AI-generated product ads, AI-generated video marketing, and marketplace integrations, so that future features do not require core rewrites.

#### Acceptance Criteria

1. THE Commerce_OS SHALL define adapter interfaces for `MessagingChannelAdapter` (Messenger today; WhatsApp, voice future), `MarketplaceAdapter` (Shopify, marketplace future), and `MediaGenerationAdapter` (ad image, video future).
2. THE Commerce_OS SHALL include a `language` field in Agent_Identity and SHALL pass it to the prompt builder so that multilingual AI can be enabled by adapter without changing the loop.
3. THE Commerce_OS SHALL NOT couple the existing Facebook Messenger pipeline to the agent loop in a way that prevents adding a new MessagingChannelAdapter alongside it.
4. WHERE a future adapter is not yet implemented, THE Commerce_OS SHALL hide its feature toggle in the dashboard rather than expose a non-functional control.

### Requirement 22: Backward Compatibility With Existing Jersey Tenant

**User Story:** As the operator of the existing demo tenant, I want every current behavior to keep working after the multi-tenant transformation, so that no live data or live conversation is broken.

#### Acceptance Criteria

1. WHEN the migration runs, THE Commerce_OS SHALL set `tenant.businessCategory=jersey` and `tenant.categorySchemaId` to the built-in jersey schema for tenant `cmooz62gy0000v5gclycwq78p`.
2. THE Commerce_OS SHALL preserve all existing products, orders, conversations, AI memory, persona settings, content calendar entries, and analytics for the demo tenant unchanged.
3. THE Commerce_OS SHALL preserve the existing Facebook page binding `659418713929142` to the demo tenant.
4. THE existing payment gateway integrations (SSLCommerz, AamarPay, bKash) SHALL continue to operate against the universal `sslcommerzTranId`/`sslcommerzSessionKey` columns for tenant orders.
5. THE existing courier integrations (Pathao, Steadfast) SHALL continue to operate against the universal `pathaoConsignmentId`/`pathaoMerchantOrderId` columns for tenant orders.
6. THE existing handoff policy (48h grace + 10h conversation mute) SHALL continue to apply to the demo tenant and to every other tenant.
7. THE existing Reply_Filter override kinds (`banned_word`, `tone_rewrite`, `capability_confession`, `anti_hallucination`, `confirmation_block`) SHALL continue to apply per tenant.
8. THE existing Telegram alert pipeline (Confirm/Reject inline buttons + invoice PDF doc) SHALL continue to operate for the demo tenant after the refactor.
9. THE existing vision pipeline `classifyImageContent`, `pickCatalogByVisualComparison`, and `identifyJerseyFromPhoto` (kept as enrichment only) SHALL continue to operate for tenants whose `businessCategory=jersey`.
10. WHERE the existing past-order handoff with 48h grace window and 10h conversation mute is configured for the demo tenant, THE Commerce_OS SHALL preserve those exact thresholds.

### Requirement 23: Repository, Build, and Operational Constraints

**User Story:** As an engineer working in the existing repo, I want the transformation to honor the documented repo rules so that the build, deploy, and migration paths keep working on Windows + OneDrive.

#### Acceptance Criteria

1. THE Commerce_OS SHALL be implemented in the existing repository at `https://github.com/ashamilon/AutoMads.git` on branch `main`, in the workspace `c:\Users\asham\OneDrive\Documents\Facebook_business_Saas`.
2. THE Commerce_OS SHALL refactor in place under `src/agent/` and SHALL NOT add a parallel `src/agent2/` directory.
3. THE Commerce_OS SHALL apply database changes through `prisma db push` only and SHALL NOT create or check in files under `prisma/migrations/`.
4. WHEN `npx prisma generate` fails with `EPERM` due to OneDrive locks, THE documented operational workaround SHALL be `Stop-Process -Name node -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; npx prisma generate`.
5. THE Commerce_OS SHALL continue to use `bcryptjs` for password hashing instead of `bcrypt` for Windows compatibility.
6. THE Commerce_OS SHALL keep the legacy admin UI at `localhost:4000/admin` and the Next admin UI at `localhost:3000/admin` operational throughout development.
7. THE production deployment SHALL keep backend on `api.pipwarp.com`, dashboard on `dashboard.pipwarp.com`, CORS configuration via `CORS_ALLOWED_ORIGINS`, production cookies `SameSite=None; Secure`, and activation link host driven by `PUBLIC_PORTAL_URL=https://dashboard.pipwarp.com`.
8. WHERE a `NEXT_PUBLIC_*` env var changes, THE Next app SHALL be rebuilt because those values are inlined at build time.
9. THE Commerce_OS SHALL preserve the existing test conventions: tsx-runnable test files, IIFE-wrapped, Prisma stubs in `installStubs`/`restoreStubs`, axios stub installed before `src/agent/loop.ts` is imported, and Messenger short-circuit through `psid: "SIM_..."`.
10. THE Commerce_OS SHALL NOT introduce new physical columns for category-specific data and SHALL reuse JSON columns and historical column names per the existing storage strategy.
