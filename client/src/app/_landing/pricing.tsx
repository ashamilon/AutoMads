"use client";

/**
 * Pricing — three tiers, swipeable on mobile.
 *
 * Departure from the previous bordered-card grid:
 *   - Cards are now structured as "header band + perks list" with a
 *     gradient header strip on the highlighted plan, not a glow.
 *   - 3-up grid on md+, single SwipeRow on mobile so the user pages
 *     through the tiers instead of scrolling a tall stack.
 *   - The perks list uses a violet checkmark plus a faint divider
 *     between rows for editorial density.
 */

import { motion } from "framer-motion";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { SectionHeader } from "./feature-grid";
import { SwipeRow } from "./swipe-row";

const TIERS = [
  {
    slug: "starter",
    name: "Starter",
    price: "৳999",
    period: "/mo",
    blurb: "Solo operators getting started.",
    perks: [
      "1 Facebook page",
      "AI sales agent",
      "2,000 messages / month",
      "50 products",
      "Manual posting",
    ],
    cta: "Start free trial",
    highlight: false,
  },
  {
    slug: "pro",
    name: "Pro",
    price: "৳2,999",
    period: "/mo",
    blurb: "Growing shops with serious volume.",
    perks: [
      "3 social accounts",
      "AI posting + content calendar",
      "20,000 messages / month",
      "500 products",
      "Priority support",
    ],
    cta: "Start free trial",
    highlight: true,
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    price: "Custom",
    period: "",
    blurb: "Multi-store, multi-category, multi-region.",
    perks: [
      "Unlimited messages + tokens",
      "Unlimited products",
      "Dedicated success manager",
      "Custom category schemas",
      "SLA + audit logs",
    ],
    cta: "Talk to sales",
    highlight: false,
  },
] as const;

export function Pricing() {
  const tierCards = TIERS.map((t, i) => <TierCard key={t.slug} tier={t} index={i} />);

  return (
    <section id="pricing" className="relative mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <SectionHeader
        eyebrow="Pricing"
        title={
          <>
            Simple plans.
            <span className="block bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
              14-day free trial on every tier.
            </span>
          </>
        }
        subtitle="No credit card to start. Upgrade, downgrade, or cancel any time from your billing page."
      />

      <div className="mt-14">
        <SwipeRow gridCols="md:grid-cols-3" cardWidth="min-w-[82%]">
          {tierCards}
        </SwipeRow>
      </div>

      {/* Trust strip */}
      <p className="mt-8 text-center font-mono text-[11px] text-slate-500">
        SSLCommerz · bKash · Nagad · Rocket · Stripe — all invoices PDF · taxes included
      </p>
    </section>
  );
}

function TierCard({
  tier,
  index,
}: {
  tier: (typeof TIERS)[number];
  index: number;
}) {
  const { highlight } = tier;
  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.45, delay: index * 0.07 }}
      whileHover={{ y: -4 }}
      className={`relative h-full overflow-hidden rounded-2xl border transition-all ${
        highlight
          ? "border-violet-400/40 bg-gradient-to-b from-violet-500/[0.12] via-violet-500/[0.04] to-transparent shadow-[0_30px_80px_-30px_rgba(168,85,247,0.55)]"
          : "border-white/[0.07] bg-white/[0.02]"
      }`}
    >
      {/* Header band — only on highlighted plan */}
      {highlight && (
        <div className="border-b border-violet-300/20 bg-gradient-to-r from-violet-500/20 via-fuchsia-500/15 to-violet-500/20 px-6 py-2 text-center">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.2em] text-violet-100">
            Most popular
          </span>
        </div>
      )}

      <div className="p-6 sm:p-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
          {tier.name}
        </p>
        <div className="mt-3 flex items-baseline gap-1">
          <span className="font-display text-[2.4rem] font-bold tracking-tight text-white">
            {tier.price}
          </span>
          <span className="text-[12px] text-slate-500">{tier.period}</span>
        </div>
        <p className="mt-2 text-[13px] text-slate-400">{tier.blurb}</p>

        <ul className="mt-6 divide-y divide-white/[0.05]">
          {tier.perks.map((p) => (
            <li
              key={p}
              className="flex items-start gap-2.5 py-2 text-[13px] text-slate-200"
            >
              <CheckCircle2
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                  highlight ? "text-violet-300" : "text-emerald-400"
                }`}
              />
              {p}
            </li>
          ))}
        </ul>

        <Link
          href="/login"
          className={`mt-7 inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-[13.5px] font-semibold transition-all ${
            highlight
              ? "bg-gradient-to-r from-violet-500 to-indigo-500 text-white shadow-[0_8px_24px_-8px_rgba(99,102,241,0.7)] hover:from-violet-400 hover:to-indigo-400"
              : "border border-white/[0.08] bg-white/[0.03] text-slate-200 hover:bg-white/[0.06]"
          }`}
        >
          {tier.cta} <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </motion.article>
  );
}
