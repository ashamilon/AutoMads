"use client";

/**
 * Final CTA banner.
 *
 * Departure from the previous centered glow-card:
 *   - Asymmetric two-column layout on desktop: copy + CTAs on the left,
 *     a stacked "join the launch" card on the right showing the trial
 *     length + onboarding speed claim.
 *   - On mobile, stacks into a single column but keeps the bold display
 *     headline tight to the edges so it dominates.
 *   - The container has a diagonal violet→indigo gradient mask running
 *     from top-left to bottom-right rather than a top-anchored halo.
 */

import { motion } from "framer-motion";
import { ArrowRight, Clock3, Sparkles, Zap } from "lucide-react";
import Link from "next/link";
import { WhatsAppButton } from "@/components/ui/whatsapp-cta";

export function FinalCta() {
  return (
    <section className="relative mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.55 }}
        className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-br from-violet-500/[0.18] via-indigo-500/[0.06] to-transparent p-8 sm:p-12 lg:p-14"
      >
        {/* Diagonal accent */}
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "linear-gradient(120deg, transparent 0%, rgba(168,85,247,0.18) 32%, transparent 60%)",
          }}
        />
        <div className="pointer-events-none absolute -top-24 left-1/3 h-72 w-[60%] rounded-full bg-[radial-gradient(closest-side,rgba(168,85,247,0.3),transparent)] blur-3xl" />

        <div className="relative grid gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-center">
          {/* Left — copy */}
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-violet-300/25 bg-violet-500/10 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-violet-200">
              <Sparkles className="h-3 w-3" /> Free 14-day trial
            </span>
            <h2
              className="mt-5 font-display font-bold tracking-tight text-white"
              style={{
                fontSize: "clamp(1.9rem, 1.4rem + 2.4vw, 3.2rem)",
                lineHeight: 1.05,
                letterSpacing: "-0.03em",
              }}
            >
              Launch your AI business agent
              <span className="block bg-gradient-to-r from-violet-200 via-fuchsia-200 to-sky-200 bg-clip-text text-transparent">
                today.
              </span>
            </h2>
            <p className="mt-5 max-w-lg text-[14.5px] leading-relaxed text-slate-300">
              Onboard in 12 minutes. Connect a Facebook page, point at your catalog, watch
              the AI close its first order before lunch.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/login"
                className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-7 py-3 text-[14.5px] font-semibold text-white shadow-[0_12px_30px_-10px_rgba(99,102,241,0.7)] transition hover:from-violet-400 hover:to-indigo-400"
              >
                Start free trial
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <WhatsAppButton
                prefill="Hi! I'd like to talk before signing up — can you walk me through how this works for my business?"
                label="Talk on WhatsApp"
                variant="secondary"
              />
            </div>
          </div>

          {/* Right — quick-stats card */}
          <div className="relative rounded-2xl border border-white/[0.08] bg-black/30 p-5 backdrop-blur-sm">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              What you get
            </p>
            <ul className="mt-4 space-y-3">
              {[
                { icon: Clock3, label: "Setup", value: "12 minutes" },
                { icon: Zap, label: "First AI reply", value: "< 30 seconds" },
                { icon: Sparkles, label: "Trial", value: "14 days, no card" },
              ].map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between border-b border-white/[0.05] pb-3 last:border-0 last:pb-0"
                >
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-400">
                    <row.icon className="h-3.5 w-3.5 text-violet-300" />
                    {row.label}
                  </span>
                  <span className="font-display text-[13.5px] font-semibold text-white">
                    {row.value}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-5 rounded-xl border border-violet-300/20 bg-violet-500/[0.08] p-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-violet-200">
                Includes
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-300">
                Sales agent · content calendar · multi-page support · payment + courier
                integrations · live dashboard
              </p>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
