import { parseTenantSettings } from "../types/tenant-settings.js";

export type CartLineForAdvance = {
  quantity: number;
  /** Lines with at least one add-on count as "customised" for per_product advance pricing. */
  addOns?: Array<unknown>;
};

export type AdvanceBreakdownLine = {
  kind: "fixed" | "plain" | "customised";
  qty: number;
  unitBdt: number;
  subtotalBdt: number;
};

export type ResolvedAdvance = {
  totalBdt: number;
  /** Human-readable breakdown lines for the agent observation / merchant audit. */
  breakdown: AdvanceBreakdownLine[];
  policyDescription: string;
};

/**
 * Compute the advance amount payable now for a given cart, given tenant advance policy.
 * Returns 0 + an empty breakdown when no policy is configured (caller may fall back to subtotal).
 */
export function computeAdvanceForCart(args: {
  tenantSettings: ReturnType<typeof parseTenantSettings>;
  cart: CartLineForAdvance[];
}): ResolvedAdvance {
  const policy = args.tenantSettings.advancePolicy;
  const legacyFixed = args.tenantSettings.advancePaymentBdt;

  if (policy?.mode === "fixed") {
    return {
      totalBdt: Math.max(0, policy.fixedAmountBdt),
      breakdown: [
        {
          kind: "fixed",
          qty: 1,
          unitBdt: policy.fixedAmountBdt,
          subtotalBdt: policy.fixedAmountBdt,
        },
      ],
      policyDescription: `fixed: ${policy.fixedAmountBdt} BDT per order`,
    };
  }

  if (policy?.mode === "per_product") {
    const perPlain = policy.perProductBdt ?? 0;
    const perCust = policy.perCustomisedProductBdt ?? 0;
    let plainQty = 0;
    let custQty = 0;
    for (const line of args.cart) {
      const q = Math.max(1, Math.floor(Number(line.quantity) || 1));
      const isCustomised = Array.isArray(line.addOns) && line.addOns.length > 0;
      if (isCustomised) custQty += q;
      else plainQty += q;
    }
    const breakdown: AdvanceBreakdownLine[] = [];
    if (plainQty > 0 && perPlain > 0) {
      breakdown.push({ kind: "plain", qty: plainQty, unitBdt: perPlain, subtotalBdt: perPlain * plainQty });
    }
    if (custQty > 0 && perCust > 0) {
      breakdown.push({
        kind: "customised",
        qty: custQty,
        unitBdt: perCust,
        subtotalBdt: perCust * custQty,
      });
    }
    const totalBdt = breakdown.reduce((s, b) => s + b.subtotalBdt, 0);
    const parts: string[] = [];
    if (perPlain > 0) parts.push(`${perPlain} BDT × per plain product`);
    if (perCust > 0) parts.push(`${perCust} BDT × per customised product`);
    return {
      totalBdt,
      breakdown,
      policyDescription: `per_product: ${parts.join(" + ") || "(no rates set)"}`,
    };
  }

  // No structured policy — fall back to legacy fixed amount if set.
  if (typeof legacyFixed === "number") {
    return {
      totalBdt: Math.max(0, legacyFixed),
      breakdown: [
        { kind: "fixed", qty: 1, unitBdt: legacyFixed, subtotalBdt: legacyFixed },
      ],
      policyDescription: `legacy_fixed: ${legacyFixed} BDT per order`,
    };
  }

  return { totalBdt: 0, breakdown: [], policyDescription: "no advance policy" };
}
