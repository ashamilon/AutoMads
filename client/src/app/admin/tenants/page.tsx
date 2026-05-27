"use client";

/**
 * Admin tenants list — the Commerce_OS-aware tenant directory (R20.1).
 *
 * Reads `/api/v1/admin/tenants`, which returns one row per tenant with
 * the headline subscription fields (status, plan, period end, last
 * payment). Suspended / overdue rows surface as colored status pills so
 * the operator can spot them at a glance and click through to the
 * detail page where the subscription actions live.
 *
 * Distinct from `/admin` (the legacy account-management list focused on
 * activation links + API keys) — this view is the entry point for the
 * subscription / billing panels required by task 12.3.
 */

import { Button } from "@/components/ui/button";
import { adminFetch } from "@/lib/admin-api";
import { Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PaymentPill, SubscriptionStatusPill } from "./status-pills";

interface AdminTenantSummary {
  tenantId: string;
  name: string;
  businessCategory: string | null;
  planId: string | null;
  planSlug: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  lastPaymentStatus: string | null;
}

export default function AdminTenantsListPage() {
  const [tenants, setTenants] = useState<AdminTenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Tenants &amp; subscriptions</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every tenant on the platform with their billing status. Click a row to manage
            suspension, overrides, and category assignment.
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
      ) : tenants.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-12 text-center">
          <p className="text-sm text-slate-500">No tenants yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.07] bg-white/[0.02]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Tenant</th>
                <th className="px-4 py-3 font-semibold">Business category</th>
                <th className="px-4 py-3 font-semibold">Plan</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Period end</th>
                <th className="px-4 py-3 font-semibold">Last payment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {tenants.map((t) => (
                <tr
                  key={t.tenantId}
                  className="transition hover:bg-white/[0.03]"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/tenants/${t.tenantId}`}
                      className="font-semibold text-white hover:text-indigo-300"
                    >
                      {t.name}
                    </Link>
                    <p className="mt-0.5 font-mono text-[10px] text-slate-500">{t.tenantId}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{t.businessCategory ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-300">{t.planSlug ?? "—"}</td>
                  <td className="px-4 py-3">
                    <SubscriptionStatusPill status={t.subscriptionStatus} />
                  </td>
                  <td className="px-4 py-3 text-slate-400">{formatDate(t.currentPeriodEnd)}</td>
                  <td className="px-4 py-3">
                    <PaymentPill status={t.lastPaymentStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}


