"use client";

/**
 * Feature grid — number-led cards.
 *
 * Departure from the previous icon-tile design:
 *   - Each card has a giant `01..08` numeral as the visual anchor, not
 *     an icon tile. Inspired by editorial / Linear changelog cards.
 *   - 4×2 grid on lg+, 2×4 on md, single-column SwipeRow on mobile.
 *   - Hover reveals an angled violet underline + lifts the card.
 *
 * The `SectionHeader` helper is exported from here so other sections
 * can keep using a consistent layout without duplicating styles.
 */

import { motion } from "framer-motion";
import {
  BarChart3,
  Bot,
  Brain,
  CalendarDays,
  CreditCard,
  HeadphonesIcon,
  Layers,
  Sparkles,
} from "lucide-react";
import { SwipeRow } from "./swipe-row";

const FEATURES = [
  {
    icon: Bot,
    title: "AI Sales Agent",
    desc: "Category-aware agent that closes orders, recommends products, handles objections — Banglish or English.",
  },
  {
    icon: Sparkles,
    title: "Autonomous Posting",
    desc: "Brand-tuned posts publish to Facebook + Instagram on the schedule you set. Approval mode optional.",
  },
  {
    icon: CalendarDays,
    title: "AI Content Calendar",
    desc: "Captions, hashtags, image picks — generated and queued. Style-cycled so feeds never feel repetitive.",
  },
  {
    icon: Layers,
    title: "Multi-Business Support",
    desc: "One platform, every category. Schemas adapt automatically — jersey, restaurant, cosmetics, electronics.",
  },
  {
    icon: CreditCard,
    title: "Smart Orders",
    desc: "SSLCommerz, bKash, Nagad, COD — all native. Verified payment hands off to courier. No manual touch.",
  },
  {
    icon: HeadphonesIcon,
    title: "AI Customer Support",
    desc: "Past-order grace window, human handoff on demand, polite Banglish replies — out of the box.",
  },
  {
    icon: Brain,
    title: "Subscription Automation",
    desc: "Trial → active → grace → suspend → reactivate. Billing, invoicing, dunning — handled.",
  },
  {
    icon: BarChart3,
    title: "Dashboard Analytics",
    desc: "Live revenue, conversation health, AI usage. Per-category dashboards built from your schema.",
  },
] as const;

export function FeatureGrid() {
  const cards = FEATURES.map((f, i) => (
    <FeatureCard key={f.title} feature={f} index={i} />
  ));

  return (
    <section id="features" className="relative mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <SectionHeader
        eyebrow="Built-in"
        title={
          <>
            Everything an online business needs,
            <span className="block bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
              automated.
            </span>
          </>
        }
        subtitle="Your AI workforce: sales, marketing, support, ops. One platform that adapts to your category."
      />

      <div className="mt-12">
        <SwipeRow gridCols="md:grid-cols-2 lg:grid-cols-4" cardWidth="min-w-[78%] sm:min-w-[55%]">
          {cards}
        </SwipeRow>
      </div>
    </section>
  );
}

function FeatureCard({
  feature,
  index,
}: {
  feature: (typeof FEATURES)[number];
  index: number;
}) {
  const { icon: Icon, title, desc } = feature;
  return (
    <motion.article
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.45, delay: (index % 4) * 0.05 }}
      whileHover={{ y: -4 }}
      className="group relative h-full overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 transition-colors hover:border-violet-300/25 hover:bg-white/[0.035]"
    >
      {/* Big numeral */}
      <div className="flex items-start justify-between">
        <span className="font-display text-[2.6rem] font-bold leading-none tracking-tight text-white/[0.07] transition-colors group-hover:text-violet-300/30">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.06] bg-white/[0.04] text-violet-200 transition-all group-hover:border-violet-300/30 group-hover:bg-violet-500/10">
          <Icon className="h-4 w-4" />
        </div>
      </div>

      <h3 className="mt-4 font-display text-[17px] font-semibold tracking-tight text-white">
        {title}
      </h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-400">{desc}</p>

      {/* Hover underline */}
      <span className="pointer-events-none absolute inset-x-5 bottom-4 h-px origin-left scale-x-0 bg-gradient-to-r from-violet-400 via-fuchsia-400 to-transparent transition-transform duration-300 group-hover:scale-x-100" />

      {/* Hover bottom glow */}
      <div className="pointer-events-none absolute -bottom-12 left-1/2 h-24 w-24 -translate-x-1/2 rounded-full bg-violet-500/15 opacity-0 blur-2xl transition-opacity group-hover:opacity-100" />
    </motion.article>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  align = "center",
}: {
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: string;
  align?: "center" | "left";
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5 }}
      className={`max-w-3xl ${align === "center" ? "mx-auto text-center" : ""}`}
    >
      {eyebrow && (
        <span className="inline-flex items-center gap-2 rounded-full border border-violet-300/20 bg-violet-500/10 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-violet-200">
          {eyebrow}
        </span>
      )}
      <h2
        className="mt-4 font-display font-bold tracking-tight text-white"
        style={{
          fontSize: "clamp(1.75rem, 1.4rem + 1.6vw, 2.8rem)",
          lineHeight: 1.08,
          letterSpacing: "-0.025em",
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p className="mt-4 text-[14.5px] leading-relaxed text-slate-400">{subtitle}</p>
      )}
    </motion.div>
  );
}
