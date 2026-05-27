import type { NotificationChannelAdapter } from "../types.js";

/**
 * Dashboard channel adapter (R13.1, R13.4).
 *
 * The dispatcher (`src/services/notifications/dispatcher.ts`) already creates
 * the `Notification` row, persists `tenantId`, `channel='dashboard'`, `type`,
 * and `payload`, and — on a successful adapter response — flips the row's
 * status to `delivered` and stamps `sentAt`. So this adapter has nothing
 * external to do; the persisted row IS the dashboard delivery.
 *
 * The dashboard notification center reads recent rows for a tenant via
 * `prisma.notification.findMany({ where: { tenantId, channel: 'dashboard' },
 * orderBy: { createdAt: 'desc' } })` and uses `readAt` to track unread state.
 *
 * Returning `{ ok: true }` here intentionally short-circuits any retry
 * behaviour the dispatcher might add later — there is no upstream service
 * to be flaky about.
 */
export const dashboardChannel: NotificationChannelAdapter = {
  id: "dashboard",
  async send(_input): Promise<{ ok: true }> {
    return { ok: true };
  },
};
