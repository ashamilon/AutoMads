/**
 * Single source of truth for the platform owner's contact channels.
 *
 * Kept here so a future change (different WhatsApp number, business email,
 * etc.) only touches one file. Components import from this module rather
 * than hard-coding the number.
 */

/** WhatsApp number in E.164 — used for both display and the wa.me URL. */
export const WHATSAPP_NUMBER_E164 = "+44 7441 340355";

/** Digits-only form (no `+`, no spaces) — required by the wa.me URL scheme. */
const WHATSAPP_DIGITS = WHATSAPP_NUMBER_E164.replace(/[^0-9]/g, "");

export const WHATSAPP_NUMBER_DISPLAY = WHATSAPP_NUMBER_E164;

/** Default message that pre-fills the WhatsApp compose box. */
const DEFAULT_PREFILL =
  "Hi! I'd like to get a setup link for the AI Commerce OS platform. Can you help me get started?";

/**
 * Build a `wa.me` deep link with an optional pre-filled message. The link
 * works on every platform — desktop, iOS, and Android — and falls back to
 * web.whatsapp.com when the WhatsApp app isn't installed.
 */
export function buildWhatsAppUrl(prefill?: string): string {
  const text = (prefill ?? DEFAULT_PREFILL).trim();
  const params = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${WHATSAPP_DIGITS}${params}`;
}

/** Operator email used on the marketing surface. Update in lock-step with the WhatsApp number. */
export const SUPPORT_EMAIL = "hello@aicommos.com";
