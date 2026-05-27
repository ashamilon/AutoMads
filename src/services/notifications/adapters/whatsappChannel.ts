import type { NotificationChannelAdapter } from "../types.js";

/**
 * WhatsApp channel adapter — placeholder stub (R13.2, R21.1, R21.4).
 *
 * The Notification System contract requires that WhatsApp be a registered
 * channel id on the `NotificationChannelAdapter` interface so call sites
 * can target it without import-time errors, but a real WhatsApp Cloud API
 * (or BSP) integration is intentionally out of scope for this milestone.
 *
 * Until that real adapter lands this stub:
 *
 *   • Implements `NotificationChannelAdapter` so the dispatcher can fan
 *     out to it through the same code path as `dashboard`, `email`, and
 *     `telegram` — no special-casing required (R13.2).
 *   • Returns `{ ok: false, reason: 'not_implemented' }` from `send` so
 *     the dispatcher records the `Notification` row as `failed` with a
 *     stable, machine-readable reason. It does NOT call any external
 *     WhatsApp endpoint and does NOT throw, so an accidental dispatch
 *     never blocks the caller or leaks credentials.
 *   • Stays disconnected from the dashboard's feature-toggle UI: per
 *     R21.4 the WhatsApp toggle stays hidden via `featureFlagService`
 *     until a real adapter replaces this file. Do NOT register this
 *     export in any channel-toggle registry yet.
 *
 * Replace this file's `send` implementation when the WhatsApp adapter is
 * activated; the `id: 'whatsapp'` contract and call sites stay stable.
 */
export const whatsappChannel: NotificationChannelAdapter = {
  id: "whatsapp",
  async send(_input): Promise<{ ok: false; reason: "not_implemented" }> {
    return { ok: false, reason: "not_implemented" };
  },
};
