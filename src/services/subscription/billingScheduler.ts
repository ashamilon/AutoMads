/**
 * Billing Scheduler — the hourly cron driver that walks every
 * `Subscription` row and pushes it forward through the lifecycle.
 *
 * Responsibilities (R10.5, R10.6, R12.1-12.4, R15.5):
 *
 *  1. **Period-end sweep.** Find `status='active'` rows whose
 *     `currentPeriodEnd` has elapsed AND have no successful payment
 *     covering the current period. Drive
 *     `applyTransition(tenantId, 'period_end_reached', 'system')` so the
 *     state machine flips them to `overdue` and computes
 *     `gracePeriodEndsAt = currentPeriodEnd + 3d`.
 *
 *  2. **Grace ladder.** For every `status='overdue'` row, work out how
 *     long it has been overdue (using `currentPeriodEnd` as the anchor
 *     — `gracePeriodEndsAt = currentPeriodEnd + 3d` is the design
 *     contract) and call:
 *        - `gracePeriodService.runDay0` at T+0h
 *        - `gracePeriodService.runDay1` once T+24h has passed
 *        - `gracePeriodService.runDay2` once T+48h has passed
 *        - `gracePeriodService.runDay3` once `gracePeriodEndsAt` is
 *          reached (T+72h)
 *     Each `runDayN` is itself idempotent — the
 *     `(subscriptionId, day, channel)` unique constraint on
 *     `GracePeriodTracking` is the source of truth.
 *
 *  3. **Usage-counter reset.** For every `status='active'` row whose
 *     `currentPeriodStart` advanced within the last cron interval AND a
 *     successful renewal payment landed in the *prior* period, reset
 *     usage counters via `planLimitService.resetUsageCounters`. The
 *     `applyTransition('payment_success')` path already resets counters
 *     in the same txn; this sweep is the belt-and-suspenders catch for
 *     any path that advanced the period anchors without going through
 *     the state machine. `resetUsageCounters` is naturally idempotent.
 *
 * Error isolation: every per-tenant action runs inside its own
 * `try/catch` so one tenant's failure (a bad plan ref, a Prisma timeout,
 * a notification adapter throwing) cannot poison the rest of the tick
 * (R12.4 implies the scheduler must keep moving even when one tenant is
 * misconfigured).
 *
 * Lifecycle: `startBillingScheduler()` boots the cron;
 * `stopBillingScheduler()` halts it. The module never auto-starts on
 * import — `src/index.ts` decides when to boot the cron so test runners
 * and CLI tools that import this file don't accidentally fire timers.
 */

import cron, { type ScheduledTask } from "node-cron";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { resetUsageCounters } from "../plan/planLimitService.js";
import { runDay0, runDay1, runDay2, runDay3 } from "./gracePeriodService.js";
import { applyTransition } from "./subscriptionService.js";

/**
 * Hourly cron expression — fires at minute 0 of every hour. The 1-hour
 * cadence is a design constraint (R12.1: warnings within 1 hour of
 * entering overdue).
 */
const HOURLY_CRON = "0 * * * *";

/** ms in 24 / 48 / 72 hours — kept as constants so the math is readable. */
const HOUR_MS = 60 * 60 * 1000;
const DAY1_OFFSET_MS = 24 * HOUR_MS;
const DAY2_OFFSET_MS = 48 * HOUR_MS;
const DAY3_OFFSET_MS = 72 * HOUR_MS;

/**
 * Window inside which a subscription whose `currentPeriodStart` was
 * recently bumped will be picked up by the usage-counter reset sweep.
 * Slightly larger than the 1-hour cron interval so a tick that runs
 * a few minutes late never misses a renewal.
 */
const RECENT_PERIOD_START_WINDOW_MS = 75 * 60 * 1000; // 75 minutes

/**
 * Number of subscription rows fetched per sweep query. Each sweep is
 * O(active rows) — for small tenant counts a single page is plenty;
 * larger deployments can wire pagination here later.
 */
const SWEEP_BATCH_SIZE = 1000;

let scheduledTask: ScheduledTask | null = null;
let tickRunning = false;

/**
 * Public entry point — starts the hourly cron if it isn't running.
 * Idempotent: calling it twice keeps the same task. Returns the
 * ScheduledTask so callers can introspect / stop it directly if they
 * need to.
 */
export function startBillingScheduler(): ScheduledTask {
  if (scheduledTask !== null) return scheduledTask;
  scheduledTask = cron.schedule(HOURLY_CRON, () => {
    void runBillingTick().catch((err) => {
      // Should be impossible — runBillingTick swallows its own errors.
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        { event: "billing_scheduler_tick_unhandled", err: reason },
        "billing_scheduler_tick_unhandled",
      );
    });
  });
  scheduledTask.start();
  logger.info(
    { event: "billing_scheduler_started", cron: HOURLY_CRON },
    "billing scheduler started (hourly)",
  );
  return scheduledTask;
}

/**
 * Stop the cron. Idempotent. Safe to call from process shutdown hooks.
 */
export function stopBillingScheduler(): void {
  if (scheduledTask === null) return;
  scheduledTask.stop();
  scheduledTask = null;
  logger.info(
    { event: "billing_scheduler_stopped" },
    "billing scheduler stopped",
  );
}

/**
 * Single tick of the billing scheduler. Exposed so tests and operator
 * scripts can drive a sweep without waiting for the cron schedule.
 *
 * Tick guard: a previous tick still in flight (e.g. a slow DB) is
 * skipped to avoid concurrent sweeps stepping on each other. The hourly
 * cadence makes overlap unlikely, but the guard is cheap insurance.
 */
export async function runBillingTick(): Promise<void> {
  if (tickRunning) {
    logger.warn(
      { event: "billing_scheduler_tick_overlap" },
      "billing scheduler tick skipped — previous tick still running",
    );
    return;
  }
  tickRunning = true;
  const startedAt = Date.now();
  try {
    await sweepPeriodEndForActive();
    await sweepGraceLadder();
    await sweepUsageCounterReset();
  } catch (err) {
    // Defense in depth — every sweep handles its own errors; this catch
    // exists only for unexpected throws from the sweep dispatchers.
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(
      { event: "billing_scheduler_tick_failed", err: reason },
      "billing_scheduler_tick_failed",
    );
  } finally {
    tickRunning = false;
    logger.info(
      {
        event: "billing_scheduler_tick_complete",
        durationMs: Date.now() - startedAt,
      },
      "billing_scheduler_tick_complete",
    );
  }
}

// ─── Sweep 1: period_end_reached on active subscriptions ───────────────────

/**
 * Find every `status='active'` subscription whose `currentPeriodEnd` has
 * elapsed AND has no successful `PaymentTransaction` for the current
 * period. Drive `period_end_reached` so the state machine flips them to
 * `overdue`.
 *
 * "Successful payment for the current period" is defined as: a
 * `PaymentTransaction` with `status='success'` and
 * `createdAt >= currentPeriodStart`. (Invoices link transactions to
 * subscriptions via the `Invoice` row; checking transactions directly is
 * sufficient because every successful renewal funnels through the
 * SSLCommerz adapter which writes the transaction row.)
 */
async function sweepPeriodEndForActive(): Promise<void> {
  const now = new Date();

  const candidates = await prisma.subscription.findMany({
    where: {
      status: "active",
      currentPeriodEnd: { lte: now },
    },
    select: {
      id: true,
      tenantId: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
    },
    take: SWEEP_BATCH_SIZE,
  });

  if (candidates.length === 0) return;

  for (const sub of candidates) {
    try {
      // Re-check inside the per-tenant try/catch so a race where the
      // payment lands between findMany and applyTransition doesn't push
      // a paid subscription into overdue.
      const successfulPayment = await prisma.paymentTransaction.findFirst({
        where: {
          tenantId: sub.tenantId,
          status: "success",
          createdAt: { gte: sub.currentPeriodStart },
        },
        select: { id: true },
      });
      if (successfulPayment !== null) continue;

      await applyTransition(sub.tenantId, "period_end_reached", "system");

      logger.info(
        {
          event: "billing_scheduler_period_end_overdue",
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        },
        "billing_scheduler_period_end_overdue",
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          event: "billing_scheduler_period_end_failed",
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          err: reason,
        },
        "billing_scheduler_period_end_failed",
      );
    }
  }
}

// ─── Sweep 2: grace-period ladder for overdue subscriptions ────────────────

/**
 * For each `status='overdue'` subscription, compute hours since the
 * subscription entered overdue (anchor = `currentPeriodEnd`) and run
 * `runDay0` / `runDay1` / `runDay2` / `runDay3` as appropriate.
 *
 * Each `runDayN` is itself idempotent (backed by the
 * `(subscriptionId, day, channel)` unique constraint), so even if the
 * cron fires more than once between day boundaries the warnings are
 * never duplicated. The scheduler still gates on the elapsed window so
 * we don't pile up no-op DB round-trips.
 */
async function sweepGraceLadder(): Promise<void> {
  const now = new Date();

  const overdue = await prisma.subscription.findMany({
    where: { status: "overdue" },
    select: {
      id: true,
      tenantId: true,
      currentPeriodEnd: true,
      gracePeriodEndsAt: true,
    },
    take: SWEEP_BATCH_SIZE,
  });

  if (overdue.length === 0) return;

  for (const sub of overdue) {
    try {
      const anchor = sub.currentPeriodEnd.getTime();
      const elapsedMs = now.getTime() - anchor;

      // Day 0 — runs on the first tick after the row enters overdue.
      // The runDayN function uses GracePeriodTracking inserts as its
      // idempotency guard, so we always invoke it; it short-circuits
      // when the row already exists.
      await runDay0(sub.id);

      if (elapsedMs >= DAY1_OFFSET_MS) {
        await runDay1(sub.id);
      }

      if (elapsedMs >= DAY2_OFFSET_MS) {
        await runDay2(sub.id);
      }

      // Day 3 fires once `gracePeriodEndsAt` is reached. We prefer the
      // explicit anchor when set; the offset math is the fallback for
      // rows where the column was never populated (defense in depth).
      const day3Due =
        (sub.gracePeriodEndsAt !== null && now >= sub.gracePeriodEndsAt) ||
        elapsedMs >= DAY3_OFFSET_MS;
      if (day3Due) {
        await runDay3(sub.id);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          event: "billing_scheduler_grace_ladder_failed",
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          err: reason,
        },
        "billing_scheduler_grace_ladder_failed",
      );
    }
  }
}

// ─── Sweep 3: usage-counter reset on period rollover ───────────────────────

/**
 * Reset usage counters for any `status='active'` subscription whose
 * `currentPeriodStart` advanced within the last cron interval AND has a
 * successful payment recorded in the prior period.
 *
 * `applyTransition('payment_success')` already zeroes the counters in
 * the same DB transaction, so this sweep is the safety net for paths
 * that advanced the period anchors outside the state machine. The
 * underlying `resetUsageCounters` write is idempotent — it only sets
 * the JSON column, so re-running on subsequent ticks while the period
 * is still inside the window is a no-op apart from one redundant
 * `UPDATE`.
 */
async function sweepUsageCounterReset(): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - RECENT_PERIOD_START_WINDOW_MS);

  const candidates = await prisma.subscription.findMany({
    where: {
      status: "active",
      currentPeriodStart: { gte: windowStart, lte: now },
    },
    select: {
      id: true,
      tenantId: true,
      currentPeriodStart: true,
    },
    take: SWEEP_BATCH_SIZE,
  });

  if (candidates.length === 0) return;

  for (const sub of candidates) {
    try {
      // "Prior period" check: a successful payment dated *before* the
      // new currentPeriodStart anchors the renewal we're acknowledging.
      // Without this check we'd reset counters for fresh trials whose
      // currentPeriodStart was set on signup (no real renewal happened).
      const priorPayment = await prisma.paymentTransaction.findFirst({
        where: {
          tenantId: sub.tenantId,
          status: "success",
          createdAt: { lte: sub.currentPeriodStart },
        },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });
      if (priorPayment === null) continue;

      await resetUsageCounters(sub.tenantId);

      logger.info(
        {
          event: "billing_scheduler_usage_counters_reset",
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          currentPeriodStart: sub.currentPeriodStart.toISOString(),
        },
        "billing_scheduler_usage_counters_reset",
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          event: "billing_scheduler_usage_reset_failed",
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          err: reason,
        },
        "billing_scheduler_usage_reset_failed",
      );
    }
  }
}
