"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { WhatsAppCard } from "@/components/ui/whatsapp-cta";
import { useTenant } from "@/context/tenant-context";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Tab = "password" | "apiKey";

export default function LoginPage() {
  const { login } = useTenant();
  const router = useRouter();
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();
  const [tab, setTab] = useState<Tab>("password");

  // Password tab state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Api-key tab state
  const [apiKey, setApiKey] = useState("");

  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setPending(true);
    try {
      if (tab === "password") {
        if (!email.trim() || !password) {
          setErr("Email and password are required.");
          setPending(false);
          return;
        }
        await login({ mode: "password", email: email.trim(), password });
      } else {
        if (!apiKey.trim()) {
          setErr("API key is required.");
          setPending(false);
          return;
        }
        await login({ mode: "apiKey", apiKey: apiKey.trim() });
      }
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
              <img src={brandLogoUrl} alt="Brand logo" className="h-[3.75rem] w-[3.75rem] rounded-xl object-contain sm:h-[4.375rem] sm:w-[4.375rem] brightness-0 invert" />
              <img src={brandNameUrl} alt="Brand name" className="h-[1.875rem] w-auto max-w-[12.5rem] object-contain sm:h-[2.1875rem] sm:max-w-[13.75rem] brightness-0 invert" />
            </div>
            <h1 className="font-display text-display-sm font-bold text-balance text-white">Sign in</h1>
            <p className="mt-3 text-sm font-medium leading-relaxed text-slate-500">
              Use the email + password you set during activation. Forgot your
              password? Ask the platform admin to issue a new activation link.
            </p>
          </div>

          {/* Tabs */}
          <div className="mb-5 flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
            <button
              type="button"
              onClick={() => setTab("password")}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                tab === "password" ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Email & password
            </button>
            <button
              type="button"
              onClick={() => setTab("apiKey")}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                tab === "apiKey" ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              API key (developer)
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            {tab === "password" ? (
              <>
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
                    Email
                  </label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                    autoComplete="email"
                    placeholder="you@yourshop.com"
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
                    required
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
                    Password
                  </label>
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
                    required
                  />
                </div>
              </>
            ) : (
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
                <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                  Only use this if you also use the API key for webhooks. For dashboard access, prefer Email & password.
                </p>
              </div>
            )}

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

        {/* WhatsApp escape hatch — for first-time visitors who don't have credentials yet. */}
        <div className="mt-5">
          <WhatsAppCard
            title="Don't have an activation link yet?"
            description="Message us on WhatsApp and we'll send you a setup link. Once you receive it, come back here to sign in."
            prefill="Hi! I'd like to sign up for the AI Commerce OS platform. Can you send me a setup / activation link?"
          />
        </div>
      </motion.div>
    </div>
  );
}
