# Implementation Plan: Multi-Tenant Commerce OS

## Overview

Convert the existing single-vertical jersey commerce platform into a multi-tenant, category-agnostic AI Commerce OS while keeping the live demo tenant `cmooz62gy0000v5gclycwq78p` and every existing subsystem (legacy `localhost:4000/admin`, Next.js `localhost:3000/admin`, SSLCommerz/AamarPay/bKash, Pathao/Steadfast, Telegram alerts, vision pipeline, handoff policy, reply filter) operational throughout the rollout.

The implementation is organized around the architectural seams from the design: Prisma schema deltas, Category Engine, Reasoning_Context builder, Agent_Identity service, prompt extension, Reply Filter terminology pass, Subscription/Plan/Feature Flag plane, SSLCommerz subscription adapter, Notification Dispatcher, Onboarding service + wizard, Admin Super Control Panel, Dynamic Form Builder, Dashboard Module Registry, demo-tenant migration script, and property-based tests for the ten correctness properties.

Constraints honored across every task:

- `prisma db push` only — no files in `prisma/migrations/` (R14.3, R23.3).
- In-place under `src/agent/` — no `src/agent2/` (R17.1, R23.2).
- `bcryptjs` for password hashing (R23.5).
- Both admin UIs preserved (R17.4, R23.6).
- Universal storage columns reused: `sslcommerzTranId`/`sslcommerzSessionKey` and `pathaoConsignmentId`/`pathaoMerchantOrderId` (R8.6, R14.2, R22.4, R22.5, R23.10).
- Tests follow the tsx-runnable IIFE pattern with `installStubs`/`restoreStubs`, axios stub before `loop.ts` import, `psid: "SIM_..."` short-circuit (R18.5, R23.9).

## Tasks

- [x] 1. Extend Prisma schema and run `prisma db push`
  - [x] 1.1 Add Commerce_OS Prisma models and Tenant deltas in `prisma/schema.prisma`
    - Add new fields on `Tenant`: `businessCategory String?`, `businessSubcategory String?`, `categorySchemaId String?`, `dashboardTemplate String?`, `onboardingCompletedAt DateTime?`, `onboardingState Json?`, `agentIdentity Json?` plus the relation `categorySchema CategorySchema? @relation(...)`.
    - Add new models: `CategorySchema`, `Plan`, `Subscription`, `Invoice`, `PaymentTransaction`, `SubscriptionLog`, `PaymentFailure`, `GracePeriodTracking`, `Notification`, `SuperAdmin`, `SuperAdminSession` per the Data Models section of the design.
    - Reuse universal columns on `Invoice` and `PaymentTransaction`: `sslcommerzTranId`, `sslcommerzSessionKey`. Do not add gateway-specific columns.
    - Do NOT rename, drop, or repurpose any existing columns on `Tenant`, `TenantSession`, `Order`, `ProductMapping`, `MessengerConversation`, `MessengerMessage`, `CustomerProfile`, `FollowUp`, `AgentTrace`, `KnowledgeExample`, or `ScheduledPost`.
    - Apply via `prisma db push`. If `npx prisma generate` fails with `EPERM`, run `Stop-Process -Name node -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; npx prisma generate`.
    - _Requirements: 3.1, 3.6, 8.1, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 17.1, 22.4, 22.5, 23.2, 23.3, 23.4, 23.10_

- [ ] 2. Build Category Engine and ship built-in schemas
  - [x] 2.1 Define category schema TypeScript types and built-in JSON schemas
    - Create `src/agent/categoryEngine/types.ts` with `AttributeField`, `CategorySchema`, `WorkflowRules`, `ValidationError`, `DashboardModuleId` types matching the design.
    - Create JSON files under `src/agent/categoryEngine/schemas/` for: `jersey.json`, `clothing.json`, `undergarments.json`, `shoes.json`, `cosmetics.json`, `electronics.json`, `restaurant.json`, `grocery.json`, `jewelry.json`, `furniture.json`, `pet_shop.json`, `pharmacy.json`, `mobile_accessories.json`, `custom.json`.
    - Each schema MUST populate `attributes`, `variantAttributes`, `orderAttributes`, `filterAttributes`, `terminology`, `dashboardModules`, `workflowRules`, `promptFragments`, `isBuiltIn=true`, `tenantId=null`, `slug`, `version=1`. Use the attribute keys called out in the design: jersey (`chest, length, sleeve, version, team, season`), undergarments (`waist, fabric, fit, cup_size`), shoes (`shoe_size, gender, sole_type, width`), restaurant (`spice_level, portion_size, food_category, prep_time`), cosmetics (`shade, skin_type, ingredients, volume`), electronics (`model, brand, specs, warranty_months`).
    - `custom.json` MUST have empty `attributes`/`orderAttributes` with placeholders the wizard fills in.
    - _Requirements: 1.3, 2.2, 2.4, 3.1, 3.6_

  - [-] 2.2 Implement schema loader, per-tenant LRU cache, and `LISTEN/NOTIFY` invalidation
    - Create `src/agent/categoryEngine/schemaLoader.ts` exposing `loadBuiltInSchemas()` (reads JSON files at boot) and `loadTenantSchemaFromDb(tenantId)`.
    - Create `src/agent/categoryEngine/schemaCache.ts` with a per-`tenantId` Map of `{ schema, fetchedAt }`, 30s TTL, max-entries cap.
    - Create `src/agent/categoryEngine/invalidation.ts` that opens a Postgres `LISTEN category_schema_invalidate` connection on bootstrap and calls `schemaCache.invalidate(payload)` on each notification. Provide a publisher helper that emits `pg_notify('category_schema_invalidate', tenantId)` on writes.
    - Cache keys MUST include `tenantId` as a prefix.
    - _Requirements: 2.1, 2.6, 6.4_

  - [-] 2.3 Implement Category Engine public API
    - Create `src/agent/categoryEngine/index.ts` exporting `loadCategorySchema`, `validateProductAttributes`, `validateOrderAttributes`, `resolveTerminology`, `listDashboardModules`, `getWorkflowRules`, `invalidateSchemaCache`.
    - `loadCategorySchema(tenantId)` MUST: read `tenant.categorySchemaId`; fall back to built-in for `tenant.businessCategory`; finally fall back to `jersey` and emit `category_schema_fallback` log tagged with `tenantId`.
    - `validateProductAttributes` and `validateOrderAttributes` MUST reject unknown keys, missing required fields, and type mismatches; for `enum`/`multi_enum` they must check membership in `enumValues`; for `number` they must honor `min`/`max`. Return `{ ok: true }` or `{ ok: false, errors: [{ key, code, detail? }] }`.
    - For `tenant.businessCategory === 'jersey'`, run validators in "preserve mode" — accept the historical keys `chest, length, sleeve, version, team, season` regardless of the active schema's `required` list to keep demo tenant data flowing.
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 3.2, 3.3, 3.4, 8.2, 9.3_

  - [ ]* 2.4 Property test for category schema determinism
    - **Property 3: Category Schema Determinism** — for any `(tenantId, attributes, schemaVersion)`, repeated calls to `validateProductAttributes` and `validateOrderAttributes` return identical results within a single schema version; cache invalidation only occurs when the version changes.
    - Implement as a tsx-runnable IIFE under `src/agent/__tests__/categorySchemaDeterminism.test.ts` using a fast-check generator over the built-in schemas.
    - **Validates: Requirements 2.6, 3.2, 8.2, 9.3 (CP-3)**

  - [ ]* 2.5 Property test for tenant cache key isolation
    - **Property 10: Tenant Cache Key Isolation** — for any cache `c` in `{schemaCache, identityCache, planLimitCache, featureFlagCache, replyFilterCache}` and any `(tenantA, tenantB)` with `tenantA != tenantB`, `c.get(tenantA)` and `c.get(tenantB)` operate on disjoint keys.
    - Cover `schemaCache` here; the other caches are wired in their own tasks (3.4, 6.5).
    - File: `src/agent/__tests__/tenantCacheKeyIsolation.test.ts`.
    - **Validates: Requirements 6.4 (CP-10)**

- [ ] 3. Build Agent_Identity service and Reasoning_Context builder
  - [~] 3.1 Implement Agent_Identity service with three-layer resolution
    - Create `src/agent/identity/agentIdentityService.ts` exporting `resolve(tenantId, schema)` returning `AgentIdentity` (`name, role, personality, tone, language, salesStyle, greetingStyle`).
    - Resolution chain: per-tenant `tenant.agentIdentity` JSON → `categorySchema.agentIdentityDefaults` (optional) → platform defaults (`Karim`, `Moderator of this Page`, `warm, concise, friendly`, `banglish_warm`, `bn-BD`, `consultative`, `casual`).
    - Add a per-`tenantId` 30s cache with `pg_notify('agent_identity_invalidate', tenantId)` listener.
    - _Requirements: 5.1, 5.2, 5.4, 5.7, 19.2, 21.2_

  - [~] 3.2 Implement Reasoning_Context builder and typed errors
    - Create `src/agent/context/reasoningContextErrors.ts` with `MissingTenantScopeError` and `ReasoningContextIncompleteError` classes.
    - Create `src/agent/context/reasoningContext.ts` exposing `buildReasoningContext({ tenantId, conversationId? })`. Steps: load tenant; resolve `categorySchema` via `categoryEngine.loadCategorySchema`; resolve `agentIdentity` via `agentIdentityService.resolve`; resolve `planLimits` via `planLimitService.resolve` (task 6); read `subscription.status` and compute `isOperational = status in {trial, active}` OR (`status=overdue` AND `now < gracePeriodEndsAt`).
    - Validate that `tenantId`, `businessCategory`, `categorySchema` are all non-null; otherwise throw `ReasoningContextIncompleteError`.
    - Return `Object.freeze(context)` so callers cannot mutate it.
    - _Requirements: 5.6, 6.6, 7.1, 7.6, 12.4, 18.1, 18.2_

  - [~] 3.3 Wire Reasoning_Context into the agent loop and tool registry
    - Extend `src/agent/loop.ts` so `runAgentTurn` accepts a `reasoningContext` on its input. Call `buildReasoningContext` before `observe_input` if not already provided, and propagate the frozen object on every node's `state.ctx`.
    - Extend `ToolHandlerCtx` in `src/agent/tools/registry.ts` so every tool receives `tenantId`, `categorySchema`, `agentIdentity`, `planLimits`, `workflowRules`, `subscription`. Wrap each tool handler with a guard that throws `MissingTenantScopeError` when `ctx.tenantId` is falsy and emits a `tenant_isolation_violation` log event.
    - Update `src/agent/router.ts` `askRouter` path to call `buildReasoningContext` once per turn before invoking the loop, replacing any ad-hoc tenant settings fetches.
    - Outbound surfaces (Messenger reply, content publish, follow-up send) MUST short-circuit when `ctx.subscription.isOperational === false`.
    - _Requirements: 6.1, 6.2, 6.3, 7.1, 12.4, 18.1, 18.4_

  - [ ]* 3.4 Property test for Reasoning Context completeness
    - **Property 2: Reasoning Context Completeness** — for any `runAgentTurn(input)` either the loop produces a reply with `input.reasoningContext.{tenantId, businessCategory, categorySchema}` all non-null, or it throws `ReasoningContextIncompleteError` and emits no Messenger send (verify via `psid: "SIM_..."` short-circuit assertion).
    - File: `src/agent/__tests__/reasoningContextCompleteness.test.ts`. Use existing axios + Prisma stubs.
    - **Validates: Requirements 7.1, 7.6, 18.1 (CP-2)**

  - [ ]* 3.5 Property test for tenant scope invariant
    - **Property 1: Tenant Scope Invariant** — for any tool invocation `t` with `ctx.tenantId == null`, `runTool(t, ctx)` throws `MissingTenantScopeError`. Every Prisma query reaching tenant-scoped tables in tools includes `tenantId` in the `where` clause.
    - Implement by enumerating registered tools in `src/agent/tools/registry.ts` and running each with an empty ctx; assert error class.
    - File: `src/agent/__tests__/tenantScopeInvariant.test.ts`.
    - **Validates: Requirements 6.1, 6.2, 6.3 (CP-1)**

- [ ] 4. Extend prompt builder and Reply Filter for category awareness
  - [~] 4.1 Extend `buildAgentSystemPrompt` to inject Agent_Identity and category fragments
    - Update `src/agent/prompts.ts` so `resolvePersonaIdentity()` now reads from the resolved `AgentIdentity` and `buildAgentSystemPrompt()` injects `personality`, `tone`, `language`, `salesStyle`, `greetingStyle` into the rendered prompt after the existing `{{personaName}}`/`{{personaRole}}` placeholders. Preserve existing placeholder semantics and rendering order.
    - When the active `categorySchema.promptFragments` array is non-empty, append the fragments after the persona section in declared order.
    - When `tenant.businessCategory !== 'jersey'`, exclude jersey-specific fragments (chest/length/team/version) from the rendered prompt.
    - _Requirements: 5.2, 5.3, 7.5, 19.1, 19.2, 19.3, 19.4, 19.5_

  - [~] 4.2 Add terminology pass to Reply Filter
    - Update `src/agent/replyFilter.ts` to run a new pre-pass `applyTerminology(reply, schema.terminology)` BEFORE `banned_word`, `tone_rewrite`, `capability_confession`, `anti_hallucination`, `confirmation_block`. The pass replaces any occurrence of internal terminology keys (e.g. `catalog`, `cart`, `select`, `checkout`, `sku`) with the value defined in the active schema's `terminology` map.
    - Preserve all five existing override kinds and per-tenant loading. The terminology map MUST come from the resolved `ReasoningContext.categorySchema`.
    - _Requirements: 2.5, 18.6, 18.7, 22.7_

  - [ ]* 4.3 Property test for Banglish customer-facing text
    - **Property 8: Banglish Customer-Facing Text** — for any reply `r` produced by the agent loop and passed through the reply filter, `r` does not contain any string in `internalTerminologyKeys` (`'catalog'`, `'cart'`, `'select'`, `'checkout'`, `'sku'`) outside of values defined in the active schema's `terminology` map.
    - File: `src/agent/__tests__/banglishTerminology.test.ts`. Drive with fast-check generators over schemas and synthetic LLM replies that intentionally embed internal terms.
    - **Validates: Requirements 18.7, 22.7 (CP-8)**

- [~] 5. Checkpoint - reasoning plane integration
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Build Plan / Feature Flag plane
  - [x] 6.1 Implement Plan service and seeded plan rows
    - Create `src/services/plan/planService.ts` exposing `listPlans()`, `getPlanBySlug(slug)`, `seedDefaultPlans()`. Seeding is idempotent on bootstrap.
    - Seed the four plans from the design table: `starter` (14d trial, 2k msgs, 50 products, 1 social, no AI posting), `pro` (14d trial, 20k msgs, 500 products, 3 social, AI posting), `agency` (14d trial, 100k msgs, 5000 products, 10 social, AI posting + automation rules), `enterprise` (0d trial, all `-1`, all flags true).
    - Numeric `-1` MUST be interpreted as unlimited.
    - _Requirements: 15.1, 15.2_

  - [-] 6.2 Implement Plan Limit service with usage counters
    - Create `src/services/plan/planLimitService.ts` exposing `resolve(tenantId)`, `checkLimit(tenantId, key, requestedDelta?)`, `incrementUsage(tenantId, key, delta)`, `resetUsageCounters(tenantId)`.
    - Resolution chain: `Subscription.planLimitOverrides[key]` → `Plan.limits[key]` → platform default.
    - Usage counters are stored as `Subscription.usageCounters` JSON (`{ messages, aiTokens, posts }`); reset is invoked when `subscriptionService` advances `currentPeriodStart`.
    - When a numeric limit is hit, `checkLimit` returns `{ ok: false, current, max }`. Tools/controllers translate this to a 402 response `{ error: 'plan_limit_exceeded', limitKey, current, max }`.
    - _Requirements: 15.3, 15.4, 15.5, 15.6_

  - [-] 6.3 Implement Feature Flag service
    - Create `src/services/plan/featureFlagService.ts` exposing `featureFlag(tenantId, flagKey): Promise<boolean>`.
    - Lookup chain: tenant override on `Subscription.planLimitOverrides[flagKey]` → `Plan.featureFlags[flagKey]` → platform default `false`.
    - Per-`tenantId` 30s cache. Subscribe to `pg_notify('feature_flag_invalidate', tenantId)` and evict.
    - Predefined flags: `feature.aiPosting`, `feature.contentCalendar`, `feature.automationRules`, `feature.multiSocialAccounts`, `feature.advancedAnalytics`, `feature.customCategorySchema`. NEVER use `if (tenantId === '...')` checks for feature gating anywhere in the code base.
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [ ]* 6.4 Property test for plan limit lookup chain order
    - **Property 7: Plan Limit Lookup Chain Order** — for any `(tenantId, key)`, `resolveLimit(tenantId, key)` returns the first non-null value in the sequence `[Subscription.planLimitOverrides[key], Plan.limits[key], platformDefault[key]]`.
    - File: `src/services/__tests__/planLimitLookupChain.test.ts`. Drive with fast-check over generated `(override, plan, default)` triples.
    - **Validates: Requirements 15.6, 16.1 (CP-7)**

  - [ ]* 6.5 Property test for feature flag and plan limit cache key isolation
    - Extends Property 10 to `planLimitCache` and `featureFlagCache`. Verify `c.get(tenantA)` and `c.get(tenantB)` never collide and 30s invalidation only evicts the targeted `tenantId`.
    - File: `src/services/__tests__/planFlagCacheIsolation.test.ts`.
    - **Validates: Requirements 6.4, 16.5 (CP-10)**

- [ ] 7. Build Subscription plane and state machine
  - [-] 7.1 Implement pure subscription state machine
    - Create `src/services/subscription/subscriptionStateMachine.ts` exporting `transition(currentStatus, event)`.
    - Cover every cell of `{trial, active, overdue, suspended, cancelled} × {onboarding_complete, payment_success, payment_failure, period_end_reached, grace_period_end_reached, tenant_cancel, super_admin_reactivate, super_admin_force_suspend}`. Undefined cells return a typed `IllegalTransition` error.
    - The function MUST be pure — no DB access. It returns the next status plus a `reason` string for the log.
    - _Requirements: 10.2, 10.4, 10.5, 10.6, 10.7, 12.7_

  - [ ]* 7.2 Property test for subscription state machine soundness
    - **Property 4: Subscription State Machine Soundness** — for every `(currentStatus, event)` in the cross product, `transition` returns either a defined next status or a typed `IllegalTransition` error; no transition is silently dropped.
    - Also assert: every successful transition writes exactly one `SubscriptionLog` row when run through `subscriptionService.applyTransition`.
    - File: `src/services/__tests__/subscriptionStateMachine.test.ts`.
    - **Validates: Requirements 10.2, 10.4, 10.5, 10.6, 10.7, 12.7 (CP-4)**

  - [~] 7.3 Implement Subscription service with logged transitions
    - Create `src/services/subscription/subscriptionService.ts` exposing `getStatus(tenantId)`, `startTrial(tenantId, planSlug)`, `applyTransition(tenantId, event, actor, metadata?)`, `cancel(tenantId, actor)`, `overrideLimits(tenantId, overrides, actor)`.
    - `applyTransition` calls the pure state machine, performs the DB update inside a transaction, writes a `SubscriptionLog` row with `fromStatus`, `toStatus`, `reason`, `actor` (`system | super_admin:<id> | tenant:<id>`), and on `period_end_reached → overdue` sets `gracePeriodEndsAt = currentPeriodEnd + 3 days`.
    - On `payment_success` from `active` it advances `currentPeriodStart`/`currentPeriodEnd` by one billing cycle and clears `gracePeriodEndsAt`. On `tenant_cancel` it sets `cancelledAt` but defers the status flip until `currentPeriodEnd`.
    - _Requirements: 10.1, 10.3, 10.4, 10.5, 10.7, 12.7, 15.6_

  - [~] 7.4 Implement Suspension service
    - Create `src/services/subscription/suspensionService.ts` exposing `applySuspension(tenantId)` and `applyReactivation(tenantId)`.
    - On suspension: set `tenant.isActive = false`; do NOT delete or anonymize any tenant-scoped row. The Messenger webhook handler, content agent, follow-up sender, and any tenant-public read endpoint check `reasoningContext.subscription.isOperational` and refuse outbound work when false (returning 503 for storefront reads).
    - On reactivation: set `tenant.isActive = true`. Behavior must resume within 5 minutes (the cache TTL), without restart. Dispatch the reactivation notification through `notificationDispatcher`.
    - _Requirements: 12.4, 12.5, 12.6_

  - [ ]* 7.5 Property test for suspension preserves data
    - **Property 6: Suspension Preserves Data** — for any `tenantId`, `rowCount(table, tenantId)` after suspension equals `rowCount(table, tenantId)` before suspension for every tenant-scoped table. Only `tenant.isActive` and feature toggles change.
    - File: `src/services/__tests__/suspensionPreservesData.test.ts`. Stub Prisma to return seeded counts.
    - **Validates: Requirements 12.5 (CP-6)**

  - [~] 7.6 Implement Grace Period service and Billing Scheduler
    - Create `src/services/subscription/gracePeriodService.ts` exposing `runDay0(subscriptionId)`, `runDay1(...)`, `runDay2(...)`, `runDay3(...)`. Each call writes a `GracePeriodTracking` row (unique on `subscriptionId, day, channel`) so re-firing the cron never double-sends warnings.
    - Day 0 (T+0h after entering `overdue`): first warning. Day 1 (T+24h): second. Day 2 (T+48h): final. Day 3 (T+72h, `gracePeriodEndsAt`): call `subscriptionService.applyTransition('grace_period_end_reached')` then `suspensionService.applySuspension`.
    - Create `src/services/subscription/billingScheduler.ts` using existing `node-cron`. Hourly tick: find `status=active` with `currentPeriodEnd <= now` and no successful payment → transition to `overdue`; find `status=overdue` rows that need a Day 1/2/3 run; find `currentPeriodEnd <= now` AND last payment success → transition to `active` (period advanced) and reset usage counters via `planLimitService.resetUsageCounters`.
    - _Requirements: 10.5, 10.6, 12.1, 12.2, 12.3, 12.4, 15.5_

- [ ] 8. Implement SSLCommerz subscription adapter and invoice service
  - [~] 8.1 Implement SSLCommerz initiate-session and webhook handler
    - Create `src/services/billing/sslcommerzSubscriptionAdapter.ts` exposing `initiateSubscriptionPayment(invoiceId)` and `handleWebhook(rawBody, headers)`.
    - `initiateSubscriptionPayment` creates a `PaymentTransaction` row with `status='pending'`, stores `sslcommerzTranId` and `sslcommerzSessionKey`, returns the redirect URL.
    - `handleWebhook` validates SSLCommerz signature against the store secret. On signature failure: respond 400, log `payment_webhook_signature_invalid`. On unmatched `tranId`: respond 200, log `payment_webhook_unmatched`. On already-terminal transaction: respond 200 (idempotent). On success: mark transaction `success`, mark linked `Invoice` `paid`, store invoice PDF reference, call `subscriptionService.applyTransition(tenantId, 'payment_success', 'system')`, generate invoice PDF via the extended `invoicePdfService`, dispatch `payment.success` via notification dispatcher with channels `[dashboard, email, telegram]`. On failure: mark transaction `failed`, write `PaymentFailure` row, do NOT change `Subscription.status`.
    - Mount route at `POST /api/v1/billing/sslcommerz/webhook` reading raw body for signature validation. Add `SSLCOMMERZ_SUBSCRIPTION_STORE_ID` and `SSLCOMMERZ_SUBSCRIPTION_STORE_SECRET` env variables.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 14.2_

  - [-] 8.2 Extend invoice PDF service for subscription invoices
    - Extend `src/services/invoicePdfService.ts` (or wrap it via `src/services/billing/invoiceService.ts`) so it can render a subscription invoice from an `Invoice` row, persist the PDF path, and return the path. Reuse the existing PDF generation; do not introduce new physical columns.
    - Trigger PDF generation on every `Subscription` transition to `active` after a successful payment.
    - _Requirements: 11.4, 14.6_

  - [ ]* 8.3 Property test for webhook idempotency
    - **Property 5: Webhook Idempotency** — for any sequence `[w, w]` of identical SSLCommerz webhook deliveries with the same `tranId`, the database state after the second delivery equals the state after the first. Unmatched `tranId` returns 200. Invalid signature returns 400 without state change.
    - File: `src/services/__tests__/sslcommerzWebhookIdempotency.test.ts`. Stub Prisma; assert no extra `SubscriptionLog` rows on replay.
    - **Validates: Requirements 11.2, 11.5, 11.6 (CP-5)**

- [ ] 9. Build Notification Dispatcher and channel adapters
  - [x] 9.1 Define `NotificationChannelAdapter` interface and dispatcher
    - Create `src/services/notifications/types.ts` exporting the `NotificationChannelAdapter` interface from the design.
    - Create `src/services/notifications/dispatcher.ts` exposing `dispatch({ tenantId, channels, type, payload })`. Per channel, write a `Notification` row with `status='queued'`, then invoke the adapter, updating `status` to `delivered | failed`. Persist `attempts`, `sentAt`, `readAt`.
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [-] 9.2 Implement dashboard, email, telegram channel adapters
    - `src/services/notifications/adapters/dashboardChannel.ts` — marks the persisted `Notification` row `delivered`. Used by the dashboard notification center sorted by `createdAt` desc.
    - `src/services/notifications/adapters/emailChannel.ts` — calls existing email transport. On failure, retries 3 times with exponential backoff (1s, 4s, 16s). After final failure, mark row `failed`.
    - `src/services/notifications/adapters/telegramChannel.ts` — wraps `src/services/telegramService.ts` for `sendTelegramMessage` and `sendTelegramDocument`. Preserve the existing Confirm/Reject inline-button behavior and invoice-PDF document delivery.
    - _Requirements: 13.1, 13.4, 13.5, 13.6, 22.8_

  - [-] 9.3 Stub WhatsApp and Facebook adapters and hide their toggles
    - `src/services/notifications/adapters/whatsappChannel.ts` and `facebookChannel.ts` return `{ ok: false, reason: 'not_implemented' }`.
    - The dashboard MUST NOT expose feature toggles for these channels until concrete adapters exist (driven by `featureFlagService`).
    - _Requirements: 13.2, 21.1, 21.4_

  - [ ]* 9.4 Unit tests for dispatcher fan-out and email retry
    - Cover multi-channel fan-out, email backoff (1s, 4s, 16s, then `failed`), Telegram inline-button preservation, persistent `Notification` row updates per channel.
    - File: `src/services/__tests__/notificationDispatcher.test.ts`.
    - _Requirements: 13.1, 13.5, 13.6_

- [~] 10. Checkpoint - billing and notification plane
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Build Onboarding service and Next.js wizard
  - [~] 11.1 Implement Onboarding service with resumable state
    - Create `src/services/onboarding/onboardingService.ts` exposing `getState(tenantId)`, `recordStep(tenantId, step, payload)`, `finalize(tenantId, finalPayload)`.
    - Persist progress on `tenant.onboardingState = { lastCompletedStep, payload }` JSON. Resumption reads this JSON and routes the wizard to the next step.
    - `finalize` runs in a single transaction: set `tenant.businessCategory`, `tenant.businessSubcategory`, `tenant.dashboardTemplate`. For predefined categories link `tenant.categorySchemaId` to the built-in row; for `custom`, clone the closest built-in into a new `CategorySchema` row with `tenantId` set and apply the user's edits. Then call `subscriptionService.startTrial(tenantId, planSlug)` (default 14 days). Finally set `tenant.onboardingCompletedAt = now`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 10.3_

  - [~] 11.2 Build Next.js onboarding wizard pages
    - Create `client/src/app/onboarding/page.tsx` (entry router) and step pages under `client/src/app/onboarding/steps/`: `welcome.tsx`, `category.tsx`, `custom.tsx`, `preferences.tsx`, `finalize.tsx`.
    - Add `client/src/middleware.ts` (or extend if present) to redirect to `/onboarding` when authenticated and `tenant.onboardingCompletedAt` is null.
    - The Welcome step displays the tenant's business name and the configured `AgentIdentity` defaults. Category_Selection lists all 14 categories from R1.3 including `custom`. Schema_Preferences renders the chosen category's default attributes and lets the operator enable, disable, rename, or add fields. Custom step accepts a free-text category name, optional subcategory, and a starting template choice.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [ ]* 11.3 Property test for onboarding resumability
    - **Property 9: Onboarding Resumability** — for any sequence of completed steps `[s1, ..., sk]` where `sk < finalize`, on next login the wizard resumes at step `sk+1` with all prior payloads intact.
    - Drive `onboardingService.recordStep` with random sequences (excluding `finalize`); assert the persisted `onboardingState` and the resumption point.
    - File: `src/services/__tests__/onboardingResumability.test.ts`.
    - **Validates: Requirements 1.7 (CP-9)**

- [ ] 12. Build Admin Super Control Panel
  - [~] 12.1 Implement Super_Admin auth distinct from TenantSession
    - Create `src/services/admin/superAdminAuth.ts` with `requireSuperAdmin` middleware reading `SuperAdminSession` rows (mirrors `TenantSession` shape, no `tenantId`). Hash passwords with `bcryptjs`.
    - Add a bootstrap step that creates the first `SuperAdmin` row from `SUPER_ADMIN_BOOTSTRAP_EMAIL` if absent.
    - Every super-admin tenant operation MUST require an explicit `tenantId` parameter and MUST log access in `SubscriptionLog` (or the parallel audit trail for non-subscription actions).
    - _Requirements: 6.5, 20.7, 23.5_

  - [~] 12.2 Implement Admin panel service and routes
    - Create `src/services/admin/adminPanelService.ts` and mount routes under `/api/v1/admin/*`, gated by `requireSuperAdmin`:
      - `GET /admin/tenants` (id, name, businessCategory, planId, subscriptionStatus, currentPeriodEnd, lastPaymentStatus)
      - `GET /admin/tenants/:id` (full detail)
      - `POST /admin/subscriptions/:id/suspend|reactivate|cancel` (each writes `SubscriptionLog` with `actor='super_admin:<id>'`; reactivate writes `manual_reactivation` reason)
      - `POST /admin/subscriptions/:id/override-limits` (writes `planLimitOverrides`, logs the override)
      - `GET /admin/payments` (joins `PaymentTransaction` + `PaymentFailure`, filterable by tenant/gateway/date)
      - `GET /admin/usage/:tenantId` (current period usage vs limits)
      - `GET /admin/categories`, `POST /admin/categories`, `PATCH /admin/categories/:id`
      - `POST /admin/tenants/:id/category` (assign schema)
    - _Requirements: 15.6, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6_

  - [~] 12.3 Build Next.js admin views and preserve legacy admin UI
    - Add new pages under `client/src/app/admin/` for Tenants list, Subscription detail, Payments, Suspended Stores, Usage, and Category Schema management. Each view consumes the routes from 12.2.
    - Extend the legacy admin UI at `localhost:4000/admin` so existing pages render a category banner indicating which schema is active. Do NOT remove or rename existing legacy pages or endpoints — both UIs MUST remain operational.
    - _Requirements: 4.4, 17.4, 20.1..20.6, 23.6_

- [ ] 13. Build Dynamic Form Builder and Dashboard Module Registry
  - [~] 13.1 Implement Dynamic Form Builder components
    - Create `client/src/components/forms/DynamicForm.tsx` and `DynamicField.tsx`. Render product forms from `categorySchema.attributes`, variant forms from `variantAttributes`, order forms from `orderAttributes`, filters from `filterAttributes`.
    - Support field types `string`, `number`, `boolean`, `enum`, `multi_enum`, `date`, `currency`, `image_ref`. Render a required indicator when `required=true` and propagate the constraint to the backend submission (validated by `categoryEngine.validateProductAttributes` / `validateOrderAttributes`).
    - When `customerVisible=true`, mark the field so the AI reply includes the value translated through `categorySchema.terminology`.
    - Provide both Next admin UI integration and a legacy admin UI bridge (minimal vanilla wrapper invoked from `localhost:4000/admin`). Schema changes MUST take effect on the next page load.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [~] 13.2 Implement Dashboard Module Registry and built-in modules
    - Create `client/src/components/dashboard/ModuleRegistry.ts` mapping `moduleId → React component`.
    - Implement universal modules (`product_grid`, `orders_table`, `conversations_panel`, `analytics_panel`) plus category-specific modules: `size_chart`, `team_filter`, `player_filter` (jersey); `menu_manager`, `delivery_zones`, `food_variants` (restaurant); `shade_selector`, `skin_type_filter`, `ingredients_panel` (cosmetics); `shoe_size_chart`, `gender_filter` (shoes).
    - The dashboard renders modules listed in `categorySchema.dashboardModules` in declared order. When a moduleId is not registered, skip and emit a `dashboard_module_missing` warning tagged with `tenantId, moduleId`.
    - When the resolved `featureFlag` for a module is `false`, hide it and replace with an upgrade prompt linking to the plan management page.
    - The same module set MUST render on `localhost:3000/admin` and `dashboard.pipwarp.com`.
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 16.3_

  - [ ]* 13.3 Unit tests for module registry skip-and-warn behavior and upgrade prompts
    - File: `client/src/components/dashboard/__tests__/moduleRegistry.test.ts` (or co-located).
    - _Requirements: 4.3, 4.5_

- [x] 14. Implement future-ready adapter interfaces
  - [x] 14.1 Define MessagingChannel, Marketplace, and MediaGeneration adapter interfaces
    - Create `src/services/messaging/messagingChannelAdapter.ts`, `src/services/marketplace/marketplaceAdapter.ts`, and `src/services/media/mediaGenerationAdapter.ts` matching the design signatures.
    - Wrap the existing Facebook Messenger pipeline as a concrete `MessagingChannelAdapter` named `messenger` so a future `whatsapp` or `voice` adapter can be added side-by-side without touching the agent loop.
    - _Requirements: 21.1, 21.2, 21.3, 21.4_

- [ ] 15. Demo-tenant migration and bootstrap
  - [~] 15.1 Author idempotent bootstrap migration script
    - Create `src/scripts/bootstrapCommerceOs.ts` executable via `npx tsx`. The script MUST be idempotent — running twice produces the same end state.
    - Steps: (a) seed all built-in `CategorySchema` rows from the JSON files in `src/agent/categoryEngine/schemas/`; (b) seed default `Plan` rows via `planService.seedDefaultPlans()`; (c) for the demo tenant `cmooz62gy0000v5gclycwq78p` and Facebook page `659418713929142`, set `businessCategory='jersey'`, `categorySchemaId` to the built-in jersey row, `dashboardTemplate='jersey'`, `onboardingCompletedAt = migrationTimestamp`; (d) backfill `ProductMapping.metadata.attributes` from the legacy jersey columns where present, leaving the originals intact for read fallback; (e) seed a `Subscription` row for the demo tenant with `status='active'`, `currentPeriodEnd = now + 1y`, `planId = pro` so the demo stays operational; (f) bootstrap a `SuperAdmin` row from `SUPER_ADMIN_BOOTSTRAP_EMAIL` if absent.
    - The script MUST NOT delete or rename any existing data and MUST preserve the page binding, payment integrations, courier integrations, Telegram alerts, vision pipeline, handoff policy (48h grace + 10h mute), and reply filter overrides.
    - _Requirements: 1.8, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8, 22.9, 22.10_

  - [ ]* 15.2 Integration test: demo tenant survives bootstrap unchanged
    - Snapshot the demo tenant's product, order, conversation, and persona row counts before running `bootstrapCommerceOs.ts`. Run the script. Assert counts and key fields are unchanged; the new schema linkage is in place; Telegram alert path still resolves; the 48h/10h handoff thresholds are preserved.
    - File: `src/__tests__/bootstrapCommerceOs.integration.test.ts` following the tsx-runnable IIFE pattern.
    - _Requirements: 22.1..22.10_

- [~] 16. Final integration checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Core implementation tasks have no `*` and MUST be completed.
- Each task references specific Requirements clauses (R1.1–R23.10) for traceability and cites the relevant Correctness Property (CP-1..CP-10) where applicable.
- Property-based tests (tasks 2.4, 2.5, 3.4, 3.5, 4.3, 6.4, 6.5, 7.2, 7.5, 8.3, 11.3) cover all ten correctness properties from the design. Each is a tsx-runnable IIFE under `src/agent/__tests__` or `src/services/__tests__`, uses `installStubs`/`restoreStubs`, installs an axios stub before importing `loop.ts`, and exercises Messenger paths with `psid: "SIM_..."`.
- Schema changes are applied via `prisma db push` only; no files in `prisma/migrations/`. The OneDrive `EPERM` workaround is `Stop-Process -Name node -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; npx prisma generate`.
- Universal storage columns (`sslcommerzTranId`, `sslcommerzSessionKey`, `pathaoConsignmentId`, `pathaoMerchantOrderId`) are reused across all gateways and couriers — no gateway- or courier-specific physical columns are added.
- Both admin UIs stay operational throughout: legacy `localhost:4000/admin` (vanilla JS, gains a category banner) and Next.js `localhost:3000/admin` plus `dashboard.pipwarp.com`.
- All new code lives in place under `src/agent/`, `src/services/`, `client/src/`. No `src/agent2/`. Password hashing stays on `bcryptjs`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "6.1", "9.1", "14.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "6.2", "6.3", "7.1", "8.2", "9.2", "9.3"] },
    { "id": 3, "tasks": ["2.4", "2.5", "3.1", "6.4", "6.5", "7.2", "7.3", "9.4"] },
    { "id": 4, "tasks": ["3.2", "7.4", "7.6", "8.1", "11.1", "12.1"] },
    { "id": 5, "tasks": ["3.3", "7.5", "8.3", "11.2", "12.2"] },
    { "id": 6, "tasks": ["3.4", "3.5", "4.1", "4.2", "11.3", "12.3", "13.1", "13.2"] },
    { "id": 7, "tasks": ["4.3", "13.3", "15.1"] },
    { "id": 8, "tasks": ["15.2"] }
  ]
}
```
