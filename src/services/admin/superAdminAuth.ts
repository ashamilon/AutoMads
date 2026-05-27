/**
 * Super_Admin (platform-operator) authentication.
 *
 * Distinct from `TenantSession` (R20.7, R6.5): a super-admin row has NO
 * `tenantId` and acts on tenants only via explicit `tenantId` parameters
 * at the controller level. Mirrors the tenant session shape (sha256 of a
 * 32-byte random token, 7-day expiry) but lives on `SuperAdminSession`.
 *
 * Password hashing uses `bcryptjs` (R23.5). Tokens are random 64-char hex
 * strings; only the SHA-256 hash is persisted, the raw token is returned
 * to the caller and never logged.
 */

import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SuperAdminContext {
  superAdminId: string;
  email: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Match the tenant-side cost factor (utils/auth.ts). */
const BCRYPT_ROUNDS = 12;

/** 7 days, mirroring TenantSession. */
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const SUPER_ADMIN_COOKIE = "superAdminToken";

// ─── Token helpers ─────────────────────────────────────────────────────────

/** 32 random bytes → 64 hex chars (~256 bits of entropy). */
function generateRawToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function sessionExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_LIFETIME_MS);
}

// ─── Email normalisation ───────────────────────────────────────────────────

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Look up a SuperAdmin by email case-insensitively. The schema marks
 * `email` unique with default collation, so we match on the lowercased
 * value we always store at insert time.
 */
async function findSuperAdminByEmail(email: string) {
  const normalised = normaliseEmail(email);
  return prisma.superAdmin.findUnique({ where: { email: normalised } });
}

// ─── Authentication ────────────────────────────────────────────────────────

/**
 * Verify email + password and create a `SuperAdminSession`.
 *
 * Returns `{ token, superAdmin }` on success — `token` is the raw
 * 64-char hex value the caller should set as a cookie or return in JSON.
 * Returns `null` on any failure (unknown email, missing password,
 * disabled account, bad password). Failures are logged at `warn` level
 * with `event: "super_admin_login_failed"` but never include the raw
 * password or token.
 */
export async function authenticateSuperAdmin(
  email: string,
  password: string,
): Promise<{ token: string; superAdmin: SuperAdminContext } | null> {
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    logger.warn({ event: "super_admin_login_failed", reason: "missing_input" }, "super admin login: missing input");
    return null;
  }

  const normalisedEmail = normaliseEmail(email);
  const row = await findSuperAdminByEmail(normalisedEmail);

  // Always perform a bcrypt compare to keep timing roughly constant
  // whether or not the email exists. Using a constant-shape dummy hash.
  const dummyHash = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8X9Yc/iAvRnZJxXeDpNEvWl4PE0mN.";
  const hash = row?.passwordHash ?? dummyHash;
  let ok = false;
  try {
    ok = await bcrypt.compare(password, hash);
  } catch {
    ok = false;
  }

  if (!row || !row.passwordHash || !row.isActive || !ok) {
    logger.warn(
      {
        event: "super_admin_login_failed",
        email: normalisedEmail,
        reason: !row
          ? "unknown_email"
          : !row.passwordHash
            ? "password_not_set"
            : !row.isActive
              ? "inactive"
              : "bad_password",
      },
      "super admin login failed",
    );
    return null;
  }

  const token = generateRawToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = sessionExpiresAt();

  await prisma.superAdminSession.create({
    data: {
      superAdminId: row.id,
      tokenHash,
      expiresAt,
    },
  });

  logger.info(
    { event: "super_admin_login_succeeded", superAdminId: row.id, email: row.email },
    "super admin login succeeded",
  );

  return {
    token,
    superAdmin: { superAdminId: row.id, email: row.email },
  };
}

// ─── Token validation ──────────────────────────────────────────────────────

/**
 * Resolve a raw token to a `SuperAdminContext`. Hashes the token, looks up
 * the unexpired session row, joins the SuperAdmin to surface the email,
 * and best-effort touches `lastSeen`. Returns `null` if the session is
 * missing, expired, or the underlying SuperAdmin is inactive.
 */
export async function validateSuperAdminToken(token: string): Promise<SuperAdminContext | null> {
  if (typeof token !== "string" || token.length === 0) return null;

  const tokenHash = sha256Hex(token);
  const session = await prisma.superAdminSession.findUnique({
    where: { tokenHash },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  // Fetch the parent row separately because the schema does not declare a
  // `superAdmin` relation field on `SuperAdminSession` — the FK is the raw
  // `superAdminId` column.
  const admin = await prisma.superAdmin.findUnique({
    where: { id: session.superAdminId },
  });
  if (!admin || !admin.isActive) return null;

  // Best-effort lastSeen update; never block the request on it.
  void prisma.superAdminSession
    .update({ where: { id: session.id }, data: { lastSeen: new Date() } })
    .catch(() => undefined);

  return { superAdminId: admin.id, email: admin.email };
}

// ─── Logout ────────────────────────────────────────────────────────────────

/**
 * Burn the session row identified by `token`. Idempotent — if the row is
 * missing the call still resolves successfully. Never logs the raw token.
 */
export async function logoutSuperAdmin(token: string): Promise<void> {
  if (typeof token !== "string" || token.length === 0) return;
  const tokenHash = sha256Hex(token);
  await prisma.superAdminSession
    .deleteMany({ where: { tokenHash } })
    .catch((err: unknown) => {
      logger.warn({ event: "super_admin_logout_failed", err: String(err) }, "super admin logout failed");
    });
}

// ─── Express middleware ────────────────────────────────────────────────────

/**
 * Read a super-admin token from either `Authorization: Bearer <token>` or
 * the `superAdminToken` cookie. Returns `null` if neither is present.
 *
 * Cookie parsing is intentionally local (not via `cookie-parser`) so this
 * middleware works regardless of upstream cookie middleware ordering.
 */
function extractSuperAdminToken(req: Request): string | null {
  const auth = req.header("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const v = auth.slice(7).trim();
    // Reject API keys: those are tenant-scoped (sk_live_...) and must not
    // pass super-admin checks.
    if (v && !v.startsWith("sk_live_")) return v;
  }
  const cookieHeader = req.headers.cookie ?? "";
  const re = new RegExp(`(?:^|;\\s*)${SUPER_ADMIN_COOKIE}=([^;]+)`);
  const m = cookieHeader.match(re);
  if (m && m[1]) return decodeURIComponent(m[1]);
  return null;
}

/**
 * Express middleware that enforces a valid super-admin session. On
 * success populates `req.superAdmin` with `SuperAdminContext` and calls
 * `next()`. On failure responds `401 { error: "super_admin_required" }`.
 *
 * Accepts three credential shapes (in order):
 *  1. `Authorization: Bearer <SuperAdminSession token>` or the
 *     `superAdminToken` cookie — preferred, validated against the DB.
 *  2. `X-Admin-Api-Key: <ADMIN_API_KEY>` (or the same value via Bearer)
 *     matching the platform-wide static key configured in env. This
 *     fallback exists so the existing platform-admin flow under
 *     `localhost:3000/admin` (which authenticates with `ADMIN_API_KEY`,
 *     not a per-user session) keeps working against the new
 *     `/api/v1/admin/*` panel without introducing a second auth scheme
 *     in the UI. The synthetic actor id `static-admin-key` flows into
 *     SubscriptionLog so the audit trail clearly distinguishes it from
 *     real per-user super admins.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  // Fallback: the static `ADMIN_API_KEY` issued via env. Lets the legacy
  // platform-admin flow (X-Admin-Api-Key header) reuse the new panel
  // routes without introducing a separate session UI.
  const staticKey = config.adminApiKey;
  if (staticKey) {
    const headerKey = req.header("x-admin-api-key");
    const auth = req.header("authorization");
    const bearerKey =
      auth && auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim()
        : undefined;
    if (
      (headerKey && headerKey === staticKey) ||
      (bearerKey && bearerKey === staticKey)
    ) {
      req.superAdmin = {
        superAdminId: "static-admin-key",
        email: "platform-admin",
      };
      next();
      return;
    }
  }

  const token = extractSuperAdminToken(req);
  if (!token) {
    res.status(401).json({ error: "super_admin_required" });
    return;
  }
  validateSuperAdminToken(token)
    .then((ctx) => {
      if (!ctx) {
        res.status(401).json({ error: "super_admin_required" });
        return;
      }
      req.superAdmin = ctx;
      next();
    })
    .catch((err: unknown) => {
      logger.error(
        { event: "super_admin_validate_error", err: String(err) },
        "super admin token validation threw",
      );
      res.status(401).json({ error: "super_admin_required" });
    });
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

/**
 * Create the first SuperAdmin row from environment variables, if the
 * platform operator has set them and no row with that email exists yet.
 *
 * Reads `SUPER_ADMIN_BOOTSTRAP_EMAIL` and `SUPER_ADMIN_BOOTSTRAP_PASSWORD`.
 * Both must be set; if either is missing we no-op silently. Idempotent —
 * a re-run with the same email is a no-op (we never overwrite an existing
 * row's password from env, that would be a footgun on container restart).
 *
 * Logs creation at `info` level. Never logs the raw password.
 */
export async function bootstrapSuperAdminFromEnv(): Promise<void> {
  const email = process.env.SUPER_ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.SUPER_ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) return;

  const normalisedEmail = normaliseEmail(email);
  const existing = await prisma.superAdmin.findUnique({
    where: { email: normalisedEmail },
  });
  if (existing) {
    logger.debug(
      { event: "super_admin_bootstrap_skipped", reason: "exists", email: normalisedEmail },
      "super admin bootstrap skipped — row exists",
    );
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await prisma.superAdmin.create({
    data: {
      email: normalisedEmail,
      passwordHash,
      isActive: true,
    },
  });

  logger.info(
    { event: "super_admin_bootstrap_created", email: normalisedEmail },
    "super admin bootstrap created initial row",
  );
}
