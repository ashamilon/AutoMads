"use client";

import { Button } from "@/components/ui/button";
import { useTenant } from "@/context/tenant-context";
import { getStoredApiKey } from "@/lib/api";
import { Loader2, WifiOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { tenant, loading, authError, refresh } = useTenant();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !tenant && !getStoredApiKey()) {
      router.replace("/login");
    }
  }, [loading, tenant, router]);

  if (loading && !tenant && !authError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-mesh-dark">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-white/5 px-10 py-12">
          <Loader2 className="h-10 w-10 animate-spin text-accent-bright" />
          <p className="text-sm text-slate-400">Loading workspace…</p>
        </div>
      </div>
    );
  }

  /** Key saved but /me failed (e.g. API off) — don’t send them back to login */
  if (!tenant && getStoredApiKey() && authError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-mesh-dark px-4">
        <div className="max-w-md rounded-2xl border border-amber-500/20 bg-amber-500/5 p-8 text-center">
          <WifiOff className="mx-auto mb-4 h-10 w-10 text-amber-400" />
          <h2 className="font-display text-lg font-semibold text-white">Can’t reach the API</h2>
          <p className="mt-2 text-sm text-slate-400">{authError}</p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button onClick={() => void refresh()}>Retry</Button>
            <Link href="/login">
              <Button variant="secondary" className="w-full sm:w-auto">
                Re-enter API key
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!tenant) {
    if (getStoredApiKey()) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-accent-bright" />
        </div>
      );
    }
    return null;
  }

  return <>{children}</>;
}
