"use client";

import { useTenant } from "@/context/tenant-context";
import { getBrandLogoUrl } from "@/lib/branding";
import { Bell, ChevronDown, LogOut, Search, Sparkles, User } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";

const labelMap: Record<string, string> = {
  portal: "Overview",
  orders: "Orders",
  catalog: "Catalog",
  sandbox: "Chat sandbox",
  integration: "Integration",
  settings: "Settings",
  help: "Help",
};

function useCrumbs() {
  const path = usePathname() || "/";
  const segs = path.split("/").filter(Boolean);
  return segs.map((s, i) => {
    const href = "/" + segs.slice(0, i + 1).join("/");
    const label = labelMap[s] || (s.length > 14 ? s.slice(0, 12) + "…" : s);
    return { href, label };
  });
}

export function Topbar() {
  const crumbs = useCrumbs();
  const { tenant, logout } = useTenant();
  const brandLogoUrl = getBrandLogoUrl();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClick(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="sticky top-0 z-30 -mx-8 mb-8 flex items-center justify-between gap-4 border-b border-white/[0.06] bg-surface-950/80 px-8 py-3 backdrop-blur-xl lg:-mx-10 lg:px-10">
      <nav className="flex min-w-0 items-center gap-2 text-sm">
        <img src={brandLogoUrl} alt="Brand logo" className="mr-1 hidden h-8 w-8 rounded object-contain sm:block brightness-0 invert" />
        {crumbs.map((c, i) => (
          <Fragment key={c.href}>
            {i > 0 && <span className="text-slate-700">/</span>}
            {i === crumbs.length - 1 ? (
              <span className="truncate font-medium text-white">{c.label}</span>
            ) : (
              <Link
                href={c.href}
                className="truncate font-medium text-slate-500 transition hover:text-slate-300"
              >
                {c.label}
              </Link>
            )}
          </Fragment>
        ))}
      </nav>

      <div className="flex items-center gap-2">
        <div className="relative hidden md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            placeholder="Search orders, SKUs…"
            className="w-72 rounded-xl border border-white/[0.08] bg-white/[0.03] py-2 pl-9 pr-12 text-sm text-slate-200 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-md border border-white/10 bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 md:inline-block">
            ⌘K
          </kbd>
        </div>

        <button
          type="button"
          aria-label="Notifications"
          className="relative grid h-9 w-9 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
        >
          <Bell className="h-4 w-4" />
          <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-rose-400" />
        </button>

        <div ref={ref} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] py-1.5 pl-1.5 pr-3 text-sm text-slate-200 transition hover:bg-white/[0.06]"
          >
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-violet-600 text-[11px] font-bold text-white">
              {(tenant?.name || "?").slice(0, 2).toUpperCase()}
            </span>
            <span className="max-w-[8rem] truncate font-medium">{tenant?.name || "Workspace"}</span>
            <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
          </button>
          {open && (
            <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-white/10 bg-surface-950/95 shadow-card backdrop-blur-xl">
              <div className="border-b border-white/[0.06] px-4 py-3">
                <p className="truncate text-sm font-semibold text-white">{tenant?.name}</p>
                <p className="font-mono text-[11px] text-slate-500">{tenant?.slug}</p>
              </div>
              <Link
                href="/portal/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                <User className="h-4 w-4 text-slate-500" /> Workspace settings
              </Link>
              <Link
                href="/portal/integration"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                <Sparkles className="h-4 w-4 text-slate-500" /> Integration
              </Link>
              <button
                type="button"
                onClick={() => {
                  logout();
                  window.location.href = "/login";
                }}
                className="flex w-full items-center gap-3 border-t border-white/[0.06] px-4 py-2.5 text-sm text-rose-300 transition hover:bg-rose-500/10"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
