"use client";

/**
 * Dashboard preview — framed in a faux browser chrome.
 *
 * Departure from the previous flat-card preview:
 *   - Wrapped in browser chrome (traffic-light buttons + URL bar) so it
 *     reads as "look at the actual product" instead of a generic stat
 *     panel.
 *   - Three-column KPI rail collapses to a SwipeRow on mobile.
 *   - Activity ticker now alternates between three lines on a slow loop,
 *     reinforcing "things are constantly happening".
 */

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  MessageCircleMore,
  Package,
  TrendingUp,
} from "lucide-react";
import { SectionHeader } from "./feature-grid";
import { SwipeRow } from "./swipe-row";

const TICKER_LINES = [
  { tone: "text-emerald-400", verb: "AI agent", action: "closed 4 orders", suffix: "in the last hour" },
  { tone: "text-sky-400", verb: "Content bot", action: "queued 3 captions", suffix: "for tomorrow" },
  { tone: "text-amber-400", verb: "Marketing", action: "sent 1,243 follow-ups", suffix: "this morning" },
];

function useTickingCount(start: number, jitter: number) {
  const [n, setN] = useState(start);
  const prefersReducedMotion = useReducedMotion();
  useEffect(() => {
    if (prefersReducedMotion) return;
    const t = setInterval(() => {
      setN((prev) => prev + Math.floor(Math.random() * jitter));
    }, 4500);
    return () => clearInterval(t);
  }, [jitter, prefersReducedMotion]);
  return n;
}

export function DashboardPreview() {
  const messages = useTickingCount(8214, 5);
  const orders = useTickingCount(312, 2);
  const revenue = useTickingCount(98456, 14);

  // Rotating ticker line
  const [tickIdx, setTickIdx] = useState(0);
  const prefersReducedMotion = useReducedMotion();
  useEffect(() => {
    if (prefersReducedMotion) return;
    const t = setInterval(
      () => setTickIdx((p) => (p + 1) % TICKER_LINES.length),
      4200,
    );
    return () => clearInterval(t);
  }, [prefersReducedMotion]);
  const tick = TICKER_LINES[tickIdx]!;

  const stats = [
    {
      icon: TrendingUp,
      label: "Revenue (30d)",
      value: `৳${revenue.toLocaleString()}`,
      delta: "+12.8%",
    },
    {
      icon: Package,
      label: "Orders",
      value: orders.toLocaleString(),
      delta: "+6.2%",
    },
    {
      icon: MessageCircleMore,
      label: "Customer messages",
      value: messages.toLocaleString(),
      delta: "+18.4%",
    },
  ];

  return (
    <section className="relative mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <SectionHeader
        eyebrow="Live dashboard"
        title={
          <>
            See your business
            <span className="block bg-gradient-to-r from-violet-300 via-indigo-300 to-sky-300 bg-clip-text text-transparent">
              breathing.
            </span>
          </>
        }
        subtitle="One pane for orders, conversations, AI activity, and sales — refreshed in real time."
      />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.55 }}
        className="mt-14 overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-white/[0.04] via-white/[0.02] to-transparent shadow-[0_40px_120px_-40px_rgba(124,58,237,0.5)]"
      >
        {/* Browser chrome */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] bg-black/30 px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          </div>
          <div className="flex-1 truncate rounded-md border border-white/[0.06] bg-black/40 px-3 py-1 font-mono text-[10.5px] text-slate-400">
            commerce-os.app/portal/overview
          </div>
          <span className="rounded border border-white/[0.06] bg-black/40 px-1.5 py-0.5 font-mono text-[9.5px] text-slate-400">
            ⌘K
          </span>
        </div>

        <div className="p-5 sm:p-6">
          {/* KPI rail */}
          <SwipeRow gridCols="md:grid-cols-3" cardWidth="min-w-[78%]">
            {stats.map((s) => (
              <Stat key={s.label} {...s} />
            ))}
          </SwipeRow>

          <div className="mt-6 grid gap-4 md:grid-cols-[1.5fr_1fr]">
            {/* Left — revenue chart */}
            <div className="rounded-xl border border-white/[0.06] bg-black/30 p-4">
              <div className="flex items-center justify-between">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Revenue trend
                </p>
                <span className="font-mono text-[10px] text-slate-500">last 14 days</span>
              </div>
              <ChartLine />
            </div>

            {/* Right — recent orders */}
            <div className="rounded-xl border border-white/[0.06] bg-black/30 p-4">
              <p className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Recent orders
              </p>
              <ul className="space-y-2.5">
                {[
                  { sku: "JR-2419", price: "1,450", state: "paid" },
                  { sku: "JR-2418", price: "1,500", state: "courier" },
                  { sku: "JR-2415", price: "1,300", state: "delivered" },
                  { sku: "JR-2410", price: "1,650", state: "paid" },
                ].map((o) => (
                  <li
                    key={o.sku}
                    className="flex items-center justify-between text-[12px]"
                  >
                    <div className="flex items-center gap-2">
                      <Activity className="h-3 w-3 text-slate-500" />
                      <span className="font-mono text-[11px] text-slate-300">{o.sku}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-white">৳{o.price}</span>
                      <OrderPill state={o.state} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Activity ticker */}
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-black/30 px-3 py-2 text-[11.5px]">
            <CheckCircle2 className={`h-3 w-3 ${tick.tone}`} />
            <span className="text-slate-400">{tick.verb}</span>
            <motion.span
              key={tickIdx}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="font-mono text-slate-200"
            >
              {tick.action}
            </motion.span>
            <span className="text-slate-500">{tick.suffix}</span>
            <span className="ml-auto inline-flex items-center gap-1 text-slate-500">
              <ArrowUpRight className="h-3 w-3" /> trending up
            </span>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  delta,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
  delta: string;
}) {
  return (
    <div className="h-full rounded-xl border border-white/[0.06] bg-black/30 p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-slate-500" />
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          {label}
        </p>
      </div>
      <p className="mt-2 font-display text-2xl font-bold tracking-tight text-white">
        {value}
      </p>
      <p className="mt-1 flex items-center gap-1 text-[11px] text-emerald-300">
        <TrendingUp className="h-3 w-3" /> {delta}
      </p>
    </div>
  );
}

function OrderPill({ state }: { state: string }) {
  const map: Record<string, string> = {
    paid: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    courier: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    delivered: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  };
  const cls = map[state] ?? "border-white/[0.08] bg-white/[0.04] text-slate-300";
  return (
    <span
      className={`rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {state}
    </span>
  );
}

function ChartLine() {
  return (
    <svg viewBox="0 0 320 90" className="mt-3 h-24 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="dashLine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(196,181,253,0.7)" />
          <stop offset="100%" stopColor="rgba(196,181,253,0)" />
        </linearGradient>
      </defs>
      <path
        d="M0 70 L20 64 L40 56 L60 60 L80 48 L100 52 L120 38 L140 44 L160 30 L180 36 L200 22 L220 28 L240 16 L260 22 L280 12 L300 18 L320 8 L320 90 L0 90 Z"
        fill="url(#dashLine)"
      />
      <path
        d="M0 70 L20 64 L40 56 L60 60 L80 48 L100 52 L120 38 L140 44 L160 30 L180 36 L200 22 L220 28 L240 16 L260 22 L280 12 L300 18 L320 8"
        fill="none"
        stroke="rgba(196,181,253,0.95)"
        strokeWidth="2"
      />
    </svg>
  );
}
