import type { NotificationChannelAdapter } from "../types.js";

/**
 * Facebook channel adapter — placeholder stub (R13.2, R21.1, R21.4).
 *
 * "Facebook" here is the *operator notification* channel (e.g. Facebook
 * Messenger / Page-inbox style alerts to the Tenant_Admin), distinct from
 * the customer-facing Messenger reply pipeline that already runs through
 * the agent loop. The Notification System contract reserves this slot on
 * `NotificationChannelAdapter` so dispatch call sites can target it
 * without import-time errors, but a real Facebook send integration is
 * intentionally deferred.
 *
 * Until that real adapter lands this stub:
 *
 *   • Implements `NotificationChannelAdapter` so the dispatcher fans out
 *     through the same code path as the active channels (R13.2).
 *   • Returns `{ ok: false, reason: 'not_implemented' }` from `send` so
 *     the dispatcher records the `Notification` row as `failed` with a
 *     stable, machine-readable reason. No external call, no throw.
 *   • Stays disconnected from the dashboard's feature-toggle UI: per
 *     R21.4 the Facebook toggle stays hidden via `featureFlagService`
 *     until a real adapter replaces this file. Do NOT register this
 *     export in any channel-toggle registry yet.
 *
 * Replace this file's `send` implementation when the Facebook adapter is
 * activated; the `id: 'facebook'` contract and call sites stay stable.
 */
export const facebookChannel: NotificationChannelAdapter = {
  id: "facebook",
  async send(_input): Promise<{ ok: false; reason: "not_implemented" }> {
    return { ok: false, reason: "not_implemented" };
  },
};
