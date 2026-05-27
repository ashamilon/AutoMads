"use client";

/**
 * Tenant billing page (`/portal/billing`).
 *
 * Three sections:
 *   1. Current plan card — name, price, status, period dates, days remaining.
 *   2. Usage bars — messages, AI tokens, posts vs plan limits.
 *   3. Past invoices table with PDF download links.
 *
 * Calls three endpoints:
 *   - GET /api/v1/billing/me        → subscription + usage summary
 *   - GET /api/v1/billing/invoices  → invoice history
 *   - POST /api/v1/billing/initiate-renewal → kicks SSLCommerz redirect
 *   - POST /api/v1/billing/cancel   → deferred cancel
 *
 * Loading and error states match the rest of the portal so the page feels
 * native. The "Pay now" button only appears when there's a `pending` invoice.
 */

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { apiFetch } from "@/lib/api";
import { Loader2, Receipt, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────

interface SubscriptionView {
  id: string;
  status: string;
  planSlug: string;
  planName: string;
  priceBdt: string;
  billingCycle: string;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  gracePeriodEndsAt: string | null;
  cancelledAt: string | null;
  nextBillingAt: string | null;
  daysRemaining: number;
}

interface MyBillingResponse {
  subscription: SubscriptionView | null;
  limits: Record<string, unknown>;
  usage: Record<string, number>;
  percentageUsed: Record<string, number | null>;
}

interface InvoiceRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  amountBdt: string;
  currency: string;
  status: string;
  pdfPath: string | null;
  sslcommerzTranId: string | null;
  createdAt: string;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const [billing, setBilling] = useState<MyBillingResponse | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<"pay" | "cancel" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [me, inv] = await Promise.all([
        apiFetch<MyBillingResponse>("/api/v1/billing/me"),
        apiFetch<{ invoices: InvoiceRow[] }>("/api/v1/billing/invoices"),
      ]);
      setBilling(me);
      setInvoices(inv.invoices);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handlePayNow() {
    setActionPending("pay");
    try {
      const result = await apiFetch<{ redirectUrl: string }>(
        "/api/v1/billing/initiate-renewal",
        { method: "POST" },
      );
      // Redirect the browser to SSLCommerz's hosted checkout page.
      window.location.href = result.redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start payment");
      setActionPending(null);
    }
  }

  async function handleCancel() {
    if (!confirm(
      "Cancel your subscription? Your access stays active until the current period ends; only the cancellation date is set immediately.",
    )) {
      return;
    }
    setActionPending("cancel");
    try {
      await apiFetch("/api/v1/billing/cancel", { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel");
    } finally {
      setActionPending(null);
    }
  }

  if (loading && !billing) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-accent-bright" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Your subscription, usage, and past invoices."
        actions={
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {!billing?.subscription ? (
        <Section title="No subscription" description="Your trial will start once you finish onboarding.">
          <p className="text-sm text-slate-500">
            If you've already finished onboarding and are seeing this, please reach out to support.
          </p>
        </Section>
      ) : (
        <>
          <SubscriptionCard
            subscription={billing.subscription}
            onPay={handlePayNow}
            onCancel={handleCancel}
            actionPending={actionPending}
          />
          <UsageCard
            limits={billing.limits}
            usage={billing.usage}
            percentageUsed={billing.percentageUsed}
          />
        </>
      )}

      <InvoicesCard invoices={invoices} />
    </div>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────────

function SubscriptionCard({
  subscription,
  onPay,
  onCancel,
  actionPending,
}: {
  subscription: SubscriptionView;
  onPay: () => void;
  onCancel: () => void;
  actionPending: "pay" | "cancel" | null;
}) {
  const banner = subscriptionBanner(subscription);
  const showPayNow =
    subscription.status === "overdue" || subscription.status === "trial";
  const cancelable =
    subscription.status === "trial" ||
    subscription.status === "active" ||
    subscription.status === "overdue";

  return (
    <Section
      title="Current plan"
      description="Your active plan, billing dates, and how many days remain."
      actions={
        <div className="flex flex-wrap gap-2">
          {showPayNow && (
            <Button onClick={onPay} disabled={actionPending !== null}>
              {actionPending === "pay" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Pay now
            </Button>
          )}
          {cancelable && !subscription.cancelledAt && (
            <Button variant="ghost" onClick={onCancel} disabled={actionPending !== null}>
              {actionPending === "cancel" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Cancel
            </Button>
          )}
        </div>
      }
    >
      {banner && (
        <div
          className={`mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 ${banner.cls}`}
        >
          {banner.icon}
          <div className="text-sm">{banner.message}</div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Stat label="Plan" value={`${subscription.planName}`} sub={`${subscription.priceBdt} BDT / mo`} />
        <Stat label="Status" value={<StatusPill status={subscription.status} />} />
        <Stat label="Days remaining" value={`${subscription.daysRemaining}`} sub="until next billing" />
        <Stat
          label="Period end"
          value={formatDate(subscription.currentPeriodEnd)}
          sub={
            subscription.gracePeriodEndsAt
              ? `Grace ends ${formatDate(subscription.gracePeriodEndsAt)}`
              : subscription.cancelledAt
                ? `Cancels ${formatDate(subscription.currentPeriodEnd)}`
                : "auto-renews"
          }
        />
      </div>
    </Section>
  );
}

function UsageCard({
  limits,
  usage,
  percentageUsed,
}: {
  limits: Record<string, unknown>;
  usage: Record<string, number>;
  percentageUsed: Record<string, number | null>;
}) {
  const counterToLimit: Record<string, string> = {
    messages: "maxMonthlyMessages",
    aiTokens: "maxAiTokensMonthly",
    posts: "maxPostingPerDay",
  };
  const labels: Record<string, string> = {
    messages: "Customer messages",
    aiTokens: "AI tokens",
    posts: "Social posts",
  };
  const rows = Object.entries(counterToLimit).map(([counter, limitKey]) => {
    const used = usage[counter] ?? 0;
    const max = limits[limitKey];
    const pct = percentageUsed[limitKey] ?? null;
    return { counter, label: labels[counter] ?? counter, used, max, pct };
  });

  return (
    <Section title="Usage" description="How much you've used this billing period.">
      <div className="space-y-4">
        {rows.map((row) => (
          <UsageBar
            key={row.counter}
            label={row.label}
            used={row.used}
            max={row.max}
            pct={row.pct}
          />
        ))}
      </div>
    </Section>
  );
}

function InvoicesCard({ invoices }: { invoices: InvoiceRow[] }) {
  if (invoices.length === 0) {
    return (
      <Section title="Invoices" description="Your past invoices will show up here once you pay.">
        <p className="text-sm text-slate-500">No invoices yet.</p>
      </Section>
    );
  }
  return (
    <Section title="Invoices" description="Past billing periods. Click an invoice to download the PDF.">
      <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2.5 font-semibold">Period</th>
              <th className="px-3 py-2.5 font-semibold">Amount</th>
              <th className="px-3 py-2.5 font-semibold">Status</th>
              <th className="px-3 py-2.5 font-semibold">Created</th>
              <th className="px-3 py-2.5 text-right font-semibold">PDF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {invoices.map((inv) => (
              <tr key={inv.id} className="text-slate-300">
                <td className="px-3 py-2.5">
                  {formatDate(inv.periodStart)} → {formatDate(inv.periodEnd)}
                </td>
                <td className="px-3 py-2.5 font-mono">
                  {inv.amountBdt} {inv.currency}
                </td>
                <td className="px-3 py-2.5">
                  <InvoiceStatusPill status={inv.status} />
                </td>
                <td className="px-3 py-2.5 text-slate-500">
                  {new Date(inv.createdAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {inv.pdfPath ? (
                    <a
                      href={inv.pdfPath}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-white/[0.06]"
                    >
                      <Receipt className="h-3.5 w-3.5" /> Download
                    </a>
                  ) : (
                    <span className="text-xs text-slate-600">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1 text-base font-semibold text-white">{value}</div>
      {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

function UsageBar({
  label,
  used,
  max,
  pct,
}: {
  label: string;
  used: number;
  max: unknown;
  pct: number | null;
}) {
  const maxLabel =
    typeof max === "number" && max === -1
      ? "unlimited"
      : typeof max === "number"
        ? max.toLocaleString()
        : typeof max === "boolean"
          ? max
            ? "yes"
            : "no"
          : "—";
  const pctClamped = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const tone =
    pctClamped >= 100
      ? "bg-rose-500"
      : pctClamped >= 80
        ? "bg-amber-400"
        : "bg-emerald-400";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-slate-200">{label}</span>
        <span className="font-mono text-slate-400">
          {used.toLocaleString()} / {maxLabel}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
        {pct === null ? (
          <div className="h-full bg-white/[0.04]" style={{ width: "100%" }} />
        ) : (
          <div className={`h-full ${tone}`} style={{ width: `${pctClamped}%` }} />
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    trial: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    overdue: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    suspended: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    cancelled: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  };
  const cls = map[status] ?? "border-white/10 bg-white/[0.04] text-slate-300";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}
    >
      {status}
    </span>
  );
}

function InvoiceStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    paid: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    pending: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    failed: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    cancelled: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  };
  const cls = map[status] ?? "border-white/10 bg-white/[0.04] text-slate-300";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}
    >
      {status}
    </span>
  );
}

function subscriptionBanner(
  subscription: SubscriptionView,
): { cls: string; icon: React.ReactNode; message: React.ReactNode } | null {
  if (subscription.status === "overdue") {
    return {
      cls: "border-amber-500/30 bg-amber-500/10 text-amber-200",
      icon: <AlertCircle className="h-4 w-4 shrink-0" />,
      message: (
        <>
          Your last payment didn't go through. You have{" "}
          <strong>{subscription.daysRemaining} day{subscription.daysRemaining === 1 ? "" : "s"}</strong>{" "}
          to pay before your store is suspended.
        </>
      ),
    };
  }
  if (subscription.status === "suspended") {
    return {
      cls: "border-rose-500/30 bg-rose-500/10 text-rose-200",
      icon: <AlertCircle className="h-4 w-4 shrink-0" />,
      message: (
        <>
          Your store is suspended. Your data is preserved — pay your overdue balance to reactivate.
        </>
      ),
    };
  }
  if (subscription.status === "trial") {
    return {
      cls: "border-sky-500/30 bg-sky-500/10 text-sky-200",
      icon: <CheckCircle2 className="h-4 w-4 shrink-0" />,
      message: (
        <>
          You're on a free trial — <strong>{subscription.daysRemaining} day{subscription.daysRemaining === 1 ? "" : "s"}</strong>{" "}
          remaining.
        </>
      ),
    };
  }
  if (subscription.cancelledAt) {
    return {
      cls: "border-slate-500/30 bg-slate-500/10 text-slate-200",
      icon: <AlertCircle className="h-4 w-4 shrink-0" />,
      message: (
        <>
          Cancellation scheduled. Your access ends on{" "}
          <strong>{formatDate(subscription.currentPeriodEnd)}</strong>.
        </>
      ),
    };
  }
  return null;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}
