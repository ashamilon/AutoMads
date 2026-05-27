"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { WhatsAppCard } from "@/components/ui/whatsapp-cta";
import { ApiError, apiFetch, setStoredSessionToken } from "@/lib/api";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import { motion } from "framer-motion";
import { CheckCircle2, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

/**
 * Tenant activation page.
 *
 * Flow:
 *   - Platform admin generated a one-time activation link via /admin and
 *     forwarded it to the tenant.
 *   - Tenant opens the link → this page reads `token` from the URL.
 *   - Tenant picks an email + password (with confirm) and submits.
 *   - Server burns the token, stores the email + bcrypt-hashed password,
 *     and issues a fresh session.
 *   - Page redirects to /portal logged in.
 *
 * Token expiry is 7 days. If expired or already-used, the server returns
 * 400 and we tell the tenant to ask the admin to re-issue.
 */
function ActivateInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!token) {
      setErr("Activation token is missing from the URL. Use the full link the platform admin sent you.");
      return;
    }
    if (!email.trim()) {
      setErr("Email is required.");
      return;
    }
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      setErr("Password must include at least one letter and one digit.");
      return;
    }
    if (password !== confirm) {
      setErr("Passwords don't match.");
      return;
    }

    setPending(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        tenant: { id: string; name: string; slug: string };
        sessionToken: string;
      }>("/api/v1/auth/activate", {
        method: "POST",
        body: JSON.stringify({ token, email: email.trim(), password }),
        requireAuth: false,
      });
      setStoredSessionToken(res.sessionToken, res.tenant.slug);
      router.replace("/portal");
    } catch (ex) {
      let msg = ex instanceof Error ? ex.message : "Activation failed.";
      if (ex instanceof ApiError) {
        try {
          const body = JSON.parse(ex.body) as { error?: string; message?: string };
          if (body?.error === "invalid_token") msg = "This activation link is invalid or already used.";
          else if (body?.error === "token_expired") msg = "This activation link has expired. Ask the platform admin to issue a new one.";
          else if (body?.error === "weak_password") msg = body.message ?? msg;
          else if (body?.error === "email_already_used") msg = "Another tenant already uses this email.";
          else if (body?.message) msg = body.message;
        } catch {
          /* ignore */
        }
      }
      setErr(msg);
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
            <h1 className="font-display text-display-sm font-bold text-balance text-white">Activate your workspace</h1>
            <p className="mt-3 text-sm font-medium leading-relaxed text-slate-500">
              Set the email and password you'll use to sign in. The platform
              admin <span className="text-slate-300">cannot see your password</span>.
              You can change both later from <span className="text-slate-300">Settings</span>.
            </p>
          </div>

          {!token && (
            <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              Activation token missing from the URL. Use the exact link the admin sent you.
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
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
                autoComplete="new-password"
                placeholder="At least 8 characters, 1 letter, 1 digit"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
                Confirm password
              </label>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                type="password"
                autoComplete="new-password"
                placeholder="Re-enter password"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
                required
              />
            </div>
            {err && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {err}
              </p>
            )}
            <Button type="submit" disabled={pending || !token} className="w-full py-3 text-base">
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Activating…
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" /> Activate &amp; sign in
                </>
              )}
            </Button>
          </form>
          <p className="mt-6 text-center text-xs text-slate-600">
            Already activated?{" "}
            <Link href="/login" className="text-indigo-400 hover:text-indigo-300">
              Sign in
            </Link>
          </p>
        </Card>

        {/* Recovery path: WhatsApp the operator if the link is bad / expired. */}
        <div className="mt-5">
          <WhatsAppCard
            title="Activation link expired or missing?"
            description="WhatsApp us and we'll re-send a fresh activation link within minutes."
            prefill="Hi! My activation link isn't working — could you send me a new one please?"
          />
        </div>
      </motion.div>
    </div>
  );
}

export default function ActivatePage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-slate-400">Loading…</div>}>
      <ActivateInner />
    </Suspense>
  );
}
