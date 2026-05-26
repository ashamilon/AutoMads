"use client";

import { Button } from "@/components/ui/button";
import { OneTimeSecret } from "@/components/admin/one-time-secret";
import { adminFetch } from "@/lib/admin-api";
import { CheckCircle2, KeyRound, Loader2, Mail, RefreshCw, Settings2, ShieldAlert, UserPlus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type AdminTenant = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  facebookPageId: string | null;
  hasApiKey: boolean;
  email: string | null;
  hasPassword: boolean;
  hasPendingActivation: boolean;
  activationExpiresAt: string | null;
  createdAt: string;
  integration: { type: "API" | "DATABASE" | "WEBHOOK" } | null;
};

type Secret =
  | { kind: "apiKey"; value: string; tenantName: string }
  | { kind: "activation"; value: string; tenantName: string; expiresAt: string };

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch<{ tenants: AdminTenant[] }>("/admin/tenants");
      setTenants(data.tenants);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function regenerateApiKey(t: AdminTenant) {
    if (!confirm(`Regenerate API key for ${t.name}? The old key stops working immediately. Webhook integrations using the old key will fail until re-keyed.`)) return;
    setBusyId(t.id);
    try {
      const res = await adminFetch<{ apiKey: string }>(`/admin/tenants/${t.id}/regenerate-api-key`, { method: "POST" });
      setSecret({ kind: "apiKey", value: res.apiKey, tenantName: t.name });
    } catch (e) {
      alert("Failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  }

  async function sendActivationLink(t: AdminTenant) {
    const verb = t.hasPassword ? "reset password" : "issue activation link";
    const warn = t.hasPassword
      ? `Reset password for ${t.name}?\n\nThis WIPES their current password AND every active session. The new activation link replaces both. Use when the client lost access.`
      : `Issue an activation link for ${t.name}? Any previous link will be invalidated. The client opens this to set their email + password.`;
    if (!confirm(warn)) return;
    setBusyId(t.id);
    try {
      const endpoint = t.hasPassword
        ? `/admin/tenants/${t.id}/reset-password`
        : `/admin/tenants/${t.id}/issue-activation`;
      const res = await adminFetch<{ activationUrl: string; activationExpiresAt: string }>(endpoint, { method: "POST" });
      setSecret({
        kind: "activation",
        value: res.activationUrl,
        tenantName: t.name,
        expiresAt: res.activationExpiresAt,
      });
      void load();
    } catch (e) {
      alert(`${verb} failed: ` + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Tenants</h1>
          <p className="mt-1 text-sm text-slate-500">Issue activation links, regenerate API keys, reset passwords.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
          </Button>
        </div>
      </div>

      {secret && (
        <OneTimeSecret
          label={
            secret.kind === "apiKey"
              ? `New API key for ${secret.tenantName}`
              : `Activation link for ${secret.tenantName}`
          }
          value={secret.value}
          description={
            secret.kind === "apiKey"
              ? "Send this to the client (or your integration). Old key has been invalidated."
              : `Forward this link to the client. Expires ${new Date(secret.expiresAt).toLocaleString()}.`
          }
          onDismiss={() => setSecret(null)}
        />
      )}

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {loading && tenants.length === 0 ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
        </div>
      ) : tenants.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-12 text-center">
          <p className="text-sm text-slate-500">No tenants yet. Create one via <code>POST /admin/tenants</code>.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tenants.map((t) => {
            const busy = busyId === t.id;
            return (
              <div
                key={t.id}
                className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5 transition hover:border-white/[0.12]"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/admin/tenants/${t.id}`} className="font-semibold text-white hover:text-indigo-300">
                        {t.name}
                      </Link>
                      {!t.isActive && (
                        <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-300">
                          Disabled
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-slate-500">{t.slug}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <KeyRound className="h-3 w-3 text-slate-500" />
                        {t.hasApiKey ? "API key set" : "No API key"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-3 w-3 text-slate-500" />
                        {t.email ? t.email : "No email yet"}
                      </span>
                      {t.hasPassword ? (
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" />
                          Activated
                        </span>
                      ) : t.hasPendingActivation ? (
                        <span className="inline-flex items-center gap-1 text-amber-300">
                          <ShieldAlert className="h-3 w-3" />
                          Activation pending
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-300">
                          <ShieldAlert className="h-3 w-3" />
                          Not activated
                        </span>
                      )}
                      {t.facebookPageId && <span className="text-slate-500">FB: {t.facebookPageId}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => void regenerateApiKey(t)} disabled={busy}>
                      <KeyRound className="h-3.5 w-3.5" /> Regenerate API key
                    </Button>
                    <Button variant="secondary" onClick={() => void sendActivationLink(t)} disabled={busy}>
                      {t.hasPassword ? (
                        <>
                          <ShieldAlert className="h-3.5 w-3.5" /> Reset password
                        </>
                      ) : (
                        <>
                          <UserPlus className="h-3.5 w-3.5" /> Issue activation link
                        </>
                      )}
                    </Button>
                    <Link href={`/admin/tenants/${t.id}`}>
                      <Button variant="ghost">
                        <Settings2 className="h-3.5 w-3.5" /> Details
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
