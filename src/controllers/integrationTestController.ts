import type { Request, Response } from "express";
import axios from "axios";
import { z } from "zod";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { probePathaoToken } from "../integrations/pathao/pathaoService.js";
import { probeSteadfastConnection } from "../integrations/steadfast/steadfastService.js";

type TenantSettings = {
  sslcommerz?: { storeId?: string; storePassword?: string; isLive?: boolean };
  telegram?: { enabled?: boolean; botToken?: string; chatId?: string };
  pathao?: {
    baseUrl?: string;
    clientId?: string;
    clientSecret?: string;
    username?: string;
    password?: string;
    storeId?: number | string;
    isLive?: boolean;
  };
  steadfast?: {
    apiKey?: string;
    secretKey?: string;
  };
};

const PATHAO_LIVE = "https://api-hermes.pathao.com";
const PATHAO_SANDBOX = "https://courier-api-sandbox.pathao.com";

function tenantSettings(req: Request): TenantSettings {
  const raw = req.tenant?.settings;
  return (raw && typeof raw === "object" ? (raw as TenantSettings) : {});
}

const sslcommerzBody = z
  .object({
    storeId: z.string().trim().optional(),
    storePassword: z.string().optional(),
    isLive: z.boolean().optional(),
  })
  .partial()
  .optional();

/** Lightweight SSLCommerz credential check.
 *  Calls the real init endpoint with a small dummy session — gateway URL is NOT returned to the user.
 *  SSLCommerz returns status=SUCCESS only when store_id + store_passwd authenticate; otherwise
 *  failedreason contains a "Store Credential Error" style message. */
export async function testSslcommerz(req: Request, res: Response): Promise<void> {
  const parsed = sslcommerzBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Invalid body" });
    return;
  }
  const saved = tenantSettings(req).sslcommerz ?? {};
  const storeId = (parsed.data?.storeId ?? saved.storeId ?? "").trim();
  const storePassword = parsed.data?.storePassword ?? saved.storePassword ?? "";
  const isLive =
    typeof parsed.data?.isLive === "boolean"
      ? parsed.data.isLive
      : typeof saved.isLive === "boolean"
        ? saved.isLive
        : !config.sslcommerz.isSandbox;

  if (!storeId || !storePassword) {
    res.status(200).json({
      ok: false,
      message: "Store ID and password are required.",
    });
    return;
  }

  const url = isLive
    ? "https://securepay.sslcommerz.com/gwprocess/v4/api.php"
    : "https://sandbox.sslcommerz.com/gwprocess/v4/api.php";
  const tranId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const form = new URLSearchParams({
    store_id: storeId,
    store_passwd: storePassword,
    total_amount: "10",
    currency: "BDT",
    tran_id: tranId,
    success_url: `${config.publicBaseUrl}/webhooks/sslcommerz/return`,
    fail_url: `${config.publicBaseUrl}/webhooks/sslcommerz/return`,
    cancel_url: `${config.publicBaseUrl}/webhooks/sslcommerz/return`,
    ipn_url: `${config.publicBaseUrl}/webhooks/sslcommerz/ipn`,
    product_category: "general",
    cus_name: "Connection Test",
    cus_email: "test@example.com",
    cus_phone: "01700000000",
    cus_add1: "Dhaka",
    shipping_method: "NO",
    product_name: "Connection Test",
    product_profile: "general",
  });

  try {
    const r = await axios.post(url, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15_000,
      validateStatus: () => true,
    });
    const data = (r.data ?? {}) as { status?: string; failedreason?: string; GatewayPageURL?: string };
    if (r.status >= 400) {
      res.json({ ok: false, message: `HTTP ${r.status} from SSLCommerz`, detail: String(data?.failedreason ?? "") });
      return;
    }
    if (data.status === "SUCCESS" && data.GatewayPageURL) {
      res.json({
        ok: true,
        message: `Connected (${isLive ? "live" : "sandbox"}).`,
      });
      return;
    }
    res.json({
      ok: false,
      message: data.failedreason || "SSLCommerz rejected the credentials.",
      detail: data.status ? `status=${data.status}` : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: msg }, "SSLCommerz test failed");
    res.json({ ok: false, message: "Could not reach SSLCommerz.", detail: msg });
  }
}

const pathaoBody = z
  .object({
    baseUrl: z.string().url().optional(),
    isLive: z.boolean().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  })
  .partial()
  .optional();

/** Pathao credential check — just calls the issue-token endpoint. */
export async function testPathao(req: Request, res: Response): Promise<void> {
  const parsed = pathaoBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Invalid body" });
    return;
  }
  const saved = tenantSettings(req).pathao ?? {};
  const isLive =
    typeof parsed.data?.isLive === "boolean"
      ? parsed.data.isLive
      : typeof saved.isLive === "boolean"
        ? saved.isLive
        : false;
  const explicitBase = parsed.data?.baseUrl ?? saved.baseUrl;
  const baseUrl = (explicitBase ?? (isLive ? PATHAO_LIVE : PATHAO_SANDBOX)).replace(/\/$/, "");
  const clientId = parsed.data?.clientId ?? saved.clientId ?? "";
  const clientSecret = parsed.data?.clientSecret ?? saved.clientSecret ?? "";
  const username = parsed.data?.username ?? saved.username ?? "";
  const password = parsed.data?.password ?? saved.password ?? "";

  if (!clientId || !clientSecret || !username || !password) {
    res.json({ ok: false, message: "Client ID, secret, username, and password are required." });
    return;
  }

  try {
    const probe = await probePathaoToken({
      baseUrl,
      clientId,
      clientSecret,
      username,
      password,
      storeId: 0,
    });

    if (probe.ok) {
      const mode = baseUrl.includes("sandbox") ? "sandbox" : "live";
      res.json({
        ok: true,
        message: `Connected (${mode} via ${probe.apiStyle}).`,
        detail: `Token endpoint: ${probe.attemptedPath}`,
      });
      return;
    }

    const summary = probe.attempts
      .map((a) => `${a.path}→${a.status}${a.detail ? ` (${String(a.detail).slice(0, 80)})` : ""}`)
      .join("; ");
    res.json({
      ok: false,
      message: "Pathao rejected credentials on every known token endpoint.",
      detail: summary,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: msg }, "Pathao test failed");
    res.json({ ok: false, message: "Could not reach Pathao.", detail: msg });
  }
}

const telegramBody = z
  .object({
    botToken: z.string().trim().optional(),
    chatId: z.string().trim().optional(),
    enabled: z.boolean().optional(),
    webhookBaseUrl: z.string().url().optional(),
  })
  .partial()
  .optional();

function isLocalBaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /^(localhost|127\.0\.0\.1|::1)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Telegram setup check + webhook set for this tenant slug. */
export async function testTelegram(req: Request, res: Response): Promise<void> {
  const parsed = telegramBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Invalid body" });
    return;
  }
  const saved = tenantSettings(req).telegram ?? {};
  const botToken = (parsed.data?.botToken ?? saved.botToken ?? "").trim();
  const chatId = (parsed.data?.chatId ?? saved.chatId ?? "").trim();
  const enabled =
    typeof parsed.data?.enabled === "boolean"
      ? parsed.data.enabled
      : typeof saved.enabled === "boolean"
        ? saved.enabled
        : true;

  if (!enabled) {
    res.json({ ok: false, message: "Telegram integration is disabled in settings." });
    return;
  }
  if (!botToken || !chatId) {
    res.json({ ok: false, message: "Bot token and chat ID are required." });
    return;
  }
  const slug = req.tenant?.slug?.trim();
  if (!slug) {
    res.status(400).json({ ok: false, message: "Tenant slug missing." });
    return;
  }
  const requestBase = (parsed.data?.webhookBaseUrl ?? "").trim();
  const configuredBase = String(config.publicBaseUrl ?? "").trim();
  // Prefer dashboard-provided base only if it's public; otherwise fall back to
  // server-configured PUBLIC_BASE_URL.
  const baseCandidate =
    requestBase && !isLocalBaseUrl(requestBase)
      ? requestBase
      : configuredBase && !isLocalBaseUrl(configuredBase)
        ? configuredBase
        : requestBase || configuredBase;
  const base = baseCandidate.replace(/\/$/, "");
  if (isLocalBaseUrl(base)) {
    res.json({
      ok: false,
      message: "Webhook base URL must be publicly reachable (not localhost).",
      detail:
        "Set NEXT_PUBLIC_WEBHOOK_BASE_URL (client) or PUBLIC_BASE_URL (server) to your public API domain (example: https://api.pipwarp.com).",
    });
    return;
  }
  const webhookUrl = `${base}/webhooks/telegram/${encodeURIComponent(slug)}`;

  try {
    const api = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: 15_000,
      validateStatus: () => true,
    });
    const me = await api.get("/getMe");
    if (me.status >= 400 || !me.data?.ok) {
      res.json({ ok: false, message: "Telegram bot token is invalid.", detail: `HTTP ${me.status}` });
      return;
    }

    const setRes = await api.post("/setWebhook", { url: webhookUrl });
    if (setRes.status >= 400 || !setRes.data?.ok) {
      res.json({
        ok: false,
        message: "Telegram setWebhook failed.",
        detail: String(setRes.data?.description ?? `HTTP ${setRes.status}`),
      });
      return;
    }

    const infoRes = await api.get("/getWebhookInfo");
    const info = infoRes.data?.result ?? {};
    const got = String(info.url ?? "");
    if (got !== webhookUrl) {
      res.json({
        ok: false,
        message: "Webhook set but URL mismatch.",
        detail: `Expected ${webhookUrl}, got ${got || "(empty)"}`,
      });
      return;
    }

    // Also send a test message to validate chat_id correctness.
    const msgRes = await api.post("/sendMessage", {
      chat_id: chatId,
      text: `Telegram connected for tenant "${slug}". Manual payment alerts will appear here.`,
      disable_web_page_preview: true,
    });
    if (msgRes.status >= 400 || !msgRes.data?.ok) {
      res.json({
        ok: false,
        message: "Webhook set, but failed to send test message to chat ID.",
        detail: String(msgRes.data?.description ?? `HTTP ${msgRes.status}`),
      });
      return;
    }

    res.json({
      ok: true,
      message: "Telegram webhook set and verified. Test message sent.",
      detail: webhookUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: msg }, "Telegram test failed");
    res.json({ ok: false, message: "Could not reach Telegram API.", detail: msg });
  }
}


const steadfastBody = z
  .object({
    apiKey: z.string().trim().optional(),
    secretKey: z.string().trim().optional(),
  })
  .partial()
  .optional();

/** Steadfast credential check — calls /get_balance with Api-Key + Secret-Key headers. */
export async function testSteadfast(req: Request, res: Response): Promise<void> {
  const parsed = steadfastBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Invalid body" });
    return;
  }
  const saved = tenantSettings(req).steadfast ?? {};
  const apiKey = parsed.data?.apiKey ?? saved.apiKey ?? "";
  const secretKey = parsed.data?.secretKey ?? saved.secretKey ?? "";
  if (!apiKey || !secretKey) {
    res.json({ ok: false, message: "API Key and Secret Key are required." });
    return;
  }
  try {
    const probe = await probeSteadfastConnection({ apiKey, secretKey });
    if (probe.ok) {
      res.json({
        ok: true,
        message: "Connected to Steadfast.",
        detail: probe.balance != null ? `Current balance: ${probe.balance} BDT` : undefined,
      });
      return;
    }
    res.json({
      ok: false,
      message: "Steadfast rejected credentials.",
      detail: `HTTP ${probe.status}: ${probe.detail}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: msg }, "Steadfast test failed");
    res.json({ ok: false, message: "Could not reach Steadfast.", detail: msg });
  }
}
