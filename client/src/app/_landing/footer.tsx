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

import { Mail, Twitter } from "lucide-react";
import Link from "next/link";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import { WHATSAPP_NUMBER_DISPLAY, buildWhatsAppUrl } from "@/lib/contact";
import { WhatsAppGlyph } from "@/components/ui/whatsapp-cta";

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
                className="h-9 w-9 rounded-md object-contain brightness-0 invert"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={brandNameUrl}
                alt="Brand name"
                className="h-[1.725rem] w-auto max-w-[11.5rem] object-contain brightness-0 invert"
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
                  <WhatsAppGlyph className="h-3.5 w-3.5 text-[#25D366]" />
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
