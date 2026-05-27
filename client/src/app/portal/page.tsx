"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { StatCard } from "@/components/ui/stat-card";
import { useTenant } from "@/context/tenant-context";
import { apiFetch } from "@/lib/api";
import type { OrderRow } from "@/lib/types";
import { orderStatusTone, paymentTone } from "@/lib/status-styles";
import { formatDistanceToNow } from "date-fns";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

export default function PortalDashboardPage() {
  const { tenant } = useTenant();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ orders: OrderRow[] }>("/api/v1/orders?limit=200")
      .then((r) => setOrders(r.orders))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const today = orders.filter((o) => now - new Date(o.createdAt).getTime() < day);
    const week = orders.filter((o) => now - new Date(o.createdAt).getTime() < 7 * day);
    const by = (s: string) => orders.filter((o) => o.status === s).length;
    const paid = orders.filter((o) => o.paymentStatus === "PAID").length;
    const awaiting = by("AWAITING_PAYMENT") + by("PENDING_CLIENT_SYNC");
    const failed = by("FAILED");
    const completed = by("COMPLETED") + by("DELIVERED");
    const revenue = orders
      .filter((o) => o.paymentStatus === "PAID" && o.totalAmount)
      .reduce((s, o) => s + Number(o.totalAmount || 0), 0);
    return { total: orders.length, today: today.length, week: week.length, paid, awaiting, failed, completed, revenue };
  }, [orders]);

  const dist = useMemo(() => {
    const total = Math.max(1, stats.paid + stats.awaiting + stats.failed + stats.completed);
    return [
      { label: "Paid", value: stats.paid, color: "bg-emerald-400/80", pct: (stats.paid / total) * 100 },
      { label: "Completed", value: stats.completed, color: "bg-indigo-400/80", pct: (stats.completed / total) * 100 },
      { label: "Awaiting", value: stats.awaiting, color: "bg-amber-400/80", pct: (stats.awaiting / total) * 100 },
      { label: "Failed", value: stats.failed, color: "bg-rose-400/80", pct: (stats.failed / total) * 100 },
    ];
  }, [stats]);

  const recent = orders.slice(0, 8);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <>
            <Sparkles className="h-3.5 w-3.5" /> Workspace
          </>
        }
        title={
          <>
            Welcome back<span className="text-gradient-accent">{tenant?.name ? `, ${tenant.name}` : ""}</span>
          </>
        }
        description={
          <>
            Live overview of Messenger orders flowing through your automation. Workspace slug{" "}
            <span className="font-mono text-indigo-300">{tenant?.slug}</span>.
          </>
        }
        actions={
          <Link href="/portal/orders">
            <Button variant="secondary" className="gap-2">
              View all orders <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Total orders"
          value={loading ? "—" : stats.total}
          hint={`${stats.today} today · ${stats.week} this week`}
          icon={ShoppingBag}
          tone="indigo"
        />
        <StatCard
          label="Paid"
          value={loading ? "—" : stats.paid}
          hint={
            stats.revenue
              ? `${stats.revenue.toLocaleString()} BDT collected`
              : "No payments yet"
          }
          icon={CheckCircle2}
          tone="emerald"
        />
        <StatCard
          label="Awaiting action"
          value={loading ? "—" : stats.awaiting}
          hint="Pending payment or sync"
          icon={Clock}
          tone="amber"
        />
        <StatCard
          label="Failed"
          value={loading ? "—" : stats.failed}
          hint={stats.failed === 0 ? "All clear" : "Needs review"}
          icon={XCircle}
          tone="rose"
        />
      </div>

      <Section
        title="Status distribution"
        description="Across your last 200 orders"
        actions={
          <Badge tone="info">
            <TrendingUp className="mr-1 h-3 w-3" />
            {stats.total} total
          </Badge>
        }
      >
        <div className="space-y-4">
          <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.04]">
            {dist.map((d) => (
              <motion.div
                key={d.label}
                initial={{ width: 0 }}
                animate={{ width: `${d.pct}%` }}
                transition={{ duration: 0.6 }}
                className={`${d.color}`}
                title={`${d.label}: ${d.value}`}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {dist.map((d) => (
              <div
                key={d.label}
                className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${d.color}`} />
                  <p className="text-xs font-medium text-slate-400">{d.label}</p>
                </div>
                <p className="mt-1.5 font-display text-xl font-bold tabular-figures text-white">
                  {d.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Recent activity"
        actions={
          <Link
            href="/portal/orders"
            className="inline-flex items-center gap-1 text-xs font-medium text-indigo-300 hover:text-indigo-200"
          >
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
      >
        {loading ? (
          <SkeletonRows />
        ) : recent.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="-mx-2 overflow-x-auto [scrollbar-width:thin]">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="label-caps text-slate-500">
                  <th className="px-2 pb-3">When</th>
                  <th className="px-2 pb-3">Order</th>
                  <th className="px-2 pb-3">Status</th>
                  <th className="px-2 pb-3">Payment</th>
                  <th className="px-2 pb-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {recent.map((o) => (
                  <tr key={o.id} className="text-slate-300 transition hover:bg-white/[0.02]">
                    <td className="whitespace-nowrap px-2 py-3 text-xs text-slate-500">
                      {formatDistanceToNow(new Date(o.createdAt), { addSuffix: true })}
                    </td>
                    <td className="px-2 py-3">
                      <Link
                        href={`/portal/orders/${o.id}`}
                        className="font-mono text-xs font-medium text-indigo-300 hover:text-indigo-200"
                      >
                        {o.id.slice(0, 12)}…
                      </Link>
                    </td>
                    <td className="px-2 py-3">
                      <Badge tone={orderStatusTone(o.status)}>{o.status}</Badge>
                    </td>
                    <td className="px-2 py-3">
                      <Badge tone={paymentTone(o.paymentStatus)}>{o.paymentStatus}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 text-right tabular-figures">
                      {o.totalAmount != null ? `${o.totalAmount} ${o.currency || ""}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-3 py-3">
          <div className="h-3 w-24 animate-pulse rounded bg-white/[0.06]" />
          <div className="h-3 w-32 animate-pulse rounded bg-white/[0.06]" />
          <div className="ml-auto h-3 w-20 animate-pulse rounded bg-white/[0.06]" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/[0.04]">
        <Activity className="h-5 w-5 text-slate-500" />
      </div>
      <div>
        <p className="font-medium text-white">No orders yet</p>
        <p className="mt-1 max-w-sm text-sm text-slate-500">
          When Messenger conversations convert to orders, they will appear here in real time.
        </p>
      </div>
    </div>
  );
}
