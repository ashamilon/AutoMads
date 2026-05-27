"use client";

/**
 * Suspended stores — Admin Super Control Panel (R20.4).
 *
 * Reads `/api/v1/admin/tenants` and filters to
 * `subscriptionStatus === 'suspended'` client-side. The list endpoint is
 * already capped to a sane size and we don't need a separate
 * server-side filter just for this view; reusing the same payload also
 * means a single round-trip is enough for an operator to scan all
 * statuses across `/admin/tenants` and `/admin/suspended` with shared
 * cache.
 *
 * Each row exposes a one-click Reactivate button that opens a small
 * modal asking for the audit-log reason and POSTs to
 * `/api/v1/admin/subscriptions/:tenantId/reactivate`.
 */

import { Button } from "@/components/ui/button";
import { adminFetch } from "@/lib/admin-api";
import { Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

interface AdminTenantSummary {
  tenantId: string;
  name: string;
  businessCategory: string | null;
  planSlug: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  lastPaymentStatus: string | null;
}

export default function AdminSuspendedPage() {
  const [tenants, setTenants] = useState<AdminTenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reactivating, setReactivating] = useState<AdminTenantSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch<{ tenants: AdminTenantSummary[] }>("/api/v1/admin/tenants");
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

  const suspended = useMemo(
    () => tenants.filter((t) => t.subscriptionStatus === "suspended"),
    [tenants],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Suspended stores</h1>
          <p className="mt-1 text-sm text-slate-500">
            Tenants whose subscription is in the <code>suspended</code> state. All data is
            preserved (R12.5) — reactivation flips the flag back without restoring any
            deletions.
          </p>
        </div>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {loading && tenants.length === 0 ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
        </div>
      ) : suspended.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-12 text-center">
          <p className="text-sm text-slate-500">No suspended tenants. Everyone's paid up.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.07] bg-white/[0.02]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Tenant</th>
                <th className="px-4 py-3 font-semibold">Plan</th>
                <th className="px-4 py-3 font-semibold">Period end</th>
                <th className="px-4 py-3 font-semibold">Last payment</th>
                <th className="px-4 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {suspended.map((t) => (
                <tr key={t.tenantId} className="transition hover:bg-white/[0.03]">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/tenants/${t.tenantId}`}
                      className="font-semibold text-white hover:text-indigo-300"
                    >
                      {t.name}
                    </Link>
                    <p className="mt-0.5 font-mono text-[10px] text-slate-500">{t.tenantId}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {t.businessCategory ?? "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{t.planSlug ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {t.currentPeriodEnd
                      ? new Date(t.currentPeriodEnd).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-300">{t.lastPaymentStatus ?? "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <Button onClick={() => setReactivating(t)}>Reactivate</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reactivating && (
        <ReactivateModal
          tenant={reactivating}
          onClose={() => setReactivating(null)}
          onCompleted={() => {
            setReactivating(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ReactivateModal({
  tenant,
  onClose,
  onCompleted,
}: {
  tenant: AdminTenantSummary;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    setBusy(true);
    try {
      await adminFetch(`/api/v1/admin/subscriptions/${tenant.tenantId}/reactivate`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      onCompleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-surface-950 p-6">
        <h3 className="text-sm font-semibold text-white">Reactivate {tenant.name}</h3>
        <p className="mt-1 text-xs text-slate-500">
          Sets <code>tenant.isActive=true</code> and runs the reactivation transition. The
          AI agent + outbound surfaces resume within 5 minutes.
        </p>
        <div className="mt-4">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Reason (recorded in audit log)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Manual reactivation - paid out-of-band"
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
        {err && (
          <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {err}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Reactivate
          </Button>
        </div>
      </div>
    </div>
  );
}
