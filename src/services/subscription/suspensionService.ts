/**
 * Suspension service — owns the `tenant.isActive` toggle that gates every
 * outbound surface for a non-paying tenant (R12.4, R12.5, R12.6).
 *
 * Why this is a thin wrapper:
 *
 *  - Outbound enforcement (Messenger reply, content agent posts, follow-up
 *    sender, tenant-public storefront reads) is wired in task 3.3 by
 *    consulting `reasoningContext.subscription.isOperational`. That cache
 *    flips within 5 minutes once `tenant.isActive` flips here, so this
 *    service only needs to update the column and fan a notification out;
 *    it does NOT need to walk every outbound surface itself.
 *
 *  - Status transitions (`overdue → suspended`, `suspended → active`) are
 *    owned by `subscriptionService.applyTransition`. This module is the
 *    side-effect arm that runs after the status flip lands. Callers are
 *    expected to invoke `applyTransition` first; this service does not
 *    re-validate the subscription state.
 *
 *  - R12.5: NEVER deletes or anonymizes tenant-scoped data. Only the
 *    `Tenant.isActive` flag changes. Conversations, products, AI memory,
 *    schemas, and notifications stay intact so reactivation is lossless.
 *
 *  - R12.6: Reactivation must resume behavior within 5 minutes — that is
 *    enforced by the 30s in-process cache TTLs upstream
 *    (`reasoningContext`, `featureFlagService`, `planLimitService`). No
 *    explicit cache eviction is needed here; flipping `isActive=true` is
 *    sufficient because the next cache miss after TTL expiry rereads the
 *    tenant row.
 *
 * Notification fan-out goes through `notificationDispatcher.dispatch` so
 * the dashboard, email, and telegram adapters all receive the event; per
 * R13.1/R13.2/R13.6 the channel set is `['dashboard', 'email', 'telegram']`.
 * Dispatch failures are logged but never surface as suspension failures —
 * the status change is what protects platform revenue, not the alert.
 */

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { dispatch } from "../notifications/dispatcher.js";
import type { NotificationChannelId } from "../notifications/types.js";

/**
 * Channels that receive subscription lifecycle notifications. Matches the
 * design (R13.1, R13.6): dashboard + email at minimum, telegram preserved
 * from the existing alert pipeline.
 */
const SUSPENSION_NOTIFICATION_CHANNELS: NotificationChannelId[] = [
  "dashboard",
  "email",
  "telegram",
];

const SUSPENDED_EVENT_TYPE = "subscription.suspended";
const REACTIVATED_EVENT_TYPE = "subscription.reactivated";

/**
 * Mark the tenant as suspended (R12.4).
 *
 * Steps:
 *  1. Flip `tenant.isActive = false`. Every cached `ReasoningContext` will
 *     pick this up on its next refresh (≤ 5 minutes per R12.6 inverse).
 *  2. Fan out a `subscription.suspended` notification on
 *     `[dashboard, email, telegram]`. Failures are logged, not thrown —
 *     the suspension itself succeeds even if a channel is degraded.
 *
 * NOT performed here (intentional, per task 3.3 ownership):
 *  - Walking outbound surfaces to short-circuit them. The webhook handler,
 *    content agent, and follow-up sender all consult
 *    `ctx.subscription.isOperational` themselves.
 *  - Deleting or anonymizing rows. R12.5 forbids any data mutation beyond
 *    the `isActive` flag.
 *  - Driving the `Subscription.status` field. That is
 *    `subscriptionService.applyTransition`'s job.
 *
 * @param tenantId The tenant whose access should be paused. Required.
 * @returns Resolves once the DB write completes; notification dispatch
 *   may continue but is not awaited as a hard dependency for failure.
 */
export async function applySuspension(tenantId: string): Promise<void> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  // R12.4: only the access flag changes. R12.5: no other tenant-scoped row
  // is touched. Using `update` (not `upsert`) so a missing tenant surfaces
  // as a clear Prisma error rather than silently creating a stub row.
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { isActive: false },
  });

  logger.info(
    {
      event: "tenant_suspension_applied",
      tenantId,
    },
    "tenant_suspension_applied",
  );

  try {
    await dispatch({
      tenantId,
      channels: SUSPENSION_NOTIFICATION_CHANNELS,
      type: SUSPENDED_EVENT_TYPE,
      payload: {
        tenantId,
        suspendedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Notification failure is non-fatal: the column flip already protects
    // revenue. Surface the error in logs so operators can resend manually.
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        event: "tenant_suspension_notification_failed",
        tenantId,
        err: reason,
      },
      "tenant_suspension_notification_failed",
    );
  }
}

/**
 * Mark the tenant as reactivated (R12.6).
 *
 * Steps:
 *  1. Flip `tenant.isActive = true`. Existing `ReasoningContext` caches
 *     will re-read this on their next miss (TTL ≤ 5 minutes), at which
 *     point outbound surfaces resume on their own — no restart needed.
 *  2. Fan out a `subscription.reactivated` notification on
 *     `[dashboard, email, telegram]` so the Tenant_Admin sees the event.
 *
 * Like `applySuspension`, this function does NOT mutate `Subscription`
 * status; the caller (typically the SSLCommerz webhook on
 * `payment_success` from `suspended`, or the Admin Panel manual
 * reactivation) drives that via `subscriptionService.applyTransition`.
 */
export async function applyReactivation(tenantId: string): Promise<void> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { isActive: true },
  });

  logger.info(
    {
      event: "tenant_reactivation_applied",
      tenantId,
    },
    "tenant_reactivation_applied",
  );

  try {
    await dispatch({
      tenantId,
      channels: SUSPENSION_NOTIFICATION_CHANNELS,
      type: REACTIVATED_EVENT_TYPE,
      payload: {
        tenantId,
        reactivatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        event: "tenant_reactivation_notification_failed",
        tenantId,
        err: reason,
      },
      "tenant_reactivation_notification_failed",
    );
  }
}
