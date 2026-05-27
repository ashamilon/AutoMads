"use client";

/**
 * Asymmetric "violet wash" backdrop.
 *
 * Total visual departure from the previous symmetric-orbs treatment.
 * Three intentional layers, each with a different mood:
 *
 *   1. **Deep violet wash** anchored top-left (aurora-style, blown out
 *      so the whole page reads "violet OS" not "neutral dashboard").
 *   2. **Diagonal scan-grid** drawn in violet, masked to a 35° band so
 *      the page feels like a CAD/OS interface rather than a neutral
 *      marketing template.
 *   3. **Slow-pulsing edge bloom** in the bottom-right — only one orb,
 *      and it's deliberately off-center so the composition feels
 *      designed, not generated.
 *
 * Particles are gone — they read "AI cliché". Replaced with a single
 * vertical light beam that drifts horizontally on a long loop.
 */

import { motion, useReducedMotion } from "framer-motion";

export function AnimatedBg() {
  const prefersReducedMotion = useReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Layer 0 — solid base */}
      <div className="absolute inset-0 bg-[#06030f]" />

      {/* Layer 1 — violet aurora anchored top-left */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 60% at 18% -10%, rgba(124,58,237,0.55) 0%, rgba(91,33,182,0.25) 38%, transparent 70%), radial-gradient(60% 50% at 110% 30%, rgba(56,189,248,0.18) 0%, transparent 60%), radial-gradient(50% 40% at -10% 110%, rgba(236,72,153,0.15) 0%, transparent 60%)",
        }}
      />

      {/* Layer 2 — diagonal scan-grid (35deg band) */}
      <div
        className="absolute inset-0 opacity-[0.22]"
        style={{
          backgroundImage:
            "linear-gradient(transparent 0, transparent calc(100% - 1px), rgba(196,181,253,0.18) 100%), linear-gradient(90deg, transparent 0, transparent calc(100% - 1px), rgba(196,181,253,0.12) 100%)",
          backgroundSize: "72px 72px",
          maskImage:
            "linear-gradient(120deg, transparent 0%, black 30%, black 65%, transparent 95%)",
          WebkitMaskImage:
            "linear-gradient(120deg, transparent 0%, black 30%, black 65%, transparent 95%)",
        }}
      />

      {/* Layer 3 — bottom-right edge bloom */}
      <motion.div
        aria-hidden="true"
        className="absolute -bottom-40 -right-40 h-[640px] w-[760px] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgba(168,85,247,0.32), transparent 70%)",
          filter: "blur(40px)",
        }}
        animate={
          prefersReducedMotion
            ? undefined
            : { opacity: [0.6, 1, 0.6], scale: [1, 1.04, 1] }
        }
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Layer 5 — top hairline */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/30 to-transparent" />
    </div>
  );
}
