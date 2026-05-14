"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { apiFetch } from "@/lib/api";
import type { OrderRow } from "@/lib/types";
import { orderStatusTone, paymentTone } from "@/lib/status-styles";
import { format, isToday, isYesterday } from "date-fns";
import {
  ArrowDownUp,
  Download,
  Filter,
  Loader2,
  RefreshCw,
  Search,
  ShoppingBag,
} from "lucide-react";
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

type SortKey = "createdAt-desc" | "createdAt-asc" | "amount-desc" | "amount-asc";

const filters = [
  { id: "all", label: "All" },
  { id: "AWAITING_PAYMENT", label: "Awaiting payment" },
  { id: "PAID", label: "Paid" },
  { id: "COMPLETED", label: "Completed" },
  { id: "FAILED", label: "Failed" },
];

const PAGE_SIZE = 50;

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("createdAt-desc");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch<{ orders: OrderRow[] }>("/api/v1/orders?limit=200");
      setOrders(r.orders);
      setVisibleCount(PAGE_SIZE);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = orders.filter((o) => {
      if (filter !== "all" && o.status !== filter && o.paymentStatus !== filter) return false;
      if (q) {
        const blob = `${o.id} ${JSON.stringify(o.structuredData || {})} ${o.externalOrderId || ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      if (sort.startsWith("createdAt")) {
        const va = new Date(a.createdAt).getTime();
        const vb = new Date(b.createdAt).getTime();
        return sort === "createdAt-desc" ? vb - va : va - vb;
      }
      const va = Number(a.totalAmount || 0);
      const vb = Number(b.totalAmount || 0);
      return sort === "amount-desc" ? vb - va : va - vb;
    });
    return list;
  }, [orders, filter, query, sort]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  const grouped = useMemo(() => {
    const groups = new Map<string, OrderRow[]>();
    visible.forEach((o) => {
      const d = new Date(o.createdAt);
      const key = isToday(d)
        ? "Today"
        : isYesterday(d)
          ? "Yesterday"
          : format(d, "MMM d, yyyy");
      const arr = groups.get(key) || [];
      arr.push(o);
      groups.set(key, arr);
    });
    return Array.from(groups.entries());
  }, [visible]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, query, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: orders.length };
    filters.forEach((f) => {
      if (f.id === "all") return;
      c[f.id] = orders.filter((o) => o.status === f.id || o.paymentStatus === f.id).length;
    });
    return c;
  }, [orders]);

  function exportCsv() {
    const rows = [
      ["id", "createdAt", "status", "paymentStatus", "deliveryStatus", "amount", "currency"].join(","),
      ...filtered.map((o) =>
        [o.id, o.createdAt, o.status, o.paymentStatus, o.deliveryStatus, o.totalAmount ?? "", o.currency || ""]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(","),
      ),
    ].join("\n");
    const blob = new Blob([rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orders-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <>
            <ShoppingBag className="h-3.5 w-3.5" /> {filtered.length} of {orders.length}
          </>
        }
        title="Orders"
        description="Pipeline from Messenger through payment and delivery. Filter, search, sort and export."
        actions={
          <>
            <Button variant="ghost" onClick={exportCsv} className="gap-2">
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button variant="secondary" onClick={() => load()} disabled={loading} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="search"
            placeholder="Search by id, customer, address…"
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] py-2.5 pl-10 pr-4 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-slate-600" />
          {filters.map((f) => {
            const a = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`group inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
                  a
                    ? "border-accent/40 bg-accent/15 text-white"
                    : "border-white/[0.08] bg-white/[0.03] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
                }`}
              >
                {f.label}
                {counts[f.id] != null && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      a ? "bg-white/10 text-indigo-100" : "bg-white/[0.05] text-slate-500"
                    }`}
                  >
                    {counts[f.id]}
                  </span>
                )}
              </button>
            );
          })}
          <div className="relative ml-auto lg:ml-0">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="appearance-none rounded-xl border border-white/[0.08] bg-white/[0.03] py-1.5 pl-3 pr-9 text-xs font-medium text-slate-200 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="createdAt-desc">Newest first</option>
              <option value="createdAt-asc">Oldest first</option>
              <option value="amount-desc">Amount high → low</option>
              <option value="amount-asc">Amount low → high</option>
            </select>
            <ArrowDownUp className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          </div>
        </div>
      </div>

      <Section title={`${filtered.length} order${filtered.length === 1 ? "" : "s"}`}>
        {loading && orders.length === 0 ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-accent-bright" />
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/[0.04]">
              <ShoppingBag className="h-5 w-5 text-slate-500" />
            </div>
            <p className="text-sm text-slate-500">No orders match this view.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {grouped.map(([day, list]) => (
              <div key={day}>
                <div className="mb-2 flex items-center gap-3">
                  <h3 className="label-caps">{day}</h3>
                  <span className="h-px flex-1 bg-white/[0.06]" />
                  <span className="text-[11px] font-medium text-slate-500">{list.length}</span>
                </div>
                <div className="overflow-hidden rounded-xl border border-white/[0.06]">
                  <table className="w-full text-left text-sm">
                    <tbody className="divide-y divide-white/[0.05]">
                      {list.map((o) => (
                        <OrderRowItem key={o.id} order={o} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {filtered.length > visible.length && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="ghost"
                  onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                  className="gap-2"
                >
                  Show more ({filtered.length - visible.length} remaining)
                </Button>
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

const OrderRowItem = memo(function OrderRowItem({ order: o }: { order: OrderRow }) {
  const sd = (o.structuredData || {}) as Record<string, unknown>;
  const customer = (sd.name as string) || (sd.phone as string) || "—";
  const product = (sd.product as string) || (sd.item as string) || null;
  return (
    <tr className="bg-white/[0.015] text-slate-300 transition hover:bg-white/[0.04]">
      <td className="w-20 px-4 py-3 text-xs text-slate-500">
        {format(new Date(o.createdAt), "HH:mm")}
      </td>
      <td className="min-w-[180px] px-2 py-3">
        <Link
          href={`/portal/orders/${o.id}`}
          className="font-mono text-xs font-medium text-indigo-300 hover:text-indigo-200"
        >
          {o.id.slice(0, 16)}…
        </Link>
        {o.externalOrderId && (
          <p className="font-mono text-[10px] text-slate-600">ext: {o.externalOrderId}</p>
        )}
      </td>
      <td className="min-w-[180px] px-2 py-3">
        <p className="truncate text-sm font-medium text-slate-200">{customer}</p>
        {product && <p className="truncate text-xs text-slate-500">{product}</p>}
      </td>
      <td className="px-2 py-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={orderStatusTone(o.status)}>{o.status}</Badge>
          <Badge tone={paymentTone(o.paymentStatus)}>{o.paymentStatus}</Badge>
        </div>
      </td>
      <td className="px-2 py-3 text-right tabular-figures">
        {o.totalAmount != null ? `${o.totalAmount} ${o.currency || ""}` : "—"}
      </td>
      <td className="w-16 px-3 py-3 text-right">
        <Link
          href={`/portal/orders/${o.id}`}
          className="text-xs font-medium text-indigo-400 transition hover:text-indigo-300"
        >
          Open
        </Link>
      </td>
    </tr>
  );
});
