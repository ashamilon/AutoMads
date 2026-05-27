import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import type {
  DispatchInput,
  NotificationChannelAdapter,
  NotificationChannelId,
} from "./types.js";

/**
 * Notification Dispatcher.
 *
 * Responsibilities:
 *  - Persist a `Notification` row for every (tenantId, channel, type) so the
 *    dashboard / admin panel can drill into delivery state (R13.1, R13.3).
 *  - Fan out to each registered adapter for the requested channels.
 *  - Aggregate per-channel results so callers can act on partial success.
 *
 * Non-responsibilities:
 *  - Per-channel retry policy. Each adapter owns its own retry strategy
 *    (e.g. email channel implements 3-try exponential backoff in task 9.2).
 *  - Sending — adapter implementations do that. The dispatcher itself never
 *    talks to an external service.
 */

const channelRegistry = new Map<NotificationChannelId, NotificationChannelAdapter>();

export function registerChannel(adapter: NotificationChannelAdapter): void {
  channelRegistry.set(adapter.id, adapter);
}

export function getRegisteredChannels(): NotificationChannelId[] {
  return Array.from(channelRegistry.keys());
}

/**
 * Test/bootstrap helper. Not part of the dispatcher's public surface for
 * runtime callers. Exposed so test setup and bootstrap code can reset the
 * registry between runs.
 */
export function clearRegisteredChannels(): void {
  channelRegistry.clear();
}

export interface DispatchChannelResult {
  channel: NotificationChannelId;
  ok: boolean;
  reason?: string;
  notificationId: string;
}

export interface DispatchResult {
  tenantId: string;
  results: DispatchChannelResult[];
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { tenantId, channels, type, payload } = input;

  logger.info(
    { tenantId, type, channels },
    "notification_dispatch_start",
  );

  const results: DispatchChannelResult[] = [];

  for (const channel of channels) {
    // 1. Persist the queued row first so the dashboard can see in-flight work
    //    and we have a stable id to thread through the adapter contract.
    const notification = await prisma.notification.create({
      data: {
        tenantId,
        channel,
        type,
        payload: toJsonValue(payload),
        status: "queued",
        attempts: 0,
      },
    });

    const adapter = channelRegistry.get(channel);

    if (!adapter) {
      // Unknown channel: mark the persisted row as failed with a structured
      // reason so the admin panel can surface the misconfiguration. Continue
      // with the remaining channels rather than aborting the fan-out.
      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: "failed",
          payload: extendPayload(payload, {
            reason: "channel_not_registered",
          }),
          sentAt: null,
        },
      });

      results.push({
        channel,
        ok: false,
        reason: "channel_not_registered",
        notificationId: notification.id,
      });
      continue;
    }

    try {
      const result = await adapter.send({
        tenantId,
        type,
        payload,
        notificationId: notification.id,
      });

      if (result.ok) {
        await prisma.notification.update({
          where: { id: notification.id },
          data: {
            status: "delivered",
            sentAt: new Date(),
            attempts: { increment: 1 },
          },
        });

        results.push({
          channel,
          ok: true,
          notificationId: notification.id,
        });
      } else {
        const reason = result.reason ?? "adapter_returned_not_ok";
        await prisma.notification.update({
          where: { id: notification.id },
          data: {
            status: "failed",
            payload: extendPayload(payload, { _failureReason: reason }),
            attempts: { increment: 1 },
          },
        });

        results.push({
          channel,
          ok: false,
          reason,
          notificationId: notification.id,
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        { tenantId, type, channel, err: reason },
        "notification_adapter_threw",
      );
      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: "failed",
          payload: extendPayload(payload, { _failureReason: reason }),
          attempts: { increment: 1 },
        },
      });

      results.push({
        channel,
        ok: false,
        reason,
        notificationId: notification.id,
      });
    }
  }

  logger.info(
    { tenantId, type, channels },
    "notification_dispatch_complete",
  );

  return { tenantId, results };
}

/**
 * Coerce arbitrary payloads into a Prisma-safe JSON value without mutating
 * the caller's object. Non-object payloads are wrapped under `{ value }` so
 * the column always stores a JSON object the dashboard can render.
 */
function toJsonValue(payload: unknown): Prisma.InputJsonValue {
  if (payload === null || payload === undefined) {
    return {} as Prisma.InputJsonValue;
  }
  if (typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>) } as Prisma.InputJsonValue;
  }
  return { value: payload } as Prisma.InputJsonValue;
}

/**
 * Returns a NEW JSON-safe object combining `payload` with `extra`. Never
 * mutates the caller's original payload (R: dispatcher must not mutate
 * inputs).
 */
function extendPayload(
  payload: unknown,
  extra: Record<string, unknown>,
): Prisma.InputJsonValue {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...(payload as Record<string, unknown>),
      ...extra,
    } as Prisma.InputJsonValue;
  }
  return { value: payload, ...extra } as Prisma.InputJsonValue;
}
