/**
 * Pure state machine for `Subscription.status` transitions.
 *
 * Covers every cell of
 *   {trial, active, overdue, suspended, cancelled}
 *     ×
 *   {onboarding_complete, payment_success, payment_failure,
 *    period_end_reached, grace_period_end_reached, tenant_cancel,
 *    super_admin_reactivate, super_admin_force_suspend}
 *
 * Undefined cells return a typed `IllegalTransition` error rather than a
 * silently-dropped status — the caller MUST handle both branches (R10.2,
 * R10.4-R10.7, R12.7). This module is intentionally pure: no DB access, no
 * `Date`, no logger. Side effects (writing `SubscriptionLog`, advancing
 * `currentPeriodEnd`, setting `gracePeriodEndsAt`) live in
 * `subscriptionService.applyTransition`.
 */

export type SubscriptionStatus =
  | "trial"
  | "active"
  | "overdue"
  | "suspended"
  | "cancelled";

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trial",
  "active",
  "overdue",
  "suspended",
  "cancelled",
] as const;

export type SubscriptionEvent =
  | "onboarding_complete"
  | "payment_success"
  | "payment_failure"
  | "period_end_reached"
  | "grace_period_end_reached"
  | "tenant_cancel"
  | "super_admin_reactivate"
  | "super_admin_force_suspend";

export const SUBSCRIPTION_EVENTS: readonly SubscriptionEvent[] = [
  "onboarding_complete",
  "payment_success",
  "payment_failure",
  "period_end_reached",
  "grace_period_end_reached",
  "tenant_cancel",
  "super_admin_reactivate",
  "super_admin_force_suspend",
] as const;

/**
 * Successful transition outcome — the next state plus a stable `reason`
 * string the service writes into `SubscriptionLog.reason`.
 */
export interface TransitionOk {
  readonly ok: true;
  readonly nextStatus: SubscriptionStatus;
  readonly reason: string;
}

/**
 * Typed failure for `(currentStatus, event)` pairs that have no defined
 * transition. Matches `subscriptionService.applyTransition`'s error contract;
 * `code === 'illegal_transition'` so log/metric pipelines can group on it.
 */
export interface TransitionErr {
  readonly ok: false;
  readonly code: "illegal_transition";
  readonly currentStatus: SubscriptionStatus;
  readonly event: SubscriptionEvent;
}

export type TransitionResult = TransitionOk | TransitionErr;

/**
 * Thrown by `subscriptionService.applyTransition` when the pure machine
 * returns `TransitionErr`. Kept here so consumers can `instanceof` against
 * the same class the service throws.
 */
export class IllegalTransitionError extends Error {
  public readonly code = "illegal_transition" as const;
  constructor(
    public readonly currentStatus: SubscriptionStatus,
    public readonly event: SubscriptionEvent,
  ) {
    super(
      `Illegal subscription transition: ${currentStatus} --(${event})--> ?`,
    );
    this.name = "IllegalTransitionError";
  }
}

function ok(
  nextStatus: SubscriptionStatus,
  reason: string,
): TransitionOk {
  return { ok: true, nextStatus, reason };
}

function err(
  currentStatus: SubscriptionStatus,
  event: SubscriptionEvent,
): TransitionErr {
  return { ok: false, code: "illegal_transition", currentStatus, event };
}

/**
 * Pure transition. Given the current status and an event, returns the next
 * status plus a `reason` string. Returns `TransitionErr` for undefined
 * cells. The cells encoded here mirror the state diagram in design.md
 * (Subscription Service section):
 *
 *   trial     --payment_success-->        active
 *   trial     --period_end_reached-->     overdue
 *   trial     --tenant_cancel-->          cancelled
 *   trial     --super_admin_force_suspend-> suspended
 *   active    --payment_success-->        active        (renewal)
 *   active    --period_end_reached-->     overdue
 *   active    --tenant_cancel-->          active        (deferred — service sets cancelledAt; flip to cancelled at currentPeriodEnd)
 *   active    --super_admin_force_suspend-> suspended
 *   overdue   --payment_success-->        active
 *   overdue   --grace_period_end_reached-> suspended
 *   overdue   --tenant_cancel-->          cancelled
 *   overdue   --super_admin_force_suspend-> suspended
 *   suspended --payment_success-->        active
 *   suspended --super_admin_reactivate--> active
 *   suspended --tenant_cancel-->          cancelled
 *   cancelled --super_admin_reactivate--> active
 *   cancelled --period_end_reached-->     cancelled     (terminal sweep — already at final state)
 *
 * `onboarding_complete` is only valid as the initial event creating a row in
 * `trial`; it is rejected from any existing status because the service uses
 * `startTrial` (not `applyTransition`) for that path.
 *
 * `payment_failure` never advances state — the grace-period scheduler is the
 * actor that drives `period_end_reached` / `grace_period_end_reached`.
 */
export function transition(
  currentStatus: SubscriptionStatus,
  event: SubscriptionEvent,
): TransitionResult {
  switch (currentStatus) {
    case "trial": {
      switch (event) {
        case "payment_success":
          return ok("active", "trial_payment_success");
        case "period_end_reached":
          return ok("overdue", "trial_ended_no_payment");
        case "tenant_cancel":
          return ok("cancelled", "tenant_cancelled_during_trial");
        case "super_admin_force_suspend":
          return ok("suspended", "super_admin_force_suspend");
        case "onboarding_complete":
        case "payment_failure":
        case "grace_period_end_reached":
        case "super_admin_reactivate":
          return err(currentStatus, event);
      }
      return err(currentStatus, event);
    }

    case "active": {
      switch (event) {
        case "payment_success":
          // Renewal — service advances currentPeriodStart/End by one cycle.
          return ok("active", "renewal_payment_success");
        case "period_end_reached":
          return ok("overdue", "period_end_no_renewal");
        case "tenant_cancel":
          // Deferred cancel: status stays `active` until currentPeriodEnd.
          // Service writes `cancelledAt` and the billing scheduler flips to
          // `cancelled` later via period_end_reached on a cancelled row.
          return ok("active", "tenant_cancel_deferred");
        case "super_admin_force_suspend":
          return ok("suspended", "super_admin_force_suspend");
        case "onboarding_complete":
        case "payment_failure":
        case "grace_period_end_reached":
        case "super_admin_reactivate":
          return err(currentStatus, event);
      }
      return err(currentStatus, event);
    }

    case "overdue": {
      switch (event) {
        case "payment_success":
          return ok("active", "overdue_payment_success");
        case "grace_period_end_reached":
          return ok("suspended", "grace_period_expired");
        case "tenant_cancel":
          return ok("cancelled", "tenant_cancelled_during_overdue");
        case "super_admin_force_suspend":
          return ok("suspended", "super_admin_force_suspend");
        case "onboarding_complete":
        case "payment_failure":
        case "period_end_reached":
        case "super_admin_reactivate":
          return err(currentStatus, event);
      }
      return err(currentStatus, event);
    }

    case "suspended": {
      switch (event) {
        case "payment_success":
          return ok("active", "suspended_payment_success");
        case "super_admin_reactivate":
          return ok("active", "manual_reactivation");
        case "tenant_cancel":
          return ok("cancelled", "tenant_cancelled_while_suspended");
        case "onboarding_complete":
        case "payment_failure":
        case "period_end_reached":
        case "grace_period_end_reached":
        case "super_admin_force_suspend":
          return err(currentStatus, event);
      }
      return err(currentStatus, event);
    }

    case "cancelled": {
      switch (event) {
        case "super_admin_reactivate":
          return ok("active", "manual_reactivation_after_cancel");
        case "period_end_reached":
          // Terminal sweep — row is already cancelled, stays cancelled.
          return ok("cancelled", "cancellation_period_end");
        case "onboarding_complete":
        case "payment_success":
        case "payment_failure":
        case "grace_period_end_reached":
        case "tenant_cancel":
        case "super_admin_force_suspend":
          return err(currentStatus, event);
      }
      return err(currentStatus, event);
    }
  }
}
