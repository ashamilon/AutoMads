import { cn } from "@/lib/utils";

const tones: Record<string, string> = {
  default: "bg-white/10 text-slate-200 border-white/15",
  success: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25",
  warning: "bg-amber-500/15 text-amber-200 border-amber-500/25",
  danger: "bg-rose-500/15 text-rose-300 border-rose-500/25",
  info: "bg-indigo-500/15 text-indigo-200 border-indigo-500/25",
};

export function Badge({
  tone = "default",
  className,
  children,
}: {
  tone?: keyof typeof tones;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-lg border px-2.5 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-[0.14em]",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
