"use client";

/**
 * Shared status pills for the admin tenants list and detail pages.
 *
 * Lives in a non-page file because Next.js App Router rejects extra named
 * exports from `page.tsx` files (only `default`, `metadata`, and a fixed
 * allow-list of route-config names are permitted). Co-locating these
 * primitives next to the tenants pages keeps the import path short
 * while satisfying the type-checker.
 */

export function SubscriptionStatusPill({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
        none
      </span>
    );
  }
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
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}
    >
      {status}
    </span>
  );
}

export function PaymentPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-slate-500">—</span>;
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
