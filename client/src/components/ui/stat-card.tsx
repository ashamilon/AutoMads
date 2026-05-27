import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type Tone = "indigo" | "emerald" | "amber" | "rose" | "violet" | "sky";

const toneMap: Record<Tone, { glow: string; icon: string; ring: string }> = {
  indigo: { glow: "from-indigo-500/25", icon: "text-indigo-300", ring: "ring-indigo-400/20" },
  emerald: { glow: "from-emerald-500/25", icon: "text-emerald-300", ring: "ring-emerald-400/20" },
  amber: { glow: "from-amber-500/25", icon: "text-amber-300", ring: "ring-amber-400/20" },
  rose: { glow: "from-rose-500/25", icon: "text-rose-300", ring: "ring-rose-400/20" },
  violet: { glow: "from-violet-500/25", icon: "text-violet-300", ring: "ring-violet-400/20" },
  sky: { glow: "from-sky-500/25", icon: "text-sky-300", ring: "ring-sky-400/20" },
};

/**
 * KPI card with a tinted glow corner.
 *
 * Padding and value font-size shrink on mobile so long numeric values like
 * "৳1,48,920" fit a 360px column. Long currency values get `break-words` so
 * if they ever do overflow the card grows vertically rather than horizontally.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "indigo",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  className?: string;
}) {
  const t = toneMap[tone];
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-gradient-to-br p-4 shadow-card transition hover:border-white/[0.13] sm:p-5",
        t.glow,
        "to-transparent",
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            "absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-xl bg-white/[0.04] ring-1 sm:right-4 sm:top-4 sm:h-10 sm:w-10",
            t.icon,
            t.ring,
          )}
        >
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
      )}
      <p className="label-caps pr-12">{label}</p>
      <p className="mt-2 break-words font-display text-[1.6rem] font-bold leading-none tabular-figures tracking-display text-white sm:text-[2rem]">
        {value}
      </p>
      {hint && <p className="mt-2 text-[11px] font-medium text-slate-500 sm:text-xs">{hint}</p>}
    </div>
  );
}
