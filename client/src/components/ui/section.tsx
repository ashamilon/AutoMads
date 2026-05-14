import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.04] to-white/[0.01] shadow-card",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] bg-white/[0.015] px-6 py-4">
          <div>
            {title && (
              <h2 className="font-display text-[0.95rem] font-semibold tracking-snug text-white">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-0.5 text-xs font-medium text-slate-500">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1", className)}>
      {tabs.map((t) => {
        const a = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition",
              a
                ? "bg-white/10 text-white shadow-inner"
                : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
            )}
          >
            {t.label}
            {t.count != null && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  a ? "bg-indigo-500/30 text-indigo-100" : "bg-white/[0.06] text-slate-400",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
