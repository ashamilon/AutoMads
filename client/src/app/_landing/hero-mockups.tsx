"use client";

/**
 * Hero visual: a single frosted "OS" panel rather than scattered cards.
 *
 * The previous version used a brain-orb with five floating cards drifting
 * around it. This one is a deliberate departure: it shows ONE composed
 * panel that looks like the actual operating system the platform sells —
 *
 *   - Top: a status command bar ("Agent online · 18,432 msgs today")
 *   - Middle: a typed conversation strip (customer ↔ AI in Banglish)
 *   - Right column: a stacked KPI rail (revenue / orders / messages)
 *   - Bottom: a frosted "dock" with the four AI workers — each glows
 *     in turn on a 3.4s loop to signal they are active.
 *
 * Composition is intentionally asymmetric and dense — closer to Linear /
 * Arc than to a typical SaaS hero. Floats with a very subtle 6px tilt.
 */

import { motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  Bot,
  CheckCircle2,
  MessageSquare,
  Package,
  PenLine,
  Send,
  ShoppingBag,
  Sparkles,
} from "lucide-react";

const DOCK_AGENTS = [
  { Icon: ShoppingBag, label: "Sales", tone: "from-violet-400 to-fuchsia-400" },
  { Icon: PenLine, label: "Content", tone: "from-sky-400 to-cyan-400" },
  { Icon: MessageSquare, label: "Support", tone: "from-emerald-400 to-teal-400" },
  { Icon: Sparkles, label: "Marketing", tone: "from-amber-400 to-rose-400" },
] as const;

const CHAT_LINES = [
  { who: "customer", text: "Apu, ei jersey er size L ache?" },
  { who: "ai", text: "Hae bhaiya, ache. Cumilla 1 din e deliver hobe — confirm korbo?" },
  { who: "customer", text: "Confirm. bKash payment link den." },
  { who: "ai", text: "Pathiye dilam · Order #JR-2419 · Tk 1,450" },
] as const;

export function HeroMockups() {
  const prefersReducedMotion = useReducedMotion();
  return (
    <div className="relative h-full w-full">
      {/* Soft violet halo behind the panel */}
      <div className="pointer-events-none absolute inset-x-8 top-8 h-72 rounded-[40px] bg-[radial-gradient(closest-side,rgba(168,85,247,0.45),transparent)] blur-3xl" />

      <motion.div
        initial={{ opacity: 0, y: 24, rotateX: 6 }}
        animate={{ opacity: 1, y: 0, rotateX: 0 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        style={{ transformPerspective: 1200 }}
        className="relative h-full w-full"
      >
        <motion.div
          animate={prefersReducedMotion ? undefined : { y: [0, -6, 0] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
          className="relative overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03] backdrop-blur-2xl shadow-[0_60px_140px_-40px_rgba(124,58,237,0.55)]"
        >
          {/* Top status bar */}
          <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.03] px-5 py-3">
            <div className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500">
                <Bot className="h-3.5 w-3.5 text-white" />
              </span>
              <div className="leading-tight">
                <p className="text-[11px] font-semibold text-white">Sales Nation BD</p>
                <p className="flex items-center gap-1.5 text-[9.5px] text-emerald-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Agent online · 18,432 msgs today
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-slate-300">
                ⌘K
              </span>
              <span className="hidden rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[9.5px] font-semibold uppercase text-violet-200 sm:inline">
                Pro · 14d
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-[1.4fr_1fr]">
            {/* Left: live conversation */}
            <div className="rounded-2xl border border-white/[0.06] bg-black/30 p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Live conversation
                </p>
                <span className="font-mono text-[10px] text-slate-500">FB · m.me/sn-bd</span>
              </div>
              <ul className="space-y-2.5">
                {CHAT_LINES.map((c, i) => (
                  <motion.li
                    key={i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.3 + i * 0.18 }}
                    className={`flex ${c.who === "customer" ? "justify-start" : "justify-end"}`}
                  >
                    <span
                      className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] leading-snug ${
                        c.who === "customer"
                          ? "rounded-bl-sm bg-white/[0.06] text-slate-100"
                          : "rounded-br-sm bg-gradient-to-br from-violet-500 to-indigo-500 text-white"
                      }`}
                    >
                      {c.text}
                    </span>
                  </motion.li>
                ))}
              </ul>

              {/* Typing indicator */}
              <motion.div
                animate={
                  prefersReducedMotion ? undefined : { opacity: [0.4, 1, 0.4] }
                }
                transition={{ duration: 1.6, repeat: Infinity }}
                className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-400"
              >
                <span className="h-1 w-1 rounded-full bg-violet-300" />
                <span className="h-1 w-1 rounded-full bg-violet-300" />
                <span className="h-1 w-1 rounded-full bg-violet-300" />
                <span className="ml-1 font-mono">AI thinking · 4 next replies queued</span>
              </motion.div>
            </div>

            {/* Right: KPI rail + order receipt */}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: "Today", value: "Tk 48,210", tone: "text-emerald-300", sub: "+12.4%" },
                  { label: "Orders", value: "126", tone: "text-sky-300", sub: "+8" },
                ].map((k) => (
                  <div
                    key={k.label}
                    className="rounded-xl border border-white/[0.06] bg-black/30 p-3"
                  >
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                      {k.label}
                    </p>
                    <p className="mt-1 font-display text-base font-bold text-white">
                      {k.value}
                    </p>
                    <p className={`mt-0.5 text-[9.5px] ${k.tone}`}>{k.sub}</p>
                  </div>
                ))}
              </div>

              {/* Order receipt */}
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 1.1 }}
                className="overflow-hidden rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-3"
              >
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" /> Order placed
                  </p>
                  <span className="font-mono text-[9.5px] text-slate-400">just now</span>
                </div>
                <p className="mt-1.5 font-mono text-[11px] text-white">JR-2419 · Jersey AR L</p>
                <div className="mt-2 flex items-center justify-between text-[10px]">
                  <span className="text-slate-400">bKash · paid</span>
                  <span className="font-mono text-white">Tk 1,450</span>
                </div>
              </motion.div>

              {/* Mini activity ticker */}
              <div className="rounded-xl border border-white/[0.06] bg-black/30 p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-slate-400">
                  <Activity className="h-2.5 w-2.5" /> Recent
                </p>
                <ul className="space-y-1 font-mono text-[10px] text-slate-400">
                  <li>· caption posted to FB · 2m</li>
                  <li>· courier label booked · 4m</li>
                  <li>· stock auto-decreased · 6m</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Frosted dock — bottom strip */}
          <div className="border-t border-white/[0.06] bg-white/[0.02] px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                AI Workforce
              </p>
              <span className="font-mono text-[9.5px] text-slate-500">4 active</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              {DOCK_AGENTS.map((a, i) => (
                <motion.div
                  key={a.label}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.5 + i * 0.1 }}
                  className="relative flex flex-1 items-center gap-2 rounded-xl border border-white/[0.06] bg-black/30 px-3 py-2"
                >
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${a.tone}`}
                  >
                    <a.Icon className="h-3.5 w-3.5 text-white" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold text-white">{a.label}</p>
                    <p className="truncate text-[8.5px] text-slate-500">running</p>
                  </div>
                  {!prefersReducedMotion && (
                    <motion.span
                      className="pointer-events-none absolute inset-0 rounded-xl border border-violet-300/40"
                      animate={{ opacity: [0, 0.7, 0] }}
                      transition={{
                        duration: 3.4,
                        repeat: Infinity,
                        delay: i * 0.85,
                        ease: "easeInOut",
                      }}
                    />
                  )}
                </motion.div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Floating quick-reply chip — overlaps top-right of the panel */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6, delay: 0.9 }}
          className="absolute -right-3 top-24 hidden rounded-2xl border border-white/10 bg-white/[0.04] p-3 backdrop-blur-xl shadow-[0_24px_60px_-25px_rgba(99,102,241,0.6)] xl:block"
        >
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-violet-500 to-indigo-500">
              <Send className="h-3 w-3 text-white" />
            </span>
            <p className="text-[11px] font-semibold text-white">Reply queued</p>
          </div>
          <p className="mt-1.5 max-w-[180px] text-[10.5px] leading-snug text-slate-400">
            "Bhaiya bKash link · Tk 1,450 · ektu wait koren"
          </p>
        </motion.div>

        {/* Floating revenue spark — bottom-left overlap */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 1.05 }}
          className="absolute -bottom-4 -left-4 hidden rounded-2xl border border-white/10 bg-white/[0.04] p-3 backdrop-blur-xl shadow-[0_24px_60px_-25px_rgba(56,189,248,0.5)] xl:block"
        >
          <p className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wider text-slate-400">
            <Package className="h-2.5 w-2.5" /> 30-day revenue
          </p>
          <p className="mt-1 font-display text-lg font-bold text-white">৳1,48,920</p>
          <svg viewBox="0 0 100 24" className="mt-1 h-5 w-32" preserveAspectRatio="none">
            <path
              d="M0 18 L12 14 L24 16 L36 10 L48 12 L60 6 L72 9 L84 4 L100 2"
              fill="none"
              stroke="rgba(165,180,252,0.95)"
              strokeWidth="1.5"
            />
          </svg>
        </motion.div>
      </motion.div>
    </div>
  );
}
