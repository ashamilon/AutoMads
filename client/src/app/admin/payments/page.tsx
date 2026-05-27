"use client";

/**
 * Payments dashboard — Admin Super Control Panel (R20.3).
 *
 * Reads `/api/v1/admin/payments` with optional filters tenantId / gateway
 * / since / until and renders one PaymentTransaction row per record with
 * an expandable child failure list. Filtering is delegated to the server
 * — the response is already capped at the 500 most recent rows so we
 * just render what we get back.
 */

import { Button } from "@/components/ui/button";
import { adminFetch } from "@/lib/admin-api";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";

interface AdminPaymentRow {
  id: string;
  tenantId: string;
  invoiceId: string;
  gateway: string;
  amountBdt: string;
  status: string;
  sslcommerzTranId: string | null;
  sslcommerzSessionKey: string | null;
  createdAt: string;
  updatedAt: string;
  failures: Array<{ id: string; reason: string; createdAt: string }>;
}

interface FilterState {
  tenantId: string;
  gateway: string;
  since: string;
  until: string;
}

const EMPTY_FILTERS: FilterState = { tenantId: "", gateway: "", since: "", until: "" };

export default function AdminPaymentsPage() {
  const [rows, setRows] = useState<AdminPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (active: FilterState) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (active.tenantId.trim()) params.set("tenantId", active.tenantId.trim());
        if (active.gateway.trim()) params.set("gateway", active.gateway.trim());
        if (active.since.trim()) params.set("since", active.since.trim());
        if (active.until.trim()) params.set("until", active.until.trim());
        const qs = params.toString();
        const data = await adminFetch<{ payments: AdminPaymentRow[] }>(
          `/api/v1/admin/payments${qs ? "?" + qs : ""}`,
        );
        setRows(data.payments);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(EMPTY_FILTERS);
  }, [load]);

  function toggleRow(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Payments</h1>
          <p className="mt-1 text-sm text-slate-500">
            PaymentTransaction rows joined with their failure children. Up to 500 most
            recent records per query.
          </p>
        </div>
        <Button variant="ghost" onClick={() => void load(filters)} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <form
        className="grid gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 md:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void load(filters);
        }}
      >
        <FilterField
          label="Tenant id"
          value={filters.tenantId}
          onChange={(v) => setFilters({ ...filters, tenantId: v })}
          placeholder="cmooz62gy0000v5gclycwq78p"
        />
        <FilterField
          label="Gateway"
          value={filters.gateway}
          onChange={(v) => setFilters({ ...filters, gateway: v })}
          placeholder="sslcommerz"
        />
        <FilterField
          label="Since (ISO)"
          value={filters.since}
          onChange={(v) => setFilters({ ...filters, since: v })}
          placeholder="2024-01-01"
          type="date"
        />
        <FilterField
          label="Until (ISO)"
          value={filters.until}
          onChange={(v) => setFilters({ ...filters, until: v })}
          placeholder="2024-12-31"
          type="date"
        />
        <div className="flex items-end gap-2 md:col-span-4">
          <Button type="submit" disabled={loading}>
            Apply filters
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              void load(EMPTY_FILTERS);
            }}
            disabled={loading}
          >
            Reset
          </Button>
        </div>
      </form>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-12 text-center">
          <p className="text-sm text-slate-500">No transactions match the current filter.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.07] bg-white/[0.02]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-8 px-2 py-3" />
                <th className="px-3 py-3 font-semibold">Created</th>
                <th className="px-3 py-3 font-semibold">Tenant</th>
                <th className="px-3 py-3 font-semibold">Gateway</th>
                <th className="px-3 py-3 font-semibold">Status</th>
                <th className="px-3 py-3 text-right font-semibold">Amount (BDT)</th>
                <th className="px-3 py-3 font-semibold">Tran id</th>
                <th className="px-3 py-3 font-semibold">Invoice</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {rows.map((row) => {
                const isOpen = expanded.has(row.id);
                const hasFailures = row.failures.length > 0;
                return (
                  <Fragment key={row.id}>
                    <tr className="text-slate-300 transition hover:bg-white/[0.03]">
                      <td className="px-2 py-3">
                        {hasFailures ? (
                          <button
                            type="button"
                            onClick={() => toggleRow(row.id)}
                            className="text-slate-500 hover:text-slate-200"
                            aria-label={isOpen ? "Collapse failures" : "Expand failures"}
                          >
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-slate-400">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-3">
                        <Link
                          href={`/admin/tenants/${row.tenantId}`}
                          className="font-mono text-[11px] text-indigo-300 hover:text-indigo-200"
                        >
                          {row.tenantId}
                        </Link>
                      </td>
                      <td className="px-3 py-3 font-mono text-[11px]">{row.gateway}</td>
                      <td className="px-3 py-3">
                        <PaymentStatusPill status={row.status} />
                      </td>
                      <td className="px-3 py-3 text-right font-mono">{row.amountBdt}</td>
                      <td className="px-3 py-3 font-mono text-[11px]">
                        {row.sslcommerzTranId ?? "—"}
                      </td>
                      <td className="px-3 py-3 font-mono text-[11px]">{row.invoiceId}</td>
                    </tr>
                    {isOpen && hasFailures && (
                      <tr className="bg-white/[0.01]">
                        <td colSpan={8} className="px-3 py-3">
                          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                            Failures ({row.failures.length})
                          </p>
                          <ul className="space-y-1.5 text-xs text-slate-300">
                            {row.failures.map((f) => (
                              <li
                                key={f.id}
                                className="flex items-start justify-between gap-3 rounded-lg border border-rose-500/15 bg-rose-500/5 px-3 py-2"
                              >
                                <span className="font-mono">{f.reason}</span>
                                <span className="text-slate-500">
                                  {new Date(f.createdAt).toLocaleString()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Local primitives ─────────────────────────────────────────────────────

function FilterField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "date";
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
    </label>
  );
}

function PaymentStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    pending: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    failed: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  };
  const cls = map[status] ?? "border-white/10 bg-white/[0.04] text-slate-300";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}
    >
      {status}
    </span>
  );
}
