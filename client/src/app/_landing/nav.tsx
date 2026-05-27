"use client";

/**
 * Compact landing nav.
 *
 * Differs from the previous version by:
 *   - A denser pill-shaped wrapper that "floats" off the top edge
 *     (visually anchored to the violet wash) instead of a flat bar.
 *   - Live "AI online" status indicator — reinforces the platform claim.
 *   - Mobile keeps brand + CTA only (no link list, no hamburger needed).
 */

import { motion, useScroll, useTransform } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";

const LINKS = [
  { href: "#features", label: "Product" },
  { href: "#flow", label: "AI Agents" },
  { href: "#categories", label: "Categories" },
  { href: "#pricing", label: "Pricing" },
] as const;

export function LandingNav() {
  const { scrollY } = useScroll();
  const padding = useTransform(scrollY, [0, 80], [16, 8]);
  const blur = useTransform(scrollY, [0, 80], [12, 24]);
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();
  return (
    <motion.header
      style={{ paddingTop: padding, backdropFilter: useTransform(blur, (b) => `blur(${b}px)`) }}
      className="sticky top-0 z-50"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-black/40 px-3 py-2 backdrop-blur-xl shadow-[0_18px_60px_-30px_rgba(0,0,0,0.7)] sm:px-4 sm:py-2.5">
          {/* Brand + status */}
          <Link href="/" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={brandLogoUrl}
              alt="Brand logo"
              className="h-7 w-7 rounded-lg object-contain brightness-0 invert"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={brandNameUrl}
              alt="Brand name"
              className="h-4 w-auto max-w-[7rem] object-contain brightness-0 invert"
            />
            <span className="ml-1.5 hidden items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-emerald-300 sm:inline-flex">
              <span className="h-1 w-1 animate-pulse rounded-full bg-emerald-400" /> Live
            </span>
          </Link>

          {/* Desktop links */}
          <nav className="hidden items-center gap-7 text-[12.5px] font-medium text-slate-400 lg:flex">
            {LINKS.map((l) => (
              <a key={l.href} href={l.href} className="transition hover:text-white">
                {l.label}
              </a>
            ))}
          </nav>

          {/* Right CTAs */}
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="hidden rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-slate-300 transition hover:text-white sm:block"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="group inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-[0_8px_22px_-8px_rgba(99,102,241,0.7)] transition hover:from-violet-400 hover:to-indigo-400"
            >
              Start free
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </div>
    </motion.header>
  );
}
