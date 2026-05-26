import { cn } from "@/lib/utils";

/**
 * Animated placeholder block used inside `loading.tsx` files. Next.js renders
 * the closest `loading.tsx` instantly when a route transition starts, so the
 * customer SEES something immediately even if the destination page's data
 * fetch takes 800ms. The visual is intentionally minimal — fast load + no
 * layout shift when the real content arrives.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-lg bg-gradient-to-r from-white/[0.04] via-white/[0.07] to-white/[0.04]",
        className,
      )}
    />
  );
}

/** Page-level skeleton for portal subroutes — header + cards. */
export function PageSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-8 pt-2">
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]">
        <div className="border-b border-white/[0.06] px-6 py-4">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="divide-y divide-white/[0.04]">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-6 py-4">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
