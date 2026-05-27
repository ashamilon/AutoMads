/**
 * Subscription service — the single write surface for `Subscription` rows
 * and `SubscriptionLog` audit entries.
 *
 * The state machine is pure (`subscriptionStateMachine.ts`); this module
 * owns side effects: DB writes inside `prisma.$transaction`, advancing
 * billing periods on `payment_success`, setting `gracePeriodEndsAt` on
 * `period_end_reached`, deferring `tenant_cancel`, and recording every
 * transition in `SubscriptionLog` (R10.1, R10.3-R10.7, R12.7, R15.6).
 *
 * Callers MUST go through `applyTransition` rather than mutating
 * `Subscription.status` directly, otherwise the audit trail breaks.
 */

import { Prisma, type Subscription } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import {
  IllegalTransitionError,
  type SubscriptionEvent,
  type SubscriptionStatus,
  transition,
} from "./subscriptionStateMachine.js";

/**
 * Actor that triggered a transition. The shape is the same as the spec's
 * `actor` column on `SubscriptionLog`: `'system'` for cron-driven moves,
 * `super_admin:<id>` for Admin Panel actions, `tenant:<id>` for tenant
 * self-service. Stringly-typed to keep the column free-form.
 */
export type SubscriptionActor =
  | "system"
  | `super_admin:${string}`
  | `tenant:${string}`;

/** Default grace period after `period_end_reached` (R10.5). */
const GRACE_PERIOD_DAYS = 3;

/** Cycle-length lookup for advancing `currentPeriodStart`/`currentPeriodEnd`. */
const CYCLE_LENGTH_MS: Record<string, number> = {
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Advance a billing period anchor by one cycle. Months are computed in
 * calendar terms when the cycle is `monthly` so subscriptions stay aligned
 * to the same day-of-month; weekly/yearly fall back to fixed-ms math.
 */
function advancePeriod(start: Date, end: Date, billingCycle: string): {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  nextBillingAt: Date;
} {
  if (billingCycle === "monthly") {
    const nextStart = new Date(end);
    const nextEnd = new Date(end);
    nextEnd.setMonth(nextEnd.getMonth() + 1);
    return {
      currentPeriodStart: nextStart,
      currentPeriodEnd: nextEnd,
      nextBillingAt: nextEnd,
    };
  }

  const cycleMs = CYCLE_LENGTH_MS[billingCycle] ?? CYCLE_LENGTH_MS.monthly!;
  const nextStart = new Date(end.getTime());
  const nextEnd = new Date(end.getTime() + cycleMs);
  // Suppress "noUnused" lint for `start` — kept in signature for future
  // calendar-anchored cycles (e.g. quarterly with month-end snapping).
  void start;
  return {
    currentPeriodStart: nextStart,
    currentPeriodEnd: nextEnd,
    nextBillingAt: nextEnd,
  };
}

/**
 * Read the current `Subscription` row for a tenant. Returns `null` when no
 * subscription exists (e.g. before the onboarding wizard finalizes).
 *
 * R10.1: subscription rows are 1:1 with tenants via `tenantId @unique`.
 */
export async function getStatus(tenantId: string): Promise<Subscription | null> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }
  return prisma.subscription.findUnique({ where: { tenantId } });
}

/**
 * Create the initial `Subscription` row for a tenant when onboarding
 * finalizes. Idempotent: returns the existing row if one is already present.
 *
 * - `status='trial'`
 * - `trialEndsAt = now + plan.trialDays` (default 14 days, R10.3)
 * - `currentPeriodStart = now`, `currentPeriodEnd = trialEndsAt` so the
 *   billing scheduler can drive `period_end_reached` cleanly when the
 *   trial expires.
 *
 * Writes a `SubscriptionLog` row with `fromStatus=null`, `toStatus='trial'`,
 * `reason='onboarding_complete'` (R12.7).
 *
 * Accepts an optional `tx` interactive transaction client so callers
 * (e.g. the onboarding `finalize` flow) can sequence the trial creation
 * with their own writes inside a single `prisma.$transaction`. When `tx`
 * is omitted, a fresh transaction is opened internally.
 */
export async function startTrial(
  tenantId: string,
  planSlug: string,
  actor: SubscriptionActor = "system",
  tx?: Prisma.TransactionClient,
): Promise<Subscription> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  const client: Prisma.TransactionClient | typeof prisma = tx ?? prisma;

  const existing = await client.subscription.findUnique({
    where: { tenantId },
  });
  if (existing) {
    return existing;
  }

  const plan = await client.plan.findUnique({ where: { slug: planSlug } });
  if (!plan) {
    throw new Error(`Plan not found: ${planSlug}`);
  }

  const now = new Date();
  const trialDays = plan.trialDays > 0 ? plan.trialDays : 14;
  const trialEndsAt = addDays(now, trialDays);

  const runWrites = async (
    inner: Prisma.TransactionClient,
  ): Promise<Subscription> => {
    const created = await inner.subscription.create({
      data: {
        tenantId,
        planId: plan.id,
        status: "trial",
        trialEndsAt,
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
        billingCycle: plan.billingCycle,
        nextBillingAt: trialEndsAt,
      },
    });

    await inner.subscriptionLog.create({
      data: {
        tenantId,
        fromStatus: null,
        toStatus: "trial",
        reason: "onboarding_complete",
        actor,
        metadata: {
          planSlug: plan.slug,
          trialDays,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return created;
  };

  const subscription = tx
    ? await runWrites(tx)
    : await prisma.$transaction(runWrites);

  logger.info(
    {
      event: "subscription_trial_started",
      tenantId,
      planSlug: plan.slug,
      trialEndsAt: trialEndsAt.toISOString(),
    },
    "subscription_trial_started",
  );

  return subscription;
}

/**
 * Optional metadata persisted on the `SubscriptionLog` row written by
 * `applyTransition`. Use it to attach the triggering payment id, super-admin
 * note, or any other context the audit trail should carry.
 */
export type ApplyTransitionMetadata = Record<string, unknown>;

/**
 * Drive the subscription forward by one event.
 *
 * Steps (all inside a single `prisma.$transaction`):
 * 1. Re-read the row inside the txn so we operate on the latest status.
 * 2. Run the pure state machine. On `IllegalTransition` → throw.
 * 3. Compute side effects per event:
 *    - `period_end_reached → overdue`: set
 *      `gracePeriodEndsAt = currentPeriodEnd + 3 days` (R10.5).
 *    - `payment_success` from `active`: advance `currentPeriodStart` /
 *      `currentPeriodEnd` by one billing cycle, clear `gracePeriodEndsAt`,
 *      reset `usageCounters` to zero (R10.4, R15.5).
 *    - `payment_success` from `trial`/`overdue`/`suspended`: clear
 *      `gracePeriodEndsAt` and reset usage counters; period anchors are
 *      seeded by the billing scheduler when it advances on the next cycle.
 *    - `tenant_cancel` from `active`/`trial`: defer the status flip — keep
 *      `status='active'` (or `trial`), set `cancelledAt=now`. The pure
 *      state machine returns `status='active'` for `(active, tenant_cancel)`
 *      precisely so this branch is the only place that mutates `cancelledAt`.
 * 4. Write the `SubscriptionLog` row with `fromStatus`, `toStatus`,
 *    `reason`, `actor`, and optional `metadata` (R10.7, R12.7).
 *
 * The function returns the post-update `Subscription` row. Throws
 * `IllegalTransitionError` for undefined `(currentStatus, event)` pairs.
 */
export async function applyTransition(
  tenantId: string,
  event: SubscriptionEvent,
  actor: SubscriptionActor,
  metadata?: ApplyTransitionMetadata,
): Promise<Subscription> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  return prisma.$transaction(async (tx) => {
    return applyTransitionWithClient(tx, tenantId, event, actor, metadata);
  });
}

/**
 * Compose-friendly variant of `applyTransition` that runs against an existing
 * Prisma transaction client (e.g. the SSLCommerz webhook handler that needs
 * the `PaymentTransaction` + `Invoice` + `SubscriptionLog` writes to commit
 * atomically).
 *
 * Every state-mutation step is identical to `applyTransition` — the only
 * difference is that this function does NOT open a new transaction. Callers
 * are responsible for providing a `tx` client created by their own
 * `prisma.$transaction(...)` block.
 */
export async function applyTransitionWithClient(
  tx: Prisma.TransactionClient,
  tenantId: string,
  event: SubscriptionEvent,
  actor: SubscriptionActor,
  metadata?: ApplyTransitionMetadata,
): Promise<Subscription> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  const sub = await tx.subscription.findUnique({ where: { tenantId } });
  if (!sub) {
    throw new Error(`Subscription not found for tenant ${tenantId}`);
  }

  const fromStatus = sub.status as SubscriptionStatus;
  const result = transition(fromStatus, event);
  if (!result.ok) {
    throw new IllegalTransitionError(fromStatus, event);
  }

  const now = new Date();

  // Build the partial update based on the (fromStatus, event) pair. Status
  // alone comes from the pure machine; period anchors / grace dates / the
  // cancelledAt marker come from this side-effect layer.
  const update: Prisma.SubscriptionUpdateInput = {
    status: result.nextStatus,
  };

  let logReason = result.reason;
  const logMetadata: Record<string, unknown> = { ...(metadata ?? {}) };

  if (event === "period_end_reached" && result.nextStatus === "overdue") {
    // R10.5: gracePeriodEndsAt = currentPeriodEnd + 3 days.
    update.gracePeriodEndsAt = addDays(sub.currentPeriodEnd, GRACE_PERIOD_DAYS);
  }

  if (event === "payment_success") {
    // R10.4 / R15.5: clear grace, reset usage counters on every renewal.
    update.gracePeriodEndsAt = null;
    update.usageCounters = {
      messages: 0,
      aiTokens: 0,
      posts: 0,
    } as unknown as Prisma.InputJsonValue;

    if (fromStatus === "active") {
      // True renewal: advance the period anchors by one cycle.
      const next = advancePeriod(
        sub.currentPeriodStart,
        sub.currentPeriodEnd,
        sub.billingCycle,
      );
      update.currentPeriodStart = next.currentPeriodStart;
      update.currentPeriodEnd = next.currentPeriodEnd;
      update.nextBillingAt = next.nextBillingAt;
    }
  }

  if (event === "tenant_cancel" && fromStatus === "active") {
    // Deferred cancel — keep the row active until currentPeriodEnd. Only
    // cancelledAt changes here; the billing scheduler flips status to
    // 'cancelled' once currentPeriodEnd passes.
    update.cancelledAt = now;
    logReason = "tenant_cancel_deferred";
    logMetadata.effectiveAt = sub.currentPeriodEnd.toISOString();
  }

  if (event === "tenant_cancel" && fromStatus === "trial") {
    // Trial cancels flip immediately to `cancelled`; record the moment.
    update.cancelledAt = now;
  }

  const updated = await tx.subscription.update({
    where: { tenantId },
    data: update,
  });

  await tx.subscriptionLog.create({
    data: {
      tenantId,
      fromStatus,
      toStatus: result.nextStatus,
      reason: logReason,
      actor,
      metadata:
        Object.keys(logMetadata).length === 0
          ? undefined
          : (logMetadata as unknown as Prisma.InputJsonValue),
    },
  });

  logger.info(
    {
      event: "subscription_transition",
      tenantId,
      fromStatus,
      toStatus: result.nextStatus,
      reason: logReason,
      actor,
    },
    "subscription_transition",
  );

  return updated;
}

/**
 * Convenience wrapper for the tenant-initiated cancel path.
 *
 * Routes through `applyTransition('tenant_cancel', actor)`. The pure state
 * machine returns:
 *   - `(active, tenant_cancel)   -> active`    (deferred — cancelledAt set)
 *   - `(trial,  tenant_cancel)   -> cancelled`
 *   - `(overdue, tenant_cancel)  -> cancelled`
 *   - `(suspended, tenant_cancel)-> cancelled`
 */
export async function cancel(
  tenantId: string,
  actor: SubscriptionActor,
  metadata?: ApplyTransitionMetadata,
): Promise<Subscription> {
  return applyTransition(tenantId, "tenant_cancel", actor, metadata);
}

/**
 * Per-tenant Plan_Limit overrides for support cases (R15.6). Persists the
 * supplied JSON on `Subscription.planLimitOverrides`, replacing any prior
 * overrides, and writes a `SubscriptionLog` audit row with
 * `reason='plan_limit_override'` and the diff in `metadata`.
 *
 * The override JSON is stored verbatim. Lookup precedence (override → plan
 * → platform default) is enforced in `planLimitService` and
 * `featureFlagService`, not here.
 */
export async function overrideLimits(
  tenantId: string,
  overrides: Record<string, unknown>,
  actor: SubscriptionActor,
): Promise<Subscription> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.subscription.findUnique({
      where: { tenantId },
    });
    if (!existing) {
      throw new Error(`Subscription not found for tenant ${tenantId}`);
    }

    const updated = await tx.subscription.update({
      where: { tenantId },
      data: {
        planLimitOverrides: overrides as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.subscriptionLog.create({
      data: {
        tenantId,
        fromStatus: existing.status,
        toStatus: existing.status,
        reason: "plan_limit_override",
        actor,
        metadata: {
          previous: existing.planLimitOverrides ?? null,
          next: overrides,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info(
      {
        event: "subscription_plan_limit_override",
        tenantId,
        actor,
      },
      "subscription_plan_limit_override",
    );

    return updated;
  });
}
