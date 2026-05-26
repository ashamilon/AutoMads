"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { adminPing, setStoredAdminKey } from "@/lib/admin-api";
import { motion } from "framer-motion";
import { Loader2, Shield } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function AdminLoginPage() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!key.trim()) {
      setErr("Admin API key is required.");
      return;
    }
    setPending(true);
    setStoredAdminKey(key.trim());
    const ok = await adminPing();
    if (!ok) {
      setErr("Admin key rejected by the API.");
      setPending(false);
      return;
    }
    router.replace("/admin");
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <div className="pointer-events-none absolute inset-0 bg-mesh-dark" />
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-10 w-full max-w-md"
      >
        <Card className="border-white/10 p-8">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-amber-500/40 bg-amber-500/10">
              <Shield className="h-6 w-6 text-amber-300" />
            </div>
            <h1 className="font-display text-display-sm font-bold text-balance text-white">Platform admin</h1>
            <p className="mt-3 text-sm font-medium leading-relaxed text-slate-500">
              Use the <code className="text-amber-300">ADMIN_API_KEY</code> from your server <code>.env</code>.
              Stays in this browser until you sign out.
            </p>
          </div>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
                Admin API key
              </label>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                type="password"
                placeholder="••••••••"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
                autoComplete="off"
                required
              />
            </div>
            {err && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {err}
              </p>
            )}
            <Button type="submit" disabled={pending} className="w-full py-3 text-base">
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
                </>
              ) : (
                "Continue"
              )}
            </Button>
          </form>
          <p className="mt-6 text-center text-xs text-slate-600">
            <Link href="/login" className="text-indigo-400 hover:text-indigo-300">
              ← Tenant sign in
            </Link>
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
