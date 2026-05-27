"use client";

/**
 * AI agent showcase — staged conversation rail.
 *
 * Departure from the previous "4 cards in a row with a flowing line"
 * version:
 *   - Cards now look like terminal-style "stage" panels with monospaced
 *     timestamps and example payloads, not generic icons.
 *   - Mobile uses SwipeRow so the user pages through stages instead of
 *     scrolling a tall stack.
 *   - Desktop uses an asymmetric 4-up grid where odd cards are nudged
 *     down 24px, creating a zig-zag rhythm rather than a flat row.
 */

import { motion } from "framer-motion";
import { Bot, MessageSquare, Package, Send } from "lucide-react";
import { SectionHeader } from "./feature-grid";
import { SwipeRow } from "./swipe-row";

const STAGES = [
  {
    icon: MessageSquare,
    code: "00:00",
    title: "Customer message",
    body: "Apu, ei jersey kintu lagbe — size L. Cumilla deliver kora jabe?",
    tone: "border-sky-400/30 bg-sky-500/10 text-sky-200",
    accent: "from-sky-500/40 to-sky-500/0",
  },
  {
    icon: Bot,
    code: "00:02",
    title: "AI reasoning",
    body: "→ resolves SKU JR-2419\n→ stock = 6 units\n→ Cumilla courier OK\n→ asks confirmation",
    tone: "border-violet-400/30 bg-violet-500/10 text-violet-200",
    accent: "from-violet-500/40 to-violet-500/0",
  },
  {
    icon: Package,
    code: "00:08",
    title: "Order created",
    body: "Validated · payment link sent (bKash) · courier prepped (Pathao 1d)",
    tone: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
    accent: "from-emerald-500/40 to-emerald-500/0",
  },
  {
    icon: Send,
    code: "T+1d",
    title: "Follow-up",
    body: "Reminder · review request · abandoned-cart nudge — autonomous.",
    tone: "border-amber-400/30 bg-amber-500/10 text-amber-200",
    accent: "from-amber-500/40 to-amber-500/0",
  },
] as const;

export function AgentFlow() {
  const cards = STAGES.map((s, i) => (
    <motion.div
      key={s.title}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.45, delay: i * 0.1 }}
      className={`group relative h-full overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5 backdrop-blur-sm md:translate-y-0 ${
        i % 2 === 1 ? "md:translate-y-6" : ""
      }`}
    >
      <div
        className={`pointer-events-none absolute inset-x-0 -top-6 h-28 bg-gradient-to-b ${s.accent}`}
      />
      <div className="relative flex items-start justify-between">
        <div className={`grid h-10 w-10 place-items-center rounded-xl border ${s.tone}`}>
          <s.icon className="h-5 w-5" />
        </div>
        <span className="font-mono text-[10.5px] tracking-wider text-slate-500">
          {s.code}
        </span>
      </div>

      <p className="relative mt-4 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        Step 0{i + 1}
      </p>
      <h3 className="relative mt-1 font-display text-[16px] font-semibold tracking-tight text-white">
        {s.title}
      </h3>
      <pre className="relative mt-2 whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-slate-300">
        {s.body}
      </pre>
    </motion.div>
  ));

  return (
    <section id="flow" className="relative mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <SectionHeader
        eyebrow="AI Agent in action"
        title={
          <>
            From conversation to delivery.
            <span className="block bg-gradient-to-r from-violet-300 via-fuchsia-300 to-amber-200 bg-clip-text text-transparent">
              Hands-free.
            </span>
          </>
        }
        subtitle="One inbound message, four autonomous steps. Your AI workforce closes the loop without you."
      />

      <div className="relative mt-14">
        {/* Connector hairline behind the desktop zig-zag */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-12 hidden h-px bg-gradient-to-r from-transparent via-violet-400/40 to-transparent md:block"
        />
        <SwipeRow
          gridCols="md:grid-cols-2 lg:grid-cols-4"
          cardWidth="min-w-[80%] sm:min-w-[55%]"
        >
          {cards}
        </SwipeRow>
      </div>
    </section>
  );
}
