import type { Request, Response } from "express";
import crypto from "node:crypto";
import { prisma } from "../db/prisma.js";
import { config } from "../config/index.js";
import { isMessengerHostedMediaUrl } from "../integrations/facebook/messengerService.js";
import { handleInboundMessengerMessage } from "../services/orderWorkflowService.js";
import { logger } from "../utils/logger.js";

type TenantRow = {
  facebookPageId: string | null;
  facebookPageAccessToken: string | null;
  settings: unknown;
};

function resolvePageAccessToken(tenant: TenantRow, entryPageId: string | undefined): string | null {
  if (!entryPageId) return tenant.facebookPageAccessToken;
  if (tenant.facebookPageId && entryPageId === tenant.facebookPageId) {
    return tenant.facebookPageAccessToken;
  }
  const settings =
    tenant.settings && typeof tenant.settings === "object" && !Array.isArray(tenant.settings)
      ? (tenant.settings as Record<string, unknown>)
      : {};
  const pages =
    settings["facebookPages"] && typeof settings["facebookPages"] === "object" && !Array.isArray(settings["facebookPages"])
      ? (settings["facebookPages"] as Record<string, unknown>)
      : {};
  const pageEntry = pages[entryPageId];
  if (pageEntry && typeof pageEntry === "object" && !Array.isArray(pageEntry)) {
    const rec = pageEntry as Record<string, unknown>;
    if (rec["enabled"] === false) return null;
    const token = rec["pageAccessToken"];
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  if (!tenant.facebookPageId) return tenant.facebookPageAccessToken;
  return null;
}

const tenantWebhookChains = new Map<string, Promise<void>>();

function enqueueTenantWebhookWork(tenantId: string, fn: () => Promise<void>): void {
  const prev = tenantWebhookChains.get(tenantId) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((e) => {
      logger.error({ e, tenantId }, "Queued tenant webhook job failed");
    });
  tenantWebhookChains.set(
    tenantId,
    next.finally(() => {
      if (tenantWebhookChains.get(tenantId) === next) tenantWebhookChains.delete(tenantId);
    }),
  );
}

function verifySignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  const secret = config.facebookAppSecret;
  // Fail CLOSED if the app secret isn't configured. Earlier this returned
  // `true` when the secret was empty, which meant a misconfigured production
  // server (env var missing) would silently accept any unsigned payload —
  // including spoofed customer messages forged by anyone who knows a tenant
  // slug. Refusing the request makes the misconfiguration loud and makes
  // spoofing impossible. Test harnesses that need to bypass should inject a
  // real secret + sign the request, just like Meta does.
  if (!secret) {
    logger.error(
      { event: "facebook_webhook_no_secret" },
      "FACEBOOK_APP_SECRET is not set — refusing to accept unverified Messenger webhook payloads. Set the env var to enable signature verification.",
    );
    return false;
  }
  if (!rawBody || !signature?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature.slice(7), "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export async function verifyFacebookWebhook(req: Request, res: Response): Promise<void> {
  try {
    const mode = req.query["hub.mode"] as string | undefined;
    const token = req.query["hub.verify_token"] as string | undefined;
    const challenge = req.query["hub.challenge"] as string | undefined;
    const slug = String(req.params["tenantSlug"] ?? "");

    if (mode !== "subscribe" || !token || challenge === undefined) {
      res.status(400).send("Bad Request");
      return;
    }

    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    if (!tenant?.facebookVerifyToken || token !== tenant.facebookVerifyToken) {
      res.status(403).send("Forbidden");
      return;
    }

    res.status(200).send(challenge);
  } catch (e) {
    logger.error({ e }, "verifyFacebookWebhook failed");
    res.status(503).send("Service Unavailable");
  }
}

export async function receiveFacebookWebhook(req: Request, res: Response): Promise<void> {
  try {
    const slug = String(req.params["tenantSlug"] ?? "");
    if (!verifySignature(req.rawBody, req.header("x-hub-signature-256"))) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    if (!tenant?.isActive) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    const body = req.body as {
      object?: string;
      entry?: Array<{ id?: string; messaging?: unknown[] }>;
    };

    if (body.object !== "page" || !body.entry?.length) {
      res.status(200).send("EVENT_RECEIVED");
      return;
    }

    res.status(200).send("EVENT_RECEIVED");

    enqueueTenantWebhookWork(tenant.id, async () => {
      for (const entry of body.entry ?? []) {
        const pageToken = resolvePageAccessToken(tenant, entry.id);
        if (!pageToken) {
          logger.warn({ entryId: entry.id, tenantPageId: tenant.facebookPageId }, "Page id not recognized — skipping");
          continue;
        }
        const messaging = entry.messaging;
        if (!Array.isArray(messaging)) continue;
        for (const ev of messaging) {
          const msg = ev as {
            sender?: { id?: string };
            message?: {
              mid?: string;
              reply_to?: { mid?: string };
              text?: string;
              is_echo?: boolean;
              attachments?: Array<{ type?: string; payload?: { url?: string } }>;
            };
            delivery?: unknown;
            read?: unknown;
          };
          if (msg.message?.is_echo) continue;
          if (!msg.sender?.id) continue;

          const text = msg.message?.text?.trim() ?? "";
          const imageUrls: string[] = [];
          for (const a of msg.message?.attachments ?? []) {
            if (a.type === "image" && a.payload?.url && isMessengerHostedMediaUrl(a.payload.url)) {
              imageUrls.push(a.payload.url);
            }
          }
          if (!text && imageUrls.length === 0) continue;

          const customerMessageMid = msg.message?.mid?.trim() || undefined;
          const replyToParentMid = msg.message?.reply_to?.mid?.trim() || undefined;

          await handleInboundMessengerMessage({
            tenantId: tenant.id,
            tenantSlug: slug,
            psid: msg.sender.id,
            text: text || undefined,
            imageUrls: imageUrls.length ? imageUrls : undefined,
            customerMessageMid,
            replyToParentMid,
            pageAccessTokenOverride: pageToken !== tenant.facebookPageAccessToken ? pageToken : undefined,
          }).catch((e) => logger.error({ e }, "Inbound messenger handling failed"));
        }
      }
    });
  } catch (e) {
    logger.error({ e }, "receiveFacebookWebhook failed");
    if (!res.headersSent) res.status(503).json({ error: "webhook_temporarily_unavailable" });
  }
}
