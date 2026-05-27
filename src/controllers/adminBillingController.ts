/**
 * Legacy admin (`localhost:4000/admin`) billing endpoints.
 *
 * These mirror the platform-admin actions exposed under
 * `/api/v1/admin/...` (the Next.js Admin Super Control Panel) but are
 * mounted under the legacy `/admin/*` namespace + gated by
 * `requireAdminApiKey` so the operator can manage everything from the
 * vanilla-JS console at `localhost:4000/admin`.
 *
 * Routes (mounted by `routes/adminRoutes.ts`):
 *  - GET  /admin/plans                          → list all plans
 *  - PATCH /admin/plans/:planId                 → edit price + caps
 *  - GET  /admin/subscriptions                  → list subscriptions w/ tenant + plan
 *  - GET  /admin/subscriptions/:tenantId        → single subscription detail
 *  - POST /admin/subscriptions/:tenantId/suspend
 *  - POST /admin/subscriptions/:tenantId/reactivate
 *  - POST /admin/subscriptions/:tenantId/cancel
 *  - POST /admin/subscriptions/:tenantId/change-plan { planSlug }
 *  - POST /admin/subscriptions/:tenantId/override-limits { overrides }
 *  - GET  /admin/payments                       → payment transactions w/ filters
 *  - GET  /admin/usage/:tenantId                → usage vs plan limits
 *
 * Admin actor on every audit row is `super_admin:legacy-admin-key` so the
 * audit trail clearly distinguishes from real per-user super admins (the
 * static `ADMIN_API_KEY` is shared across operators by design).
 */

import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import {
  resolve as resolvePlanLimits,
  parseUsageCounters,
  type UsageCounterKey,
  type ResolvedPlanLimits,
} from "../services/plan/planLimitService.js";
import {
  applyTransition,
  cancel as cancelSubscription,
  overrideLimits as overrideLimitsSvc,
  type SubscriptionActor,
} from "../services/subscription/subscriptionService.js";
import { applySuspension, applyReactivation } from "../services/subscription/suspensionService.js";

const LEGACY_ACTOR: SubscriptionActor = "super_admin:legacy-admin-key";

// ─── Plans ───────────────────────────────────────────────────────────────

export async function listPlans(_req: Request, res: Response): Promise<void> {
  try {
    const plans = await prisma.plan.findMany({ orderBy: { priceBdt: "asc" } });
    res.json({
      plans: plans.map((p) => ({
        id: p.id,
        slug: p.slug,
        displayName: p.displayName,
        billingCycle: p.billingCycle,
        priceBdt: p.priceBdt.toString(),
        trialDays: p.trialDays,
        limits: p.limits,
        featureFlags: p.featureFlags,
        isActive: p.isActive,
      })),
    });
  } catch (err) {
    logger.error(
      { event: "admin_list_plans_failed", err: errMsg(err) },
      "admin_list_plans_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

export async function patchPlan(req: Request, res: Response): Promise<void> {
  const planId = String(req.params.planId ?? "");
  if (!planId) {
    res.status(400).json({ error: "plan_id_required" });
    return;
  }
  const body = req.body as {
    displayName?: string;
    priceBdt?: number | string;
    trialDays?: number;
    billingCycle?: string;
    limits?: Record<string, unknown>;
    featureFlags?: Record<string, unknown>;
    isActive?: boolean;
  };
  const data: Prisma.PlanUpdateInput = {};
  if (typeof body.displayName === "string") data.displayName = body.displayName;
  if (body.priceBdt !== undefined) {
    const n = typeof body.priceBdt === "string" ? Number(body.priceBdt) : body.priceBdt;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
      data.priceBdt = new Prisma.Decimal(n);
    } else {
      res.status(400).json({ error: "invalid_priceBdt" });
      return;
    }
  }
  if (typeof body.trialDays === "number" && body.trialDays >= 0) {
    data.trialDays = body.trialDays;
  }
  if (typeof body.billingCycle === "string") data.billingCycle = body.billingCycle;
  if (body.limits && typeof body.limits === "object" && !Array.isArray(body.limits)) {
    data.limits = body.limits as unknown as Prisma.InputJsonValue;
  }
  if (body.featureFlags && typeof body.featureFlags === "object" && !Array.isArray(body.featureFlags)) {
    data.featureFlags = body.featureFlags as unknown as Prisma.InputJsonValue;
  }
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;

  try {
    const updated = await prisma.plan.update({ where: { id: planId }, data });
    res.json({
      plan: {
        id: updated.id,
        slug: updated.slug,
        displayName: updated.displayName,
        priceBdt: updated.priceBdt.toString(),
        trialDays: updated.trialDays,
        billingCycle: updated.billingCycle,
        limits: updated.limits,
        featureFlags: updated.featureFlags,
        isActive: updated.isActive,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      res.status(404).json({ error: "plan_not_found" });
      return;
    }
    logger.error(
      { event: "admin_patch_plan_failed", planId, err: errMsg(err) },
      "admin_patch_plan_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

// ─── Subscriptions ──────────────────────────────────────────────────────

export async function listSubscriptions(req: Request, res: Response): Promise<void> {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  try {
    const subs = await prisma.subscription.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: "desc" },
      include: {
        plan: { select: { slug: true, displayName: true, priceBdt: true } },
        tenant: { select: { id: true, name: true, slug: true, businessCategory: true } },
      },
    });

    // Most-recent payment status per subscription (single round trip via groupBy).
    const tenantIds = subs.map((s) => s.tenantId);
    const lastPaymentByTenant = new Map<string, string>();
    if (tenantIds.length > 0) {
      const grouped = await prisma.paymentTransaction.groupBy({
        by: ["tenantId"],
        where: { tenantId: { in: tenantIds } },
        _max: { createdAt: true },
      });
      await Promise.all(
        grouped.map(async (g) => {
          if (!g._max.createdAt) return;
          const row = await prisma.paymentTransaction.findFirst({
            where: { tenantId: g.tenantId, createdAt: g._max.createdAt },
            select: { status: true },
          });
          if (row) lastPaymentByTenant.set(g.tenantId, row.status);
        }),
      );
    }

    const now = Date.now();
    res.json({
      subscriptions: subs.map((s) => {
        const ref =
          s.status === "trial" && s.trialEndsAt
            ? s.trialEndsAt
            : s.status === "overdue" && s.gracePeriodEndsAt
              ? s.gracePeriodEndsAt
              : s.currentPeriodEnd;
        const daysRemaining = Math.max(
          0,
          Math.ceil((ref.getTime() - now) / (24 * 60 * 60 * 1000)),
        );
        return {
          id: s.id,
          tenantId: s.tenantId,
          tenantName: s.tenant.name,
          tenantSlug: s.tenant.slug,
          businessCategory: s.tenant.businessCategory ?? null,
          planSlug: s.plan.slug,
          planName: s.plan.displayName,
          priceBdt: s.plan.priceBdt.toString(),
          status: s.status,
          currentPeriodStart: s.currentPeriodStart.toISOString(),
          currentPeriodEnd: s.currentPeriodEnd.toISOString(),
          gracePeriodEndsAt: s.gracePeriodEndsAt?.toISOString() ?? null,
          trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
          cancelledAt: s.cancelledAt?.toISOString() ?? null,
          daysRemaining,
          lastPaymentStatus: lastPaymentByTenant.get(s.tenantId) ?? null,
        };
      }),
    });
  } catch (err) {
    logger.error(
      { event: "admin_list_subscriptions_failed", err: errMsg(err) },
      "admin_list_subscriptions_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

export async function getSubscription(req: Request, res: Response): Promise<void> {
  const tenantId = String(req.params.tenantId ?? "");
  if (!tenantId) {
    res.status(400).json({ error: "tenant_id_required" });
    return;
  }
  try {
    const sub = await prisma.subscription.findUnique({
      where: { tenantId },
      include: {
        plan: true,
        tenant: { select: { id: true, name: true, slug: true, businessCategory: true } },
      },
    });
    if (!sub) {
      res.status(404).json({ error: "subscription_not_found" });
      return;
    }
    const planLimits = await resolvePlanLimits(tenantId);
    const recentLogs = await prisma.subscriptionLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    const usage = parseUsageCounters(sub.usageCounters);
    const overrides =
      sub.planLimitOverrides && typeof sub.planLimitOverrides === "object" && !Array.isArray(sub.planLimitOverrides)
        ? (sub.planLimitOverrides as Record<string, unknown>)
        : null;

    res.json({
      subscription: {
        id: sub.id,
        tenantId,
        tenantName: sub.tenant.name,
        tenantSlug: sub.tenant.slug,
        businessCategory: sub.tenant.businessCategory ?? null,
        planSlug: sub.plan.slug,
        planName: sub.plan.displayName,
        priceBdt: sub.plan.priceBdt.toString(),
        billingCycle: sub.billingCycle,
        status: sub.status,
        trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
        currentPeriodStart: sub.currentPeriodStart.toISOString(),
        currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        gracePeriodEndsAt: sub.gracePeriodEndsAt?.toISOString() ?? null,
        cancelledAt: sub.cancelledAt?.toISOString() ?? null,
        nextBillingAt: sub.nextBillingAt?.toISOString() ?? null,
      },
      planLimits,
      overrides,
      usage,
      percentageUsed: percentageUsedView(usage, planLimits),
      recentLogs: recentLogs.map((l) => ({
        id: l.id,
        fromStatus: l.fromStatus ?? null,
        toStatus: l.toStatus,
        reason: l.reason,
        actor: l.actor,
        metadata: l.metadata,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error(
      { event: "admin_get_subscription_failed", tenantId, err: errMsg(err) },
      "admin_get_subscription_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

export async function suspendTenantSubscription(req: Request, res: Response): Promise<void> {
  const tenantId = String(req.params.tenantId ?? "");
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  if (!tenantId) {
    res.status(400).json({ error: "tenant_id_required" });
    return;
  }
  if (!reason) {
    res.status(400).json({ error: "reason_required" });
    return;
  }
  try {
    await applyTransition(tenantId, "super_admin_force_suspend", LEGACY_ACTOR, {
      adminReason: reason,
    });
    await applySuspension(tenantId);
    res.json({ ok: true });
  } catch (err) {
    handleTxnErr(res, err, "admin_suspend_failed", { tenantId });
  }
}

export async function reactivateTenantSubscription(req: Request, res: Response): Promise<void> {
  const tenantId = String(req.params.tenantId ?? "");
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  if (!tenantId) {
    res.status(400).json({ error: "tenant_id_required" });
    return;
  }
  if (!reason) {
    res.status(400).json({ error: "reason_required" });
    return;
  }
  try {
    await applyTransition(tenantId, "super_admin_reactivate", LEGACY_ACTOR, {
      adminReason: reason,
    });
    await applyReactivation(tenantId);
    res.json({ ok: true });
  } catch (err) {
    handleTxnErr(res, err, "admin_reactivate_failed", { tenantId });
  }
}

export async function cancelTenantSubscription(req: Request, res: Response): Promise<void> {
  const tenantId = String(req.params.tenantId ?? "");
  if (!tenantId) {
    res.status(400).json({ error: "tenant_id_required" });
    return;
  }
  try {
    await cancelSubscription(tenantId, LEGACY_ACTOR);
    res.json({ ok: true });
  } catch (err) {
    handleTxnErr(res, err, "admin_cancel_failed", { tenantId });
  }
}

export async function changeTenantPlan(req: Request, res: Response): Promise<void> {
  const tenantId = String(req.params.tenantId ?? "");
  const planSlug = typeof req.body?.planSlug === "string" ? req.body.planSlug : "";
  if (!tenantId) {
    res.status(400).json({ error: "tenant_id_required" });
    return;
  }
  if (!planSlug) {
    res.status(400).json({ error: "plan_slug_required" });
    return;
  }
  try {
    const plan = await prisma.plan.findUnique({ where: { slug: planSlug } });
    if (!plan) {
      res.status(404).json({ error: "plan_not_found" });
      return;
    }
    await prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { tenantId } });
      if (!sub) throw new Error("Subscription not found");
      const fromPlanId = sub.planId;
      await tx.subscription.update({
        where: { tenantId },
        data: { planId: plan.id },
      });
      await tx.subscriptionLog.create({
        data: {
          tenantId,
          fromStatus: sub.status,
          toStatus: sub.status,
          reason: "plan_change",
          actor: LEGACY_ACTOR,
          metadata: {
            fromPlanId,
            toPlanSlug: plan.slug,
            toPlanId: plan.id,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });
    res.json({ ok: true, planSlug: plan.slug });
  } catch (err) {
    handleTxnErr(res, err, "admin_change_plan_failed", { tenantId });
  }
}

export async function overrideLimits(req: Request, res: Response): Promise<void> {
  const tenantId = String(req.params.tenantId ?? "");
  const overrides = req.body?.overrides;
  if (!tenantId) {
    res.status(400).json({ error: "tenant_id_required" });
    return;
  }
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    res.status(400).json({ error: "overrides_required" });
    return;
  }
  try {
    await overrideLimitsSvc(tenantId, overrides as Record<string, unknown>, LEGACY_ACTOR);
    res.json({ ok: true });
  } catch (err) {
    handleTxnErr(res, err, "admin_override_limits_failed", { tenantId });
  }
}

// ─── Payments + Usage ────────────────────────────────────────────────────

export async function listPayments(req: Request, res: Response): Promise<void> {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
  const gateway = typeof req.query.gateway === "string" ? req.query.gateway : undefined;
  const sinceStr = typeof req.query.since === "string" ? req.query.since : undefined;
  const untilStr = typeof req.query.until === "string" ? req.query.until : undefined;
  const since = sinceStr ? new Date(sinceStr) : undefined;
  const until = untilStr ? new Date(untilStr) : undefined;

  const where: Prisma.PaymentTransactionWhereInput = {};
  if (tenantId) where.tenantId = tenantId;
  if (gateway) where.gateway = gateway;
  if (since && !Number.isNaN(since.getTime())) {
    where.createdAt = { ...(where.createdAt as object), gte: since };
  }
  if (until && !Number.isNaN(until.getTime())) {
    where.createdAt = { ...(where.createdAt as object), lte: until };
  }

  try {
    const txns = await prisma.paymentTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { paymentFailures: { orderBy: { createdAt: "desc" } } },
    });
    res.json({
      payments: txns.map((t) => ({
        id: t.id,
        tenantId: t.tenantId,
        invoiceId: t.invoiceId,
        gateway: t.gateway,
        amountBdt: t.amountBdt.toString(),
        status: t.status,
        sslcommerzTranId: t.sslcommerzTranId,
        sslcommerzSessionKey: t.sslcommerzSessionKey,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        failures: t.paymentFailures.map((f) => ({
          id: f.id,
          reason: f.reason,
          createdAt: f.createdAt.toISOString(),
        })),
      })),
    });
  } catch (err) {
    logger.error(
      { event: "admin_list_payments_failed", err: errMsg(err) },
      "admin_list_payments_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

export async function getUsageReport(req: Request, res: Response): Promise<void> {
  const tenantId = String(req.params.tenantId ?? "");
  if (!tenantId) {
    res.status(400).json({ error: "tenant_id_required" });
    return;
  }
  try {
    const sub = await prisma.subscription.findUnique({
      where: { tenantId },
      select: { usageCounters: true, planLimitOverrides: true },
    });
    const usage = parseUsageCounters(sub?.usageCounters);
    const planLimits = await resolvePlanLimits(tenantId);
    res.json({
      tenantId,
      usage,
      planLimits,
      overrides:
        sub?.planLimitOverrides &&
        typeof sub.planLimitOverrides === "object" &&
        !Array.isArray(sub.planLimitOverrides)
          ? (sub.planLimitOverrides as Record<string, unknown>)
          : null,
      percentageUsed: percentageUsedView(usage, planLimits),
    });
  } catch (err) {
    logger.error(
      { event: "admin_get_usage_failed", tenantId, err: errMsg(err) },
      "admin_get_usage_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function percentageUsedView(
  usage: Record<UsageCounterKey, number>,
  limits: ResolvedPlanLimits,
): Record<string, number | null> {
  const counterToLimit: Record<UsageCounterKey, keyof ResolvedPlanLimits> = {
    messages: "maxMonthlyMessages",
    aiTokens: "maxAiTokensMonthly",
    posts: "maxPostingPerDay",
  };
  const out: Record<string, number | null> = {};
  for (const [counterKey, limitKey] of Object.entries(counterToLimit) as Array<
    [UsageCounterKey, keyof ResolvedPlanLimits]
  >) {
    const max = limits[limitKey];
    const current = usage[counterKey];
    if (typeof max !== "number" || max === -1 || max === 0) {
      out[limitKey as string] = null;
      continue;
    }
    out[limitKey as string] = Math.round((current / max) * 1000) / 10;
  }
  return out;
}

function handleTxnErr(
  res: Response,
  err: unknown,
  event: string,
  context: Record<string, unknown>,
): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("Illegal subscription transition")) {
    res.status(409).json({ error: "illegal_transition", detail: message });
    return;
  }
  if (message.startsWith("Subscription not found")) {
    res.status(404).json({ error: "subscription_not_found" });
    return;
  }
  if (message === "tenantId is required") {
    res.status(400).json({ error: "tenant_id_required" });
    return;
  }
  if (message === "overrides must be an object") {
    res.status(400).json({ error: "overrides_required" });
    return;
  }
  logger.error({ event, err: { message }, ...context }, event);
  res.status(500).json({ error: "internal_error" });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
