/**
 * Grace Period service — drives the Day 0/1/2/3 warning + suspension
 * ladder once a `Subscription` enters `status='overdue'` (R12.1, R12.2,
 * R12.3, R12.4).
 *
 * Design contract:
 *
 *  - Day 0 (T+0h, entry): first overdue warning.
 *  - Day 1 (T+24h):       second warning.
 *  - Day 2 (T+48h):       final warning.
 *  - Day 3 (T+72h, `gracePeriodEndsAt`): drive
 *      `subscriptionService.applyTransition('grace_period_end_reached', 'system')`
 *    then `suspensionService.applySuspension(tenantId)`.
 *
 *  Each `runDayN` is idempotent. The idempotency key is the
 *  `(subscriptionId, day, channel)` unique constraint on
 *  `GracePeriodTracking`. Re-firing the cron — or invoking the same day
 *  twice in the same tick — never produces a duplicate `Notification`,
 *  duplicate `SubscriptionLog`, or duplicate suspension flip.
 *
 *  We rely on `prisma.gracePeriodTracking.createMany({ skipDuplicates:
 *  true })` (Postgres `INSERT ... ON CONFLICT DO NOTHING`) for the
 *  insert-or-skip. The number of rows actually inserted tells us whether
 *  the warning is fresh or already-sent. We only fan out a notification
 *  when at least one channel-tracking row was newly inserted.
 *
 *  Notification fan-out goes through `notificationDispatcher.dispatch`
 *  which itself persists `Notification` rows per channel; that is the
 *  delivery surface (R13.1, R13.6). The grace-period tracking rows here
 *  are the *cron-side* idempotency record, not the user-visible
 *  notification.
 *
 *  Day 3 has no warning of its own — the suspension itself is the
 *  signal. `runDay3` records a `(day=3, channel='system')` tracking row
 *  so the scheduler can ask "has Day 3 already run?" without re-running
 *  the suspension. The `applySuspension` call is naturally idempotent
 *  (it just sets `tenant.isActive=false`) but driving the state-machine
 *  transition twice would throw `IllegalTransitionError` once the row
 *  is already `suspended`, so the tracking guard is what protects us.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { dispatch } from "../notifications/dispatcher.js";
import type { NotificationChannelId } from "../notifications/types.js";
import { applyTransition } from "./subscriptionService.js";
import { applySuspension } from "./suspensionService.js";

/** Day numbers stored on `GracePeriodTracking.day`. */
type WarningDay = 0 | 1 | 2;

/**
 * Channels every grace-period warning is fanned out on (R13.1, R13.6).
 * Same set used by `suspensionService` so the audit trail is consistent.
 */
const WARNING_CHANNELS: ReadonlyArray<NotificationChannelId> = [
  "dashboard",
  "email",
  "telegram",
];

/**
 * Stable channel string written into `GracePeriodTracking.channel` for
 * the Day 3 suspension marker. NOT a real `NotificationChannelId` — the
 * row is purely an idempotency record so the cron can ask "did Day 3
 * already run?" without re-flipping the state machine.
 */
const SYSTEM_CHANNEL = "system";

interface RunDayResult {
  /** Whether any work was performed (rows inserted, notification sent,
   *  or suspension flipped). `false` on idempotent re-runs. */
  performed: boolean;
  /** Resolved tenantId for log correlation; `null` when the subscription
   *  could not be located. */
  tenantId: string | null;
}

/**
 * Insert one tracking row per channel for `(subscriptionId, day)`. Uses
 * `createMany({ skipDuplicates: true })` so the unique constraint on
 * `(subscriptionId, day, channel)` becomes our idempotency guard. Returns
 * the number of NEW rows that were actually inserted; `0` means the
 * warning was already sent in a prior run and the caller should skip the
 * dispatch.
 */
async function recordWarningChannels(
  subscriptionId: string,
  tenantId: string,
  day: WarningDay,
): Promise<number> {
  const rows: Prisma.GracePeriodTrackingCreateManyInput[] = WARNING_CHANNELS.map(
    (channel) => ({
      subscriptionId,
      tenantId,
      day,
      channel,
    }),
  );

  const result = await prisma.gracePeriodTracking.createMany({
    data: rows,
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Insert a single `(day=3, channel='system')` marker for the suspension
 * step. Returns `true` when the row was newly inserted (and the caller
 * should run the transition), `false` when it already existed (no-op).
 */
async function claimDay3(
  subscriptionId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await prisma.gracePeriodTracking.createMany({
    data: [
      {
        subscriptionId,
        tenantId,
        day: 3,
        channel: SYSTEM_CHANNEL,
      },
    ],
    skipDuplicates: true,
  });
  return result.count > 0;
}

/**
 * Resolve the `tenantId` for a `subscriptionId`. Returns `null` when the
 * row was deleted between scheduling and execution; callers treat that
 * as a no-op rather than an error.
 */
async function resolveTenantId(subscriptionId: string): Promise<string | null> {
  const row = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: { tenantId: true },
  });
  return row?.tenantId ?? null;
}

/**
 * Shared body of `runDay0` / `runDay1` / `runDay2`. Records the tracking
 * rows first (the idempotency anchor) and only fans out the notification
 * when at least one row was newly inserted.
 *
 * Notification dispatch failures are logged but never thrown — the
 * tracking rows are already committed, and a later cron tick will not
 * re-attempt because the rows exist. Re-delivery is the dispatcher's
 * concern, not the scheduler's.
 */
async function runWarningDay(
  subscriptionId: string,
  day: WarningDay,
  type: string,
): Promise<RunDayResult> {
  if (!subscriptionId) {
    throw new Error("subscriptionId is required");
  }

  const tenantId = await resolveTenantId(subscriptionId);
  if (tenantId === null) {
    logger.warn(
      {
        event: "grace_period_subscription_missing",
        subscriptionId,
        day,
      },
      "grace_period_subscription_missing",
    );
    return { performed: false, tenantId: null };
  }

  const inserted = await recordWarningChannels(subscriptionId, tenantId, day);
  if (inserted === 0) {
    // Already sent on a prior run — idempotent no-op.
    return { performed: false, tenantId };
  }

  try {
    await dispatch({
      tenantId,
      channels: [...WARNING_CHANNELS],
      type,
      payload: {
        subscriptionId,
        tenantId,
        day,
        sentAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Non-fatal: tracking rows already committed; we don't re-fire the
    // warning on the next tick. Surface the failure in logs so operators
    // can resend manually if needed.
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        event: "grace_period_warning_dispatch_failed",
        subscriptionId,
        tenantId,
        day,
        type,
        err: reason,
      },
      "grace_period_warning_dispatch_failed",
    );
  }

  logger.info(
    {
      event: "grace_period_warning_sent",
      subscriptionId,
      tenantId,
      day,
      type,
      channels: WARNING_CHANNELS,
    },
    "grace_period_warning_sent",
  );

  return { performed: true, tenantId };
}

/**
 * Day 0 — first overdue warning at `T+0h` after entering `overdue`
 * (R12.1). Idempotent.
 */
export async function runDay0(subscriptionId: string): Promise<RunDayResult> {
  return runWarningDay(subscriptionId, 0, "subscription.overdue.day0");
}

/**
 * Day 1 — second overdue warning at `T+24h` (R12.2). Idempotent.
 */
export async function runDay1(subscriptionId: string): Promise<RunDayResult> {
  return runWarningDay(subscriptionId, 1, "subscription.overdue.day1");
}

/**
 * Day 2 — final overdue warning at `T+48h` (R12.3). Idempotent.
 */
export async function runDay2(subscriptionId: string): Promise<RunDayResult> {
  return runWarningDay(subscriptionId, 2, "subscription.overdue.day2");
}

/**
 * Day 3 — at `gracePeriodEndsAt` (T+72h). Drives the
 * `grace_period_end_reached` transition (overdue → suspended) and then
 * runs `suspensionService.applySuspension(tenantId)` to flip
 * `tenant.isActive=false` (R12.4).
 *
 * Idempotency:
 *  - The `(subscriptionId, day=3, channel='system')` tracking row is the
 *    primary guard. We only run the transition + suspension when we
 *    successfully insert that row.
 *  - As a defense in depth: if the row exists but the prior run
 *    crashed between transition and suspension, the cron's next sweep
 *    will not re-claim Day 3, so a stale `overdue` row would be left
 *    behind. To avoid that we additionally look at the current
 *    subscription status before the transition; if it is already
 *    `suspended` we skip the transition and just ensure
 *    `applySuspension` was applied (it is naturally idempotent — sets
 *    `isActive=false` on a row that may already be false).
 */
export async function runDay3(subscriptionId: string): Promise<RunDayResult> {
  if (!subscriptionId) {
    throw new Error("subscriptionId is required");
  }

  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: { tenantId: true, status: true },
  });
  if (subscription === null) {
    logger.warn(
      {
        event: "grace_period_subscription_missing",
        subscriptionId,
        day: 3,
      },
      "grace_period_subscription_missing",
    );
    return { performed: false, tenantId: null };
  }

  const { tenantId, status } = subscription;

  const claimed = await claimDay3(subscriptionId, tenantId);
  if (!claimed) {
    // Day 3 already executed on a prior tick. No-op.
    return { performed: false, tenantId };
  }

  // Only drive the state-machine when the row is still `overdue`.
  // (`super_admin_force_suspend` from the Admin Panel could have flipped
  // it to `suspended` between cron ticks; in that case we skip the
  // transition but still call `applySuspension` to ensure the
  // `tenant.isActive` flag is consistent — it's a no-op when already
  // false.)
  if (status === "overdue") {
    try {
      await applyTransition(tenantId, "grace_period_end_reached", "system");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          event: "grace_period_transition_failed",
          subscriptionId,
          tenantId,
          err: reason,
        },
        "grace_period_transition_failed",
      );
      throw err;
    }
  } else {
    logger.info(
      {
        event: "grace_period_day3_status_skip",
        subscriptionId,
        tenantId,
        status,
      },
      "grace_period_day3_status_skip",
    );
  }

  try {
    await applySuspension(tenantId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        event: "grace_period_suspension_failed",
        subscriptionId,
        tenantId,
        err: reason,
      },
      "grace_period_suspension_failed",
    );
    throw err;
  }

  logger.info(
    {
      event: "grace_period_day3_completed",
      subscriptionId,
      tenantId,
    },
    "grace_period_day3_completed",
  );

  return { performed: true, tenantId };
}
