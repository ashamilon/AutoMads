"use client";

/**
 * Testimonial section — avatar selector + active panel.
 *
 * Departure from the previous auto-rotating quote with bottom dots:
 *   - Avatar tabs sit above the quote panel; clicking an avatar selects
 *     it as active. The currently-active avatar gets a violet ring +
 *     "Active" pill below.
 *   - Auto-advances every 5.4s when not hovered or selected, but the
 *     row-of-avatars makes it feel curated, not slide-show-ish.
 *   - Mobile gets the same affordance — three big avatar circles in a
 *     row, full-width quote panel below.
 */

import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { Quote, Star } from "lucide-react";
import { SectionHeader } from "./feature-grid";

const QUOTES = [
  {
    quote:
      "Setting up took 12 minutes. By the next morning my AI was closing orders at 3am — something I could never do myself.",
    name: "Tanvir Ahmed",
    role: "Founder · Sports Nation BD",
    avatar: "T",
    tone: "from-indigo-500 to-violet-500",
    metric: "Tk 4.2L extra revenue · 30d",
  },
  {
    quote:
      "We replaced three customer-support people with one platform. The replies are warmer than what my team used to write.",
    name: "Sanjida Karim",
    role: "Owner · Glow Beauty Café",
    avatar: "S",
    tone: "from-rose-500 to-pink-500",
    metric: "−68% support cost · 90d",
  },
  {
    quote:
      "Eid weekend the AI handled 18,400 messages and shipped 612 orders. Zero burned cookies, zero overtime.",
    name: "Imran Hossain",
    role: "Director · Bondhu Restaurant",
    avatar: "I",
    tone: "from-amber-500 to-orange-500",
    metric: "612 orders · 3 days",
  },
] as const;

export function Testimonials() {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    if (paused || prefersReducedMotion) return;
    const t = setInterval(() => setIdx((p) => (p + 1) % QUOTES.length), 5400);
    return () => clearInterval(t);
  }, [paused, prefersReducedMotion]);

  const active = QUOTES[idx]!;

  return (
    <section className="relative mx-auto max-w-5xl px-6 py-20 sm:py-24">
      <SectionHeader
        eyebrow="Operators love it"
        title={
          <>
            Real shops.
            <span className="block bg-gradient-to-r from-violet-300 via-fuchsia-300 to-amber-200 bg-clip-text text-transparent">
              Real Eid weekends.
            </span>
          </>
        }
      />

      {/* Avatar row */}
      <div className="mt-12 flex items-center justify-center gap-3 sm:gap-5">
        {QUOTES.map((q, i) => (
          <button
            key={q.name}
            type="button"
            onClick={() => {
              setIdx(i);
              setPaused(true);
            }}
            aria-label={`Show testimonial from ${q.name}`}
            className={`group relative grid place-items-center transition-all ${
              i === idx ? "scale-110" : "opacity-60 hover:opacity-100"
            }`}
          >
            <div
              className={`grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br ${q.tone} font-display text-lg font-bold text-white sm:h-16 sm:w-16 ${
                i === idx ? "ring-2 ring-violet-300/70 ring-offset-4 ring-offset-[#06030f]" : ""
              }`}
            >
              {q.avatar}
            </div>
            {i === idx && (
              <span className="absolute -bottom-5 rounded-full border border-violet-400/30 bg-violet-500/15 px-1.5 py-px text-[8px] font-semibold uppercase tracking-wider text-violet-100">
                Active
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Quote panel */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.55 }}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="relative mt-10 overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025] p-7 sm:p-12 shadow-[0_30px_80px_-30px_rgba(168,85,247,0.45)] backdrop-blur-sm"
      >
        <Quote className="absolute right-7 top-6 h-12 w-12 text-violet-400/20" />
        <AnimatePresence mode="wait">
          <motion.div
            key={active.name}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.4 }}
          >
            <div className="flex items-center gap-1 text-amber-300">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star key={i} className="h-3.5 w-3.5 fill-current" />
              ))}
            </div>

            <p className="mt-4 font-display text-[19px] leading-snug text-slate-100 sm:text-[26px]">
              "{active.quote}"
            </p>

            <div className="mt-7 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-display text-[15px] font-semibold text-white">{active.name}</p>
                <p className="text-[12.5px] text-slate-400">{active.role}</p>
              </div>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 font-mono text-[11px] text-emerald-300">
                {active.metric}
              </span>
            </div>
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </section>
  );
}
