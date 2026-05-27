"use client";

/**
 * Landing page for the AI Commerce OS.
 *
 * Total visual rewrite from the previous attempt. New direction:
 *   - Dark-on-violet aurora backdrop (no symmetric orbs).
 *   - Denser, bolder display typography with a 4-line stacked headline
 *     and a left-aligned hero on desktop, single-column on mobile.
 *   - Frosted "OS panel" hero visual instead of scattered cards.
 *   - Stat-pill rail directly under the CTA buttons reinforces scale.
 *   - Trust strip + multi-business chip row anchored to the bottom of
 *     the hero so the hero feels structurally "complete".
 *
 * Section order:
 *   1. Hero
 *   2. Trust strip (logos / proof bar)
 *   3. Feature grid (8 cards, swipeable on mobile)
 *   4. AI agent showcase (4 stages, swipeable on mobile)
 *   5. Multi-business category strip (two contra-rotating rows)
 *   6. Social automation showcase
 *   7. Live dashboard preview
 *   8. Pricing (swipeable on mobile)
 *   9. Testimonials (avatar selector)
 *  10. Final CTA
 *  11. Footer
 *
 * Authenticated tenants get redirected to `/portal` to skip the
 * marketing surface entirely.
 */

import { getStoredApiKey } from "@/lib/api";
import { motion } from "framer-motion";
import { ArrowRight, PlayCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AgentFlow } from "./_landing/agent-flow";
import { AnimatedBg } from "./_landing/animated-bg";
import { CategoryMarquee } from "./_landing/category-marquee";
import { DashboardPreview } from "./_landing/dashboard-preview";
import { FeatureGrid } from "./_landing/feature-grid";
import { FinalCta } from "./_landing/final-cta";
import { LandingFooter } from "./_landing/footer";
import { HeroMockups } from "./_landing/hero-mockups";
import { LandingNav } from "./_landing/nav";
import { Pricing } from "./_landing/pricing";
import { SocialAutomation } from "./_landing/social-automation";
import { Testimonials } from "./_landing/testimonials";
import { WhatsAppFloater } from "@/components/ui/whatsapp-cta";

const HERO_STATS = [
  { value: "12 min", label: "Avg setup" },
  { value: "18k+", label: "Msgs/day per shop" },
  { value: "14 schemas", label: "Built-in categories" },
  { value: "24/7", label: "AI workforce" },
];

const TRUST_LOGOS = [
  "SSLCommerz",
  "bKash",
  "Nagad",
  "Pathao",
  "RedX",
  "Steadfast",
  "Meta",
  "Stripe",
];

export default function LandingPage() {
  const router = useRouter();

  useEffect(() => {
    if (getStoredApiKey()) router.replace("/portal");
  }, [router]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#06030f] text-slate-100">
      <AnimatedBg />
      <LandingNav />

      {/* HERO */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pt-12 pb-16 sm:pt-20 sm:pb-24 lg:pt-24">
        <div className="grid items-start gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          {/* Left — copy */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="relative max-w-2xl"
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-violet-300/25 bg-violet-500/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-100">
              <Sparkles className="h-3 w-3" />
              AI Commerce Operating System
            </span>

            <h1
              className="mt-6 font-display font-bold tracking-tight text-white"
              style={{
                fontSize: "clamp(2.6rem, 1.8rem + 4vw, 5rem)",
                lineHeight: 0.98,
                letterSpacing: "-0.035em",
              }}
            >
              Run your entire
              <br />
              <span className="bg-gradient-to-r from-violet-200 via-fuchsia-200 to-sky-200 bg-clip-text text-transparent">
                commerce empire
              </span>
              <br />
              with AI agents.
            </h1>

            <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-slate-300 sm:text-[16px]">
              The all-in-one platform that runs your store, marketing, content, support,
              and ops on autopilot. <span className="text-white">One AI workforce. Every category. Zero manual.</span>
            </p>

            {/* CTAs */}
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/login"
                className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-7 py-3.5 text-[14.5px] font-semibold text-white shadow-[0_14px_36px_-10px_rgba(124,58,237,0.7)] transition hover:from-violet-400 hover:to-indigo-400"
              >
                Start free trial
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <a
                href="#features"
                className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-5 py-3 text-[13.5px] font-medium text-slate-200 backdrop-blur-sm transition hover:bg-white/[0.06]"
              >
                <PlayCircle className="h-4 w-4 text-slate-300" />
                Watch demo
              </a>
            </div>

            {/* Stat-pill rail */}
            <div className="mt-10 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {HERO_STATS.map((s) => (
                <div
                  key={s.label}
                  className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 backdrop-blur-sm"
                >
                  <p className="font-display text-[18px] font-bold tracking-tight text-white">
                    {s.value}
                  </p>
                  <p className="mt-0.5 text-[10.5px] uppercase tracking-[0.14em] text-slate-400">
                    {s.label}
                  </p>
                </div>
              ))}
            </div>

            {/* Multi-business chip row — desktop */}
            <div className="mt-9 hidden lg:block">
              <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                Your multi-business ecosystem
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  { letters: "US", label: "Urban Style", tone: "from-orange-500 to-rose-500" },
                  { letters: "TN", label: "Tech Nova", tone: "from-rose-500 to-fuchsia-500" },
                  { letters: "FL", label: "Fit Life", tone: "from-amber-500 to-orange-500" },
                  { letters: "BG", label: "Beauty Glow", tone: "from-violet-500 to-pink-500" },
                ].map((b) => (
                  <div
                    key={b.label}
                    className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5 backdrop-blur-sm"
                  >
                    <div
                      className={`grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br ${b.tone} font-display text-[10px] font-bold text-white`}
                    >
                      {b.letters}
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-white">{b.label}</p>
                      <p className="text-[9px] text-emerald-300">Active</p>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="grid h-[42px] place-items-center rounded-xl border border-dashed border-white/[0.12] bg-white/[0.015] px-3 text-[10px] text-slate-500 transition hover:bg-white/[0.04]"
                >
                  + Add Store
                </button>
              </div>
            </div>
          </motion.div>

          {/* Right — frosted OS panel mockup (desktop only) */}
          <div className="relative hidden h-[640px] lg:block">
            <HeroMockups />
          </div>

          {/* Mobile — compact hero card */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="relative lg:hidden"
          >
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-2xl shadow-[0_30px_80px_-30px_rgba(124,58,237,0.55)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 text-[11px] font-bold text-white">
                    AI
                  </span>
                  <p className="text-[12px] font-semibold text-white">Sales Agent</p>
                </div>
                <span className="flex items-center gap-1 text-[10px] text-emerald-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Online
                </span>
              </div>
              <div className="mt-3 space-y-2">
                <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white/[0.06] px-3 py-2 text-[11.5px] leading-snug text-slate-100">
                  Apu, ei jersey er size L ache?
                </div>
                <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-br from-violet-500 to-indigo-500 px-3 py-2 text-[11.5px] leading-snug text-white">
                  Hae bhaiya, ache. Cumilla 1 din e deliver hobe — confirm korbo?
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                  Order placed · just now
                </p>
                <p className="mt-1 font-mono text-[11px] text-white">JR-2419 · Tk 1,450</p>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="relative z-10 border-y border-white/[0.05] bg-black/30 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-6 py-5">
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 sm:gap-x-12">
            <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-slate-500">
              Native integrations
            </p>
            {TRUST_LOGOS.map((l) => (
              <span
                key={l}
                className="font-display text-[12.5px] font-semibold tracking-tight text-slate-300/90"
              >
                {l}
              </span>
            ))}
          </div>
        </div>
      </section>

      <FeatureGrid />
      <AgentFlow />
      <div id="categories">
        <CategoryMarquee />
      </div>
      <SocialAutomation />
      <DashboardPreview />
      <Pricing />
      <Testimonials />
      <FinalCta />
      <LandingFooter />

      {/* Floating WhatsApp bubble — always reachable from anywhere on the page */}
      <WhatsAppFloater prefill="Hi! I'd like to learn more about the AI Commerce OS platform — can you send me a setup link?" />
    </div>
  );
}
