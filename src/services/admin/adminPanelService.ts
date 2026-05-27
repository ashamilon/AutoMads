/**
 * Admin Super Control Panel service (Multi-Tenant Commerce OS, task 12.2).
 *
 * Thin orchestration layer over the already-built planes:
 *   - Subscription plane: `subscriptionService` for state transitions and
 *     overrides; `suspensionService` for the `tenant.isActive` toggle that
 *     gates outbound surfaces (R10, R12, R20.2, R20.4).
 *   - Plan plane: `planLimitService` (`resolve`, `parseUsageCounters`) for
 *     the usage-vs-limits view (R20.5).
 *   - Category plane: `categoryEngine.invalidateSchemaCache` to fan out the
 *     `pg_notify('category_schema_invalidate', tenantId)` that lets peer
 *     processes drop the old schema within the 30 s propagation window
 *     (R2.6, R20.6).
 *
 * Audit (R20.2, R20.4, R15.6):
 *   - Every subscription-touching action threads `actor='super_admin:<id>'`
 *     down through `subscriptionService` so the SubscriptionLog row is
 *     written inside the same transaction as the status change.
 *   - For schema-management actions tied to a tenant clone we additionally
 *     write a SubscriptionLog row with `reason='audit:<action>'` and
 *     `fromStatus=toStatus=<current>` so the audit trail is complete even
 *     when the action did not change subscription state. Built-in template
 *     CRUD has no tenant scope, so it is recorded via the application
 *     logger only.
 *
 * Tenant-scope discipline (R6.5, R20.7):
 *   - Every function that mutates tenant data takes an explicit `tenantId`
 *     argument. The HTTP layer (`adminPanelRoutes.ts`) is responsible for
 *     extracting it from the URL or body and passing it through.
 *   - The auth middleware (`requireSuperAdmin`) populates `req.superAdmin`;
 *     the route handlers thread `req.superAdmin.superAdminId` into every
 *     call below as part of the actor string.
 *
 * Maps to: R6.5, R15.6, R20.1, R20.2, R20.3, R20.4, R20.5, R20.6, R20.7.
 */

import { Prisma, type CategorySchema as PrismaCategorySchema } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import * as categoryEngine from "../../agent/categoryEngine/index.js";
import * as subscriptionService from "../subscription/subscriptionService.js";
import * as suspensionService from "../subscription/suspensionService.js";
import {
  parseUsageCounters,
  resolve as resolvePlanLimits,
  type ResolvedPlanLimits,
  type UsageCounterKey,
} from "../plan/planLimitService.js";

// ─── Shared types ─────────────────────────────────────────────────────────

/** Identifier used to thread the `actor` field through SubscriptionLog. */
export type SuperAdminActor = `super_admin:${string}`;

function actorFor(superAdminId: string): SuperAdminActor {
  return `super_admin:${superAdminId}`;
}

// ─── listTenants ──────────────────────────────────────────────────────────

export interface AdminTenantSummary {
  tenantId: string;
  name: string;
  businessCategory: string | null;
  planId: string | null;
  planSlug: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  lastPaymentStatus: string | null;
}

/**
 * List every tenant in the platform with the headline subscription fields
 * the Admin_Panel needs to render the dashboard table (R20.1).
 *
 * Implementation note: we read tenants with their subscription + plan in
 * one round-trip and a second small query for the most recent
 * PaymentTransaction per tenant. Doing the latter as a window function in
 * raw SQL would be slightly faster but materially harder to reason about
 * — at the platform tenant counts we expect (hundreds, not millions) the
 * straight Prisma path is the right tradeoff.
 */
export async function listTenants(): Promise<AdminTenantSummary[]> {
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      businessCategory: true,
      subscription: {
        select: {
          status: true,
          currentPeriodEnd: true,
          planId: true,
          plan: { select: { slug: true } },
        },
      },
    },
  });

  if (tenants.length === 0) return [];

  // Most-recent PaymentTransaction.status per tenant. Done as one query
  // returning the latest row per tenant via groupBy + max(createdAt) so we
  // don't fan out N queries.
  const tenantIds = tenants.map((t) => t.id);
  const latestTxnByTenant = new Map<string, string>();
  if (tenantIds.length > 0) {
    const grouped = await prisma.paymentTransaction.groupBy({
      by: ["tenantId"],
      where: { tenantId: { in: tenantIds } },
      _max: { createdAt: true },
    });
    // Then load the matching rows by (tenantId, createdAt). Using `in` over
    // tuples isn't supported by Prisma, so a parallel `findFirst` per tenant
    // with a non-empty group is simplest and stays bounded by
    // `tenants.length`.
    await Promise.all(
      grouped.map(async (g) => {
        if (!g._max.createdAt) return;
        const row = await prisma.paymentTransaction.findFirst({
          where: { tenantId: g.tenantId, createdAt: g._max.createdAt },
          select: { status: true },
        });
        if (row) latestTxnByTenant.set(g.tenantId, row.status);
      }),
    );
  }

  return tenants.map<AdminTenantSummary>((t) => ({
    tenantId: t.id,
    name: t.name,
    businessCategory: t.businessCategory ?? null,
    planId: t.subscription?.planId ?? null,
    planSlug: t.subscription?.plan?.slug ?? null,
    subscriptionStatus: t.subscription?.status ?? null,
    currentPeriodEnd: t.subscription?.currentPeriodEnd ?? null,
    lastPaymentStatus: latestTxnByTenant.get(t.id) ?? null,
  }));
}

// ─── getTenantDetail ──────────────────────────────────────────────────────

export interface AdminTenantDetail {
  tenant: {
    id: string;
    name: string;
    isActive: boolean;
    businessCategory: string | null;
    businessSubcategory: string | null;
    categorySchemaId: string | null;
    dashboardTemplate: string | null;
    onboardingCompletedAt: Date | null;
    createdAt: Date;
  };
  subscription: {
    id: string;
    status: string;
    planId: string;
    planSlug: string | null;
    billingCycle: string;
    trialEndsAt: Date | null;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    gracePeriodEndsAt: Date | null;
    cancelledAt: Date | null;
    nextBillingAt: Date | null;
    usageCounters: Record<UsageCounterKey, number>;
    planLimitOverrides: Record<string, unknown> | null;
  } | null;
  planLimits: ResolvedPlanLimits;
  recentLogs: Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string;
    actor: string;
    metadata: unknown;
    createdAt: Date;
  }>;
}

/**
 * Detailed view used by the Tenants/:id Admin_Panel page (R20.1).
 *
 * Includes:
 *   - the tenant row,
 *   - its subscription joined with its Plan,
 *   - the resolved Plan_Limits + overrides via `planLimitService.resolve`
 *     so the UI can show both layers,
 *   - the 25 most recent SubscriptionLog rows for the audit trail.
 */
export async function getTenantDetail(
  tenantId: string,
): Promise<AdminTenantDetail | null> {
  if (!tenantId) return null;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      isActive: true,
      businessCategory: true,
      businessSubcategory: true,
      categorySchemaId: true,
      dashboardTemplate: true,
      onboardingCompletedAt: true,
      createdAt: true,
      subscription: {
        select: {
          id: true,
          status: true,
          planId: true,
          billingCycle: true,
          trialEndsAt: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          gracePeriodEndsAt: true,
          cancelledAt: true,
          nextBillingAt: true,
          usageCounters: true,
          planLimitOverrides: true,
          plan: { select: { slug: true } },
        },
      },
    },
  });
  if (!tenant) return null;

  const recentLogs = await prisma.subscriptionLog.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  const planLimits = await resolvePlanLimits(tenantId);

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      isActive: tenant.isActive,
      businessCategory: tenant.businessCategory ?? null,
      businessSubcategory: tenant.businessSubcategory ?? null,
      categorySchemaId: tenant.categorySchemaId ?? null,
      dashboardTemplate: tenant.dashboardTemplate ?? null,
      onboardingCompletedAt: tenant.onboardingCompletedAt ?? null,
      createdAt: tenant.createdAt,
    },
    subscription: tenant.subscription
      ? {
          id: tenant.subscription.id,
          status: tenant.subscription.status,
          planId: tenant.subscription.planId,
          planSlug: tenant.subscription.plan?.slug ?? null,
          billingCycle: tenant.subscription.billingCycle,
          trialEndsAt: tenant.subscription.trialEndsAt ?? null,
          currentPeriodStart: tenant.subscription.currentPeriodStart,
          currentPeriodEnd: tenant.subscription.currentPeriodEnd,
          gracePeriodEndsAt: tenant.subscription.gracePeriodEndsAt ?? null,
          cancelledAt: tenant.subscription.cancelledAt ?? null,
          nextBillingAt: tenant.subscription.nextBillingAt ?? null,
          usageCounters: parseUsageCounters(tenant.subscription.usageCounters),
          planLimitOverrides: asJsonObject(tenant.subscription.planLimitOverrides),
        }
      : null,
    planLimits,
    recentLogs: recentLogs.map((l) => ({
      id: l.id,
      fromStatus: l.fromStatus ?? null,
      toStatus: l.toStatus,
      reason: l.reason,
      actor: l.actor,
      metadata: l.metadata,
      createdAt: l.createdAt,
    })),
  };
}

// ─── suspendTenant / reactivateTenant / cancelTenantSubscription ──────────

/**
 * Force-suspend a tenant (R20.2, R20.4, R12.4).
 *
 * Sequence:
 *  1. `subscriptionService.applyTransition` with `super_admin_force_suspend`
 *     — flips `Subscription.status` to `'suspended'` and writes the audit
 *     row. The user-supplied `reason` is captured in the log's metadata
 *     because the state-machine reason is fixed at
 *     `'super_admin_force_suspend'`.
 *  2. `suspensionService.applySuspension` — flips `tenant.isActive=false`
 *     so outbound surfaces refuse on the next cache miss (≤ 5 min, R12.6).
 *
 * The status flip is the authoritative protection; the `tenant.isActive`
 * flag is a mirror for the cached `ReasoningContext.subscription.isOperational`
 * predicate.
 */
export async function suspendTenant(
  tenantId: string,
  actorSuperAdminId: string,
  reason: string,
): Promise<void> {
  if (!tenantId) throw new Error("tenantId is required");
  if (!actorSuperAdminId) throw new Error("actorSuperAdminId is required");

  await subscriptionService.applyTransition(
    tenantId,
    "super_admin_force_suspend",
    actorFor(actorSuperAdminId),
    { adminReason: reason },
  );
  await suspensionService.applySuspension(tenantId);

  logger.info(
    {
      event: "admin_tenant_suspended",
      tenantId,
      actorSuperAdminId,
      reason,
    },
    "admin_tenant_suspended",
  );
}

/**
 * Reactivate a suspended tenant (R20.4, R12.6).
 *
 * Sequence:
 *  1. `subscriptionService.applyTransition` with `super_admin_reactivate`
 *     — the state machine returns `reason='manual_reactivation'`, which
 *     is exactly what R20.4 requires the audit trail to carry.
 *  2. `suspensionService.applyReactivation` — flips `tenant.isActive=true`
 *     and dispatches the reactivation notification.
 *
 * The user-supplied `reason` is captured in the log's metadata so an
 * operator can later see why a manual reactivation happened.
 */
export async function reactivateTenant(
  tenantId: string,
  actorSuperAdminId: string,
  reason: string,
): Promise<void> {
  if (!tenantId) throw new Error("tenantId is required");
  if (!actorSuperAdminId) throw new Error("actorSuperAdminId is required");

  await subscriptionService.applyTransition(
    tenantId,
    "super_admin_reactivate",
    actorFor(actorSuperAdminId),
    { adminReason: reason },
  );
  await suspensionService.applyReactivation(tenantId);

  logger.info(
    {
      event: "admin_tenant_reactivated",
      tenantId,
      actorSuperAdminId,
      reason,
    },
    "admin_tenant_reactivated",
  );
}

/**
 * Cancel a tenant's subscription on behalf of the operator (R20.2). Routes
 * through `subscriptionService.cancel` which itself defers to
 * `applyTransition('tenant_cancel')`. The actor recorded on the
 * SubscriptionLog row is `super_admin:<id>` so manual cancellations are
 * distinguishable from tenant-initiated ones.
 *
 * Note: `tenant_cancel` from `active` is a deferred cancel — `status`
 * stays `active` until `currentPeriodEnd`; only `cancelledAt` is set.
 */
export async function cancelTenantSubscription(
  tenantId: string,
  actorSuperAdminId: string,
): Promise<void> {
  if (!tenantId) throw new Error("tenantId is required");
  if (!actorSuperAdminId) throw new Error("actorSuperAdminId is required");

  await subscriptionService.cancel(tenantId, actorFor(actorSuperAdminId));

  logger.info(
    {
      event: "admin_tenant_subscription_cancelled",
      tenantId,
      actorSuperAdminId,
    },
    "admin_tenant_subscription_cancelled",
  );
}

// ─── overrideLimits ───────────────────────────────────────────────────────

/**
 * Apply per-tenant Plan_Limit overrides on `Subscription.planLimitOverrides`
 * (R15.6, R20.2). Routes through `subscriptionService.overrideLimits` which
 * persists the JSON and writes a SubscriptionLog row with
 * `reason='plan_limit_override'` and a diff in metadata.
 *
 * The override JSON is stored verbatim — lookup precedence is enforced in
 * `planLimitService` and `featureFlagService`, not here.
 */
export async function overrideLimits(
  tenantId: string,
  overrides: Record<string, unknown>,
  actorSuperAdminId: string,
): Promise<void> {
  if (!tenantId) throw new Error("tenantId is required");
  if (!actorSuperAdminId) throw new Error("actorSuperAdminId is required");
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("overrides must be an object");
  }

  await subscriptionService.overrideLimits(
    tenantId,
    overrides,
    actorFor(actorSuperAdminId),
  );

  logger.info(
    {
      event: "admin_tenant_limits_overridden",
      tenantId,
      actorSuperAdminId,
    },
    "admin_tenant_limits_overridden",
  );
}

// ─── listPayments ─────────────────────────────────────────────────────────

export interface AdminPaymentsFilter {
  tenantId?: string;
  gateway?: string;
  since?: Date;
  until?: Date;
}

export interface AdminPaymentRow {
  id: string;
  tenantId: string;
  invoiceId: string;
  gateway: string;
  amountBdt: string;
  status: string;
  sslcommerzTranId: string | null;
  sslcommerzSessionKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  failures: Array<{
    id: string;
    reason: string;
    createdAt: Date;
  }>;
}

/**
 * Payments dashboard data (R20.3). Returns PaymentTransaction rows joined
 * with their PaymentFailure children, filterable by tenant, gateway, and
 * date window. The shape is flat enough for the Admin_Panel to render
 * without further normalization.
 *
 * `amountBdt` is returned as a string because it's stored as
 * `Decimal(12, 2)` and JSON-serializing a Prisma Decimal directly
 * truncates precision.
 */
export async function listPayments(
  filter: AdminPaymentsFilter = {},
): Promise<AdminPaymentRow[]> {
  const where: Prisma.PaymentTransactionWhereInput = {};
  if (filter.tenantId) where.tenantId = filter.tenantId;
  if (filter.gateway) where.gateway = filter.gateway;
  if (filter.since || filter.until) {
    where.createdAt = {};
    if (filter.since) where.createdAt.gte = filter.since;
    if (filter.until) where.createdAt.lte = filter.until;
  }

  const txns = await prisma.paymentTransaction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      paymentFailures: {
        orderBy: { createdAt: "desc" },
        select: { id: true, reason: true, createdAt: true },
      },
    },
  });

  return txns.map<AdminPaymentRow>((t) => ({
    id: t.id,
    tenantId: t.tenantId,
    invoiceId: t.invoiceId,
    gateway: t.gateway,
    amountBdt: t.amountBdt.toString(),
    status: t.status,
    sslcommerzTranId: t.sslcommerzTranId ?? null,
    sslcommerzSessionKey: t.sslcommerzSessionKey ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    failures: t.paymentFailures.map((f) => ({
      id: f.id,
      reason: f.reason,
      createdAt: f.createdAt,
    })),
  }));
}

// ─── getUsage ─────────────────────────────────────────────────────────────

export interface AdminUsageReport {
  tenantId: string;
  usageCounters: Record<UsageCounterKey, number>;
  planLimits: ResolvedPlanLimits;
  overrides: Record<string, unknown> | null;
  /**
   * `current / max * 100` per limit key. `null` when the cap is `-1`
   * (unlimited). Snapshot-style limits (`maxProducts`, `maxSocialAccounts`)
   * are reported as `null` here because their `current` is not tracked on
   * `usageCounters` — the Admin_Panel queries the relevant table when it
   * needs that view.
   */
  percentageUsed: Record<string, number | null>;
}

/**
 * Per-tenant usage view (R20.5). Returns the counters from
 * `Subscription.usageCounters`, the resolved plan limits, the override
 * JSON (so the UI can highlight rows with custom caps), and the
 * percentage of cap consumed for each tracked counter.
 */
export async function getUsage(tenantId: string): Promise<AdminUsageReport> {
  if (!tenantId) throw new Error("tenantId is required");

  const sub = await prisma.subscription.findUnique({
    where: { tenantId },
    select: { usageCounters: true, planLimitOverrides: true },
  });

  const counters = parseUsageCounters(sub?.usageCounters);
  const planLimits = await resolvePlanLimits(tenantId);

  const counterToLimitKey: Record<UsageCounterKey, keyof ResolvedPlanLimits> = {
    messages: "maxMonthlyMessages",
    aiTokens: "maxAiTokensMonthly",
    posts: "maxPostingPerDay",
  };

  const percentageUsed: Record<string, number | null> = {};
  for (const counterKey of Object.keys(counters) as UsageCounterKey[]) {
    const limitKey = counterToLimitKey[counterKey];
    const max = planLimits[limitKey];
    const current = counters[counterKey];
    if (typeof max !== "number") {
      percentageUsed[limitKey] = null;
      continue;
    }
    if (max === -1) {
      percentageUsed[limitKey] = null;
      continue;
    }
    if (max === 0) {
      // Avoid divide-by-zero. Any non-zero usage when the cap is zero is
      // already over the cap; report 100% so the dashboard surfaces it.
      percentageUsed[limitKey] = current > 0 ? 100 : 0;
      continue;
    }
    percentageUsed[limitKey] = Math.round((current / max) * 1000) / 10;
  }

  return {
    tenantId,
    usageCounters: counters,
    planLimits,
    overrides: asJsonObject(sub?.planLimitOverrides),
    percentageUsed,
  };
}

// ─── Category schema management ───────────────────────────────────────────

/**
 * Public input shape for `createCategorySchema` / `updateCategorySchema`.
 * The runtime shape check below mirrors the JSON loader's `isCategorySchemaShape`
 * so a schema written through the Admin_Panel and a schema loaded from disk
 * obey the same contract.
 */
export interface CategorySchemaInput {
  slug: string;
  version?: number;
  attributes: unknown[];
  variantAttributes?: unknown[];
  orderAttributes?: unknown[];
  filterAttributes?: unknown[];
  terminology?: Record<string, string>;
  dashboardModules?: unknown[];
  workflowRules?: Record<string, unknown>;
  promptFragments?: unknown[];
  isBuiltIn?: boolean;
  tenantId?: string | null;
}

/**
 * List every CategorySchema row for the Admin_Panel schema management view
 * (R20.6). Built-ins are surfaced from disk via the engine; tenant-cloned
 * rows are read straight from Prisma.
 *
 * The shape returned is the Prisma row type rather than the engine's
 * runtime `CategorySchema` so the Admin_Panel can render `createdAt` /
 * `updatedAt` columns without an extra round-trip.
 */
export async function listCategorySchemas(): Promise<PrismaCategorySchema[]> {
  return prisma.categorySchema.findMany({
    orderBy: [{ isBuiltIn: "desc" }, { slug: "asc" }, { updatedAt: "desc" }],
  });
}

/**
 * Lightweight runtime shape check for incoming schema payloads. We accept
 * partial population — only `slug` and `attributes` are strictly required;
 * every other field defaults to a sensible empty value when omitted, so the
 * Admin_Panel can save a draft and refine it later.
 *
 * Returns the normalized payload on success, or throws with a stable
 * `Error('schema_invalid_<reason>')` so the route handler can map to a
 * 400 with a descriptive code.
 */
function normalizeSchemaInput(input: CategorySchemaInput): {
  slug: string;
  version: number;
  attributes: Prisma.InputJsonValue;
  variantAttributes: Prisma.InputJsonValue;
  orderAttributes: Prisma.InputJsonValue;
  filterAttributes: Prisma.InputJsonValue;
  terminology: Prisma.InputJsonValue;
  dashboardModules: Prisma.InputJsonValue;
  workflowRules: Prisma.InputJsonValue;
  promptFragments: Prisma.InputJsonValue;
  isBuiltIn: boolean;
  tenantId: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new Error("schema_invalid_payload");
  }
  if (typeof input.slug !== "string" || input.slug.length === 0) {
    throw new Error("schema_invalid_slug");
  }
  if (!Array.isArray(input.attributes)) {
    throw new Error("schema_invalid_attributes");
  }
  return {
    slug: input.slug,
    version: typeof input.version === "number" && input.version > 0 ? input.version : 1,
    attributes: input.attributes as unknown as Prisma.InputJsonValue,
    variantAttributes: (Array.isArray(input.variantAttributes)
      ? input.variantAttributes
      : []) as unknown as Prisma.InputJsonValue,
    orderAttributes: (Array.isArray(input.orderAttributes)
      ? input.orderAttributes
      : []) as unknown as Prisma.InputJsonValue,
    filterAttributes: (Array.isArray(input.filterAttributes)
      ? input.filterAttributes
      : []) as unknown as Prisma.InputJsonValue,
    terminology: (input.terminology && typeof input.terminology === "object"
      ? input.terminology
      : {}) as unknown as Prisma.InputJsonValue,
    dashboardModules: (Array.isArray(input.dashboardModules)
      ? input.dashboardModules
      : []) as unknown as Prisma.InputJsonValue,
    workflowRules: (input.workflowRules && typeof input.workflowRules === "object"
      ? input.workflowRules
      : {}) as unknown as Prisma.InputJsonValue,
    promptFragments: (Array.isArray(input.promptFragments)
      ? input.promptFragments
      : []) as unknown as Prisma.InputJsonValue,
    isBuiltIn: input.isBuiltIn === true,
    tenantId: typeof input.tenantId === "string" ? input.tenantId : null,
  };
}

/**
 * Create a CategorySchema row (R20.6). Used for both built-in templates
 * (`isBuiltIn=true, tenantId=null`) and tenant-cloned customizations
 * (`isBuiltIn=false, tenantId=<id>`).
 *
 * When the schema is tenant-scoped we additionally write a SubscriptionLog
 * row with `reason='audit:create_category_schema'` so the audit trail
 * captures the operator action against that tenant. Built-in template
 * creation is recorded via the application logger only because
 * SubscriptionLog requires a `tenantId`.
 */
export async function createCategorySchema(
  input: CategorySchemaInput,
  actorSuperAdminId: string,
): Promise<PrismaCategorySchema> {
  if (!actorSuperAdminId) throw new Error("actorSuperAdminId is required");
  const data = normalizeSchemaInput(input);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.categorySchema.create({ data });

    if (data.tenantId) {
      await writeAuditLog(
        tx,
        data.tenantId,
        actorFor(actorSuperAdminId),
        "audit:create_category_schema",
        { categorySchemaId: row.id, slug: data.slug },
      );
    }

    return row;
  });

  // Outside the transaction: punch the per-tenant cache for tenant clones
  // so the next AI turn sees the new schema without waiting for the 30 s
  // TTL or the LISTEN/NOTIFY round-trip. Best-effort.
  if (data.tenantId) {
    try {
      await categoryEngine.invalidateSchemaCache(data.tenantId);
    } catch (err) {
      logger.warn(
        {
          event: "admin_create_schema_invalidate_failed",
          tenantId: data.tenantId,
          err: serializeError(err),
        },
        "admin_create_schema_invalidate_failed",
      );
    }
  }

  logger.info(
    {
      event: "admin_category_schema_created",
      categorySchemaId: created.id,
      slug: created.slug,
      isBuiltIn: created.isBuiltIn,
      tenantId: created.tenantId ?? null,
      actorSuperAdminId,
    },
    "admin_category_schema_created",
  );

  return created;
}

/**
 * Update an existing CategorySchema row (R20.6). The `version` is bumped
 * automatically when the caller does not supply one so consumers that
 * cache by `(slug, version)` see fresh data.
 *
 * As with `createCategorySchema`, tenant-scoped updates additionally write
 * a SubscriptionLog row tagged `reason='audit:update_category_schema'`.
 */
export async function updateCategorySchema(
  id: string,
  input: Partial<CategorySchemaInput>,
  actorSuperAdminId: string,
): Promise<PrismaCategorySchema> {
  if (!id) throw new Error("id is required");
  if (!actorSuperAdminId) throw new Error("actorSuperAdminId is required");

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.categorySchema.findUnique({ where: { id } });
    if (!existing) throw new Error("schema_not_found");

    // Build the update payload from the partial input. Anything not
    // provided is preserved.
    const data: Prisma.CategorySchemaUpdateInput = {};
    if (typeof input.slug === "string" && input.slug.length > 0) {
      data.slug = input.slug;
    }
    if (typeof input.version === "number" && input.version > 0) {
      data.version = input.version;
    } else {
      data.version = existing.version + 1;
    }
    if (Array.isArray(input.attributes)) {
      data.attributes = input.attributes as unknown as Prisma.InputJsonValue;
    }
    if (Array.isArray(input.variantAttributes)) {
      data.variantAttributes =
        input.variantAttributes as unknown as Prisma.InputJsonValue;
    }
    if (Array.isArray(input.orderAttributes)) {
      data.orderAttributes =
        input.orderAttributes as unknown as Prisma.InputJsonValue;
    }
    if (Array.isArray(input.filterAttributes)) {
      data.filterAttributes =
        input.filterAttributes as unknown as Prisma.InputJsonValue;
    }
    if (input.terminology && typeof input.terminology === "object") {
      data.terminology = input.terminology as unknown as Prisma.InputJsonValue;
    }
    if (Array.isArray(input.dashboardModules)) {
      data.dashboardModules =
        input.dashboardModules as unknown as Prisma.InputJsonValue;
    }
    if (input.workflowRules && typeof input.workflowRules === "object") {
      data.workflowRules =
        input.workflowRules as unknown as Prisma.InputJsonValue;
    }
    if (Array.isArray(input.promptFragments)) {
      data.promptFragments =
        input.promptFragments as unknown as Prisma.InputJsonValue;
    }
    if (typeof input.isBuiltIn === "boolean") {
      data.isBuiltIn = input.isBuiltIn;
    }

    const row = await tx.categorySchema.update({ where: { id }, data });

    if (existing.tenantId) {
      await writeAuditLog(
        tx,
        existing.tenantId,
        actorFor(actorSuperAdminId),
        "audit:update_category_schema",
        { categorySchemaId: id, slug: row.slug, oldVersion: existing.version, newVersion: row.version },
      );
    }

    return row;
  });

  // Punch the cache for the affected tenant clone (or for every tenant
  // that pinned this id directly via tenant.categorySchemaId).
  await invalidateAllTenantsUsingSchema(updated.id);

  logger.info(
    {
      event: "admin_category_schema_updated",
      categorySchemaId: updated.id,
      slug: updated.slug,
      tenantId: updated.tenantId ?? null,
      actorSuperAdminId,
    },
    "admin_category_schema_updated",
  );

  return updated;
}

/**
 * Assign a CategorySchema to a tenant (R20.6).
 *
 * Steps:
 *  1. Verify both rows exist; refuse to assign a tenant-scoped schema
 *     belonging to a different tenant.
 *  2. Update `tenant.categorySchemaId` and `tenant.dashboardTemplate` so
 *     the Dashboard Module Registry picks up the new module list.
 *  3. Write a SubscriptionLog audit row.
 *  4. Punch the local Category Engine cache and emit
 *     `pg_notify('category_schema_invalidate', tenantId)` so peer
 *     processes evict their cached schema within the propagation window.
 */
export async function assignSchemaToTenant(
  tenantId: string,
  categorySchemaId: string,
  actorSuperAdminId: string,
): Promise<void> {
  if (!tenantId) throw new Error("tenantId is required");
  if (!categorySchemaId) throw new Error("categorySchemaId is required");
  if (!actorSuperAdminId) throw new Error("actorSuperAdminId is required");

  await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, categorySchemaId: true },
    });
    if (!tenant) throw new Error("tenant_not_found");

    const schema = await tx.categorySchema.findUnique({
      where: { id: categorySchemaId },
      select: { id: true, slug: true, isBuiltIn: true, tenantId: true },
    });
    if (!schema) throw new Error("schema_not_found");

    // A tenant-scoped clone may only be assigned to its owning tenant.
    // Built-in schemas (tenantId=null) can be assigned to any tenant.
    if (schema.tenantId && schema.tenantId !== tenantId) {
      throw new Error("schema_not_assignable_to_tenant");
    }

    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        categorySchemaId,
        dashboardTemplate: schema.slug,
      },
    });

    await writeAuditLog(
      tx,
      tenantId,
      actorFor(actorSuperAdminId),
      "audit:assign_category_schema",
      {
        categorySchemaId,
        slug: schema.slug,
        previousCategorySchemaId: tenant.categorySchemaId ?? null,
      },
    );
  });

  // Outside the transaction: punch the cache + fan out the NOTIFY.
  try {
    await categoryEngine.invalidateSchemaCache(tenantId);
  } catch (err) {
    logger.warn(
      {
        event: "admin_assign_schema_invalidate_failed",
        tenantId,
        err: serializeError(err),
      },
      "admin_assign_schema_invalidate_failed",
    );
  }

  logger.info(
    {
      event: "admin_category_schema_assigned",
      tenantId,
      categorySchemaId,
      actorSuperAdminId,
    },
    "admin_category_schema_assigned",
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Write a non-state-changing audit row to SubscriptionLog. Used for
 * schema-management actions that touch tenant data but don't move the
 * subscription state machine. Reuses the `fromStatus=toStatus` shape so
 * the audit trail is queryable alongside real state transitions.
 */
async function writeAuditLog(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actor: SuperAdminActor,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const sub = await tx.subscription.findUnique({
    where: { tenantId },
    select: { status: true },
  });
  const status = sub?.status ?? "unknown";
  await tx.subscriptionLog.create({
    data: {
      tenantId,
      fromStatus: status,
      toStatus: status,
      reason,
      actor,
      metadata: metadata as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Fan out cache invalidations for every tenant whose
 * `tenant.categorySchemaId` points at the supplied schema id. Best-effort
 * — failures are logged so a single unreachable LISTEN connection never
 * blocks the admin write.
 */
async function invalidateAllTenantsUsingSchema(
  categorySchemaId: string,
): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: { categorySchemaId },
    select: { id: true },
  });
  await Promise.all(
    tenants.map(async (t) => {
      try {
        await categoryEngine.invalidateSchemaCache(t.id);
      } catch (err) {
        logger.warn(
          {
            event: "admin_update_schema_invalidate_failed",
            tenantId: t.id,
            categorySchemaId,
            err: serializeError(err),
          },
          "admin_update_schema_invalidate_failed",
        );
      }
    }),
  );
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function serializeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
