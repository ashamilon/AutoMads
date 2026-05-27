"use client";

/**
 * Social automation showcase — bullets + queued posts panel.
 *
 * Departure from the previous version:
 *   - Bullets are now numbered "axis cards" instead of icon+text rows,
 *     matching the editorial card mood from the feature grid.
 *   - The queued posts panel becomes a SwipeRow on mobile so the user
 *     pages through draft posts instead of scrolling a tall column.
 *   - The "publishing" indicator on the active post is a vertical
 *     accent strip + animated progress, not a bottom shimmer.
 */

import { motion } from "framer-motion";
import { CheckCircle2, Hash, Image as ImageIcon, Sparkles } from "lucide-react";
import { SectionHeader } from "./feature-grid";
import { SwipeRow } from "./swipe-row";

const POSTS = [
  {
    title: "Spain WC26 Away Kit · Pre-order open",
    caption:
      "New season jersey lineup just dropped. Pre-order open till stock lasts — apnar size book korun.",
    hashtags: ["#WorldCup26", "#JerseyBD", "#Football"],
    when: "Today · 6:00 pm",
    status: "publishing" as const,
  },
  {
    title: "Carousel: 4 best-sellers this week",
    caption: "Best-seller list — 4 picks niye nile na wonderful.",
    hashtags: ["#BestSeller", "#FootballFans"],
    when: "Tomorrow · 11:00 am",
    status: "queued" as const,
  },
  {
    title: "Eid offer reminder",
    caption: "Eid offer eshe gechhe — 25% off on selected jerseys. Don't miss it.",
    hashtags: ["#EidOffer", "#FlashSale"],
    when: "Sat · 8:00 pm",
    status: "queued" as const,
  },
];

const BULLETS = [
  {
    icon: Sparkles,
    title: "Brand-voice captions",
    desc: "Trained on your past posts. Consistent tone, every time.",
  },
  {
    icon: ImageIcon,
    title: "Auto image picks",
    desc: "Pulls product photos from your catalog and slots them in.",
  },
  {
    icon: Hash,
    title: "Smart hashtags",
    desc: "Category-aware tags, never the same set twice.",
  },
  {
    icon: CheckCircle2,
    title: "Approve or auto-publish",
    desc: "Off / Draft / Auto modes. You stay in control.",
  },
];

export function SocialAutomation() {
  const postCards = POSTS.map((p, i) => <PostCard key={p.title} post={p} index={i} />);

  return (
    <section className="relative mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <SectionHeader
        eyebrow="Social Automation"
        title={
          <>
            Captions, schedules, posts —
            <span className="block bg-gradient-to-r from-fuchsia-300 via-violet-300 to-sky-300 bg-clip-text text-transparent">
              on autopilot.
            </span>
          </>
        }
        subtitle="Your AI marketer drafts, captions, schedules, and ships. Your feed never goes quiet."
      />

      <div className="mt-14 grid gap-8 lg:grid-cols-[1fr_1.2fr]">
        {/* Left — numbered bullets */}
        <div className="space-y-4">
          {BULLETS.map((b, i) => (
            <motion.div
              key={b.title}
              initial={{ opacity: 0, x: -16 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.4, delay: i * 0.06 }}
              className="group relative flex items-start gap-4 rounded-xl border border-white/[0.05] bg-white/[0.015] p-3 transition-colors hover:border-violet-300/20 hover:bg-white/[0.03]"
            >
              <span className="font-display text-[1.6rem] font-bold leading-none text-white/[0.1] transition-colors group-hover:text-violet-300/40">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <b.icon className="h-3.5 w-3.5 text-violet-300" />
                  <h3 className="font-display text-[14.5px] font-semibold text-white">
                    {b.title}
                  </h3>
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">{b.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Right — content calendar panel */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.55 }}
          className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5 backdrop-blur-sm shadow-[0_30px_80px_-30px_rgba(168,85,247,0.4)]"
        >
          <div className="mb-4 flex items-center justify-between">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Content Calendar
            </p>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-emerald-300">
              Auto mode
            </span>
          </div>
          <SwipeRow gridCols="md:grid-cols-1" cardWidth="min-w-[88%] sm:min-w-[70%]">
            {postCards}
          </SwipeRow>
        </motion.div>
      </div>
    </section>
  );
}

function PostCard({
  post,
  index: _index,
}: {
  post: (typeof POSTS)[number];
  index: number;
}) {
  const isLive = post.status === "publishing";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4 }}
      className={`relative h-full overflow-hidden rounded-xl border p-3 ${
        isLive
          ? "border-violet-400/40 bg-violet-500/[0.06]"
          : "border-white/[0.06] bg-black/30"
      }`}
    >
      {/* Vertical accent strip when publishing */}
      {isLive && (
        <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-violet-400 via-fuchsia-400 to-violet-400" />
      )}
      <div className="flex items-start justify-between gap-3 pl-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[13px] font-semibold text-white">
            {post.title}
          </p>
          <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-slate-400">
            {post.caption}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {post.hashtags.map((h) => (
              <span
                key={h}
                className="rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9.5px] text-slate-300"
              >
                {h}
              </span>
            ))}
          </div>
        </div>
        <div className="text-right text-[10px] text-slate-500">
          <p>{post.when}</p>
          <p
            className={`mt-1 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider ${
              isLive
                ? "border border-violet-400/30 bg-violet-500/15 text-violet-200"
                : "border border-white/[0.08] bg-white/[0.04] text-slate-300"
            }`}
          >
            {post.status}
          </p>
        </div>
      </div>

      {/* Animated progress bar at the bottom for publishing post */}
      {isLive && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.04]">
          <motion.span
            className="block h-full bg-gradient-to-r from-violet-400 via-fuchsia-400 to-violet-400"
            animate={{ x: ["-100%", "0%"] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: "linear" }}
            style={{ width: "55%" }}
          />
        </div>
      )}
    </motion.div>
  );
}
