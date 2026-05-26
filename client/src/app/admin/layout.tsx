"use client";

import { clearStoredAdminKey, getStoredAdminKey } from "@/lib/admin-api";
import { LogOut, Shield } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * `/admin` layout.
 *
 *  - Bypasses gating for `/admin/login` so you can actually sign in.
 *  - For every other admin route, redirects to `/admin/login` if no admin
 *    key is in localStorage. Server-side calls fail-fast on a missing
 *    key anyway; this just gives a nicer UX.
 */
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

  return (
    <div className="min-h-screen bg-surface-950">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-mesh-dark bg-cover" />
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-surface-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/admin" className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg border border-amber-500/40 bg-amber-500/10">
              <Shield className="h-4 w-4 text-amber-300" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Platform admin</p>
              <p className="text-[10px] text-slate-500">Tenant management</p>
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
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
