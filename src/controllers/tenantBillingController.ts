/**
 * Tenant-side billing endpoints. Every route is gated by
 * `requireTenantApiKey` (mounted on `tenantPortalRoutes`) so the tenant
 * can read their own subscription state and trigger a renewal payment
 * without seeing other tenants' data.
 *
 * Routes:
 *  - GET  /api/v1/billing/me        → subscription summary + usage
 *  - GET  /api/v1/billing/invoices  → past invoices (newest first)
 *  - POST /api/v1/billing/initiate-renewal → kicks off SSLCommerz session for the next pending invoice
 *  - POST /api/v1/billing/cancel    → tenant-initiated deferred cancel
 */

import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import {
  resolve as resolvePlanLimits,
  parseUsageCounters,
} from "../services/plan/planLimitService.js";
import { initiateSubscriptionPayment } from "../services/billing/sslcommerzSubscriptionAdapter.js";
import { cancel as cancelSubscription } from "../services/subscription/subscriptionService.js";

/**
 * GET /api/v1/billing/me
 *
 * Returns the tenant's subscription summary, plan, and usage view in a
 * single payload so the portal billing page can render in one round-trip.
 *
 * Shape:
 * {
 *   subscription: {
 *     status, planSlug, planName, billingCycle, priceBdt,
 *     trialEndsAt, currentPeriodStart, currentPeriodEnd,
 *     gracePeriodEndsAt, cancelledAt, nextBillingAt, daysRemaining
 *   } | null,
 *   limits: { ...resolved Plan_Limits },
 *   usage: { messages, aiTokens, posts },
 *   percentageUsed: { maxMonthlyMessages: 12.4, ... }
 * }
 */
export async function getMyBilling(req: Request, res: Response): Promise<void> {
  const tenant = req.tenant;
  if (!tenant) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const [sub, planLimits] = await Promise.all([
      prisma.subscription.findUnique({
        where: { tenantId: tenant.id },
        include: { plan: true },
      }),
      resolvePlanLimits(tenant.id),
    ]);

    if (!sub) {
      res.json({
        subscription: null,
        limits: planLimits,
        usage: parseUsageCounters(null),
        percentageUsed: {},
      });
      return;
    }

    const now = new Date();
    const reference = referenceCutoff(sub);
    const daysRemaining = Math.max(
      0,
      Math.ceil((reference.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    );

    const usage = parseUsageCounters(sub.usageCounters);
    const counterToLimit: Record<string, keyof typeof planLimits> = {
      messages: "maxMonthlyMessages",
      aiTokens: "maxAiTokensMonthly",
      posts: "maxPostingPerDay",
    };
    const percentageUsed: Record<string, number | null> = {};
    for (const [counterKey, limitKey] of Object.entries(counterToLimit)) {
      const max = planLimits[limitKey];
      const current = usage[counterKey as keyof typeof usage];
      if (typeof max !== "number" || max === -1 || max === 0) {
        percentageUsed[limitKey as string] = null;
        continue;
      }
      percentageUsed[limitKey as string] =
        Math.round((current / max) * 1000) / 10;
    }

    res.json({
      subscription: {
        id: sub.id,
        status: sub.status,
        planSlug: sub.plan.slug,
        planName: sub.plan.displayName,
        priceBdt: sub.plan.priceBdt.toString(),
        billingCycle: sub.billingCycle,
        trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
        currentPeriodStart: sub.currentPeriodStart.toISOString(),
        currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        gracePeriodEndsAt: sub.gracePeriodEndsAt?.toISOString() ?? null,
        cancelledAt: sub.cancelledAt?.toISOString() ?? null,
        nextBillingAt: sub.nextBillingAt?.toISOString() ?? null,
        daysRemaining,
      },
      limits: planLimits,
      usage,
      percentageUsed,
    });
  } catch (err) {
    logger.error(
      {
        event: "tenant_billing_me_failed",
        tenantId: tenant.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "tenant_billing_me_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * Pick the timestamp the "days remaining" countdown should reference.
 * - trial → trialEndsAt
 * - overdue → gracePeriodEndsAt
 * - else → currentPeriodEnd
 */
function referenceCutoff(sub: {
  status: string;
  trialEndsAt: Date | null;
  gracePeriodEndsAt: Date | null;
  currentPeriodEnd: Date;
}): Date {
  if (sub.status === "trial" && sub.trialEndsAt) return sub.trialEndsAt;
  if (sub.status === "overdue" && sub.gracePeriodEndsAt) return sub.gracePeriodEndsAt;
  return sub.currentPeriodEnd;
}

/**
 * GET /api/v1/billing/invoices
 *
 * Returns the tenant's invoice history (newest first), capped at 100.
 * Includes PDF path so the portal can render a download link.
 */
export async function listMyInvoices(req: Request, res: Response): Promise<void> {
  const tenant = req.tenant;
  if (!tenant) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const invoices = await prisma.invoice.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({
      invoices: invoices.map((inv) => ({
        id: inv.id,
        periodStart: inv.periodStart.toISOString(),
        periodEnd: inv.periodEnd.toISOString(),
        amountBdt: inv.amountBdt.toString(),
        currency: inv.currency,
        status: inv.status,
        pdfPath: inv.pdfPath,
        sslcommerzTranId: inv.sslcommerzTranId,
        createdAt: inv.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error(
      {
        event: "tenant_billing_invoices_failed",
        tenantId: tenant.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "tenant_billing_invoices_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * POST /api/v1/billing/initiate-renewal
 *
 * Looks up the tenant's most recent `pending` invoice and starts an
 * SSLCommerz session against it. Returns the redirect URL the portal
 * sends the tenant's browser to.
 *
 * If no pending invoice exists, returns 409 — the cron will create one
 * when the period rolls over, or the tenant is mid-cycle and doesn't
 * need to pay yet.
 */
export async function initiateRenewal(req: Request, res: Response): Promise<void> {
  const tenant = req.tenant;
  if (!tenant) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const pending = await prisma.invoice.findFirst({
      where: { tenantId: tenant.id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    if (!pending) {
      res.status(409).json({ error: "no_pending_invoice" });
      return;
    }

    const result = await initiateSubscriptionPayment(pending.id);
    res.json({
      invoiceId: pending.id,
      redirectUrl: result.redirectUrl,
      tranId: result.tranId,
    });
  } catch (err) {
    logger.error(
      {
        event: "tenant_billing_initiate_renewal_failed",
        tenantId: tenant.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "tenant_billing_initiate_renewal_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * POST /api/v1/billing/cancel
 *
 * Tenant-initiated deferred cancel. Status stays `active` until
 * `currentPeriodEnd`; only `cancelledAt` is set. The audit log records
 * `actor='tenant:<id>'` so support can distinguish from super-admin cancels.
 */
export async function cancelMySubscription(req: Request, res: Response): Promise<void> {
  const tenant = req.tenant;
  if (!tenant) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    await cancelSubscription(tenant.id, `tenant:${tenant.id}`);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Illegal subscription transition")) {
      res.status(409).json({ error: "illegal_transition", detail: message });
      return;
    }
    if (message.startsWith("Subscription not found")) {
      res.status(404).json({ error: "subscription_not_found" });
      return;
    }
    logger.error(
      {
        event: "tenant_billing_cancel_failed",
        tenantId: tenant.id,
        err: message,
      },
      "tenant_billing_cancel_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}
