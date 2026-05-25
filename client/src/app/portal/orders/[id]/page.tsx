"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Section, Tabs } from "@/components/ui/section";
import { apiFetch, apiOpenBlob } from "@/lib/api";
import type { OrderRow } from "@/lib/types";
import { orderStatusTone, paymentTone } from "@/lib/status-styles";
import { format } from "date-fns";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  Loader2,
  MessageCircle,
  Package,
  CreditCard,
  Send,
  ShieldCheck,
  Truck,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type TabId = "overview" | "customer" | "systems" | "raw";

export default function OrderDetailPage() {
  const params = useParams();
  const id = String(params.id ?? "");
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [courier, setCourier] = useState<{
    subtotalBdt: number;
    deliveryChargeBdt: number;
    grandTotalBdt: number;
    advanceRequiredBdt: number;
    advancePaidBdt: number;
    dueBdt: number;
    pathaoTrackingId: string | null;
    pathaoTrackingUrl: string | null;
  } | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [actionMsg, setActionMsg] = useState("");
  const [acting, setActing] = useState(false);
  const [manualRail, setManualRail] = useState<"BKASH_MANUAL" | "NAGAD_MANUAL">("BKASH_MANUAL");
  const [manualReference, setManualReference] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [showPathaoForm, setShowPathaoForm] = useState(false);
  const [pathaoName, setPathaoName] = useState("");
  const [pathaoPhone, setPathaoPhone] = useState("");
  const [pathaoAddress, setPathaoAddress] = useState("");
  const [pathaoItemDesc, setPathaoItemDesc] = useState("");
  const [pathaoQty, setPathaoQty] = useState(1);
  const [pathaoCod, setPathaoCod] = useState(0);
  const [pathaoBooking, setPathaoBooking] = useState(false);

  useEffect(() => {
    apiFetch<{
      order: OrderRow;
      courier?: {
        subtotalBdt: number;
        deliveryChargeBdt: number;
        grandTotalBdt: number;
        advanceRequiredBdt: number;
        advancePaidBdt: number;
        dueBdt: number;
        pathaoTrackingId: string | null;
        pathaoTrackingUrl: string | null;
      };
    }>(`/api/v1/orders/${id}`)
      .then((r) => {
        setOrder(r.order);
        setCourier(r.courier ?? null);
      })
      .catch((e) => setErr(String(e.message ?? e)));
  }, [id]);

  useEffect(() => {
    if (order?.manualTxnId && !manualReference) setManualReference(order.manualTxnId);
    if (order?.paymentMethod === "NAGAD_MANUAL") setManualRail("NAGAD_MANUAL");
    if (order?.paymentMethod === "BKASH_MANUAL") setManualRail("BKASH_MANUAL");
  }, [order, manualReference]);

  function copy(text: string) {
    void navigator.clipboard.writeText(text);
  }

  async function refresh() {
    const r = await apiFetch<{
      order: OrderRow;
      courier?: {
        subtotalBdt: number;
        deliveryChargeBdt: number;
        grandTotalBdt: number;
        advanceRequiredBdt: number;
        advancePaidBdt: number;
        dueBdt: number;
        pathaoTrackingId: string | null;
        pathaoTrackingUrl: string | null;
      };
    }>(`/api/v1/orders/${id}`);
    setOrder(r.order);
    setCourier(r.courier ?? null);
  }

  async function markPaidManually() {
    if (!order) return;
    setActing(true);
    setActionMsg("");
    try {
      await apiFetch<{ ok: boolean }>(`/api/v1/orders/${id}/mark-paid`, {
        method: "POST",
        body: JSON.stringify({
          rail: manualRail,
          reference: manualReference.trim() || undefined,
          note: manualNote.trim() || undefined,
        }),
      });
      await refresh();
      setActionMsg("Order marked paid. Stock + courier pipeline triggered.");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Mark paid failed");
    } finally {
      setActing(false);
    }
  }

  async function cancel() {
    if (!order) return;
    if (!confirm("Cancel this order? Customer will not be auto-notified.")) return;
    setActing(true);
    setActionMsg("");
    try {
      await apiFetch<{ ok: boolean }>(`/api/v1/orders/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "admin_cancel" }),
      });
      await refresh();
      setActionMsg("Order cancelled.");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setActing(false);
    }
  }

  useEffect(() => {
    if (!order || !courier) return;
    const sd = (order.structuredData || {}) as Record<string, unknown>;
    const items = Array.isArray(sd.items) ? sd.items : [];
    setPathaoName((sd.name as string) ?? "");
    setPathaoPhone((sd.phone as string) ?? "");
    setPathaoAddress((sd.address as string) ?? "");
    const qty = items.reduce((s: number, it: any) => s + (it?.quantity ?? 1), 0) || 1;
    setPathaoQty(qty);
    const desc =
      items.length > 0
        ? items
            .slice(0, 3)
            .map((it: any) => `${it.product || "Item"}${it.size ? `(${it.size})` : ""}x${it.quantity || 1}`)
            .join(", ")
        : String(sd.product ?? "Order");
    setPathaoItemDesc(desc);
    setPathaoCod(courier.dueBdt ?? 0);
  }, [order, courier]);

  async function submitPathaoBooking() {
    if (!order) return;
    setPathaoBooking(true);
    setActionMsg("");
    try {
      await apiFetch<{ ok: boolean; consignmentId: string }>(`/api/v1/orders/${id}/book-pathao`, {
        method: "POST",
        body: JSON.stringify({
          recipientName: pathaoName.trim() || undefined,
          recipientPhone: pathaoPhone.trim() || undefined,
          recipientAddress: pathaoAddress.trim() || undefined,
          itemDescription: pathaoItemDesc.trim() || undefined,
          itemQuantity: pathaoQty,
          amountToCollect: pathaoCod,
        }),
      });
      await refresh();
      setShowPathaoForm(false);
      setActionMsg("Pathao courier booked successfully!");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Pathao booking failed");
    } finally {
      setPathaoBooking(false);
    }
  }

  if (err) {
    return (
      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-rose-200">
        <p className="font-medium">{err}</p>
        <Link
          href="/portal/orders"
          className="mt-4 inline-flex items-center gap-2 text-sm text-rose-200/80 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Back to orders
        </Link>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-10 w-10 animate-spin text-accent-bright" />
      </div>
    );
  }

  const sd = (order.structuredData || {}) as Record<string, unknown>;

  const timeline = [
    {
      icon: MessageCircle,
      label: "Conversation captured",
      done: true,
      date: order.createdAt,
    },
    {
      icon: Package,
      label: "Order extracted & synced",
      done: order.status !== "PENDING_CLIENT_SYNC",
      date: order.createdAt,
    },
    {
      icon: CreditCard,
      label: "Payment",
      done: order.paymentStatus === "PAID",
      failed: order.paymentStatus === "FAILED" || order.paymentStatus === "CANCELLED",
      date: null,
    },
    {
      icon: Truck,
      label: "Delivery",
      done: order.deliveryStatus === "DELIVERED",
      failed: order.deliveryStatus === "FAILED" || order.deliveryStatus === "CANCELLED",
      date: null,
    },
  ];

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "customer", label: "Customer" },
    { id: "systems", label: "Systems" },
    { id: "raw", label: "Raw JSON" },
  ];

  return (
    <div className="space-y-6">
      <Link
        href="/portal/orders"
        className="inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-slate-300"
      >
        <ArrowLeft className="h-4 w-4" /> Orders
      </Link>

      <header className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.04] to-transparent p-6 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="label-caps mb-2">Order</p>
            <h1 className="break-all font-mono text-lg font-bold text-white md:text-xl">
              {order.id}
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              Created {format(new Date(order.createdAt), "PPpp")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={orderStatusTone(order.status)}>{order.status}</Badge>
            <Badge tone={paymentTone(order.paymentStatus)}>{order.paymentStatus}</Badge>
            <Badge tone="default">{order.deliveryStatus}</Badge>
          </div>
        </div>
        {order.totalAmount != null && (
          <div className="mt-5 flex items-baseline gap-3 border-t border-white/[0.06] pt-5">
            <span className="label-caps">Amount</span>
            <span className="font-display text-2xl font-bold tabular-figures text-white">
              {order.totalAmount}
            </span>
            <span className="text-sm font-medium text-slate-500">{order.currency}</span>
            <span className="ml-auto text-[11px] uppercase tracking-wider text-slate-500">
              via {order.paymentMethod}
            </span>
          </div>
        )}
        {order.paymentStatus === "PAID" && (
          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <Button
              variant="ghost"
              className="gap-2 text-accent-bright"
              onClick={() => {
                void apiOpenBlob(`/api/v1/orders/${order.id}/invoice`).catch((e: unknown) => {
                  // Surface the failure so the user isn't left guessing.
                  alert(e instanceof Error ? e.message : "Could not open invoice");
                });
              }}
            >
              <Download className="h-4 w-4" /> Download Invoice
            </Button>
          </div>
        )}
      </header>

      {order.paymentStatus !== "PAID" && order.status !== "CANCELLED" && (
        <Section
          title="Manual payment verification"
          description="For personal bKash / Nagad send-money. Enter the customer-supplied TrxID and mark paid — this triggers stock deduction, courier booking and a Messenger confirmation just like an SSLCommerz IPN."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <span className="label-caps mb-1.5 block">Rail</span>
              <select
                value={manualRail}
                onChange={(e) => setManualRail(e.target.value as "BKASH_MANUAL" | "NAGAD_MANUAL")}
                className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
              >
                <option value="BKASH_MANUAL">bKash (manual)</option>
                <option value="NAGAD_MANUAL">Nagad (manual)</option>
              </select>
            </div>
            <div>
              <span className="label-caps mb-1.5 block">Transaction ID</span>
              <input
                value={manualReference}
                onChange={(e) => setManualReference(e.target.value)}
                placeholder="e.g. 8A4G7P9R"
                className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
            <div>
              <span className="label-caps mb-1.5 block">Note (optional)</span>
              <input
                value={manualNote}
                onChange={(e) => setManualNote(e.target.value)}
                placeholder="verified on bKash app"
                className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={markPaidManually} disabled={acting} className="gap-2">
              {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Mark paid &amp; trigger pipeline
            </Button>
            <Button variant="ghost" onClick={cancel} disabled={acting} className="gap-2 text-rose-300">
              <Ban className="h-4 w-4" /> Cancel order
            </Button>
            {order.manualTxnId && (
              <span className="text-xs text-slate-500">
                Customer-submitted TrxID: <span className="font-mono text-slate-300">{order.manualTxnId}</span>
              </span>
            )}
            {actionMsg && <span className="text-xs text-slate-400">{actionMsg}</span>}
          </div>
        </Section>
      )}

      {order.paymentStatus === "PAID" &&
        (order.deliveryStatus === "NONE" || order.deliveryStatus === "PENDING") && (
        <Section
          title="Pathao Courier Booking"
          description={
            order.deliveryStatus === "PENDING"
              ? "This order requires manual courier booking (customized product or manual mode)."
              : "Book delivery for this order via Pathao."
          }
        >
          {!showPathaoForm ? (
            <Button
              onClick={() => setShowPathaoForm(true)}
              className="gap-2"
            >
              <Truck className="h-4 w-4" /> Create Pathao Courier
            </Button>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <span className="label-caps mb-1.5 block">Recipient Name</span>
                  <input
                    value={pathaoName}
                    onChange={(e) => setPathaoName(e.target.value)}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </div>
                <div>
                  <span className="label-caps mb-1.5 block">Recipient Phone</span>
                  <input
                    value={pathaoPhone}
                    onChange={(e) => setPathaoPhone(e.target.value)}
                    placeholder="01XXXXXXXXX"
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </div>
              </div>
              <div>
                <span className="label-caps mb-1.5 block">Recipient Address</span>
                <input
                  value={pathaoAddress}
                  onChange={(e) => setPathaoAddress(e.target.value)}
                  className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <span className="label-caps mb-1.5 block">Item Description</span>
                  <input
                    value={pathaoItemDesc}
                    onChange={(e) => setPathaoItemDesc(e.target.value)}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </div>
                <div>
                  <span className="label-caps mb-1.5 block">Quantity</span>
                  <input
                    type="number"
                    min={1}
                    value={pathaoQty}
                    onChange={(e) => setPathaoQty(Number(e.target.value) || 1)}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </div>
                <div>
                  <span className="label-caps mb-1.5 block">COD Amount (BDT)</span>
                  <input
                    type="number"
                    min={0}
                    value={pathaoCod}
                    onChange={(e) => setPathaoCod(Number(e.target.value) || 0)}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={submitPathaoBooking} disabled={pathaoBooking || !pathaoPhone || !pathaoAddress} className="gap-2">
                  {pathaoBooking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Book Courier
                </Button>
                <Button variant="ghost" onClick={() => setShowPathaoForm(false)} disabled={pathaoBooking}>
                  Cancel
                </Button>
                {actionMsg && <span className="text-xs text-slate-400">{actionMsg}</span>}
              </div>
            </div>
          )}
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Tabs
            tabs={tabs}
            active={tab}
            onChange={(id) => setTab(id as TabId)}
          />

          {tab === "overview" && (
            <Section title="Order items">
              <OrderItemsView sd={sd} />
              <div className="mt-5 space-y-3 border-t border-white/[0.06] pt-4">
                {[
                  ["Customer name", sd.name],
                  ["Phone", sd.phone],
                  ["Address", sd.address],
                ].map(([k, v]) => (
                  <div
                    key={String(k)}
                    className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
                  >
                    <dt className="label-caps">{String(k)}</dt>
                    <dd className="mt-1 break-words text-sm font-medium text-slate-200">
                      {v != null && v !== "" ? String(v) : "—"}
                    </dd>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {tab === "customer" && (
            <Section title="Customer">
              <dl className="space-y-3">
                {[
                  ["Name", sd.name],
                  ["Phone", sd.phone],
                  ["Address", sd.address],
                  ["Messenger PSID", order.messengerPsid],
                ].map(([k, v]) => (
                  <Row
                    key={String(k)}
                    label={String(k)}
                    value={v != null ? String(v) : null}
                    onCopy={copy}
                  />
                ))}
              </dl>
            </Section>
          )}

          {tab === "systems" && (
            <Section title="System references">
              <dl className="space-y-3">
                <Row label="External order ID" value={order.externalOrderId} onCopy={copy} />
                <Row label="SSLCommerz tran_id" value={order.sslcommerzTranId} onCopy={copy} />
                <Row label="Pathao consignment" value={order.pathaoConsignmentId} onCopy={copy} />
                <Row
                  label="Subtotal"
                  value={courier ? `${courier.subtotalBdt.toFixed(2)} BDT` : null}
                  onCopy={copy}
                />
                <Row
                  label="Delivery charge"
                  value={courier ? `${courier.deliveryChargeBdt.toFixed(2)} BDT` : null}
                  onCopy={copy}
                />
                <Row
                  label="Grand total"
                  value={courier ? `${courier.grandTotalBdt.toFixed(2)} BDT` : null}
                  onCopy={copy}
                />
                <Row
                  label="Advance required"
                  value={courier ? `${courier.advanceRequiredBdt.toFixed(2)} BDT` : null}
                  onCopy={copy}
                />
                <Row
                  label="Advance paid"
                  value={courier ? `${courier.advancePaidBdt.toFixed(2)} BDT` : null}
                  onCopy={copy}
                />
                <Row
                  label="Courier due (cash on delivery)"
                  value={courier ? `${courier.dueBdt.toFixed(2)} BDT` : null}
                  onCopy={copy}
                />
                <Row label="Messenger PSID" value={order.messengerPsid} onCopy={copy} />
              </dl>
              {courier?.pathaoTrackingUrl && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <a
                    href={courier.pathaoTrackingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.06]"
                  >
                    Open Pathao tracking
                  </a>
                  {courier.pathaoTrackingId && (
                    <Button
                      variant="ghost"
                      className="h-8 gap-1 px-2 text-xs"
                      onClick={() => copy(courier.pathaoTrackingId!)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy tracking ID
                    </Button>
                  )}
                </div>
              )}
              {order.failureReason && (
                <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
                  <p className="font-semibold">Failure reason</p>
                  <p className="mt-1 text-rose-200/80">{order.failureReason}</p>
                </div>
              )}
            </Section>
          )}

          {tab === "raw" && (
            <Section
              title="Raw structured data"
              actions={
                <Button
                  variant="ghost"
                  className="gap-1 text-xs"
                  onClick={() => copy(JSON.stringify(sd, null, 2))}
                >
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              }
            >
              <pre className="max-h-[28rem] overflow-auto rounded-xl bg-black/40 p-4 font-mono text-xs leading-relaxed text-slate-300">
                {JSON.stringify(sd, null, 2)}
              </pre>
            </Section>
          )}
        </div>

        <Section title="Timeline" className="self-start">
          <ol className="relative space-y-5 pl-6">
            <span className="absolute left-[11px] top-2 bottom-2 w-px bg-white/[0.07]" />
            {timeline.map((step) => {
              const Icon = step.icon;
              const ok = step.done && !step.failed;
              return (
                <li key={step.label} className="relative">
                  <span
                    className={`absolute -left-[26px] grid h-6 w-6 place-items-center rounded-full ring-4 ring-surface-950 ${
                      step.failed
                        ? "bg-rose-500/30 text-rose-200"
                        : ok
                          ? "bg-emerald-500/30 text-emerald-200"
                          : "bg-white/[0.06] text-slate-500"
                    }`}
                  >
                    {step.failed ? (
                      <XCircle className="h-3.5 w-3.5" />
                    ) : ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <Circle className="h-3 w-3" />
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-slate-500" />
                    <p className="text-sm font-medium text-slate-200">{step.label}</p>
                  </div>
                  {step.date && (
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {format(new Date(step.date), "PPpp")}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </Section>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string | null;
  onCopy: (s: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] pb-3 last:border-0 last:pb-0">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="flex max-w-[16rem] items-center gap-2 text-right">
        <span className="truncate font-mono text-xs text-slate-200">{value ?? "—"}</span>
        {value && (
          <button
            type="button"
            onClick={() => onCopy(value)}
            className="text-indigo-400 transition hover:text-indigo-300"
            aria-label="Copy"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
      </dd>
    </div>
  );
}


type OrderItemView = {
  product: string;
  size?: string;
  quantity: number;
  unitPriceBdt?: number;
  unitAddOnBdt?: number;
  addOns: Array<{ id?: string; label?: string; priceBdt?: number; value?: string; free?: boolean }>;
};

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asAddOn(raw: unknown): OrderItemView["addOns"][number] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: OrderItemView["addOns"][number] = {};
  if (typeof r.id === "string") out.id = r.id;
  if (typeof r.label === "string") out.label = r.label;
  if (typeof r.value === "string") out.value = r.value;
  const p = num(r.priceBdt);
  if (p != null) out.priceBdt = p;
  if (r.free === true) out.free = true;
  return out;
}

function readItems(sd: Record<string, unknown>): OrderItemView[] {
  const raw = sd["items"];
  if (Array.isArray(raw) && raw.length > 0) {
    const out: OrderItemView[] = [];
    for (const x of raw) {
      if (!x || typeof x !== "object" || Array.isArray(x)) continue;
      const r = x as Record<string, unknown>;
      const product = String(r.product ?? "Item").trim();
      if (!product) continue;
      const item: OrderItemView = {
        product,
        quantity: num(r.quantity) ?? 1,
        addOns: Array.isArray(r.addOns)
          ? (r.addOns as unknown[]).map(asAddOn).filter((x): x is OrderItemView["addOns"][number] => x != null)
          : [],
      };
      const size = String(r.size ?? "").trim();
      if (size) item.size = size;
      const unit = num(r.unitPriceBdt);
      if (unit != null) item.unitPriceBdt = unit;
      const addOnUnit = num(r.unitAddOnBdt);
      if (addOnUnit != null) item.unitAddOnBdt = addOnUnit;
      out.push(item);
    }
    if (out.length > 0) return out;
  }
  // Single-item legacy fallback.
  const product = String(sd.product ?? "").trim();
  if (!product) return [];
  const single: OrderItemView = {
    product,
    quantity: num(sd.quantity) ?? 1,
    addOns: [],
  };
  const size = String(sd.size ?? "").trim();
  if (size) single.size = size;
  return [single];
}

function OrderItemsView({ sd }: { sd: Record<string, unknown> }) {
  const items = readItems(sd);
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm text-slate-500">
        No item data on this order.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {items.map((it, idx) => {
        const baseUnit = it.unitPriceBdt ?? 0;
        const addOnUnit =
          it.unitAddOnBdt ?? it.addOns.reduce((s, a) => s + (a.priceBdt ?? 0), 0);
        const lineTotal = (baseUnit + addOnUnit) * it.quantity;
        return (
          <li
            key={`${it.product}-${idx}`}
            className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-100">{it.product}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {it.size ? `Size ${it.size} · ` : ""}Qty {it.quantity}
                  {baseUnit > 0 ? ` · ${baseUnit} BDT/unit` : ""}
                </p>
              </div>
              {lineTotal > 0 && (
                <span className="font-display text-sm font-bold tabular-figures text-white">
                  {lineTotal.toLocaleString()} BDT
                </span>
              )}
            </div>
            {it.addOns.length > 0 && (
              <ul className="mt-3 space-y-1.5 border-t border-white/[0.04] pt-3 text-xs text-slate-300">
                {it.addOns.map((a, i) => {
                  const label = a.label ?? a.id ?? "Add-on";
                  const value = a.value ? `: "${a.value}"` : "";
                  const isFree = a.free === true || a.priceBdt === 0;
                  const pricePart = isFree
                    ? "FREE"
                    : a.priceBdt != null
                      ? `+${a.priceBdt} BDT`
                      : "";
                  return (
                    <li key={`${label}-${i}`} className="flex items-baseline justify-between gap-3">
                      <span className="text-slate-300">
                        + {label}
                        {value}
                      </span>
                      {pricePart && (
                        <span className="font-mono text-[11px] text-slate-400">{pricePart}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
