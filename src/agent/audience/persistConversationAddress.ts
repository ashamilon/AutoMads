/**
 * Persist a resolved address style on `MessengerConversation.pendingDraftJson.preferences.addressStyle`
 * so the next turn's Reasoning_Context builder picks it up as the conversation override.
 *
 * Behavior:
 *  - Reads the existing `pendingDraftJson`, merges `preferences.addressStyle` non-destructively.
 *  - Idempotent — re-locking the same style is a no-op write of the same JSON.
 *  - Best-effort — Prisma errors are swallowed so a transient DB failure never breaks the turn.
 *
 * Why store it on `pendingDraftJson.preferences` rather than a new column:
 *  - The schema rule for this rollout is "no migrations, reuse JSON columns" (R23.3, R14.6).
 *  - The reasoning context builder already reads `pendingDraftJson.preferences` for the
 *    address override — keeping the read and write on the same key avoids drift.
 *
 * Maps to: R7.1, R18.7, R23.3.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import type { ResolvedAddress } from "./types.js";

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function lockConversationAddress(
  conversationId: string,
  addressStyle: ResolvedAddress,
): Promise<void> {
  if (!conversationId) return;
  try {
    const convo = await prisma.messengerConversation.findUnique({
      where: { id: conversationId },
      select: { pendingDraftJson: true },
    });
    const prev = asObject(convo?.pendingDraftJson);
    const prevPrefs = asObject(prev["preferences"]);
    if (prevPrefs["addressStyle"] === addressStyle) {
      // Already locked to this style — skip the write to keep the audit trail
      // free of no-op `updatedAt` churn.
      return;
    }
    const next: Record<string, unknown> = {
      ...prev,
      preferences: {
        ...prevPrefs,
        addressStyle,
      },
    };
    await prisma.messengerConversation.update({
      where: { id: conversationId },
      data: { pendingDraftJson: next as Prisma.InputJsonValue },
    });
  } catch (err) {
    logger.warn(
      {
        event: "audience_address_persist_failed",
        conversationId,
        err: err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) },
      },
      "audience address persist failed",
    );
  }
}
