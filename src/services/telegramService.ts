import axios from "axios";
import { logger } from "../utils/logger.js";

type TelegramInlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

function apiBase(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}`;
}

export async function ensureTelegramWebhook(args: {
  botToken: string;
  webhookUrl: string;
}): Promise<{ ok: boolean; detail?: string }> {
  try {
    const info = await axios.get(`${apiBase(args.botToken)}/getWebhookInfo`, {
      timeout: 15_000,
      validateStatus: () => true,
    });
    const currentUrl = String(info.data?.result?.url ?? "");
    if (currentUrl === args.webhookUrl) {
      return { ok: true, detail: "already_set" };
    }
    const setRes = await axios.post(
      `${apiBase(args.botToken)}/setWebhook`,
      {
        url: args.webhookUrl,
        allowed_updates: ["callback_query"],
      },
      { timeout: 15_000, validateStatus: () => true },
    );
    if (setRes.status >= 400 || !setRes.data?.ok) {
      return {
        ok: false,
        detail: String(setRes.data?.description ?? `HTTP ${setRes.status}`),
      };
    }
    return { ok: true, detail: "updated" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendTelegramMessage(args: {
  botToken: string;
  chatId: string;
  text: string;
  inlineKeyboard?: TelegramInlineKeyboard;
}): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: args.chatId,
    text: args.text,
    disable_web_page_preview: true,
  };
  if (args.inlineKeyboard) body.reply_markup = { inline_keyboard: args.inlineKeyboard };
  await axios.post(`${apiBase(args.botToken)}/sendMessage`, body, { timeout: 20_000 });
}

export async function answerTelegramCallback(args: {
  botToken: string;
  callbackQueryId: string;
  text?: string;
}): Promise<void> {
  await axios
    .post(
      `${apiBase(args.botToken)}/answerCallbackQuery`,
      {
        callback_query_id: args.callbackQueryId,
        text: args.text,
        show_alert: false,
      },
      { timeout: 20_000 },
    )
    .catch((e) => logger.warn({ e: String(e) }, "telegram answerCallbackQuery failed"));
}

export async function editTelegramMessage(args: {
  botToken: string;
  chatId: string;
  messageId: number;
  text: string;
}): Promise<void> {
  await axios
    .post(
      `${apiBase(args.botToken)}/editMessageText`,
      {
        chat_id: args.chatId,
        message_id: args.messageId,
        text: args.text,
        disable_web_page_preview: true,
      },
      { timeout: 20_000 },
    )
    .catch((e) => logger.warn({ e: String(e) }, "telegram editMessageText failed"));
}

