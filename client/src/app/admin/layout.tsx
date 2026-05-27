"use client";

/**
 * `/admin` layout — Admin Super Control Panel shell (R20.1, R23.6).
 *
 *  - Bypasses gating for `/admin/login` so you can actually sign in.
 *  - For every other admin route, redirects to `/admin/login` if no admin
 *    key is in localStorage. Server-side calls fail-fast on a missing
 *    key anyway; this just gives a nicer UX.
 *  - Renders a sidebar with the panels required by R20: Tenants /
 *    Subscriptions / Payments / Suspended / Category Schemas. The
 *    legacy admin UI at `localhost:4000/admin` is preserved as the
 *    operator's primary tool (R17.4, R23.6); this Next.js panel is the
 *    Commerce_OS-aware companion.
 */

import { clearStoredAdminKey, getStoredAdminKey } from "@/lib/admin-api";
import {
  CreditCard,
  Database,
  LayoutDashboard,
  LogOut,
  PauseOctagon,
  Shield,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Match exact `pathname === href` only (default), or treat as a section prefix. */
  match?: "exact" | "prefix";
};

const NAV_ITEMS: NavItem[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, match: "exact" },
  { href: "/admin/tenants", label: "Tenants", icon: Users, match: "prefix" },
  { href: "/admin/payments", label: "Payments", icon: CreditCard, match: "prefix" },
  { href: "/admin/suspended", label: "Suspended", icon: PauseOctagon, match: "prefix" },
  { href: "/admin/schemas", label: "Category schemas", icon: Database, match: "prefix" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (pathname === "/admin/login") {
      setReady(true);
      return;
    }
    if (!getStoredAdminKey()) {
      router.replace("/admin/login");
      return;
    }
    setReady(true);
  }, [pathname, router]);

  if (!ready) return null;

  if (pathname === "/admin/login") return <>{children}</>;

  function logout() {
    clearStoredAdminKey();
    router.replace("/admin/login");
  }

  function isActive(item: NavItem): boolean {
    if (!pathname) return false;
    if (item.match === "prefix") {
      return pathname === item.href || pathname.startsWith(item.href + "/");
    }
    return pathname === item.href;
  }

  return (
    <div className="min-h-screen bg-surface-950">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-mesh-dark bg-cover" />
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-surface-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <Link href="/admin" className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg border border-amber-500/40 bg-amber-500/10">
              <Shield className="h-4 w-4 text-amber-300" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Platform admin</p>
              <p className="text-[10px] text-slate-500">Commerce_OS control panel</p>
            </div>
          </Link>
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/[0.06]"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 lg:flex-row">
        <aside className="lg:w-56 lg:shrink-0">
          <nav className="sticky top-20 flex flex-row gap-1 overflow-x-auto rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 lg:flex-col lg:overflow-visible">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    "inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition " +
                    (active
                      ? "bg-white/[0.08] text-white"
                      : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200")
                  }
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
