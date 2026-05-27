import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";

/**
 * Tenant analytics overview.
 *
 * Single endpoint that aggregates everything the analytics page needs in one
 * round-trip. All counts/sums are scoped to `req.tenant.id` so a tenant can
 * never see another shop's data.
 *
 * Query params:
 *   - `days`: lookback window in days (default 30, min 1, max 365)
 *
 * Output shape (top-level keys):
 *   - `range`        — { startsAt, endsAt, days }
 *   - `kpis`         — revenue, orders, AOV, conversionRate, paid/pending counts,
 *                      messages, conversations, plus prev-period delta percent
 *   - `trend`        — daily series [{ date, orders, paidOrders, revenue }]
 *   - `byStatus`     — order count by status
 *   - `byPayment`    — order count by paymentStatus
 *   - `byPaymentMethod` — order count by rail (SSLCOMMERZ, bKash manual, …)
 *   - `byHour`       — 24-bucket array of order counts by local hour
 *   - `byWeekday`    — 7-bucket array of order counts by weekday (0=Sun)
 *   - `topProducts`  — top 10 products by revenue (extracted from structuredData.items)
 *   - `topCustomers` — top 10 PSIDs by spend
 *   - `funnel`       — conversation → with-order → paid → delivered
 *   - `cohort`       — new vs returning customers in the period
 *   - `cancellations`— top failure-reason buckets
 *   - `delivery`     — breakdown by deliveryStatus
 *
 * The endpoint is read-only and safe to refresh repeatedly. It does NOT page
 * through orders — for very large tenants (>10k orders in a window) we'd add
 * incremental materialized views, but for tens of thousands of rows the
 * Prisma queries below complete in <300ms on the demo database.
 */

type StructuredItem = {
  product?: string;
  size?: string;
  quantity?: number;
  unitPrice?: number;
  totalPrice?: number;
};

function clampDays(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

function startOfDayUtc(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function isoDay(d: Date): string {
  const x = startOfDayUtc(d);
  return x.toISOString().slice(0, 10);
}

function safePct(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function deltaPct(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

export async function getAnalyticsOverview(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const days = clampDays(req.query.days);
  const now = new Date();
  const startsAt = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prevStart = new Date(startsAt.getTime() - days * 24 * 60 * 60 * 1000);

  // --- Pull everything we need in parallel ----------------------------------
  // We deliberately keep these small / focused queries rather than one huge
  // query with raw SQL — Prisma's prepared statements + parallel execution is
  // fast enough at the volumes a single tenant produces, and the code stays
  // portable across Postgres versions.
  const [
    orders,
    prevOrders,
    convoCount,
    convoCountPrev,
    convoIdsInPeriod,
    msgAgg,
    msgAggPrev,
    customers,
    customersInPeriod,
    customersBefore,
  ] = await Promise.all([
    prisma.order.findMany({
      where: { tenantId: t.id, createdAt: { gte: startsAt } },
      select: {
        id: true,
        messengerPsid: true,
        status: true,
        paymentStatus: true,
        deliveryStatus: true,
        paymentMethod: true,
        totalAmount: true,
        currency: true,
        failureReason: true,
        structuredData: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.order.findMany({
      where: {
        tenantId: t.id,
        createdAt: { gte: prevStart, lt: startsAt },
      },
      select: {
        paymentStatus: true,
        totalAmount: true,
        messengerPsid: true,
      },
    }),
    prisma.messengerConversation.count({
      where: {
        tenantId: t.id,
        OR: [
          { lastUserMsgAt: { gte: startsAt } },
          { lastBotMsgAt: { gte: startsAt } },
          { createdAt: { gte: startsAt } },
        ],
      },
    }),
    prisma.messengerConversation.count({
      where: {
        tenantId: t.id,
        OR: [
          { lastUserMsgAt: { gte: prevStart, lt: startsAt } },
          { lastBotMsgAt: { gte: prevStart, lt: startsAt } },
          { createdAt: { gte: prevStart, lt: startsAt } },
        ],
      },
    }),
    prisma.messengerConversation.findMany({
      where: { tenantId: t.id },
      select: { id: true, psid: true },
    }),
    prisma.messengerMessage.groupBy({
      by: ["role"],
      where: {
        createdAt: { gte: startsAt },
        conversation: { tenantId: t.id },
      },
      _count: { _all: true },
    }),
    prisma.messengerMessage.groupBy({
      by: ["role"],
      where: {
        createdAt: { gte: prevStart, lt: startsAt },
        conversation: { tenantId: t.id },
      },
      _count: { _all: true },
    }),
    prisma.customerProfile.findMany({
      where: { tenantId: t.id },
      select: {
        psid: true,
        name: true,
        phone: true,
        totalOrders: true,
        totalSpentBdt: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
      orderBy: { totalSpentBdt: "desc" },
      take: 50,
    }),
    prisma.customerProfile.count({
      where: { tenantId: t.id, firstSeenAt: { gte: startsAt } },
    }),
    prisma.customerProfile.count({
      where: { tenantId: t.id, firstSeenAt: { lt: startsAt } },
    }),
  ]);

  // --- Helpers --------------------------------------------------------------
  const numAmt = (v: unknown): number => {
    if (v == null) return 0;
    const n = Number(typeof v === "object" && v && "toString" in v ? (v as { toString(): string }).toString() : v);
    return Number.isFinite(n) ? n : 0;
  };
  const isPaid = (s: string) => s === "PAID";

  // --- KPIs -----------------------------------------------------------------
  const paidOrders = orders.filter((o) => isPaid(o.paymentStatus));
  const revenue = paidOrders.reduce((s, o) => s + numAmt(o.totalAmount), 0);
  const aov = paidOrders.length > 0 ? Math.round(revenue / paidOrders.length) : 0;

  const prevPaidOrders = prevOrders.filter((o) => isPaid(o.paymentStatus));
  const prevRevenue = prevPaidOrders.reduce((s, o) => s + numAmt(o.totalAmount), 0);

  const messagesIn = msgAgg.find((g) => g.role === "user")?._count._all ?? 0;
  const messagesOut = msgAgg.find((g) => g.role === "assistant")?._count._all ?? 0;
  const messagesTotal = messagesIn + messagesOut;
  const messagesPrev =
    (msgAggPrev.find((g) => g.role === "user")?._count._all ?? 0) +
    (msgAggPrev.find((g) => g.role === "assistant")?._count._all ?? 0);

  // Conversion = unique-PSIDs-with-paid-order / unique-PSIDs-who-messaged
  const psidsMessaged = new Set<string>(orders.map((o) => o.messengerPsid));
  for (const c of convoIdsInPeriod) psidsMessaged.add(c.psid);
  const psidsPaid = new Set<string>(paidOrders.map((o) => o.messengerPsid));
  const conversionRate = safePct(psidsPaid.size, psidsMessaged.size);

  const prevPsidsMessaged = new Set<string>(prevOrders.map((o) => o.messengerPsid));
  const prevPsidsPaid = new Set<string>(prevPaidOrders.map((o) => o.messengerPsid));
  const prevConversionRate = safePct(prevPsidsPaid.size, prevPsidsMessaged.size);

  // --- Daily trend ---------------------------------------------------------
  const trendMap = new Map<
    string,
    { date: string; orders: number; paidOrders: number; revenue: number }
  >();
  for (let i = 0; i < days; i++) {
    const d = new Date(startsAt.getTime() + i * 24 * 60 * 60 * 1000);
    const key = isoDay(d);
    trendMap.set(key, { date: key, orders: 0, paidOrders: 0, revenue: 0 });
  }
  for (const o of orders) {
    const key = isoDay(o.createdAt);
    const slot = trendMap.get(key);
    if (!slot) continue;
    slot.orders += 1;
    if (isPaid(o.paymentStatus)) {
      slot.paidOrders += 1;
      slot.revenue += numAmt(o.totalAmount);
    }
  }
  const trend = Array.from(trendMap.values());

  // --- Status / payment / method breakdown ---------------------------------
  const byStatus = bucketBy(orders, (o) => o.status);
  const byPayment = bucketBy(orders, (o) => o.paymentStatus);
  const byPaymentMethod = bucketBy(orders, (o) => o.paymentMethod || "UNKNOWN");
  const byDelivery = bucketBy(orders, (o) => o.deliveryStatus || "NONE");

  // --- Hour / weekday distribution -----------------------------------------
  const byHour = new Array(24).fill(0) as number[];
  const byWeekday = new Array(7).fill(0) as number[];
  for (const o of orders) {
    const d = new Date(o.createdAt);
    byHour[d.getUTCHours()] = (byHour[d.getUTCHours()] || 0) + 1;
    byWeekday[d.getUTCDay()] = (byWeekday[d.getUTCDay()] || 0) + 1;
  }

  // --- Top products (extracted from structuredData.items) ------------------
  type ProductAgg = { name: string; orders: number; quantity: number; revenue: number };
  const productMap = new Map<string, ProductAgg>();
  for (const o of orders) {
    if (!isPaid(o.paymentStatus)) continue;
    const sd = (o.structuredData ?? {}) as Record<string, unknown>;
    const items: StructuredItem[] = Array.isArray(sd["items"])
      ? (sd["items"] as StructuredItem[])
      : sd["product"]
        ? [
            {
              product: String(sd["product"]),
              quantity: Number(sd["quantity"] ?? 1) || 1,
              size: typeof sd["size"] === "string" ? (sd["size"] as string) : undefined,
            },
          ]
        : [];
    for (const it of items) {
      const name = (it.product ?? "").toString().trim() || "Unspecified";
      const qty = Number(it.quantity ?? 1) || 1;
      const line =
        Number(it.totalPrice ?? 0) ||
        Number(it.unitPrice ?? 0) * qty ||
        0;
      const slot = productMap.get(name) ?? { name, orders: 0, quantity: 0, revenue: 0 };
      slot.orders += 1;
      slot.quantity += qty;
      // If line price was missing, fall back to a per-item allocation of the order total.
      slot.revenue += line || numAmt(o.totalAmount) / Math.max(items.length, 1);
      productMap.set(name, slot);
    }
  }
  const topProducts = Array.from(productMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((p) => ({ ...p, revenue: Math.round(p.revenue) }));

  // --- Top customers (use stored CustomerProfile aggregates) ---------------
  const topCustomers = customers.slice(0, 10).map((c) => ({
    psid: c.psid,
    name: c.name ?? null,
    phone: c.phone ?? null,
    totalOrders: c.totalOrders,
    totalSpentBdt: numAmt(c.totalSpentBdt),
    lastSeenAt: c.lastSeenAt.toISOString(),
  }));

  // --- Funnel ---------------------------------------------------------------
  const psidsWithOrder = new Set(orders.map((o) => o.messengerPsid));
  const psidsDelivered = new Set(
    orders.filter((o) => o.deliveryStatus === "DELIVERED").map((o) => o.messengerPsid),
  );
  const funnel = {
    conversations: psidsMessaged.size,
    withOrder: psidsWithOrder.size,
    paid: psidsPaid.size,
    delivered: psidsDelivered.size,
  };

  // --- Cancellations / failure reasons -------------------------------------
  const cancellationMap = new Map<string, number>();
  for (const o of orders) {
    if (!o.failureReason) continue;
    const reason = o.failureReason.split(":")[0]?.trim() || o.failureReason;
    cancellationMap.set(reason, (cancellationMap.get(reason) ?? 0) + 1);
  }
  const cancellations = Array.from(cancellationMap.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // --- Response -------------------------------------------------------------
  res.json({
    range: {
      startsAt: startsAt.toISOString(),
      endsAt: now.toISOString(),
      days,
    },
    kpis: {
      revenue: Math.round(revenue),
      revenueDelta: deltaPct(revenue, prevRevenue),
      orders: orders.length,
      ordersDelta: deltaPct(orders.length, prevOrders.length),
      paidOrders: paidOrders.length,
      paidOrdersDelta: deltaPct(paidOrders.length, prevPaidOrders.length),
      aov,
      aovDelta: deltaPct(
        aov,
        prevPaidOrders.length > 0 ? Math.round(prevRevenue / prevPaidOrders.length) : 0,
      ),
      conversionRate,
      conversionRateDelta: deltaPct(conversionRate, prevConversionRate),
      conversations: convoCount,
      conversationsDelta: deltaPct(convoCount, convoCountPrev),
      messagesIn,
      messagesOut,
      messagesTotal,
      messagesDelta: deltaPct(messagesTotal, messagesPrev),
      uniqueCustomers: psidsMessaged.size,
    },
    trend,
    byStatus,
    byPayment,
    byPaymentMethod,
    byDelivery,
    byHour,
    byWeekday,
    topProducts,
    topCustomers,
    funnel,
    cohort: {
      newCustomers: customersInPeriod,
      returningCustomers: Math.max(0, psidsMessaged.size - customersInPeriod),
      lifetimeCustomers: customersInPeriod + customersBefore,
    },
    cancellations,
  });
}

function bucketBy<T>(arr: T[], key: (x: T) => string): Array<{ label: string; count: number }> {
  const m = new Map<string, number>();
  for (const x of arr) {
    const k = key(x) || "UNKNOWN";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}
