import { prisma } from "../../../db/prisma.js";
import { logger } from "../../../utils/logger.js";
import { parseTenantSettings } from "../../../types/tenant-settings.js";
import {
  sendTelegramDocument,
  sendTelegramMessage,
} from "../../telegramService.js";
import type { NotificationChannelAdapter } from "../types.js";

/**
 * Telegram channel adapter (R13.1, R13.4, R13.6, R22.8).
 *
 * Thin wrapper around `src/services/telegramService.ts`. Per the design,
 * each Notification row is already persisted by the dispatcher; this
 * adapter only resolves the tenant's Telegram config, formats the message,
 * sends it, and returns `{ ok, reason? }`.
 *
 * Behavioural rules from the design:
 *
 *  • For `type === 'payment.success'` (or any payload that carries a
 *    `pdfPath` like an invoice) we additionally upload the PDF via
 *    `sendTelegramDocument`. This preserves the existing post-payment
 *    Telegram-invoice-PDF flow that lives in `orderWorkflowService`.
 *
 *  • Only `manual_payment_alert` events render the existing Confirm /
 *    Reject inline-keyboard buttons. Subscription / billing events
 *    (`subscription.*`, `payment.*` other than the manual workflow) are
 *    informational and ship plain text — adding buttons there would wire
 *    the existing `mp_ok:` / `mp_no:` callback handler to actions it
 *    cannot fulfil.
 */

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

async function loadTelegramConfig(
  tenantId: string,
): Promise<TelegramConfig | { error: string }> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) {
    return { error: "tenant_not_found" };
  }
  const settings = parseTenantSettings(tenant.settings);
  const tg = settings.telegram;
  if (!tg?.enabled) {
    return { error: "telegram_disabled_for_tenant" };
  }
  const botToken = tg.botToken?.trim();
  const chatId = tg.chatId?.trim();
  if (!botToken || !chatId) {
    return { error: "telegram_config_missing" };
  }
  return { botToken, chatId };
}

/**
 * Confirm / Reject inline keyboard preserved from the manual-payment alert
 * flow in `orderWorkflowService.sendManualPaymentTelegramAlert`. The
 * callback_data values (`mp_ok:<orderId>`, `mp_no:<orderId>`) match the
 * regex the existing `telegramWebhookController` listens for, so the
 * buttons keep working without webhook changes (R13.6, R22.8).
 */
function buildManualPaymentKeyboard(
  payload: unknown,
): InlineKeyboard | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const orderId = (payload as Record<string, unknown>)["orderId"];
  if (typeof orderId !== "string" || orderId.trim() === "") return undefined;
  return [
    [
      { text: "Confirm payment", callback_data: `mp_ok:${orderId}` },
      { text: "Reject", callback_data: `mp_no:${orderId}` },
    ],
  ];
}

function extractPdfPath(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const v = (payload as Record<string, unknown>)["pdfPath"];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function renderText(type: string, payload: unknown): string {
  const head = `🔔 ${type}`;
  if (!payload || typeof payload !== "object") return head;
  const obj = payload as Record<string, unknown>;
  // Skip noisy keys; surface a compact summary that fits Telegram's text
  // budget. Full payload remains visible on the dashboard row.
  const skip = new Set(["pdfPath", "_failureReason"]);
  const lines: string[] = [head];
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k)) continue;
    if (v == null) continue;
    const rendered =
      typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : safeJson(v);
    lines.push(`${k}: ${rendered}`.slice(0, 400));
  }
  return lines.join("\n").slice(0, 4000);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserialisable]";
  }
}

export const telegramChannel: NotificationChannelAdapter = {
  id: "telegram",
  async send(input) {
    const cfgOrError = await loadTelegramConfig(input.tenantId);
    if ("error" in cfgOrError) {
      return { ok: false, reason: cfgOrError.error };
    }
    const { botToken, chatId } = cfgOrError;

    const isManualPaymentAlert = input.type === "manual_payment_alert";
    const inlineKeyboard = isManualPaymentAlert
      ? buildManualPaymentKeyboard(input.payload)
      : undefined;

    try {
      await sendTelegramMessage({
        botToken,
        chatId,
        text: renderText(input.type, input.payload),
        inlineKeyboard,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          tenantId: input.tenantId,
          type: input.type,
          err: reason,
        },
        "telegram_adapter_send_failed",
      );
      return { ok: false, reason };
    }

    // Document upload happens AFTER the text message so the recipient sees
    // the context first, matching the existing manual-payment flow.
    const pdfPath = extractPdfPath(input.payload);
    const wantsDocument = input.type === "payment.success" || Boolean(pdfPath);
    if (wantsDocument && pdfPath) {
      try {
        await sendTelegramDocument({
          botToken,
          chatId,
          filePath: pdfPath,
          caption: `Invoice — ${input.type}`,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // The text message already landed, so we degrade to a partial
        // success: log the document failure but report ok=true so the
        // Notification row reflects that the operator was informed.
        logger.warn(
          {
            tenantId: input.tenantId,
            type: input.type,
            pdfPath,
            err: reason,
          },
          "telegram_adapter_document_send_failed",
        );
      }
    }

    return { ok: true };
  },
};
