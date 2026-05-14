import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { parseTenantSettings } from "../types/tenant-settings.js";
import { answerTelegramCallback, editTelegramMessage } from "../services/telegramService.js";
import { appendManualPaymentAdminLog, confirmManualPayment } from "../services/orderWorkflowService.js";
import { logger } from "../utils/logger.js";

function parseAction(data: string): { action: "ok" | "reject"; orderId: string } | null {
  if (!data) return null;
  if (data.startsWith("mp_ok:")) return { action: "ok", orderId: data.slice("mp_ok:".length) };
  if (data.startsWith("mp_no:")) return { action: "reject", orderId: data.slice("mp_no:".length) };
  return null;
}

export async function telegramWebhook(req: Request, res: Response): Promise<void> {
  logger.info(
    {
      tenantSlug: String(req.params.tenantSlug ?? ""),
      hasCallbackQuery: Boolean((req.body as { callback_query?: unknown } | undefined)?.callback_query),
    },
    "Telegram webhook received",
  );
  const tenantSlug = String(req.params.tenantSlug ?? "").trim();
  if (!tenantSlug) {
    res.status(400).json({ ok: false, error: "tenant_slug_required" });
    return;
  }
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) {
    res.status(404).json({ ok: false, error: "tenant_not_found" });
    return;
  }
  const settings = parseTenantSettings(tenant.settings);
  const tg = settings.telegram;
  if (!tg?.enabled || !tg.botToken?.trim() || !tg.chatId?.trim()) {
    res.json({ ok: true, skipped: "telegram_not_configured" });
    return;
  }
  const botToken = tg.botToken.trim();
  const chatId = tg.chatId.trim();

  const callback = (req.body ?? {}) as {
    callback_query?: {
      id?: string;
      data?: string;
      from?: { id?: number; username?: string; first_name?: string };
      message?: { message_id?: number; chat?: { id?: number | string }; text?: string };
    };
  };
  const cb = callback.callback_query;
  if (!cb?.id || !cb.data) {
    res.json({ ok: true });
    return;
  }

  const parsed = parseAction(cb.data);
  if (!parsed) {
    await answerTelegramCallback({ botToken, callbackQueryId: cb.id, text: "Unknown action" });
    res.json({ ok: true });
    return;
  }

  const chatIdFromUpdate = cb.message?.chat?.id != null ? String(cb.message.chat.id) : "";
  if (chatIdFromUpdate !== chatId) {
    await answerTelegramCallback({ botToken, callbackQueryId: cb.id, text: "Unauthorized chat" });
    res.json({ ok: true });
    return;
  }

  const order = await prisma.order.findFirst({
    where: { id: parsed.orderId, tenantId: tenant.id },
  });
  if (!order) {
    await answerTelegramCallback({ botToken, callbackQueryId: cb.id, text: "Order not found" });
    res.json({ ok: true });
    return;
  }

  // ACK immediately so Telegram button never "spins then resets".
  await answerTelegramCallback({
    botToken,
    callbackQueryId: cb.id,
    text: parsed.action === "ok" ? "Processing confirmation..." : "Processing rejection...",
  });
  res.json({ ok: true });

  void (async () => {
    if (parsed.action === "ok") {
      try {
        const rail = order.paymentMethod === "NAGAD_MANUAL" ? "NAGAD_MANUAL" : "BKASH_MANUAL";
        const verifier =
          cb.from?.username?.trim() ||
          cb.from?.first_name?.trim() ||
          (cb.from?.id ? `telegram:${cb.from.id}` : "telegram_admin");
        await confirmManualPayment({
          orderId: order.id,
          tenantId: tenant.id,
          rail,
          reference: order.manualTxnId ?? undefined,
          verifiedBy: verifier,
          note: "Verified from Telegram inline action",
        });
        if (cb.message?.message_id) {
          await editTelegramMessage({
            botToken,
            chatId,
            messageId: cb.message.message_id,
            text: `${cb.message.text ?? "Manual payment request"}\n\n✅ Confirmed by ${verifier}`,
          });
        }
        await appendManualPaymentAdminLog({
          tenantId: tenant.id,
          event: "admin_confirmed_payment",
          orderId: order.id,
          psid: order.messengerPsid,
          rail,
          reference: order.manualTxnId ?? undefined,
          message: `Telegram admin: ${verifier}`,
        });
      } catch (e) {
        logger.error({ e, orderId: order.id, tenantId: tenant.id }, "Telegram manual confirm failed");
        await appendManualPaymentAdminLog({
          tenantId: tenant.id,
          event: "admin_confirm_failed",
          level: "error",
          orderId: order.id,
          psid: order.messengerPsid,
          rail: order.paymentMethod === "NAGAD_MANUAL" ? "NAGAD_MANUAL" : "BKASH_MANUAL",
          reference: order.manualTxnId ?? undefined,
          message: String(e),
        });
        if (cb.message?.message_id) {
          await editTelegramMessage({
            botToken,
            chatId,
            messageId: cb.message.message_id,
            text: `${cb.message.text ?? "Manual payment request"}\n\n⚠️ Confirmation failed. Please retry.`,
          });
        }
      }
      return;
    }

    try {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          manualPaymentNote: `Rejected in Telegram by ${cb.from?.username ?? cb.from?.id ?? "admin"}`,
        },
      });
      await appendManualPaymentAdminLog({
        tenantId: tenant.id,
        event: "admin_rejected_payment",
        level: "warn",
        orderId: order.id,
        psid: order.messengerPsid,
        rail: order.paymentMethod === "NAGAD_MANUAL" ? "NAGAD_MANUAL" : "BKASH_MANUAL",
        reference: order.manualTxnId ?? undefined,
        message: `Telegram admin: ${cb.from?.username ?? cb.from?.id ?? "admin"}`,
      });
      if (cb.message?.message_id) {
        await editTelegramMessage({
          botToken,
          chatId,
          messageId: cb.message.message_id,
          text: `${cb.message.text ?? "Manual payment request"}\n\n❌ Rejected`,
        });
      }
    } catch (e) {
      logger.error({ e, orderId: order.id, tenantId: tenant.id }, "Telegram manual reject failed");
      await appendManualPaymentAdminLog({
        tenantId: tenant.id,
        event: "admin_reject_failed",
        level: "error",
        orderId: order.id,
        psid: order.messengerPsid,
        rail: order.paymentMethod === "NAGAD_MANUAL" ? "NAGAD_MANUAL" : "BKASH_MANUAL",
        reference: order.manualTxnId ?? undefined,
        message: String(e),
      });
    }
  })();
}

