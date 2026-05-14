"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTenant } from "@/context/tenant-context";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const { login } = useTenant();
  const router = useRouter();
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();
  const [apiKey, setApiKey] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setPending(true);
    try {
      await login(apiKey.trim());
      router.replace("/portal");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Sign-in failed");
    } finally {
      setPending(false);
    }
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
            <div className="mx-auto mb-4 flex items-center justify-center gap-2">
              <img src={brandLogoUrl} alt="Brand logo" className="h-12 w-12 rounded-xl object-contain sm:h-14 sm:w-14 brightness-0 invert" />
              <img src={brandNameUrl} alt="Brand name" className="h-6 w-auto max-w-[10rem] object-contain sm:h-7 sm:max-w-[11rem] brightness-0 invert" />
            </div>
            <h1 className="font-display text-display-sm font-bold text-balance text-white">Client workspace</h1>
            <p className="mt-3 text-sm font-medium leading-relaxed text-slate-500">
              Use the <span className="text-slate-300">tenant API key</span> your operator issued —
              it starts with <code className="text-indigo-300">sk_live_</code> (not “sk_liver”). It is
              saved in this browser until you sign out. Keep the{" "}
              <strong className="text-slate-400">backend API running</strong> on port 4000 (
              <code className="text-slate-600">npm run dev</code> in the main project folder).
            </p>
          </div>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
                API key
              </label>
              <textarea
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                rows={3}
                placeholder="sk_live_…"
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
                  <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
                </>
              ) : (
                "Continue"
              )}
            </Button>
          </form>
          <p className="mt-6 text-center text-xs text-slate-600">
            <Link href="/" className="text-indigo-400 hover:text-indigo-300">
              ← Back to home
            </Link>
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
