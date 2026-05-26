/**
 * Pure pricing helpers shared by the agent and the dashboard.
 *
 * "Compare price + sale window" model:
 *   - `metadata.price`            — the regular sell price (number, BDT).
 *   - `metadata.compareAtPrice`   — optional higher "was" price. Only relevant
 *                                   inside the sale window. When unset or
 *                                   <= price, no discount is shown.
 *   - `metadata.saleStartsAt`     — optional ISO string; when set the offer
 *                                   only kicks in from this moment.
 *   - `metadata.saleEndsAt`       — optional ISO string; when set the offer
 *                                   stops at this moment.
 *
 * If both timestamps are absent but `compareAtPrice > price`, the offer is
 * always-on. If only one timestamp is set, that side is bounded and the
 * other is open-ended.
 *
 * The helper is pure / synchronous — easy to unit-test, safe to call from
 * any tool handler or the React UI without I/O.
 */

export type PricingFacts = {
  /** What the customer pays today. */
  effectivePriceBdt: number | null;
  /** The regular price stamped on the product, regardless of any offer. */
  regularPriceBdt: number | null;
  /** When `true`, the agent should quote the discount and (optionally) a
   *  countdown. UI should render the strike-through + countdown chip. */
  isOnSale: boolean;
  /** Set when on sale AND `saleEndsAt` is in the future. ISO string. */
  endsAt: string | null;
  /** How much the customer saves vs the compareAtPrice. Positive when on sale,
   *  null otherwise. */
  savingsBdt: number | null;
  /** "30%" formatted off; null when not on sale or compare price is missing. */
  savingsPercent: number | null;
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string") {
    const cleaned = v.trim().replace(/,/g, "");
    if (cleaned === "") return null;
    const n = Number(cleaned);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function asDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Resolve the customer-facing pricing for a product right now (or at
 * `nowOverride` for testing). Reads from a metadata blob so the same logic
 * works against both `ProductMapping.metadata` and any cached snapshot.
 */
export function resolveProductPricing(
  meta: Record<string, unknown> | null | undefined,
  nowOverride?: Date,
): PricingFacts {
  const now = (nowOverride ?? new Date()).getTime();
  const m = meta ?? {};

  const regular = asNumber(m["price"] ?? m["unitPriceBdt"]);
  const compareRaw = asNumber(m["compareAtPrice"] ?? m["compare_at_price"] ?? m["regularPrice"]);
  const startsAt = asDate(m["saleStartsAt"] ?? m["sale_starts_at"]);
  const endsAt = asDate(m["saleEndsAt"] ?? m["sale_ends_at"]);

  const inWindow =
    (!startsAt || startsAt.getTime() <= now) && (!endsAt || endsAt.getTime() > now);

  const hasOffer =
    regular != null && compareRaw != null && compareRaw > regular && inWindow;

  if (!hasOffer) {
    return {
      effectivePriceBdt: regular,
      regularPriceBdt: compareRaw != null && compareRaw > (regular ?? 0) ? compareRaw : regular,
      isOnSale: false,
      endsAt: null,
      savingsBdt: null,
      savingsPercent: null,
    };
  }

  const savingsBdt = (compareRaw ?? 0) - (regular ?? 0);
  const savingsPercent = compareRaw && compareRaw > 0 ? Math.round((savingsBdt / compareRaw) * 100) : null;

  return {
    effectivePriceBdt: regular,
    regularPriceBdt: compareRaw,
    isOnSale: true,
    endsAt: endsAt ? endsAt.toISOString() : null,
    savingsBdt,
    savingsPercent,
  };
}

/**
 * Format a Banglish-friendly string for the agent to quote. Examples:
 *
 *   - On sale, with end:    `1450 BDT (regular 1700 BDT — offer ends in 4 hour 12 min)`
 *   - On sale, no end:      `1450 BDT (regular 1700 BDT — limited offer)`
 *   - No sale:              `1450 BDT`
 *   - Unknown:              `confirm kore janabo`
 */
export function formatPricingForReply(
  meta: Record<string, unknown> | null | undefined,
  nowOverride?: Date,
): string {
  const facts = resolveProductPricing(meta, nowOverride);
  if (facts.effectivePriceBdt == null) return "confirm kore janabo";
  if (!facts.isOnSale) return `${facts.effectivePriceBdt} BDT`;
  const endsAt = facts.endsAt ? new Date(facts.endsAt) : null;
  const tail = endsAt
    ? `offer ends in ${formatRemaining(endsAt, nowOverride)}`
    : "limited offer";
  return `${facts.effectivePriceBdt} BDT (regular ${facts.regularPriceBdt} BDT — ${tail})`;
}

/**
 * Format the time remaining as a short Banglish-friendly string. Returns
 * "ended" if the timestamp is in the past.
 */
export function formatRemaining(target: Date, nowOverride?: Date): string {
  const now = (nowOverride ?? new Date()).getTime();
  const diffMs = target.getTime() - now;
  if (diffMs <= 0) return "ended";
  const sec = Math.floor(diffMs / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days >= 1) return `${days} din${hours > 0 ? ` ${hours} hour` : ""}`;
  if (hours >= 1) return `${hours} hour${mins > 0 ? ` ${mins} min` : ""}`;
  return `${mins} min`;
}
