"use client";

/**
 * Tenant detail panel — Admin Super Control Panel (R20.1, R20.2, R20.4,
 * R20.5, R20.6).
 *
 * Reads `/api/v1/admin/tenants/:id` (returned by `getTenantDetail` in
 * `adminPanelService`) and renders:
 *
 *   - tenant header (name, businessCategory, dashboardTemplate,
 *     isActive, onboardingCompletedAt, createdAt)
 *   - subscription card (status, plan, period start/end, grace,
 *     cancelled, next billing)
 *   - resolved Plan_Limits + per-tenant overrides + usage counters with
 *     `% used` per limit
 *   - 25 most recent SubscriptionLog rows (audit trail)
 *
 * Actions surfaced as buttons that POST to `/api/v1/admin/...` and
 * refresh on success: Suspend, Reactivate, Cancel, Override limits,
 * Assign category schema. Each modal collects only the fields the
 * server requires; everything else is delegated to `adminPanelService`.
 */

import { Button } from "@/components/ui/button";
import { adminFetch } from "@/lib/admin-api";
import { ChevronLeft, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SubscriptionStatusPill } from "../status-pills";

interface AdminTenantDetail {
  tenant: {
    id: string;
    name: string;
    isActive: boolean;
    businessCategory: string | null;
    businessSubcategory: string | null;
    categorySchemaId: string | null;
    dashboardTemplate: string | null;
    onboardingCompletedAt: string | null;
    createdAt: string;
  };
  subscription: {
    id: string;
    status: string;
    planId: string;
    planSlug: string | null;
    billingCycle: string;
    trialEndsAt: string | null;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    gracePeriodEndsAt: string | null;
    cancelledAt: string | null;
    nextBillingAt: string | null;
    usageCounters: Record<string, number>;
    planLimitOverrides: Record<string, unknown> | null;
  } | null;
  planLimits: Record<string, unknown>;
  recentLogs: Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string;
    actor: string;
    metadata: unknown;
    createdAt: string;
  }>;
}

interface CategorySchemaRow {
  id: string;
  slug: string;
  isBuiltIn: boolean;
  tenantId: string | null;
  version: number;
}

type ActionKind = "suspend" | "reactivate" | "cancel" | "override" | "assign-schema";

export default function AdminTenantDetailPage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const [detail, setDetail] = useState<AdminTenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<ActionKind | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch<AdminTenantDetail>(`/api/v1/admin/tenants/${id}`);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !detail) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
      </div>
    );
  }
  if (error || !detail) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
        {error ?? "Tenant not found."}
        <Link href="/admin/tenants" className="ml-3 underline">
          Back to tenants
        </Link>
      </div>
    );
  }

  const { tenant, subscription, planLimits, recentLogs } = detail;
  const usageCounters = subscription?.usageCounters ?? {};
  const overrides = subscription?.planLimitOverrides ?? null;
  const subStatus = subscription?.status ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/admin/tenants"
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-300"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> All tenants
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold text-white">{tenant.name}</h1>
            <SubscriptionStatusPill status={subStatus} />
            {!tenant.isActive && (
              <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-300">
                Inactive
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-slate-500">{tenant.id}</p>
        </div>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <SectionCard title="Tenant">
        <div className="grid gap-3 md:grid-cols-2">
          <Stat label="Business category" value={tenant.businessCategory ?? "—"} />
          <Stat label="Subcategory" value={tenant.businessSubcategory ?? "—"} />
          <Stat label="Dashboard template" value={tenant.dashboardTemplate ?? "—"} />
          <Stat
            label="Category schema id"
            value={tenant.categorySchemaId ?? "—"}
            mono
          />
          <Stat
            label="Onboarding completed at"
            value={formatDateTime(tenant.onboardingCompletedAt)}
          />
          <Stat label="Created" value={formatDateTime(tenant.createdAt)} />
        </div>
      </SectionCard>

      <SectionCard
        title="Subscription"
        actions={
          subscription && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => setActiveAction("suspend")}
                disabled={subStatus === "suspended"}
              >
                Suspend
              </Button>
              <Button
                variant="secondary"
                onClick={() => setActiveAction("reactivate")}
                disabled={subStatus !== "suspended" && subStatus !== "overdue"}
              >
                Reactivate
              </Button>
              <Button
                variant="ghost"
                onClick={() => setActiveAction("cancel")}
                disabled={subStatus === "cancelled" || subStatus === "suspended"}
              >
                Cancel
              </Button>
              <Button variant="ghost" onClick={() => setActiveAction("override")}>
                Override limits
              </Button>
              <Button variant="ghost" onClick={() => setActiveAction("assign-schema")}>
                Assign category schema
              </Button>
            </div>
          )
        }
      >
        {subscription ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Stat label="Plan" value={subscription.planSlug ?? subscription.planId} />
            <Stat label="Billing cycle" value={subscription.billingCycle} />
            <Stat label="Trial ends" value={formatDateTime(subscription.trialEndsAt)} />
            <Stat
              label="Current period"
              value={`${formatDateTime(subscription.currentPeriodStart)} → ${formatDateTime(subscription.currentPeriodEnd)}`}
            />
            <Stat label="Grace period ends" value={formatDateTime(subscription.gracePeriodEndsAt)} />
            <Stat label="Cancelled at" value={formatDateTime(subscription.cancelledAt)} />
            <Stat label="Next billing" value={formatDateTime(subscription.nextBillingAt)} />
          </div>
        ) : (
          <p className="text-sm text-slate-500">No subscription on file.</p>
        )}
      </SectionCard>

      <SectionCard title="Plan limits, overrides, and usage">
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-white/[0.06] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Limit / counter</th>
                <th className="px-3 py-2 font-semibold">Resolved cap</th>
                <th className="px-3 py-2 font-semibold">Override</th>
                <th className="px-3 py-2 font-semibold">Current usage</th>
                <th className="px-3 py-2 font-semibold">% used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {Object.entries(planLimits).map(([key, max]) => {
                const counter = mapCounterKey(key);
                const current = counter ? usageCounters[counter] : undefined;
                const overrideVal =
                  overrides && overrides[key] !== undefined ? overrides[key] : undefined;
                const pct = computePercent(current, max);
                return (
                  <tr key={key} className="text-slate-300">
                    <td className="px-3 py-2 font-mono">{key}</td>
                    <td className="px-3 py-2">{formatLimit(max)}</td>
                    <td className="px-3 py-2 text-amber-300">
                      {overrideVal === undefined ? "—" : formatLimit(overrideVal)}
                    </td>
                    <td className="px-3 py-2">{current ?? "—"}</td>
                    <td className="px-3 py-2">
                      {pct === null ? "—" : <UsageBar value={pct} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Recent subscription log">
        {recentLogs.length === 0 ? (
          <p className="text-sm text-slate-500">No transitions recorded.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.06] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">From → To</th>
                  <th className="px-3 py-2 font-semibold">Reason</th>
                  <th className="px-3 py-2 font-semibold">Actor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {recentLogs.map((log) => (
                  <tr key={log.id} className="text-slate-300">
                    <td className="px-3 py-2 text-slate-400">
                      {formatDateTime(log.createdAt)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {(log.fromStatus ?? "—") + " → " + log.toStatus}
                    </td>
                    <td className="px-3 py-2">{log.reason}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{log.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {activeAction && (
        <ActionModal
          kind={activeAction}
          tenantId={id}
          currentOverrides={overrides}
          onClose={() => setActiveAction(null)}
          onCompleted={() => {
            setActiveAction(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ─── Sections / primitives ────────────────────────────────────────────────

function SectionCard({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`mt-1 break-all text-sm font-medium text-slate-200 ${
          mono ? "font-mono text-xs" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function UsageBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const tone =
    clamped >= 100 ? "bg-rose-500" : clamped >= 80 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={`h-full ${tone}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="font-mono text-[11px] text-slate-400">{value.toFixed(1)}%</span>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────

function ActionModal({
  kind,
  tenantId,
  currentOverrides,
  onClose,
  onCompleted,
}: {
  kind: ActionKind;
  tenantId: string;
  currentOverrides: Record<string, unknown> | null;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [reason, setReason] = useState("");
  const [overridesJson, setOverridesJson] = useState<string>(
    () => JSON.stringify(currentOverrides ?? {}, null, 2),
  );
  const [schemas, setSchemas] = useState<CategorySchemaRow[] | null>(null);
  const [selectedSchemaId, setSelectedSchemaId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Lazy-load category schema list when the assign modal opens.
  useEffect(() => {
    if (kind !== "assign-schema") return;
    void (async () => {
      try {
        const data = await adminFetch<{ schemas: CategorySchemaRow[] }>(
          "/api/v1/admin/categories",
        );
        setSchemas(data.schemas);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [kind]);

  const title =
    kind === "suspend"
      ? "Suspend tenant"
      : kind === "reactivate"
        ? "Reactivate tenant"
        : kind === "cancel"
          ? "Cancel subscription"
          : kind === "override"
            ? "Override plan limits"
            : "Assign category schema";

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      if (kind === "suspend") {
        if (!reason.trim()) throw new Error("Reason is required");
        await adminFetch(`/api/v1/admin/subscriptions/${tenantId}/suspend`, {
          method: "POST",
          body: JSON.stringify({ reason: reason.trim() }),
        });
      } else if (kind === "reactivate") {
        if (!reason.trim()) throw new Error("Reason is required");
        await adminFetch(`/api/v1/admin/subscriptions/${tenantId}/reactivate`, {
          method: "POST",
          body: JSON.stringify({ reason: reason.trim() }),
        });
      } else if (kind === "cancel") {
        await adminFetch(`/api/v1/admin/subscriptions/${tenantId}/cancel`, {
          method: "POST",
          body: JSON.stringify({}),
        });
      } else if (kind === "override") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(overridesJson);
        } catch {
          throw new Error("Overrides must be valid JSON");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Overrides must be a JSON object");
        }
        await adminFetch(`/api/v1/admin/subscriptions/${tenantId}/override-limits`, {
          method: "POST",
          body: JSON.stringify({ overrides: parsed }),
        });
      } else if (kind === "assign-schema") {
        if (!selectedSchemaId) throw new Error("Pick a schema");
        await adminFetch(`/api/v1/admin/tenants/${tenantId}/category`, {
          method: "POST",
          body: JSON.stringify({ categorySchemaId: selectedSchemaId }),
        });
      }
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
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-surface-950 p-6">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {(kind === "suspend" || kind === "reactivate") && (
          <div className="mt-4 space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Reason (recorded in audit log)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder={
                kind === "suspend"
                  ? "e.g. Manual suspension - chargeback dispute"
                  : "e.g. Manual reactivation - paid out-of-band"
              }
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>
        )}
        {kind === "cancel" && (
          <p className="mt-4 text-sm text-slate-400">
            Cancels the subscription. Status remains <code>active</code> until the current
            period ends; only <code>cancelledAt</code> is set immediately. The actor is
            recorded as <code>super_admin:&lt;id&gt;</code>.
          </p>
        )}
        {kind === "override" && (
          <div className="mt-4 space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Overrides JSON (object only)
            </label>
            <textarea
              value={overridesJson}
              onChange={(e) => setOverridesJson(e.target.value)}
              rows={10}
              spellCheck={false}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            <p className="text-[11px] text-slate-500">
              e.g. <code>{`{ "maxProducts": 2000, "feature.aiPosting": true }`}</code>
            </p>
          </div>
        )}
        {kind === "assign-schema" && (
          <div className="mt-4 space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Category schema
            </label>
            {schemas === null ? (
              <p className="text-xs text-slate-500">Loading schemas…</p>
            ) : (
              <select
                value={selectedSchemaId}
                onChange={(e) => setSelectedSchemaId(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
              >
                <option value="">— Pick a schema —</option>
                {schemas.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.slug} (v{s.version}) {s.isBuiltIn ? "[built-in]" : "[tenant]"} — {s.id}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
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
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatLimit(value: unknown): string {
  if (typeof value === "number") {
    return value === -1 ? "unlimited" : value.toLocaleString();
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

function computePercent(current: number | undefined, max: unknown): number | null {
  if (typeof current !== "number") return null;
  if (typeof max !== "number") return null;
  if (max === -1 || max === 0) return null;
  return Math.round((current / max) * 1000) / 10;
}

function mapCounterKey(limitKey: string): string | null {
  switch (limitKey) {
    case "maxMonthlyMessages":
      return "messages";
    case "maxAiTokensMonthly":
      return "aiTokens";
    case "maxPostingPerDay":
      return "posts";
    default:
      return null;
  }
}
