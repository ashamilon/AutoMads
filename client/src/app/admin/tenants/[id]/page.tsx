"use client";

import { Button } from "@/components/ui/button";
import { OneTimeSecret } from "@/components/admin/one-time-secret";
import { adminFetch } from "@/lib/admin-api";
import {
  CheckCircle2,
  ChevronLeft,
  KeyRound,
  Loader2,
  ShieldAlert,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type AdminTenantDetail = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  facebookPageAccessToken: string | null;
  facebookPageId: string | null;
  facebookVerifyToken: string | null;
  settings: unknown;
  hasApiKey: boolean;
  email: string | null;
  hasPassword: boolean;
  hasPendingActivation: boolean;
  activationExpiresAt: string | null;
  integration: { type: string; config: unknown } | null;
  createdAt: string;
};

type Secret =
  | { kind: "apiKey"; value: string }
  | { kind: "activation"; value: string; expiresAt: string };

export default function AdminTenantDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params?.id ?? "");
  const [tenant, setTenant] = useState<AdminTenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch<{ tenant: AdminTenantDetail }>(`/admin/tenants/${id}`);
      setTenant(data.tenant);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void load();
  }, [id, load]);

  async function regenerateApiKey() {
    if (!tenant) return;
    if (!confirm(`Regenerate API key for ${tenant.name}? The old key stops working immediately.`)) return;
    setBusy(true);
    try {
      const res = await adminFetch<{ apiKey: string }>(`/admin/tenants/${id}/regenerate-api-key`, { method: "POST" });
      setSecret({ kind: "apiKey", value: res.apiKey });
      void load();
    } catch (e) {
      alert("Failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function sendActivationLink() {
    if (!tenant) return;
    const verb = tenant.hasPassword ? "reset password" : "issue activation link";
    const warn = tenant.hasPassword
      ? `Reset password for ${tenant.name}?\n\nThis WIPES their password AND every active session. The new activation link replaces both.`
      : `Issue an activation link for ${tenant.name}? Any previous link will be invalidated.`;
    if (!confirm(warn)) return;
    setBusy(true);
    try {
      const endpoint = tenant.hasPassword
        ? `/admin/tenants/${id}/reset-password`
        : `/admin/tenants/${id}/issue-activation`;
      const res = await adminFetch<{ activationUrl: string; activationExpiresAt: string }>(endpoint, { method: "POST" });
      setSecret({ kind: "activation", value: res.activationUrl, expiresAt: res.activationExpiresAt });
      void load();
    } catch (e) {
      alert(`${verb} failed: ` + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!tenant) return;
    const next = !tenant.isActive;
    if (!confirm(`${next ? "Re-enable" : "Disable"} ${tenant.name}? ${next ? "" : "All login + webhook calls will be rejected until re-enabled."}`)) return;
    setBusy(true);
    try {
      await adminFetch(`/admin/tenants/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: next }),
      });
      void load();
    } catch (e) {
      alert("Failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !tenant) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
      </div>
    );
  }
  if (error || !tenant) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
        {error ?? "Tenant not found."}
        <button
          type="button"
          onClick={() => router.replace("/admin")}
          className="ml-3 underline"
        >
          Back to tenants
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-300"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> All tenants
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-white">{tenant.name}</h1>
          {!tenant.isActive && (
            <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-300">
              Disabled
            </span>
          )}
        </div>
        <p className="mt-1 font-mono text-xs text-slate-500">{tenant.slug}</p>
      </div>

      {secret && (
        <OneTimeSecret
          label={secret.kind === "apiKey" ? "New API key" : "Activation link"}
          value={secret.value}
          description={
            secret.kind === "apiKey"
              ? "Old key has been invalidated. Update webhook integrations using the old key."
              : `Forward this link to the client. Expires ${new Date(secret.expiresAt).toLocaleString()}.`
          }
          onDismiss={() => setSecret(null)}
        />
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Stat label="Email" value={tenant.email ?? "—"} />
        <Stat
          label="Activation status"
          value={
            tenant.hasPassword
              ? "Activated"
              : tenant.hasPendingActivation
                ? "Pending"
                : "Not activated"
          }
          accent={
            tenant.hasPassword ? "emerald" : tenant.hasPendingActivation ? "amber" : "rose"
          }
        />
        <Stat label="API key" value={tenant.hasApiKey ? "Set (hidden)" : "Not set"} />
        <Stat label="Facebook page id" value={tenant.facebookPageId ?? "—"} />
        <Stat label="Created" value={new Date(tenant.createdAt).toLocaleString()} />
        <Stat label="Integration" value={tenant.integration?.type ?? "—"} />
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold text-white">Account actions</h2>
        <p className="mt-1 text-xs text-slate-500">
          Each action returns a value shown ONCE. Forward it through your usual secure channel.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => void regenerateApiKey()} disabled={busy}>
            <KeyRound className="h-3.5 w-3.5" /> Regenerate API key
          </Button>
          <Button variant="secondary" onClick={() => void sendActivationLink()} disabled={busy}>
            {tenant.hasPassword ? (
              <>
                <ShieldAlert className="h-3.5 w-3.5" /> Reset password
              </>
            ) : (
              <>
                <UserPlus className="h-3.5 w-3.5" /> Issue activation link
              </>
            )}
          </Button>
          <Button
            variant={tenant.isActive ? "danger" : "primary"}
            onClick={() => void toggleActive()}
            disabled={busy}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {tenant.isActive ? "Disable tenant" : "Re-enable tenant"}
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold text-white">Settings preview</h2>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-white/10 bg-black/40 px-4 py-3 font-mono text-[11px] text-slate-300">
{JSON.stringify(tenant.settings ?? {}, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "emerald" | "amber" | "rose";
}) {
  const tone =
    accent === "emerald"
      ? "text-emerald-300"
      : accent === "amber"
        ? "text-amber-300"
        : accent === "rose"
          ? "text-rose-300"
          : "text-slate-200";
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-sm font-medium ${tone}`}>{value}</p>
    </div>
  );
}
