"use client";

/**
 * Reusable "Contact us on WhatsApp" affordances.
 *
 * Two surface variants:
 *
 *   - `<WhatsAppButton />` — a single button that opens wa.me with a
 *     pre-filled message. Use anywhere a primary or secondary action sits.
 *   - `<WhatsAppCard />`   — a self-contained card with title + helper text
 *     + the button. Drop this into auth pages so a new client immediately
 *     sees how to reach the operator without scrolling.
 *
 * Both honour `prefill` so the WhatsApp compose box opens with a
 * context-specific message ("I need an activation link", "I want to sign
 * up", etc.).
 */

import { cn } from "@/lib/utils";
import {
  WHATSAPP_NUMBER_DISPLAY,
  buildWhatsAppUrl,
} from "@/lib/contact";
import { MessageCircle } from "lucide-react";

/** Inline brand mark — small enough to use in a button without importing an SVG file. */
function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 2.1.55 4.05 1.6 5.78L2 22l4.41-1.71a9.86 9.86 0 0 0 5.62 1.62h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.84 9.84 0 0 0 12.04 2zm0 1.66a8.25 8.25 0 0 1 5.85 2.42 8.22 8.22 0 0 1 2.42 5.83c0 4.55-3.71 8.26-8.27 8.26h-.01a8.27 8.27 0 0 1-4.21-1.16l-.3-.18-3.13 1.21 1.23-3.05-.2-.31a8.21 8.21 0 0 1-1.27-4.39c0-4.55 3.71-8.25 8.26-8.25 0-.01.01-.01.02-.01zm-2.4 4.45c-.18 0-.46.07-.7.34-.24.27-.93.91-.93 2.22s.95 2.58 1.08 2.76c.13.18 1.84 2.92 4.55 4 .64.27 1.13.43 1.52.55.64.21 1.22.18 1.68.11.51-.08 1.57-.64 1.79-1.27.22-.62.22-1.16.16-1.27-.07-.11-.24-.18-.51-.31-.27-.13-1.57-.78-1.81-.86-.24-.09-.42-.13-.6.14-.18.27-.69.86-.85 1.04-.16.18-.31.2-.58.07-.27-.13-1.13-.42-2.16-1.33-.8-.71-1.34-1.6-1.49-1.86-.16-.27-.02-.42.12-.55.12-.12.27-.31.4-.47.13-.16.18-.27.27-.45.09-.18.04-.34-.02-.47-.07-.13-.6-1.45-.83-1.99-.22-.51-.45-.45-.6-.45-.16 0-.34-.02-.51-.02z" />
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
   * `primary` = filled WhatsApp green button.
   * `secondary` = outlined button that fits inside dark surfaces.
   */
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13.5px] font-semibold transition-all active:scale-[0.98]";
  const styles = {
    primary:
      "bg-[#25D366] text-white shadow-[0_10px_28px_-10px_rgba(37,211,102,0.6)] hover:bg-[#1EBE5A]",
    secondary:
      "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15",
  } as const;
  return (
    <a
      href={buildWhatsAppUrl(prefill)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(base, styles[variant], className)}
    >
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

/** Floating WhatsApp bubble — fixed bottom-right, used on the public landing page. */
export function WhatsAppFloater({ prefill }: { prefill?: string }) {
  return (
    <a
      href={buildWhatsAppUrl(prefill)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Contact us on WhatsApp"
      className="fixed bottom-5 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-[#25D366] px-4 py-3 text-[13px] font-semibold text-white shadow-[0_18px_50px_-12px_rgba(37,211,102,0.7)] transition-transform hover:scale-105 sm:bottom-6 sm:right-6"
    >
      <WhatsAppGlyph className="h-5 w-5" />
      <span className="hidden sm:inline">WhatsApp</span>
      <span className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-60" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-300" />
      </span>
    </a>
  );
}
