"use client";

/**
 * Mobile-first horizontally swipeable card row.
 *
 * On <md screens the children scroll horizontally with snap-x semantics
 * and pagination dots at the bottom. On md+ screens the same children lay
 * out in a CSS grid with `gridCols` columns. Same markup, two layouts.
 *
 * The dots track the most-visible child via `IntersectionObserver` against
 * the scrolling track so they stay in sync as the user drags.
 */

import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

export function SwipeRow({
  children,
  gridCols = "md:grid-cols-2 lg:grid-cols-4",
  cardWidth = "min-w-[78%] sm:min-w-[55%]",
  className = "",
}: {
  children: React.ReactNode[];
  /** Tailwind grid-cols utilities applied at md+ breakpoints. */
  gridCols?: string;
  /** Width of each swiped card on mobile. */
  cardWidth?: string;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    if (typeof IntersectionObserver === "undefined") return;
    const items = Array.from(track.querySelectorAll<HTMLElement>("[data-swipe-item]"));
    if (items.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        // Pick the most visible child as the active dot.
        let bestIdx = active;
        let bestRatio = 0;
        for (const e of entries) {
          if (e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio;
            const i = items.indexOf(e.target as HTMLElement);
            if (i >= 0) bestIdx = i;
          }
        }
        setActive(bestIdx);
      },
      { root: track, threshold: [0.4, 0.6, 0.8] },
    );
    items.forEach((it) => io.observe(it));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children.length]);

  function scrollTo(i: number) {
    const track = trackRef.current;
    if (!track) return;
    const items = track.querySelectorAll<HTMLElement>("[data-swipe-item]");
    items[i]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  }

  return (
    <div className={className}>
      {/* Mobile: scroll-snap track */}
      <div
        ref={trackRef}
        className={cn(
          "-mx-6 flex gap-3 overflow-x-auto scroll-pl-6 px-6 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:hidden",
          "snap-x snap-mandatory",
        )}
      >
        {children.map((child, i) => (
          <div
            key={i}
            data-swipe-item
            className={cn("snap-start", cardWidth)}
          >
            {child}
          </div>
        ))}
      </div>

      {/* Mobile: dots */}
      {children.length > 1 && (
        <div className="mt-2 flex items-center justify-center gap-1.5 md:hidden">
          {children.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Show card ${i + 1}`}
              onClick={() => scrollTo(i)}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === active ? "w-6 bg-violet-400" : "w-2 bg-white/15 hover:bg-white/25",
              )}
            />
          ))}
        </div>
      )}

      {/* Desktop: grid */}
      <div className={cn("hidden gap-4 md:grid", gridCols)}>{children}</div>
    </div>
  );
}
