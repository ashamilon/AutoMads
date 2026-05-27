/**
 * Notification channel adapter interface and dispatcher input types.
 *
 * Concrete adapter implementations (dashboard, email, telegram, whatsapp,
 * facebook) live under `src/services/notifications/adapters/` and are wired
 * into the dispatcher via `registerChannel`. The dispatcher itself does not
 * send anything — it only fans out to registered adapters and persists
 * `Notification` rows for visibility (R13.1, R13.2, R13.3, R13.4).
 */

export type NotificationChannelId =
  | "dashboard"
  | "email"
  | "telegram"
  | "whatsapp"
  | "facebook";

export interface NotificationChannelAdapter {
  readonly id: NotificationChannelId;
  send(input: {
    tenantId: string;
    type: string;
    payload: unknown;
    notificationId: string;
  }): Promise<{ ok: boolean; reason?: string }>;
}

export interface DispatchInput {
  tenantId: string;
  channels: NotificationChannelId[];
  type: string;
  payload: unknown;
}
