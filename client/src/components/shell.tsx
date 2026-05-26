"use client";

import { cn } from "@/lib/utils";
import { useTenant } from "@/context/tenant-context";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import {
  Cable,
  CalendarDays,
  Files,
  HelpCircle,
  LayoutDashboard,
  MessageCircleMore,
  Package,
  Settings2,
  ShoppingBag,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, type MouseEvent } from "react";
import { Topbar } from "@/components/topbar";
import { GraceBanner } from "@/components/grace-banner";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };
type NavGroup = { title: string; items: NavItem[] };

const groups: NavGroup[] = [
  {
    title: "Workspace",
    items: [
      { href: "/portal", label: "Overview", icon: LayoutDashboard },
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
      { href: "/portal/settings", label: "Settings", icon: Settings2 },
      { href: "/portal/help", label: "Help", icon: HelpCircle },
    ],
  },
];

export function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { tenant } = useTenant();
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();
  // Track which href the user just clicked so we can flash the destination
  // link as "active" instantly — even before Next.js finishes its route
  // transition. Cleared as soon as `pathname` catches up.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Once the URL has caught up to the click target, drop the optimistic flag.
  if (pendingHref && pathname === pendingHref) {
    // Schedule the reset for after this render; calling setState during render
    // is allowed but only when guarded by an equality check like this.
    queueMicrotask(() => setPendingHref(null));
  }

  function navigate(e: MouseEvent<HTMLAnchorElement>, href: string) {
    // Honor cmd/ctrl/middle-click — let the browser handle it.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    setPendingHref(href);
    startTransition(() => {
      router.push(href);
    });
  }

  return (
    <div className="flex min-h-screen">
      <aside className="fixed left-0 top-0 z-40 flex h-screen w-64 flex-col border-r border-white/[0.06] bg-surface-950/95 px-4 py-6 backdrop-blur-xl">
        <Link href="/portal" className="mb-7 flex items-center gap-3 px-2">
          <img
            src={brandLogoUrl}
            alt="Brand logo"
            className="h-11 w-11 rounded-lg object-contain sm:h-12 sm:w-12 brightness-0 invert"
          />
          <div className="min-w-0">
            <img
              src={brandNameUrl}
              alt="Brand name"
              className="h-6 w-auto max-w-[11rem] object-contain sm:h-7 sm:max-w-[13rem] brightness-0 invert"
            />
            <div className="truncate text-[11px] font-medium text-slate-500">
              {tenant?.name || "Workspace"}
            </div>
          </div>
        </Link>

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
                  // Show optimistic "active" treatment while the click is in
                  // flight so the user gets instant feedback even on slow pages.
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
      </aside>

      <main className="ml-64 min-w-0 flex-1 px-8 pb-12 lg:px-10">
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
    </div>
  );
}
