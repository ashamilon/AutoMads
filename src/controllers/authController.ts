/**
 * Tenant authentication endpoints — activation, login, logout, session,
 * change-password. The dashboard uses these; webhooks continue to use the
 * sk_live_ API key.
 *
 * Security posture:
 *   - Passwords are bcrypt-hashed (cost 12); platform admin cannot read them.
 *   - Activation tokens are SHA-256 hashes; the plaintext only exists in
 *     the URL the admin forwards to the client.
 *   - Session tokens are issued only after a successful email + password
 *     match. They live in an httpOnly cookie (browser cannot read the
 *     value via JS). They auto-expire after 7 days.
 *   - Rate-limit: not enforced here yet — see security.md follow-up.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import {
  ACTIVATION_LIFETIME_MS,
  generateUrlSafeToken,
  hashPassword,
  hashToken,
  isValidEmail,
  normaliseEmail,
  sessionExpiresAt,
  validatePasswordPolicy,
  verifyPassword,
} from "../utils/auth.js";

// ─── Cookie + bearer config ─────────────────────────────────────────────────

const SESSION_COOKIE = "tenant_session";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function setSessionCookie(res: Response, plain: string, expiresAt: Date): void {
  // In production with portal + API on different subdomains we need
  // SameSite=None + Secure so the cookie is included on cross-origin
  // credentialed requests. In dev we keep Lax + non-Secure so it works on
  // plain http://localhost.
  const sameSite = isProduction() ? "None" : "Lax";
  const opts = [
    `${SESSION_COOKIE}=${plain}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (isProduction()) opts.push("Secure");
  res.setHeader("Set-Cookie", opts.join("; "));
}

function clearSessionCookie(res: Response): void {
  const sameSite = isProduction() ? "None" : "Lax";
  const opts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0",
  ];
  if (isProduction()) opts.push("Secure");
  res.setHeader("Set-Cookie", opts.join("; "));
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const activateBody = z.object({
  token: z.string().min(16).max(256),
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

const loginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

// ─── Activation ────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/auth/activate`
 *
 * Body: { token, email, password }
 *
 * Consumes a one-time activation token (issued by the platform admin during
 * tenant creation). Sets the tenant's email + password and creates the first
 * session. Token is single-use — once consumed, it's burned.
 */
export async function activate(req: Request, res: Response): Promise<void> {
  const parsed = activateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", detail: parsed.error.flatten() });
    return;
  }
  const { token, email, password } = parsed.data;

  const policyError = validatePasswordPolicy(password);
  if (policyError) {
    res.status(400).json({ error: "weak_password", message: policyError });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }
  const normalisedEmail = normaliseEmail(email);

  const tokenHash = hashToken(token);
  const tenant = await prisma.tenant.findUnique({
    where: { activationTokenHash: tokenHash },
  });
  if (!tenant) {
    res.status(400).json({ error: "invalid_token" });
    return;
  }
  if (!tenant.activationExpiresAt || tenant.activationExpiresAt.getTime() < Date.now()) {
    res.status(400).json({ error: "token_expired", message: "Ask the platform admin to issue a new activation link." });
    return;
  }
  if (!tenant.isActive) {
    res.status(403).json({ error: "tenant_inactive" });
    return;
  }

  // Email uniqueness — keep the same generic 400 the rest of the auth flow
  // returns so an attacker probing /activate can't tell whether `email` is
  // already registered to another tenant. The error code stays distinct so
  // the operator can ask the user to pick a different email, but it doesn't
  // confirm existence the way "email_already_used" did.
  const emailTaken = await prisma.tenant.findFirst({
    where: { email: normalisedEmail, NOT: { id: tenant.id } },
  });
  if (emailTaken) {
    res.status(400).json({ error: "invalid_token" });
    return;
  }

  const passwordHash = await hashPassword(password);
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      email: normalisedEmail,
      passwordHash,
      // Burn the token so it can't be replayed.
      activationTokenHash: null,
      activationExpiresAt: null,
    },
  });

  // Issue the first session so the activation page can drop the user
  // straight into the dashboard.
  const sessionTok = generateUrlSafeToken();
  const expiresAt = sessionExpiresAt();
  await prisma.tenantSession.create({
    data: {
      tenantId: tenant.id,
      tokenHash: sessionTok.hash,
      expiresAt,
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
    },
  });
  setSessionCookie(res, sessionTok.plain, expiresAt);
  res.json({
    ok: true,
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    sessionToken: sessionTok.plain,
  });
}

// ─── Login ─────────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/auth/login`
 *
 * Body: { email, password }
 *
 * Both fields are required (this is the "double verification" the operator
 * asked for — email + password, no OTP). Returns 401 on any mismatch with
 * a generic error so an attacker can't enumerate emails.
 */
export async function login(req: Request, res: Response): Promise<void> {
  const parsed = loginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error" });
    return;
  }
  const email = normaliseEmail(parsed.data.email);
  const password = parsed.data.password;

  const tenant = await prisma.tenant.findUnique({ where: { email } });
  // Always perform a bcrypt compare even when the tenant is missing, so
  // the response time doesn't reveal whether the email exists. Use a
  // constant-shape dummy hash.
  const dummyHash = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8X9Yc/iAvRnZJxXeDpNEvWl4PE0mN.";
  const hash = tenant?.passwordHash ?? dummyHash;
  const ok = await verifyPassword(password, hash);

  if (!tenant || !tenant.passwordHash || !ok || !tenant.isActive) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }

  const sessionTok = generateUrlSafeToken();
  const expiresAt = sessionExpiresAt();
  await prisma.tenantSession.create({
    data: {
      tenantId: tenant.id,
      tokenHash: sessionTok.hash,
      expiresAt,
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
    },
  });
  setSessionCookie(res, sessionTok.plain, expiresAt);
  res.json({
    ok: true,
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    sessionToken: sessionTok.plain,
  });
}

// ─── Logout ────────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/auth/logout`
 *
 * Burns the current session. Idempotent — a missing or expired session
 * still returns 200 so logout never errors for the client.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const token = readSessionToken(req);
  if (token) {
    await prisma.tenantSession
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => undefined);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}

// ─── Session probe ─────────────────────────────────────────────────────────

/**
 * `GET /api/v1/auth/session`
 *
 * Returns the current tenant if the session is valid, or 401. Used by the
 * client's `RequireAuth` shell on first paint to decide whether to render
 * the dashboard or redirect to /login.
 */
export async function getSession(req: Request, res: Response): Promise<void> {
  const tenant = req.tenant;
  if (!tenant) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  res.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      email: (tenant as { email?: string | null }).email ?? null,
    },
  });
}

// ─── Authenticated change-password ─────────────────────────────────────────

/**
 * `POST /api/v1/auth/change-password`
 *
 * Body: { currentPassword, newPassword }
 *
 * Self-serve password change while logged in. Burns ALL other sessions on
 * success so a stolen-but-unused session stops working.
 */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const tenant = req.tenant;
  if (!tenant) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = changePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error" });
    return;
  }
  const policyError = validatePasswordPolicy(parsed.data.newPassword);
  if (policyError) {
    res.status(400).json({ error: "weak_password", message: policyError });
    return;
  }
  const row = await prisma.tenant.findUnique({ where: { id: tenant.id } });
  if (!row?.passwordHash) {
    res.status(400).json({ error: "no_password_set", message: "Tenant has no password — activate via /activate first." });
    return;
  }
  const ok = await verifyPassword(parsed.data.currentPassword, row.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const newHash = await hashPassword(parsed.data.newPassword);
  await prisma.$transaction([
    prisma.tenant.update({ where: { id: row.id }, data: { passwordHash: newHash } }),
    // Burn every other session so an old cookie can't be used after rotation.
    prisma.tenantSession.deleteMany({
      where: { tenantId: row.id, tokenHash: { not: hashToken(readSessionToken(req) ?? "") } },
    }),
  ]);
  res.json({ ok: true });
}

// ─── Helpers exported for the auth middleware ──────────────────────────────

export function readSessionToken(req: Request): string | null {
  // Cookie first (browser usage), then Authorization (so we can also pass a
  // session token from CLI tools / tests).
  const cookie = req.headers.cookie ?? "";
  const m = cookie.match(/(?:^|;\s*)tenant_session=([^;]+)/);
  if (m && m[1]) return decodeURIComponent(m[1]);
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const v = auth.slice(7).trim();
    // Distinguish a session token from an sk_live_ API key. Session tokens
    // are 64 hex chars; API keys are sk_live_<48 hex>. If it looks like an
    // api key, return null here — the api-key middleware handles it.
    if (!v.startsWith("sk_live_")) return v;
  }
  return null;
}

function clientIp(req: Request): string {
  const fwd = req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "";
}

function clientUserAgent(req: Request): string {
  return (req.header("user-agent") ?? "").slice(0, 200);
}

// Suppress unused-var warning for ACTIVATION_LIFETIME_MS (re-exported elsewhere).
void ACTIVATION_LIFETIME_MS;
