"use client";

/**
 * Footer — three-column structured layout.
 *
 * Departure from the previous flat single-row footer:
 *   - Three columns on md+: brand + tagline · navigation links · contact
 *     and social.
 *   - Brand column repeats the live status pill from the nav so the
 *     bottom of the page also feels "alive".
 *   - Mobile collapses to a single stacked column.
 */

import { Github, Mail, Twitter } from "lucide-react";
import Link from "next/link";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import { WHATSAPP_NUMBER_DISPLAY, buildWhatsAppUrl } from "@/lib/contact";

export function LandingFooter() {
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();
  return (
    <footer className="relative border-t border-white/[0.06] bg-black/30">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          {/* Brand column */}
          <div>
            <Link href="/" className="flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={brandLogoUrl}
                alt="Brand logo"
                className="h-7 w-7 rounded-md object-contain brightness-0 invert"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={brandNameUrl}
                alt="Brand name"
                className="h-5 w-auto max-w-[8rem] object-contain brightness-0 invert"
              />
            </Link>
            <p className="mt-4 max-w-sm text-[12.5px] leading-relaxed text-slate-400">
              The AI Commerce OS for Bangladeshi shops. Sales agents, content calendars,
              payments, and couriers — running themselves.
            </p>
            <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              All systems operational
            </span>
          </div>

          {/* Product links */}
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Product
            </p>
            <ul className="mt-4 space-y-2 text-[13px] text-slate-300">
              <li><a href="#features" className="transition hover:text-white">Features</a></li>
              <li><a href="#flow" className="transition hover:text-white">AI Agents</a></li>
              <li><a href="#categories" className="transition hover:text-white">Categories</a></li>
              <li><a href="#pricing" className="transition hover:text-white">Pricing</a></li>
              <li><Link href="/login" className="transition hover:text-white">Sign in</Link></li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Connect
            </p>
            <ul className="mt-4 space-y-2 text-[13px] text-slate-300">
              <li>
                <a
                  href={buildWhatsAppUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 transition hover:text-white"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-[#25D366]" fill="currentColor" aria-hidden="true">
                    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 2.1.55 4.05 1.6 5.78L2 22l4.41-1.71a9.86 9.86 0 0 0 5.62 1.62h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.84 9.84 0 0 0 12.04 2zm0 1.66a8.25 8.25 0 0 1 5.85 2.42 8.22 8.22 0 0 1 2.42 5.83c0 4.55-3.71 8.26-8.27 8.26h-.01a8.27 8.27 0 0 1-4.21-1.16l-.3-.18-3.13 1.21 1.23-3.05-.2-.31a8.21 8.21 0 0 1-1.27-4.39c0-4.55 3.71-8.25 8.26-8.25 0-.01.01-.01.02-.01zm-2.4 4.45c-.18 0-.46.07-.7.34-.24.27-.93.91-.93 2.22s.95 2.58 1.08 2.76c.13.18 1.84 2.92 4.55 4 .64.27 1.13.43 1.52.55.64.21 1.22.18 1.68.11.51-.08 1.57-.64 1.79-1.27.22-.62.22-1.16.16-1.27-.07-.11-.24-.18-.51-.31-.27-.13-1.57-.78-1.81-.86-.24-.09-.42-.13-.6.14-.18.27-.69.86-.85 1.04-.16.18-.31.2-.58.07-.27-.13-1.13-.42-2.16-1.33-.8-.71-1.34-1.6-1.49-1.86-.16-.27-.02-.42.12-.55.12-.12.27-.31.4-.47.13-.16.18-.27.27-.45.09-.18.04-.34-.02-.47-.07-.13-.6-1.45-.83-1.99-.22-.51-.45-.45-.6-.45-.16 0-.34-.02-.51-.02z" />
                  </svg>
                  WhatsApp · <span className="font-mono text-[11.5px] text-slate-400">{WHATSAPP_NUMBER_DISPLAY}</span>
                </a>
              </li>
              <li>
                <a
                  href="mailto:hello@aicommos.com"
                  className="inline-flex items-center gap-2 transition hover:text-white"
                >
                  <Mail className="h-3.5 w-3.5 text-slate-500" /> hello@aicommos.com
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/ashamilon/AutoMads"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 transition hover:text-white"
                >
                  <Github className="h-3.5 w-3.5 text-slate-500" /> GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://twitter.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 transition hover:text-white"
                >
                  <Twitter className="h-3.5 w-3.5 text-slate-500" /> Twitter / X
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-white/[0.05] pt-6 sm:flex-row sm:items-center">
          <p className="font-mono text-[11px] text-slate-500">
            © {new Date().getFullYear()} AI Commerce OS · Built for Bangladeshi commerce.
          </p>
          <div className="flex items-center gap-5 text-[11.5px] text-slate-500">
            <a href="#" className="transition hover:text-slate-300">Terms</a>
            <a href="#" className="transition hover:text-slate-300">Privacy</a>
            <a href="#" className="transition hover:text-slate-300">Status</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
