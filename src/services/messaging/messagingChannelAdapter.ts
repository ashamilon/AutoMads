/**
 * MessagingChannelAdapter — interface-only contract for outbound messaging surfaces.
 *
 * The current production pipeline is Facebook Messenger. This module defines the
 * shape that future channels (`whatsapp`, `voice`) must conform to so they can
 * be plugged in side-by-side without touching the agent loop.
 *
 * Note: inbound messages enter via the existing webhook controllers (see
 * `src/controllers/messengerWebhookController` and friends). The adapter
 * intentionally does NOT define a `receive()` method — its only job is to
 * standardize the outbound surface and the inbound message shape.
 *
 * Maps to: Requirements 21.1, 21.2, 21.3, 21.4.
 */

export type MessagingChannelId = 'messenger' | 'whatsapp' | 'voice';

/**
 * Normalized inbound message shape that webhook controllers translate raw
 * channel payloads into before handing them to the agent loop.
 *
 * `senderId` semantics by channel:
 *   - `messenger` → Facebook PSID
 *   - `whatsapp`  → E.164 phone number
 *   - `voice`     → call session id
 */
export interface InboundMessage {
  readonly tenantId: string;
  readonly senderId: string;
  readonly text: string;
  readonly imageUrls?: string[];
  readonly receivedAt: Date;
  readonly raw?: unknown;
}

/**
 * Outbound surface every messaging channel must implement.
 *
 * Implementations MUST short-circuit when the tenant's subscription is not
 * operational (see `ReasoningContext.subscription.isOperational`). The check
 * is performed by callers, not by adapters, but adapters SHOULD treat a
 * disabled channel as a non-throwing `{ ok: false, reason }` result.
 */
export interface MessagingChannelAdapter {
  readonly id: MessagingChannelId;
  send(input: {
    tenantId: string;
    recipientId: string;
    text: string;
  }): Promise<{ ok: boolean; reason?: string }>;
}
