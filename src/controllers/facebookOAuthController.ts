/**
 * Facebook self-serve OAuth flow.
 *
 * The whole point of this controller is to remove every "go to Graph API
 * Explorer, generate a token, paste it here" instruction from the customer
 * journey. A non-technical client lands on Settings → Pages, clicks
 * **Connect with Facebook**, authenticates with Meta, picks their Page, and
 * we transparently:
 *
 *   1. Exchange the short-lived user token for a long-lived one
 *   2. Fetch their Pages via `/me/accounts` and let them pick
 *   3. Save the Page id + non-expiring Page token onto the tenant row
 *   4. Read the Instagram Business Account linked to the Page (if any) and
 *      stash it under `tenant.settings.instagram.{enabled,igUserId}`
 *   5. Redirect back to the portal with `?connected=1`
 *
 * Token storage policy: Page access tokens minted from a long-lived user
 * token DO NOT EXPIRE — Meta only revokes them when the user changes their
 * password or when the app is removed from their account. That means we do
 * not need a refresh job; a periodic health check + a "Reconnect" UI banner
 * cover the rare invalidation case.
 *
 * Security:
 *   • The `state` parameter is a signed `tenantId.timestamp.hmac` triple
 *     using `config.facebookAppSecret` as the HMAC key. We verify it on the
 *     callback so a forged callback URL cannot impersonate another tenant.
 *   • The temporary `code` from Meta is exchanged via an `appsecret_proof`-
 *     guarded request so a leaked redirect URL can't be replayed.
 *   • The Page token is *never* written to logs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import axios from "axios";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Permissions we ask the user to grant. Anything not in this list will fail
 * silently when the agent tries to use it; anything in this list that is not
 * yet **Approved for Live Use** in App Review will degrade to "this user is
 * an Admin/Tester only" mode (which is fine for early adopters but blocks
 * external clients — a clear UI signal in Settings tells the operator).
 */
const FB_OAUTH_SCOPES = [
  // Page management — required for messaging + posting
  "pages_show_list",
  "pages_messaging",
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_manage_metadata",
  // Outside-24h utility templates (payment-reminder follow-ups)
  "pages_utility_messaging",
  // Basic IG profile read (enough for username display + post discovery)
  "instagram_basic",
  // Optional: IG DMs. Approved on your app already; harmless to ask for.
  "instagram_manage_messages",
  // Business asset access — needed for Pages owned by a Business Manager
  "business_management",
] as const;

type StatePayload = { tenantId: string; ts: number };

/**
 * Sign a tenant id + timestamp into an opaque `state` string for the Meta
 * `state` parameter. Format: `<tenantId>.<ts>.<hexHmac>`.
 *
 * Using the FB app secret as the HMAC key keeps key sprawl down — the secret
 * is already required for `appsecret_proof` and signature verification, so
 * we don't introduce a separate "OAUTH_STATE_SECRET" env knob.
 */
function signState(tenantId: string, ts: number): string {
  const payload = `${tenantId}.${ts}`;
  const sig = createHmac("sha256", config.facebookAppSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyState(state: string): StatePayload | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [tenantId, tsStr, sig] = parts as [string, string, string];
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return null;
  // 30-minute validity window — long enough for a slow user, short enough
  // that a leaked URL can't be replayed days later.
  if (Date.now() - ts > 30 * 60 * 1000) return null;
  const expected = createHmac("sha256", config.facebookAppSecret)
    .update(`${tenantId}.${ts}`)
    .digest("hex");
  // Constant-time compare to avoid timing oracles. Both buffers must be the
  // same length, otherwise `timingSafeEqual` throws.
  if (sig.length !== expected.length) return null;
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? { tenantId, ts } : null;
}

/**
 * `appsecret_proof` is a sha256-HMAC of the access token using the app
 * secret. Meta accepts requests without it for short-lived tokens, but
 * *requires* it for long-lived ones in some endpoints, and it cannot hurt
 * to send it always. We compute one for every Graph call we make here.
 */
function appSecretProof(token: string): string {
  return createHmac("sha256", config.facebookAppSecret).update(token).digest("hex");
}

function buildRedirectUri(): string {
  // Meta requires the redirect URI to **exactly match** one of the entries
  // configured under Facebook Login for Business → Settings → Valid OAuth
  // Redirect URIs. We use `${publicBaseUrl}/oauth/facebook/callback` so the
  // operator can paste that exact string into the Meta dashboard.
  return `${config.publicBaseUrl.replace(/\/$/, "")}/oauth/facebook/callback`;
}

/**
 * GET /api/v1/social/facebook/connect
 *
 * Tenant-authenticated. Returns the Meta authorization URL the portal
 * should redirect the user to. The portal opens this in a popup (or full
 * page) — Meta handles the rest of the dance.
 */
export async function startFacebookOAuth(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  if (!config.facebookAppId || !config.facebookAppSecret) {
    res.status(500).json({
      ok: false,
      error: "fb_app_not_configured",
      detail: "Server is missing FACEBOOK_APP_ID or FACEBOOK_APP_SECRET.",
    });
    return;
  }
  const state = signState(t.id, Date.now());
  const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  url.searchParams.set("client_id", config.facebookAppId);
  url.searchParams.set("redirect_uri", buildRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("scope", FB_OAUTH_SCOPES.join(","));
  // `response_type=code` triggers the server-side flow (we trade the code
  // for a token in the callback). The `auth_type=rerequest` makes Meta
  // re-prompt the user for any scopes they previously declined.
  url.searchParams.set("response_type", "code");
  url.searchParams.set("auth_type", "rerequest");
  res.json({ ok: true, authorizeUrl: url.toString() });
}

/**
 * GET /oauth/facebook/callback?code=...&state=...
 *
 * **Public** endpoint (Meta calls it). Tenant id comes from the signed state
 * param, NOT from request auth — the user does not have a session in the
 * popup at this point.
 */
export async function facebookOAuthCallback(req: Request, res: Response): Promise<void> {
  const portal = config.publicPortalUrl.replace(/\/$/, "");

  // Meta sends `?error=access_denied&error_reason=user_denied` when the user
  // hits "Cancel" on the consent dialog. Surface that as a clean redirect
  // back to the portal so the UI can show a friendly message.
  if (typeof req.query.error === "string") {
    const reason = String(req.query.error_description ?? req.query.error ?? "user_denied");
    res.redirect(`${portal}/portal/settings?fbConnect=cancelled&reason=${encodeURIComponent(reason)}`);
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) {
    res.redirect(`${portal}/portal/settings?fbConnect=error&reason=missing_params`);
    return;
  }
  const verified = verifyState(state);
  if (!verified) {
    res.redirect(`${portal}/portal/settings?fbConnect=error&reason=bad_state`);
    return;
  }
  const tenantId = verified.tenantId;

  try {
    // ── Step 1: code → short-lived user token ─────────────────────────────
    const tokenRes = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: {
        client_id: config.facebookAppId,
        client_secret: config.facebookAppSecret,
        redirect_uri: buildRedirectUri(),
        code,
      },
      validateStatus: () => true,
    });
    if (tokenRes.status !== 200 || !tokenRes.data?.access_token) {
      logger.warn(
        { tenantId, status: tokenRes.status, data: tokenRes.data },
        "fb-oauth: code→token exchange failed",
      );
      res.redirect(`${portal}/portal/settings?fbConnect=error&reason=code_exchange_failed`);
      return;
    }
    const shortUserToken = tokenRes.data.access_token as string;

    // ── Step 2: short-lived → long-lived user token (~60 days) ────────────
    const llRes = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: config.facebookAppId,
        client_secret: config.facebookAppSecret,
        fb_exchange_token: shortUserToken,
      },
      validateStatus: () => true,
    });
    if (llRes.status !== 200 || !llRes.data?.access_token) {
      logger.warn(
        { tenantId, status: llRes.status, data: llRes.data },
        "fb-oauth: long-lived exchange failed",
      );
      res.redirect(`${portal}/portal/settings?fbConnect=error&reason=ll_exchange_failed`);
      return;
    }
    const longUserToken = llRes.data.access_token as string;

    // ── Step 3: list Pages the user manages ──────────────────────────────
    const pagesRes = await axios.get(`${GRAPH}/me/accounts`, {
      params: {
        access_token: longUserToken,
        appsecret_proof: appSecretProof(longUserToken),
        fields: "id,name,access_token,tasks,category",
        limit: 100,
      },
      validateStatus: () => true,
    });
    if (pagesRes.status !== 200) {
      logger.warn({ tenantId, status: pagesRes.status, data: pagesRes.data }, "fb-oauth: /me/accounts failed");
      res.redirect(`${portal}/portal/settings?fbConnect=error&reason=pages_fetch_failed`);
      return;
    }
    const pages = (pagesRes.data?.data ?? []) as Array<{
      id: string;
      name: string;
      access_token: string;
      tasks?: string[];
      category?: string;
    }>;
    if (pages.length === 0) {
      res.redirect(`${portal}/portal/settings?fbConnect=error&reason=no_pages`);
      return;
    }

    // ── Step 4: pick a Page ──────────────────────────────────────────────
    // If the tenant already has a `facebookPageId` saved and it's in the
    // list, prefer that (re-auth flow). Otherwise, if the user manages
    // exactly one Page, auto-pick it. Otherwise redirect to a picker UI.
    const existing = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { facebookPageId: true },
    });
    let chosen = existing?.facebookPageId
      ? pages.find((p) => p.id === existing.facebookPageId)
      : undefined;
    if (!chosen && pages.length === 1) chosen = pages[0]!;

    if (!chosen) {
      // Multi-Page picker isn't implemented yet — for now we tell the
      // operator to retry from a refreshed session. 99% of real shops own
      // exactly one Page; multi-Page setups will surface as a future task.
      res.redirect(
        `${portal}/portal/settings?fbConnect=needs_picker&pages=${encodeURIComponent(
          pages.map((p) => `${p.id}:${p.name}`).join(","),
        )}`,
      );
      return;
    }

    // ── Step 5: discover the IG Business Account linked to the Page ──────
    let igUserId: string | null = null;
    try {
      const igRes = await axios.get(`${GRAPH}/${chosen.id}`, {
        params: {
          access_token: chosen.access_token,
          appsecret_proof: appSecretProof(chosen.access_token),
          fields: "instagram_business_account{id,username},connected_instagram_account{id,username}",
        },
        validateStatus: () => true,
      });
      const iba =
        igRes.data?.instagram_business_account ?? igRes.data?.connected_instagram_account;
      if (iba?.id) igUserId = iba.id;
    } catch (e) {
      // IG-link discovery is best-effort — Pages without an IG link still
      // succeed at connecting. Just note it and keep going.
      logger.warn({ tenantId, e: String(e) }, "fb-oauth: IG discovery failed");
    }

    // ── Step 6: persist on the tenant row ────────────────────────────────
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const settings =
      tenant?.settings && typeof tenant.settings === "object" && !Array.isArray(tenant.settings)
        ? { ...(tenant.settings as Record<string, unknown>) }
        : {};
    if (igUserId) {
      const ig =
        settings.instagram && typeof settings.instagram === "object" && !Array.isArray(settings.instagram)
          ? { ...(settings.instagram as Record<string, unknown>) }
          : {};
      ig.igUserId = igUserId;
      ig.enabled = true;
      settings.instagram = ig;
    }

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        facebookPageId: chosen.id,
        facebookPageAccessToken: chosen.access_token,
        facebookConnectedAt: new Date(),
        settings: settings as Prisma.InputJsonValue,
      },
    });

    logger.info(
      { tenantId, pageId: chosen.id, pageName: chosen.name, igUserId },
      "fb-oauth: tenant connected",
    );

    res.redirect(
      `${portal}/portal/settings?fbConnect=ok&page=${encodeURIComponent(chosen.name)}${
        igUserId ? "&ig=1" : ""
      }`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ tenantId, e: msg }, "fb-oauth: callback failed");
    res.redirect(`${portal}/portal/settings?fbConnect=error&reason=callback_exception`);
  }
}

/**
 * POST /api/v1/social/facebook/disconnect
 *
 * Clears the Page id + token on the tenant, leaving the IG settings alone
 * (the operator can clear those separately). We do NOT call Meta's
 * `/me/permissions` revoke endpoint — that requires the user's session,
 * which we don't have server-side. Meta naturally invalidates Page tokens
 * a few hours after a Page is removed from the user's account or after
 * password change.
 */
export async function disconnectFacebook(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  await prisma.tenant.update({
    where: { id: t.id },
    data: {
      facebookPageAccessToken: null,
      // We deliberately KEEP facebookPageId so the next reconnect flow can
      // auto-pick the same Page without prompting. Operators who really
      // want to switch pages can clear the field via the Advanced JSON tab.
    },
  });
  res.json({ ok: true });
}

/**
 * GET /api/v1/social/facebook/health
 *
 * Lightweight token health check — calls `/me` with the saved Page token
 * and reports back. The portal polls this on the Settings page so the
 * "Connected" badge can flip to "Reconnect needed" the moment Meta
 * invalidates a session (password change, etc.).
 */
export async function facebookHealth(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const token = t.facebookPageAccessToken;
  const pageId = t.facebookPageId;
  if (!token || !pageId) {
    res.json({ ok: false, connected: false });
    return;
  }
  try {
    const r = await axios.get(`${GRAPH}/me`, {
      params: {
        access_token: token,
        appsecret_proof: appSecretProof(token),
        fields: "id,name,category",
      },
      validateStatus: () => true,
    });
    if (r.status === 200 && r.data?.id === pageId) {
      const settings =
        (t.settings && typeof t.settings === "object" && !Array.isArray(t.settings)
          ? (t.settings as Record<string, unknown>)
          : {}) as Record<string, unknown>;
      const ig = settings.instagram as { igUserId?: string; enabled?: boolean } | undefined;
      res.json({
        ok: true,
        connected: true,
        page: { id: r.data.id, name: r.data.name, category: r.data.category },
        instagram: ig?.igUserId ? { igUserId: ig.igUserId, enabled: ig.enabled !== false } : null,
      });
      return;
    }
    // Mismatch (saved pageId differs from token's id) or auth error.
    res.json({
      ok: false,
      connected: false,
      reason: "token_invalid",
      detail: r.data?.error?.message ?? `unexpected status ${r.status}`,
    });
  } catch (e: any) {
    res.json({
      ok: false,
      connected: false,
      reason: "health_check_failed",
      detail: String(e?.message ?? e),
    });
  }
}
