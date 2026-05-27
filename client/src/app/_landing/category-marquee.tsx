"use client";

/**
 * Category section.
 *
 * Departure from the previous single-line marquee:
 *   - Two contra-rotating marquee rows (top scrolls left, bottom right)
 *     so the section reads as a flowing strip, not a single ticker.
 *   - Below the marquee, a small "schema preview" stub on desktop that
 *     teases the dynamic-form-builder claim (e.g. "Jersey · 6 fields").
 *   - Edge fades use a hard violet→transparent gradient instead of
 *     surface-950 so the marquee blends with the page wash.
 */

import { motion, useReducedMotion } from "framer-motion";
import {
  Apple,
  Coffee,
  Cpu,
  Gem,
  Heart,
  Home,
  PawPrint,
  Pill,
  Shirt,
  Smartphone,
  Sparkles,
  Watch,
} from "lucide-react";
import { SectionHeader } from "./feature-grid";

const CATEGORIES = [
  { icon: Shirt, label: "Jersey", tone: "text-sky-300", fields: "size, version, badge" },
  { icon: Sparkles, label: "Cosmetics", tone: "text-rose-300", fields: "skin type, shade, ingredients" },
  { icon: Coffee, label: "Restaurant", tone: "text-amber-300", fields: "menu, dietary, spice level" },
  { icon: Cpu, label: "Electronics", tone: "text-violet-300", fields: "spec, warranty, condition" },
  { icon: Watch, label: "Shoes", tone: "text-emerald-300", fields: "size, gender, material" },
  { icon: Heart, label: "Undergarments", tone: "text-pink-300", fields: "size, fit, fabric" },
  { icon: Apple, label: "Grocery", tone: "text-lime-300", fields: "weight, brand, expiry" },
  { icon: Gem, label: "Jewelry", tone: "text-yellow-300", fields: "metal, karat, stone" },
  { icon: Home, label: "Furniture", tone: "text-orange-300", fields: "dimensions, material, room" },
  { icon: PawPrint, label: "Pet shop", tone: "text-teal-300", fields: "species, age, breed" },
  { icon: Pill, label: "Pharmacy", tone: "text-cyan-300", fields: "dosage, prescription, brand" },
  { icon: Smartphone, label: "Mobile accessories", tone: "text-indigo-300", fields: "compatibility, color, type" },
] as const;

export function CategoryMarquee() {
  const prefersReducedMotion = useReducedMotion();
  const rowA = [...CATEGORIES, ...CATEGORIES];
  const rowB = [...CATEGORIES.slice().reverse(), ...CATEGORIES.slice().reverse()];
  return (
    <section className="relative mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <SectionHeader
        eyebrow="Multi-business"
        title={
          <>
            Every category. One AI.
            <span className="block bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
              Zero rewrites.
            </span>
          </>
        }
        subtitle="The agent picks up your category schema and adapts vocabulary, recommendations, and workflows automatically."
      />

      <div className="relative mt-14 space-y-3">
        {/* Edge fades */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-[#06030f] to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-[#06030f] to-transparent" />

        {/* Row A — left */}
        <div className="overflow-hidden">
          <motion.div
            className="flex gap-3"
            animate={prefersReducedMotion ? undefined : { x: ["0%", "-50%"] }}
            transition={{ duration: 38, repeat: Infinity, ease: "linear" }}
          >
            {rowA.map((c, i) => (
              <CategoryChip key={`a-${c.label}-${i}`} c={c} />
            ))}
          </motion.div>
        </div>

        {/* Row B — right */}
        <div className="overflow-hidden">
          <motion.div
            className="flex gap-3"
            animate={prefersReducedMotion ? undefined : { x: ["-50%", "0%"] }}
            transition={{ duration: 42, repeat: Infinity, ease: "linear" }}
          >
            {rowB.map((c, i) => (
              <CategoryChip key={`b-${c.label}-${i}`} c={c} />
            ))}
          </motion.div>
        </div>
      </div>

      {/* Desktop teaser — schema adapts per category */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5 }}
        className="mt-10 hidden items-center justify-center gap-2 text-[12px] text-slate-400 md:flex"
      >
        <span className="font-mono">schema.adaptsTo(</span>
        <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 font-mono text-violet-200">
          your_category
        </span>
        <span className="font-mono">)</span>
        <span>·</span>
        <span>14 schemas built-in · custom schemas on Pro+</span>
      </motion.div>
    </section>
  );
}

function CategoryChip({ c }: { c: (typeof CATEGORIES)[number] }) {
  return (
    <div className="group flex shrink-0 items-center gap-2.5 rounded-full border border-white/[0.07] bg-white/[0.025] px-4 py-2 backdrop-blur-sm transition-colors hover:border-violet-300/30 hover:bg-violet-500/[0.05]">
      <c.icon className={`h-4 w-4 ${c.tone}`} />
      <span className="text-[12.5px] font-medium text-slate-100">{c.label}</span>
      <span className="hidden font-mono text-[10px] text-slate-500 sm:inline">
        · {c.fields}
      </span>
    </div>
  );
}
