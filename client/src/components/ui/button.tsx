import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary:
    "bg-gradient-to-r from-accent to-indigo-500 text-white shadow-glow hover:brightness-110 border border-white/10",
  secondary:
    "border border-white/15 bg-white/5 text-slate-100 hover:bg-white/10",
  ghost: "text-slate-300 hover:bg-white/5 hover:text-white",
  danger: "bg-rose-600/90 text-white hover:bg-rose-600 border border-rose-500/40",
};

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 font-sans text-sm font-semibold tracking-snug transition-all duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-[0.97] active:brightness-95 disabled:pointer-events-none disabled:opacity-40",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
