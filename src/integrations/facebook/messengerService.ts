import axios from "axios";
import { logger } from "../../utils/logger.js";
import { getMessengerReplyToMidFromContext } from "./messengerReplyContext.js";

const GRAPH = "https://graph.facebook.com/v21.0";

export function isSimulatorPsid(psid: string): boolean {
  return psid.startsWith("SIM_");
}

/** Only allow Meta CDN / graph hosts to avoid SSRF when downloading webhook attachment URLs */
export function isMessengerHostedMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h.endsWith("fbcdn.net")) return true;
    if (h.endsWith("facebook.com")) return true;
    if (h.endsWith("fbsbx.com")) return true;
    return false;
  } catch {
    return false;
  }
}

/** Download binary from Messenger attachment URL (requires Page access token). */
export async function downloadMessengerAttachment(url: string, pageAccessToken: string): Promise<Buffer> {
  if (!isMessengerHostedMediaUrl(url)) {
    throw new Error("attachment_url_not_allowed");
  }
  const res = await axios.get<ArrayBuffer>(url, {
    params: { access_token: pageAccessToken },
    responseType: "arraybuffer",
    timeout: 45_000,
    maxContentLength: 6 * 1024 * 1024,
    maxBodyLength: 6 * 1024 * 1024,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    logger.warn({ status: res.status, url: url.slice(0, 80) }, "Messenger attachment download failed");
    throw new Error(`attachment_download_${res.status}`);
  }
  return Buffer.from(res.data);
}

function resolveReplyToMid(explicit: string | undefined): string | undefined {
  const v = explicit ?? getMessengerReplyToMidFromContext();
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function attachReplyToBody(body: Record<string, unknown>, replyToMid: string | undefined): void {
  // Meta requires `reply_to` on the Send API root — not inside `message` (that returns #100 invalid keys).
  if (replyToMid) body.reply_to = { mid: replyToMid };
}

export async function sendMessengerText(opts: {
  pageAccessToken: string;
  psid: string;
  text: string;
  within24hWindow: boolean;
  /** When set, threads this send under that message id (overrides inbound-turn context). */
  replyToMid?: string;
}): Promise<void> {
  if (isSimulatorPsid(opts.psid)) {
    logger.info({ psid: opts.psid, text: opts.text.slice(0, 160) }, "Simulator messenger text send skipped");
    return;
  }
  const replyToMid = resolveReplyToMid(opts.replyToMid);
  const body: Record<string, unknown> = {
    recipient: { id: opts.psid },
    message: { text: opts.text },
  };
  attachReplyToBody(body, replyToMid);
  if (opts.within24hWindow) {
    body.messaging_type = "RESPONSE";
  } else {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "ACCOUNT_UPDATE";
  }

  const res = await axios.post(`${GRAPH}/me/messages`, body, {
    params: { access_token: opts.pageAccessToken },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    logger.error({ status: res.status, data: res.data }, "Messenger send failed");
    throw new Error(`Messenger API error: ${res.status}`);
  }
}

export async function sendMessengerImage(opts: {
  pageAccessToken: string;
  psid: string;
  imageUrl: string;
  within24hWindow: boolean;
  replyToMid?: string;
}): Promise<{ messageId?: string }> {
  if (isSimulatorPsid(opts.psid)) {
    logger.info({ psid: opts.psid, imageUrl: opts.imageUrl.slice(0, 180) }, "Simulator messenger image send skipped");
    return {};
  }
  const replyToMid = resolveReplyToMid(opts.replyToMid);
  const body: Record<string, unknown> = {
    recipient: { id: opts.psid },
    message: {
      attachment: {
        type: "image",
        payload: { url: opts.imageUrl, is_reusable: false },
      },
    },
  };
  attachReplyToBody(body, replyToMid);
  if (opts.within24hWindow) {
    body.messaging_type = "RESPONSE";
  } else {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "ACCOUNT_UPDATE";
  }

  const res = await axios.post(`${GRAPH}/me/messages`, body, {
    params: { access_token: opts.pageAccessToken },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    logger.error({ status: res.status, data: res.data }, "Messenger image send failed");
    throw new Error(`Messenger API image error: ${res.status}`);
  }
  const mid = (res.data as Record<string, unknown>)?.message_id;
  return { messageId: typeof mid === "string" ? mid : undefined };
}

export async function sendMessengerFile(opts: {
  pageAccessToken: string;
  psid: string;
  fileUrl: string;
  within24hWindow: boolean;
  replyToMid?: string;
}): Promise<void> {
  if (isSimulatorPsid(opts.psid)) {
    logger.info({ psid: opts.psid, fileUrl: opts.fileUrl.slice(0, 180) }, "Simulator messenger file send skipped");
    return;
  }
  const replyToMid = resolveReplyToMid(opts.replyToMid);
  const body: Record<string, unknown> = {
    recipient: { id: opts.psid },
    message: {
      attachment: {
        type: "file",
        payload: { url: opts.fileUrl, is_reusable: false },
      },
    },
  };
  attachReplyToBody(body, replyToMid);
  if (opts.within24hWindow) {
    body.messaging_type = "RESPONSE";
  } else {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "ACCOUNT_UPDATE";
  }
  const res = await axios.post(`${GRAPH}/me/messages`, body, {
    params: { access_token: opts.pageAccessToken },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    logger.error({ status: res.status, data: res.data }, "Messenger file send failed");
    throw new Error(`Messenger API file error: ${res.status}`);
  }
}

export function isWithinMessagingWindow(lastUserMessageAt: Date): boolean {
  const ms = Date.now() - lastUserMessageAt.getTime();
  return ms < 24 * 60 * 60 * 1000;
}
