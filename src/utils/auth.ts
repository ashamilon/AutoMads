/**
 * Tenant authentication helpers.
 *
 * Two parallel mechanisms in this codebase:
 *
 *   1. API KEY (sk_live_…) — long-lived, machine-to-machine. Issued by the
 *      platform admin during tenant creation, used by webhooks and
 *      external integrations. Stored as a SHA-256 hash. Already implemented
 *      in `utils/apiKey.ts` — left intact.
 *
 *   2. SESSION TOKEN — issued only after a successful email + password login
 *      from the tenant's browser. Stored as a SHA-256 hash on
 *      TenantSession. Auto-expires after 7 days. The cookie value is only
 *      ever visible to the tenant's browser — admin (platform owner)
 *      cannot impersonate the tenant via this mechanism.
 *
 * Bcrypt is used for the user-supplied password (the bit the tenant
 * actually types). Activation + session tokens are SHA-256 hashes of
 * cryptographically-random bytes — bcrypt is overkill for those because
 * the input itself has 192 bits of entropy.
 */

import bcrypt from "bcryptjs";
import crypto from "node:crypto";

// ─── Password hashing ───────────────────────────────────────────────────────

/**
 * bcrypt cost factor. 12 is the 2024-2025 industry sweet spot — ~250ms per
 * hash on commodity hardware, which is enough to make brute-force expensive
 * without making login feel slow. Tune up as hardware improves.
 */
const BCRYPT_ROUNDS = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    // bcrypt.compare can throw on a malformed hash; treat as a non-match.
    return false;
  }
}

/**
 * Minimum policy: 8+ chars, at least one letter and one digit. Returns
 * `null` if valid, or a customer-facing error string. Kept simple on
 * purpose — we don't enforce special-character requirements because they
 * push users toward predictable patterns (`Password1!`).
 */
export function validatePasswordPolicy(plaintext: string): string | null {
  if (typeof plaintext !== "string") return "Password is required.";
  if (plaintext.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(plaintext)) return "Password must include at least one letter.";
  if (!/\d/.test(plaintext)) return "Password must include at least one digit.";
  return null;
}

// ─── Email normalisation ───────────────────────────────────────────────────

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function isValidEmail(email: string): boolean {
  if (typeof email !== "string") return false;
  if (email.length > 254) return false;
  return EMAIL_RE.test(email.trim());
}

/** Lowercase + trim. We don't strip plus-tags because legitimate users use them. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─── Token generators (activation, session) ────────────────────────────────

/**
 * 32 random bytes → 64-char hex. ~256 bits of entropy. The PLAINTEXT value
 * is the URL parameter we forward to the client; the HASH is what the
 * database stores so a DB read alone can't be used to log in.
 */
export function generateUrlSafeToken(): { plain: string; hash: string } {
  const plain = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(plain, "utf8").digest("hex");
  return { plain, hash };
}

/** SHA-256 of an arbitrary token string. Used to look up by hash. */
export function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}

// ─── Activation URL builder ───────────────────────────────────────────────

/**
 * Build the activation URL the platform admin forwards to the client. The
 * client opens it in their browser, picks email + password, and is logged
 * in. Domain is read from `PUBLIC_BASE_URL` (the external https URL of the
 * Next.js portal) — defaults to localhost for dev.
 */
export function buildActivationUrl(plainToken: string, portalBaseUrl: string): string {
  const base = portalBaseUrl.replace(/\/$/, "");
  return `${base}/activate?token=${encodeURIComponent(plainToken)}`;
}

// ─── Session lifetime ──────────────────────────────────────────────────────

/** 7 days. Aligns with the bcrypt-hashed-cookie pattern most SaaS apps use. */
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** 7 days. Enough time for the admin to forward the link without rushing. */
export const ACTIVATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_LIFETIME_MS);
}

export function activationExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + ACTIVATION_LIFETIME_MS);
}
