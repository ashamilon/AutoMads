import type { RequestHandler } from "express";
import { prisma } from "../db/prisma.js";
import { extractBearerToken, hashApiKey } from "../utils/apiKey.js";
import { hashToken } from "../utils/auth.js";
import { readSessionToken } from "../controllers/authController.js";

/**
 * Unified tenant authentication middleware. Accepts EITHER:
 *
 *   1. A session token issued by `POST /api/v1/auth/login` (cookie or
 *      Bearer header). Used by the client's browser dashboard.
 *
 *   2. An sk_live_ API key. Used by webhooks and external integrations.
 *
 * Both routes resolve to `req.tenant` so every existing controller
 * continues to work unchanged.
 *
 * Order of checks: session first (because the browser sends both a cookie
 * AND its sk_live_ API key wouldn't make sense for normal UI usage) then
 * api key. A failed session check falls through to the api key check; a
 * failed api key check returns 401.
 */
export const requireTenantApiKey: RequestHandler = async (req, res, next) => {
  // 1. Session token (cookie or Bearer that doesn't start with sk_live_).
  const sessionToken = readSessionToken(req);
  if (sessionToken) {
    const session = await prisma.tenantSession.findUnique({
      where: { tokenHash: hashToken(sessionToken) },
      include: { tenant: true },
    });
    if (session && session.expiresAt.getTime() > Date.now() && session.tenant.isActive) {
      // Touch lastSeen so the admin can see recently-used sessions later.
      // Best-effort: don't block the request on this write.
      void prisma.tenantSession
        .update({ where: { id: session.id }, data: { lastSeen: new Date() } })
        .catch(() => undefined);
      req.tenant = session.tenant;
      next();
      return;
    }
  }

  // 2. Legacy API key.
  const raw = extractBearerToken(req);
  if (!raw) {
    res
      .status(401)
      .json({ error: "missing_credentials", hint: "Sign in via /login or use Authorization: Bearer sk_live_..." });
    return;
  }
  // If the bearer was a session token (i.e. NOT sk_live_) and we got here,
  // the session check above already failed. Don't try it as an API key.
  if (!raw.startsWith("sk_live_")) {
    res.status(401).json({ error: "invalid_session" });
    return;
  }
  const hash = hashApiKey(raw);
  const tenant = await prisma.tenant.findFirst({ where: { apiKeyHash: hash, isActive: true } });
  if (!tenant) {
    res.status(401).json({ error: "invalid_api_key" });
    return;
  }
  req.tenant = tenant;
  next();
};
