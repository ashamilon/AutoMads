"use client";

/**
 * Top-of-screen navigation progress bar.
 *
 * Why this exists: the portal feels unresponsive because clicking a sidebar
 * link doesn't visually do ANYTHING until the destination page's `useEffect`
 * finishes its first fetch. We can't change every page's data flow at once,
 * but we CAN show the user that the click registered.
 *
 * How it works:
 *   - Watches `usePathname()` for changes.
 *   - When the pathname changes, animates a thin bar from 0 → 80% over 400ms.
 *     If the page is still mounting (browser hasn't finished idle), the bar
 *     stays at 80%.
 *   - When the new pathname has been stable for 250ms, the bar shoots to
 *     100% and fades out.
 *
 * Pure presentational. Does not block navigation. Pinned to the top of the
 * viewport so it's visible even while the page transitions.
 */

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export function NavProgress() {
  const pathname = usePathname();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const lastPath = useRef(pathname);
  const timer1 = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timer2 = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;

    // New nav started — light up the bar.
    setVisible(true);
    setProgress(15);
    timer1.current && clearTimeout(timer1.current);
    timer2.current && clearTimeout(timer2.current);

    // Quick climb to 80%.
    timer1.current = setTimeout(() => setProgress(80), 80);

    // Settle at 100% then hide. The pathname changing IS the "page changed"
    // signal — by the time React commits this effect, the new layout/page is
    // mounting, so we just need to give it a beat to render.
    timer2.current = setTimeout(() => {
      setProgress(100);
      setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 200);
    }, 350);

    return () => {
      timer1.current && clearTimeout(timer1.current);
      timer2.current && clearTimeout(timer2.current);
    };
  }, [pathname]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-0 right-0 top-0 z-[60] h-0.5"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms" }}
    >
      <div
        className="h-full bg-gradient-to-r from-accent via-indigo-400 to-violet-500 shadow-[0_0_8px_rgba(99,102,241,0.6)]"
        style={{
          width: `${progress}%`,
          transition: "width 250ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      />
    </div>
  );
}
