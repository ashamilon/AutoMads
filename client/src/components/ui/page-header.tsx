import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * Page header.
 *
 * - Mobile: stacked vertically, actions wrap to a new row (and `flex-wrap`
 *   so wide button groups don't overflow on a 360px screen).
 * - sm+: row layout with actions pinned to the right and the title block
 *   filling the remaining space.
 *
 * The actions cluster also exposes `[&>*]:shrink-0` so any individual button
 * (e.g. a long "Watch demo" CTA) keeps its natural width and is allowed to
 * wrap onto a new line rather than getting squeezed.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="label-caps mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-indigo-200/90">
            {eyebrow}
          </div>
        )}
        <h1 className="title-page max-w-3xl break-words">{title}</h1>
        {description && (
          <p className="mt-3 max-w-2xl text-[0.9rem] font-medium leading-relaxed text-slate-400 sm:text-[0.95rem]">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 [&>*]:shrink-0">{actions}</div>
      )}
    </div>
  );
}
