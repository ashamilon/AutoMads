"use client";

/**
 * Tenant analytics dashboard.
 *
 * One-page deep view powered by a single backend call:
 *   GET /api/v1/analytics/overview?days={N}
 *
 * Layout (top to bottom):
 *   1. Range picker (7 / 30 / 90 / 365)
 *   2. KPI rail — revenue, orders, AOV, conversion (with prev-period delta)
 *   3. Revenue + orders trend (dual-series area chart)
 *   4. Funnel (conversations → with-order → paid → delivered)
 *   5. Two-up: status mix + payment-method mix
 *   6. Two-up: hour-of-day heat-bar + weekday distribution
 *   7. Two-up: top products + top customers
 *   8. Cohort + cancellations
 *
 * All charts are pure SVG — no chart-library dependency. The data shape
 * matches `tenantAnalyticsController.getAnalyticsOverview` exactly.
 */

import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { StatCard } from "@/components/ui/stat-card";
import { apiFetch } from "@/lib/api";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Coins,
  LineChart,
  MessagesSquare,
  Percent,
  ShoppingBag,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Trend = { date: string; orders: number; paidOrders: number; revenue: number };
type Bucket = { label: string; count: number };
type TopProduct = { name: string; orders: number; quantity: number; revenue: number };
type TopCustomer = {
  psid: string;
  name: string | null;
  phone: string | null;
  totalOrders: number;
  totalSpentBdt: number;
  lastSeenAt: string;
};

type Overview = {
  range: { startsAt: string; endsAt: string; days: number };
  kpis: {
    revenue: number;
    revenueDelta: number;
    orders: number;
    ordersDelta: number;
    paidOrders: number;
    paidOrdersDelta: number;
    aov: number;
    aovDelta: number;
    conversionRate: number;
    conversionRateDelta: number;
    conversations: number;
    conversationsDelta: number;
    messagesIn: number;
    messagesOut: number;
    messagesTotal: number;
    messagesDelta: number;
    uniqueCustomers: number;
  };
  trend: Trend[];
  byStatus: Bucket[];
  byPayment: Bucket[];
  byPaymentMethod: Bucket[];
  byDelivery: Bucket[];
  byHour: number[];
  byWeekday: number[];
  topProducts: TopProduct[];
  topCustomers: TopCustomer[];
  funnel: { conversations: number; withOrder: number; paid: number; delivered: number };
  cohort: { newCustomers: number; returningCustomers: number; lifetimeCustomers: number };
  cancellations: Array<{ reason: string; count: number }>;
};

const RANGES = [
  { id: 7, label: "7d" },
  { id: 30, label: "30d" },
  { id: 90, label: "90d" },
  { id: 365, label: "12m" },
] as const;

export default function AnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<Overview>(`/api/v1/analytics/overview?days=${days}`)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load analytics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow={
          <>
            <Sparkles className="h-3.5 w-3.5" /> Insights
          </>
        }
        title={
          <>
            Advanced <span className="text-gradient-accent">analytics</span>
          </>
        }
        description="Track revenue, conversion, customer behaviour, and AI agent performance. Compared against the previous period of the same length."
        actions={
          <div className="inline-flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setDays(r.id)}
                className={`rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition sm:px-3 sm:text-[12.5px] ${
                  days === r.id
                    ? "bg-white/10 text-white shadow-inner"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* KPI rail */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <KpiCard
          label="Revenue"
          value={loading ? "—" : `৳${data?.kpis.revenue.toLocaleString() ?? 0}`}
          delta={data?.kpis.revenueDelta}
          hint={data ? `${data.kpis.paidOrders} paid orders` : "—"}
          icon={Coins}
          tone="emerald"
        />
        <KpiCard
          label="Orders"
          value={loading ? "—" : data?.kpis.orders.toLocaleString() ?? 0}
          delta={data?.kpis.ordersDelta}
          hint={data ? `${data.kpis.paidOrders} paid` : "—"}
          icon={ShoppingBag}
          tone="indigo"
        />
        <KpiCard
          label="Avg order value"
          value={loading ? "—" : `৳${data?.kpis.aov.toLocaleString() ?? 0}`}
          delta={data?.kpis.aovDelta}
          hint="From paid orders"
          icon={LineChart}
          tone="violet"
        />
        <KpiCard
          label="Conversion"
          value={loading ? "—" : `${data?.kpis.conversionRate ?? 0}%`}
          delta={data?.kpis.conversionRateDelta}
          hint={data ? `${data.kpis.uniqueCustomers} chat customers` : "—"}
          icon={Percent}
          tone="amber"
        />
      </div>

      {/* Secondary rail */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <StatCard
          label="Conversations"
          value={loading ? "—" : data?.kpis.conversations.toLocaleString() ?? 0}
          hint={
            data
              ? `${formatDelta(data.kpis.conversationsDelta)} vs prev ${data.range.days}d`
              : "—"
          }
          icon={MessagesSquare}
          tone="sky"
        />
        <StatCard
          label="Messages handled"
          value={loading ? "—" : data?.kpis.messagesTotal.toLocaleString() ?? 0}
          hint={
            data
              ? `${data.kpis.messagesIn.toLocaleString()} in · ${data.kpis.messagesOut.toLocaleString()} out`
              : "—"
          }
          icon={Sparkles}
          tone="violet"
        />
        <StatCard
          label="New customers"
          value={loading ? "—" : data?.cohort.newCustomers.toLocaleString() ?? 0}
          hint={
            data
              ? `${data.cohort.returningCustomers.toLocaleString()} returning · ${data.cohort.lifetimeCustomers.toLocaleString()} lifetime`
              : "—"
          }
          icon={Users}
          tone="emerald"
          className="col-span-2 lg:col-span-1"
        />
      </div>

      {/* Revenue + orders trend */}
      <Section
        title="Revenue & orders"
        description={
          data
            ? `${formatDate(data.range.startsAt)} → ${formatDate(data.range.endsAt)}`
            : "Last selected window"
        }
      >
        {loading || !data ? (
          <div className="h-64 animate-pulse rounded-xl bg-white/[0.03]" />
        ) : data.trend.every((t) => t.orders === 0) ? (
          <EmptyChart message="No orders yet in this window. Once Messenger conversations convert to orders they'll show up here." />
        ) : (
          <TrendChart trend={data.trend} />
        )}
      </Section>

      {/* Funnel */}
      <Section
        title="Conversion funnel"
        description="Unique customers, by stage. Conversation → order → paid → delivered."
      >
        {loading || !data ? (
          <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" />
        ) : (
          <Funnel funnel={data.funnel} />
        )}
      </Section>

      {/* Status + payment method */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Order status" description="Current state of every order in the window">
          {loading || !data ? (
            <SkelBar />
          ) : (
            <BarList items={statusTones(data.byStatus)} formatValue={(n) => n.toLocaleString()} />
          )}
        </Section>
        <Section title="Payment rails" description="Which payment method customers used">
          {loading || !data ? (
            <SkelBar />
          ) : (
            <BarList
              items={paymentMethodPalette(data.byPaymentMethod)}
              formatValue={(n) => n.toLocaleString()}
            />
          )}
        </Section>
      </div>

      {/* Hour heat-bar + weekday */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          title="When customers buy"
          description="Order volume by hour of day (UTC)"
        >
          {loading || !data ? (
            <SkelBar />
          ) : (
            <HourHeatBar data={data.byHour} />
          )}
        </Section>
        <Section
          title="Weekday rhythm"
          description="Order volume across the week"
        >
          {loading || !data ? (
            <SkelBar />
          ) : (
            <WeekdayBars data={data.byWeekday} />
          )}
        </Section>
      </div>

      {/* Top products + top customers */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          title="Top products"
          description="Best sellers by paid revenue"
          actions={data && data.topProducts.length > 0 ? <Badge tone="info">{data.topProducts.length}</Badge> : null}
        >
          {loading || !data ? (
            <SkelBar />
          ) : data.topProducts.length === 0 ? (
            <EmptyChart message="No paid orders with product detail yet." />
          ) : (
            <TopProductsTable products={data.topProducts} />
          )}
        </Section>
        <Section
          title="Top customers"
          description="By total spent (lifetime)"
          actions={data && data.topCustomers.length > 0 ? <Badge tone="info">{data.topCustomers.length}</Badge> : null}
        >
          {loading || !data ? (
            <SkelBar />
          ) : data.topCustomers.length === 0 ? (
            <EmptyChart message="Customer profiles will appear here as conversations grow." />
          ) : (
            <TopCustomersTable customers={data.topCustomers} />
          )}
        </Section>
      </div>

      {/* Delivery + cancellations */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Delivery breakdown" description="Where each order is in fulfilment">
          {loading || !data ? (
            <SkelBar />
          ) : (
            <BarList items={deliveryPalette(data.byDelivery)} formatValue={(n) => n.toLocaleString()} />
          )}
        </Section>
        <Section title="Cancellation reasons" description="Top reasons orders failed or got cancelled">
          {loading || !data ? (
            <SkelBar />
          ) : data.cancellations.length === 0 ? (
            <EmptyChart message="No cancellations in this window. Nice." />
          ) : (
            <BarList
              items={data.cancellations.map((c) => ({
                label: c.reason,
                count: c.count,
                color: "bg-rose-400/80",
              }))}
              formatValue={(n) => n.toLocaleString()}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KPI card with delta arrow                                          */
/* ------------------------------------------------------------------ */

function KpiCard({
  label,
  value,
  delta,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  delta: number | undefined;
  hint?: React.ReactNode;
  icon: typeof Coins;
  tone: "indigo" | "emerald" | "amber" | "rose" | "violet" | "sky";
}) {
  const positive = (delta ?? 0) >= 0;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.04] to-transparent p-4 shadow-card sm:p-5">
      <div
        className={`absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.05] sm:right-4 sm:top-4 sm:h-10 sm:w-10 ${toneIcon(tone)}`}
      >
        <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
      </div>
      <p className="label-caps pr-12">{label}</p>
      <p className="mt-2 break-words font-display text-[1.5rem] font-bold leading-none tabular-figures tracking-display text-white sm:text-[2rem]">
        {value}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:gap-2">
        {delta !== undefined && (
          <span
            className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10.5px] font-semibold tabular-figures ${
              positive
                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                : "border-rose-400/30 bg-rose-500/10 text-rose-300"
            }`}
          >
            {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
        {hint && <span className="text-[10.5px] text-slate-500 sm:text-[11.5px]">{hint}</span>}
      </div>
    </div>
  );
}

function toneIcon(tone: "indigo" | "emerald" | "amber" | "rose" | "violet" | "sky"): string {
  return {
    indigo: "text-indigo-300",
    emerald: "text-emerald-300",
    amber: "text-amber-300",
    rose: "text-rose-300",
    violet: "text-violet-300",
    sky: "text-sky-300",
  }[tone];
}

function formatDelta(d: number): string {
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* ------------------------------------------------------------------ */
/* Trend chart — dual-axis revenue (area) + orders (line)             */
/* ------------------------------------------------------------------ */

function TrendChart({ trend }: { trend: Trend[] }) {
  const W = 800;
  const H = 240;
  const padX = 12;
  const padY = 18;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;

  const maxRev = Math.max(1, ...trend.map((t) => t.revenue));
  const maxOrd = Math.max(1, ...trend.map((t) => t.orders));
  const totalRev = trend.reduce((s, t) => s + t.revenue, 0);
  const totalOrd = trend.reduce((s, t) => s + t.orders, 0);

  const xAt = (i: number) =>
    trend.length === 1 ? padX + innerW / 2 : padX + (innerW * i) / (trend.length - 1);
  const yRev = (v: number) => padY + innerH - (innerH * v) / maxRev;
  const yOrd = (v: number) => padY + innerH - (innerH * v) / maxOrd;

  const revPath = trend.map((t, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yRev(t.revenue)}`).join(" ");
  const revArea = `${revPath} L ${xAt(trend.length - 1)} ${padY + innerH} L ${padX} ${padY + innerH} Z`;
  const ordPath = trend.map((t, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yOrd(t.orders)}`).join(" ");

  // X-axis labels: first, midpoint, last only (keeps it readable)
  const labelIdx = [0, Math.floor(trend.length / 2), trend.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 text-[12px]">
        <Legend color="bg-violet-400" label="Revenue" sub={`৳${totalRev.toLocaleString()}`} />
        <Legend color="bg-sky-400" label="Orders" sub={totalOrd.toLocaleString()} />
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-64 w-full"
        preserveAspectRatio="none"
        aria-label="Revenue and orders trend"
      >
        <defs>
          <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(196,181,253,0.55)" />
            <stop offset="100%" stopColor="rgba(196,181,253,0)" />
          </linearGradient>
        </defs>
        {/* horizontal grid */}
        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1={padX}
            x2={W - padX}
            y1={padY + innerH * p}
            y2={padY + innerH * p}
            stroke="rgba(255,255,255,0.05)"
            strokeWidth={1}
          />
        ))}
        {/* revenue area */}
        <path d={revArea} fill="url(#revFill)" />
        <path d={revPath} fill="none" stroke="rgba(196,181,253,0.95)" strokeWidth={2} />
        {/* orders line */}
        <path d={ordPath} fill="none" stroke="rgba(125,211,252,0.95)" strokeWidth={1.6} strokeDasharray="4 3" />
        {/* dots on orders line */}
        {trend.map((t, i) => (
          <circle key={i} cx={xAt(i)} cy={yOrd(t.orders)} r={1.8} fill="rgba(125,211,252,0.95)" />
        ))}
      </svg>
      <div className="flex justify-between text-[10.5px] font-mono text-slate-500">
        {labelIdx.map((i) => (
          <span key={i}>{formatDate(trend[i]!.date)}</span>
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label, sub }: { color: string; label: string; sub: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span className="text-slate-300">{label}</span>
      <span className="font-mono text-slate-500">{sub}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Funnel                                                             */
/* ------------------------------------------------------------------ */

function Funnel({ funnel }: { funnel: { conversations: number; withOrder: number; paid: number; delivered: number } }) {
  const max = Math.max(funnel.conversations, 1);
  const stages = [
    { label: "Conversations", value: funnel.conversations, tone: "from-sky-500/40 to-sky-500/10" },
    { label: "With order", value: funnel.withOrder, tone: "from-violet-500/40 to-violet-500/10" },
    { label: "Paid", value: funnel.paid, tone: "from-emerald-500/40 to-emerald-500/10" },
    { label: "Delivered", value: funnel.delivered, tone: "from-amber-500/40 to-amber-500/10" },
  ];
  return (
    <div className="space-y-2.5">
      {stages.map((s, i) => {
        const w = Math.max(8, (s.value / max) * 100);
        const conv =
          i === 0
            ? "100%"
            : `${stages[0]!.value > 0 ? Math.round((s.value / stages[0]!.value) * 1000) / 10 : 0}%`;
        return (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35, delay: i * 0.05 }}
            className="grid grid-cols-[1fr_auto] items-center gap-3"
          >
            <div className="relative h-9 overflow-hidden rounded-lg bg-white/[0.025]">
              <div
                className={`h-full rounded-lg bg-gradient-to-r ${s.tone}`}
                style={{ width: `${w}%` }}
              />
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[12px] font-semibold text-white">
                {s.label}
              </span>
            </div>
            <div className="flex items-baseline gap-2 font-mono text-[12px] text-slate-300">
              <span className="font-semibold text-white">{s.value.toLocaleString()}</span>
              <span className="text-slate-500">{conv}</span>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Generic horizontal bar list                                        */
/* ------------------------------------------------------------------ */

type BarItem = { label: string; count: number; color?: string };

function BarList({
  items,
  formatValue,
}: {
  items: BarItem[];
  formatValue: (n: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) {
    return <EmptyChart message="No data in this window." />;
  }
  return (
    <ul className="space-y-2.5">
      {items.map((it, i) => {
        const pct = (it.count / max) * 100;
        return (
          <li key={`${it.label}-${i}`} className="space-y-1">
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="font-medium text-slate-300">{prettyLabel(it.label)}</span>
              <span className="font-mono tabular-figures text-slate-400">
                {formatValue(it.count)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/[0.04]">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.5 }}
                className={`h-full rounded-full ${it.color ?? "bg-indigo-400/80"}`}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function prettyLabel(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

function statusTones(items: Bucket[]): BarItem[] {
  const map: Record<string, string> = {
    DRAFT: "bg-slate-400/80",
    AWAITING_PAYMENT: "bg-amber-400/80",
    PENDING_CLIENT_SYNC: "bg-amber-400/80",
    DELIVERY_SCHEDULED: "bg-sky-400/80",
    COMPLETED: "bg-emerald-400/80",
    DELIVERED: "bg-emerald-400/80",
    CANCELLED: "bg-rose-400/80",
    FAILED: "bg-rose-400/80",
  };
  return items.map((i) => ({ ...i, color: map[i.label] ?? "bg-indigo-400/80" }));
}

function paymentMethodPalette(items: Bucket[]): BarItem[] {
  const map: Record<string, string> = {
    SSLCOMMERZ: "bg-violet-400/80",
    BKASH_MANUAL: "bg-rose-400/80",
    NAGAD_MANUAL: "bg-orange-400/80",
    COD: "bg-amber-400/80",
    CASH: "bg-amber-400/80",
  };
  return items.map((i) => ({ ...i, color: map[i.label] ?? "bg-sky-400/80" }));
}

function deliveryPalette(items: Bucket[]): BarItem[] {
  const map: Record<string, string> = {
    NONE: "bg-slate-400/80",
    BOOKED: "bg-sky-400/80",
    IN_TRANSIT: "bg-violet-400/80",
    DELIVERED: "bg-emerald-400/80",
    RETURNED: "bg-rose-400/80",
    CANCELLED: "bg-rose-400/80",
  };
  return items.map((i) => ({ ...i, color: map[i.label] ?? "bg-indigo-400/80" }));
}

/* ------------------------------------------------------------------ */
/* Hour-of-day heat bar (24 small cells, intensity by count)          */
/* ------------------------------------------------------------------ */

function HourHeatBar({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const peakHour = data.indexOf(Math.max(...data));
  return (
    <div className="space-y-3">
      {/* 12 cells/row on phones, 24-in-a-row on sm+. Tailwind doesn't ship
          `grid-cols-24`, so we fake it with an explicit inline style. */}
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}
      >
        {data.map((c, h) => {
          const intensity = c / max;
          const opacity = c === 0 ? 0.05 : 0.15 + intensity * 0.85;
          return (
            <div
              key={h}
              className="group relative aspect-square rounded-md bg-violet-400 transition-transform hover:scale-110"
              style={{ opacity }}
              title={`${String(h).padStart(2, "0")}:00 — ${c} order${c === 1 ? "" : "s"}`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-slate-500 sm:text-[10.5px]">
        <span>00:00</span>
        <span className="text-violet-300">
          peak {String(peakHour).padStart(2, "0")}:00 · {data[peakHour]} orders
        </span>
        <span>23:00</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Weekday distribution                                               */
/* ------------------------------------------------------------------ */

function WeekdayBars({ data }: { data: number[] }) {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const max = Math.max(1, ...data);
  return (
    <div className="grid grid-cols-7 gap-2 pt-2">
      {data.map((v, i) => {
        const pct = (v / max) * 100;
        return (
          <div key={i} className="flex flex-col items-center">
            <div className="relative flex h-32 w-full items-end overflow-hidden rounded-md bg-white/[0.025]">
              <motion.div
                className="w-full rounded-md bg-gradient-to-t from-violet-500/70 to-violet-300/40"
                initial={{ height: 0 }}
                animate={{ height: `${pct}%` }}
                transition={{ duration: 0.45, delay: i * 0.04 }}
              />
              <span className="absolute inset-x-0 top-1.5 text-center font-mono text-[10px] text-white/80">
                {v}
              </span>
            </div>
            <span className="mt-1 text-[10.5px] font-medium text-slate-400">{labels[i]}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Top products / customers tables                                    */
/* ------------------------------------------------------------------ */

function TopProductsTable({ products }: { products: TopProduct[] }) {
  const max = Math.max(1, ...products.map((p) => p.revenue));
  return (
    <ul className="space-y-2.5">
      {products.map((p, i) => (
        <li
          key={`${p.name}-${i}`}
          className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-violet-500/15 font-mono text-[11px] font-semibold text-violet-200">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-white">{p.name}</p>
                <p className="font-mono text-[10.5px] text-slate-500">
                  {p.quantity} sold · {p.orders} orders
                </p>
              </div>
            </div>
            <span className="font-mono text-[12.5px] font-semibold tabular-figures text-emerald-300">
              ৳{p.revenue.toLocaleString()}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.04]">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(p.revenue / max) * 100}%` }}
              transition={{ duration: 0.5 }}
              className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function TopCustomersTable({ customers }: { customers: TopCustomer[] }) {
  const max = Math.max(1, ...customers.map((c) => c.totalSpentBdt));
  return (
    <ul className="space-y-2.5">
      {customers.map((c, i) => (
        <li
          key={c.psid}
          className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 font-display text-[12px] font-bold text-white">
                {(c.name ?? c.psid).slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-white">
                  {c.name ?? `PSID ${c.psid.slice(0, 10)}…`}
                </p>
                <p className="font-mono text-[10.5px] text-slate-500">
                  {c.totalOrders} orders {c.phone ? `· ${c.phone}` : ""}
                </p>
              </div>
            </div>
            <span className="font-mono text-[12.5px] font-semibold tabular-figures text-emerald-300">
              ৳{c.totalSpentBdt.toLocaleString()}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.04]">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(c.totalSpentBdt / max) * 100}%` }}
              transition={{ duration: 0.5 }}
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-400"
            />
          </div>
          <p className="mt-1 font-mono text-[10px] text-slate-500">
            Last seen {timeAgo(c.lastSeenAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function SkelBar() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="space-y-1.5">
          <div className="h-3 w-32 animate-pulse rounded bg-white/[0.05]" />
          <div className="h-2 w-full animate-pulse rounded-full bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-6 text-[13px] text-slate-400">
      <TrendingDown className="h-4 w-4 text-slate-500" />
      <span>{message}</span>
      <TrendingUp className="ml-auto h-4 w-4 text-slate-500" />
    </div>
  );
}
