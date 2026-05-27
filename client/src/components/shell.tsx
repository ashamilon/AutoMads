"use client";

/**
 * Portal shell: persistent sidebar on lg+, off-canvas drawer on <lg.
 *
 * Earlier the sidebar was fixed `w-64` and the main content had `ml-64`
 * unconditionally — on a 360px phone the sidebar covered 70% of the
 * viewport and the actual page got squeezed off-screen. This rewrite:
 *
 *   - Renders the sidebar as a fixed off-canvas drawer on `<lg`, slid in
 *     by 100% so it's not visible until the user opens it.
 *   - Adds a hamburger button (lives in `<Topbar>`) that flips the
 *     `mobileNavOpen` state via context.
 *   - Sets `ml-64` only at `lg+`. Below that, main content takes the
 *     full viewport and just uses sensible mobile padding.
 *   - Locks body scroll while the drawer is open and closes the drawer
 *     on route change so it doesn't linger.
 *
 * The desktop look is unchanged; only the mobile/tablet behaviour is new.
 */

import { cn } from "@/lib/utils";
import { useTenant } from "@/context/tenant-context";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import {
  Cable,
  CalendarDays,
  CreditCard,
  Files,
  HelpCircle,
  LayoutDashboard,
  LineChart,
  MessageCircleMore,
  Package,
  Settings2,
  ShoppingBag,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useTransition,
  type MouseEvent,
} from "react";
import { Topbar } from "@/components/topbar";
import { GraceBanner } from "@/components/grace-banner";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };
type NavGroup = { title: string; items: NavItem[] };

const groups: NavGroup[] = [
  {
    title: "Workspace",
    items: [
      { href: "/portal", label: "Overview", icon: LayoutDashboard },
      { href: "/portal/analytics", label: "Analytics", icon: LineChart },
      { href: "/portal/orders", label: "Orders", icon: ShoppingBag },
      { href: "/portal/catalog", label: "Catalog map", icon: Package },
      { href: "/portal/sandbox", label: "Chat sandbox", icon: MessageCircleMore },
      { href: "/portal/content-calendar", label: "Content Calendar", icon: CalendarDays },
      { href: "/portal/training-data", label: "Training JSON", icon: Files },
    ],
  },
  {
    title: "Configure",
    items: [
      { href: "/portal/integration", label: "Integration", icon: Cable },
      { href: "/portal/billing", label: "Billing", icon: CreditCard },
      { href: "/portal/settings", label: "Settings", icon: Settings2 },
      { href: "/portal/help", label: "Help", icon: HelpCircle },
    ],
  },
];

/** Context exposes the mobile-drawer toggle to descendants (e.g. Topbar's hamburger). */
type MobileNavCtx = { open: boolean; setOpen: (v: boolean) => void };
const MobileNavContext = createContext<MobileNavCtx>({ open: false, setOpen: () => undefined });

export function useMobileNav() {
  return useContext(MobileNavContext);
}

export function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { tenant } = useTenant();
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();
  // Optimistic-active flag (clicked link reads as active before route resolves)
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Mobile drawer state — closed by default, opened via the hamburger
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  if (pendingHref && pathname === pendingHref) {
    queueMicrotask(() => setPendingHref(null));
  }

  // Close the drawer whenever the route changes — otherwise it stays open
  // when the user taps a link.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Lock body scroll while the drawer is open so the page underneath
  // doesn't bounce when the user drags inside the drawer.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (mobileNavOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
    return;
  }, [mobileNavOpen]);

  function navigate(e: MouseEvent<HTMLAnchorElement>, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    setPendingHref(href);
    setMobileNavOpen(false);
    startTransition(() => {
      router.push(href);
    });
  }

  const sidebar = (
    <>
      {/* Brand */}
      <Link href="/portal" className="mb-6 flex items-center gap-3 px-2">
        <img
          src={brandLogoUrl}
          alt="Brand logo"
          className="h-12 w-12 rounded-lg object-contain brightness-0 invert"
        />
        <div className="min-w-0">
          <img
            src={brandNameUrl}
            alt="Brand name"
            className="h-[2.3rem] w-auto max-w-[13.8rem] object-contain brightness-0 invert"
          />
          <div className="truncate text-[11px] font-medium text-slate-500">
            {tenant?.name || "Workspace"}
          </div>
        </div>
      </Link>

      {/* Live status pill */}
      <div className="mb-5 rounded-xl border border-white/[0.07] bg-gradient-to-br from-indigo-500/10 to-transparent p-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-200/80">
          <Zap className="h-3 w-3" /> Live
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          Webhooks active for{" "}
          <span className="font-mono text-indigo-300">{tenant?.slug}</span>
        </p>
      </div>

      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.title}>
            <p className="label-caps mb-2 px-3">{g.title}</p>
            <div className="flex flex-col gap-0.5">
              {g.items.map(({ href, label, icon: Icon }) => {
                const realActive =
                  pathname === href || (href !== "/portal" && pathname?.startsWith(href));
                const optimisticActive = pendingHref === href;
                const active = realActive || optimisticActive;
                return (
                  <Link
                    key={href}
                    href={href}
                    prefetch
                    onClick={(e) => navigate(e, href)}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-xl px-3 py-2 text-[0.9rem] font-medium tracking-snug transition-all duration-150 ease-out active:scale-[0.98] active:bg-white/[0.09]",
                      active
                        ? "bg-white/[0.07] text-white"
                        : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                    )}
                  >
                    {active && (
                      <span className="absolute -left-4 top-2 bottom-2 w-0.5 rounded-r bg-gradient-to-b from-accent-bright to-accent-dim" />
                    )}
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0 transition",
                        active
                          ? "text-accent-bright"
                          : "text-slate-500 group-hover:text-slate-300",
                      )}
                    />
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-violet-600 text-[11px] font-bold text-white">
            {(tenant?.name || "?").slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-white">
              {tenant?.name || "Workspace"}
            </p>
            <p className="truncate font-mono text-[10px] text-slate-500">
              {tenant?.slug}
            </p>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <MobileNavContext.Provider value={{ open: mobileNavOpen, setOpen: setMobileNavOpen }}>
      <div className="flex min-h-screen">
        {/* Desktop sidebar — always visible at lg+ */}
        <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col border-r border-white/[0.06] bg-surface-950/95 px-4 py-6 backdrop-blur-xl lg:flex">
          {sidebar}
        </aside>

        {/* Mobile drawer + scrim — only mounted while open so they don't capture taps */}
        {mobileNavOpen && (
          <>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileNavOpen(false)}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            />
            <aside
              role="dialog"
              aria-label="Navigation"
              className="fixed left-0 top-0 z-50 flex h-screen w-[18rem] max-w-[85vw] animate-[slideIn_.2s_ease-out] flex-col border-r border-white/[0.06] bg-surface-950 px-4 py-5 lg:hidden"
              style={{ animationName: "slideIn" }}
            >
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  aria-label="Close navigation"
                  onClick={() => setMobileNavOpen(false)}
                  className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-300 hover:bg-white/[0.06] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {sidebar}
            </aside>
          </>
        )}

        <main className="min-w-0 flex-1 px-4 pb-12 sm:px-6 lg:ml-64 lg:px-10">
          <div className="pointer-events-none fixed inset-0 -z-10 bg-mesh-dark bg-cover" />
          <div
            className="pointer-events-none fixed inset-0 -z-10 opacity-[0.25]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
              backgroundSize: "56px 56px",
            }}
          />
          <Topbar />
          <div className="mx-auto max-w-6xl">
            <GraceBanner />
            {children}
          </div>
        </main>

        {/* Drawer slide-in keyframes (Tailwind doesn't ship slideIn) */}
        <style jsx global>{`
          @keyframes slideIn {
            from { transform: translateX(-100%); }
            to { transform: translateX(0); }
          }
        `}</style>
      </div>
    </MobileNavContext.Provider>
  );
}
