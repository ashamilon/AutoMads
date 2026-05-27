"use client";

/**
 * Reusable "Contact us on WhatsApp" affordances.
 *
 * Three surface variants:
 *
 *   - `<WhatsAppButton />` — a single button that opens wa.me with a
 *     pre-filled message. Use anywhere a primary or secondary action sits.
 *   - `<WhatsAppCard />`   — a self-contained card with title + helper text
 *     + the button. Drop this into auth pages so a new client immediately
 *     sees how to reach the operator without scrolling.
 *   - `<WhatsAppFloater />` — fixed bottom-right floating bubble with a
 *     pulsing glow ring + bouncing entrance, used on the public landing page.
 *
 * All three use the same inline `<WhatsAppGlyph />` SVG which is the official
 * WhatsApp logo cleaned up so it renders crisply at any size. The earlier
 * version had a malformed path segment that produced a broken half-rendered
 * icon on Chromium-based browsers — this rewrite uses the canonical Simple
 * Icons path.
 */

import { cn } from "@/lib/utils";
import {
  WHATSAPP_NUMBER_DISPLAY,
  buildWhatsAppUrl,
} from "@/lib/contact";
import { MessageCircle } from "lucide-react";

/**
 * Inline WhatsApp brand mark.
 *
 * Source: Simple Icons (CC0). Single closed path so `fill="currentColor"`
 * paints the whole logo in the surrounding text color and the speech-
 * bubble + handset cut-outs come from the path's own fill-rule. This was
 * the bug in the previous version — its hand-edited path had a stray
 * `0-.01.01-.01.02-.01z` token that closed the subpath inside a relative
 * coordinate run, leaving Chromium with an unclosed shape that rendered
 * as a half-blob.
 */
export function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.465 3.488" />
    </svg>
  );
}

export function WhatsAppButton({
  prefill,
  label = "Chat on WhatsApp",
  variant = "primary",
  className,
}: {
  prefill?: string;
  label?: string;
  /**
   * `primary` = filled WhatsApp green button with subtle glow.
   * `secondary` = outlined button that fits inside dark surfaces.
   */
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const base =
    "group relative inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13.5px] font-semibold transition-all active:scale-[0.98]";
  const styles = {
    primary:
      "bg-[#25D366] text-white shadow-[0_10px_28px_-10px_rgba(37,211,102,0.6)] hover:bg-[#1EBE5A] hover:shadow-[0_16px_40px_-12px_rgba(37,211,102,0.85)]",
    secondary:
      "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15 hover:border-emerald-400/50",
  } as const;
  return (
    <a
      href={buildWhatsAppUrl(prefill)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(base, styles[variant], className)}
    >
      {/* Subtle glow halo only on the primary variant — gated on hover so
          it doesn't fight the surrounding section's chrome at rest. */}
      {variant === "primary" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 rounded-xl bg-[#25D366] opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-60"
        />
      )}
      <WhatsAppGlyph className="h-4 w-4" />
      {label}
    </a>
  );
}

export function WhatsAppCard({
  prefill,
  title = "Need a setup link to get started?",
  description = "Send a quick message — we'll reply with your activation link, and you can sign in from there.",
  className,
}: {
  prefill?: string;
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.08] via-emerald-500/[0.03] to-transparent p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#25D366]/15 text-[#25D366]">
          <WhatsAppGlyph className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[14px] font-semibold text-white">{title}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slate-300">{description}</p>
          <p className="mt-2 font-mono text-[11.5px] text-emerald-200/80">
            <MessageCircle className="mr-1 inline h-3 w-3" />
            {WHATSAPP_NUMBER_DISPLAY}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <WhatsAppButton prefill={prefill} variant="primary" className="w-full" />
      </div>
    </div>
  );
}

/**
 * Floating WhatsApp bubble — fixed bottom-right, used on the public
 * landing page.
 *
 * Visual treatment:
 *   - Two stacked pulsing halos (slow + fast) make the button glow softly
 *     even when nothing is interacting with it. Intensity caps low so it
 *     reads as inviting rather than aggressive.
 *   - A "scale on hover" + "rotate icon on hover" micro-interaction.
 *   - The unread-indicator dot in the top-right corner uses Tailwind's
 *     `animate-ping` for the ripple, with a static dot underneath so the
 *     ripple looks anchored.
 *   - Compact pill on `<sm` (icon-only), pill with label on `sm+`.
 *
 * The keyframe `whatsappPulse` is defined inline via styled-jsx so we
 * don't have to extend `tailwind.config.ts` for a single-page effect.
 */
export function WhatsAppFloater({ prefill }: { prefill?: string }) {
  return (
    <a
      href={buildWhatsAppUrl(prefill)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Contact us on WhatsApp"
      className="group fixed bottom-5 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-[#25D366] px-4 py-3 text-[13px] font-semibold text-white shadow-[0_18px_50px_-12px_rgba(37,211,102,0.7)] transition-all hover:scale-110 hover:shadow-[0_24px_60px_-12px_rgba(37,211,102,0.9)] sm:bottom-6 sm:right-6"
    >
      {/* Outer glow rings — two stacked pulses for a layered halo effect */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-[#25D366] opacity-50"
        style={{ animation: "whatsappPulse 2.4s ease-out infinite" }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-[#25D366] opacity-30"
        style={{ animation: "whatsappPulse 2.4s ease-out 1.2s infinite" }}
      />
      <WhatsAppGlyph className="h-5 w-5 transition-transform duration-300 group-hover:rotate-[10deg]" />
      <span className="hidden sm:inline">WhatsApp</span>

      {/* Unread-style indicator dot */}
      <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-70" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.9)]" />
      </span>

      <style jsx>{`
        @keyframes whatsappPulse {
          0% {
            transform: scale(1);
            opacity: 0.55;
          }
          70% {
            transform: scale(1.45);
            opacity: 0;
          }
          100% {
            transform: scale(1.45);
            opacity: 0;
          }
        }
      `}</style>
    </a>
  );
}
