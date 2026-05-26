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

/**
 * Upload a local file to Telegram via the `sendDocument` endpoint.
 *
 * Used by the post-payment pipeline to ship a copy of the invoice PDF to the
 * tenant's own Telegram chat right after a payment is confirmed. Pure
 * best-effort — surfaces errors via the returned promise so callers can wrap
 * in a `.catch` + warn log without disrupting the main flow.
 *
 * The `caption` field shows up under the file in the Telegram client. Keep
 * it short (Telegram caps at 1024 chars).
 *
 * Implementation note: Telegram requires a real `multipart/form-data` request
 * for file uploads — JSON won't work — so we lazily import Node's built-in
 * `node:fs` + `form-data` to build the body. `form-data` is already a
 * transitive dependency through axios.
 */
export async function sendTelegramDocument(args: {
  botToken: string;
  chatId: string;
  filePath: string;
  filename?: string;
  caption?: string;
}): Promise<void> {
  const fs = await import("node:fs");
  const FormData = (await import("form-data")).default;
  const stat = await fs.promises.stat(args.filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`telegram_doc_missing_file: ${args.filePath}`);
  }
  const fd = new FormData();
  fd.append("chat_id", args.chatId);
  if (args.caption) fd.append("caption", args.caption.slice(0, 1024));
  fd.append("document", fs.createReadStream(args.filePath), {
    filename: args.filename ?? args.filePath.split(/[\\/]/).pop() ?? "invoice.pdf",
    contentType: "application/pdf",
  });
  await axios.post(`${apiBase(args.botToken)}/sendDocument`, fd, {
    headers: fd.getHeaders(),
    timeout: 30_000,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
  });
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

