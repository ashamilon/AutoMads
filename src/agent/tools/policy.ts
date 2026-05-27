import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { resolveProductAddons } from "../addonResolver.js";
import type { ToolDef } from "../types.js";

const PolicyArgs = z.object({}).strict();

const AddonArgs = z.object({
  /** Optional Banglish/English query to match against label, aliases, description, category. */
  query: z.string().min(1).max(120).optional(),
  /** Optional category filter ("customization", "premium", "shipping", etc.). */
  category: z.string().min(1).max(40).optional(),
  /** Optional sku — when provided, only return add-ons applicable to THIS product. */
  sku: z.string().min(1).max(80).optional(),
});

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/g)
    .filter((t) => t.length >= 2);
}

function addonMatches(
  query: string,
  a: {
    label: string;
    description?: string | undefined;
    aliases?: string[] | undefined;
    category?: string | undefined;
  },
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const qTokens = tokenize(q);
  const blob = [
    a.label,
    a.description ?? "",
    a.category ?? "",
    ...(a.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase();
  if (blob.includes(q)) return true;
  // Token overlap: every query token must appear somewhere.
  return qTokens.length > 0 && qTokens.every((t) => blob.includes(t));
}

export const policyTools: ToolDef[] = [
  {
    name: "get_shop_policies",
    description:
      "Read shop-wide policies and pricing rails the AI must NOT invent: delivery charge, delivery time (normal vs customised), advance payment amount, manual payment numbers (bKash/Nagad), SSLCommerz availability, return policy if the shop set one in settings. Call whenever the customer asks about delivery cost, delivery time / 'kobe pabo' / 'koto din lagbe', advance, payment options, address-related charges, or 'kosto'/'koto'.",
    paramsSchema: PolicyArgs,
    paramsHint: "{}",
    examples: [
      {
        when: "Customer asks 'delivery charge koto?', 'advance koto?', 'bkash kothay pathabo?'",
        call: { tool: "get_shop_policies", args: {} },
      },
    ],
    handler: async (_rawArgs, ctx) => {
      const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.input.tenantId },
        select: { name: true, settings: true },
      });
      const s = parseTenantSettings(tenant?.settings);
      const lines: string[] = [];
      lines.push(`shop=${tenant?.name ?? "shop"}`);
      lines.push(
        s.deliveryChargeBdt != null
          ? `delivery_charge_bdt=${s.deliveryChargeBdt}`
          : "delivery_charge_bdt=not_set",
      );
      // Advance policy disclosure: structured first, legacy fallback second.
      if (s.advancePolicy?.mode === "fixed") {
        lines.push(`advance_policy=fixed advance_fixed_bdt=${s.advancePolicy.fixedAmountBdt}`);
      } else if (s.advancePolicy?.mode === "per_product") {
        const parts: string[] = ["advance_policy=per_product"];
        if (s.advancePolicy.perProductBdt != null)
          parts.push(`advance_per_plain_bdt=${s.advancePolicy.perProductBdt}`);
        if (s.advancePolicy.perCustomisedProductBdt != null)
          parts.push(`advance_per_customised_bdt=${s.advancePolicy.perCustomisedProductBdt}`);
        lines.push(parts.join(" "));
      } else if (typeof s.advancePaymentBdt === "number") {
        lines.push(`advance_policy=legacy_fixed advance_fixed_bdt=${s.advancePaymentBdt}`);
      } else {
        lines.push("advance_policy=not_set");
      }
      const ssl =
        Boolean(s.sslcommerz?.storeId?.trim()) && Boolean(s.sslcommerz?.storePassword?.trim());
      lines.push(`sslcommerz_available=${ssl ? "yes" : "no"}`);
      const m = s.manualPayment;
      if (m?.enabled) {
        lines.push("manual_payment=enabled");
        if (m.bkash?.number?.trim()) lines.push(`bkash_number=${m.bkash.number.trim()}`);
        if (m.nagad?.number?.trim()) lines.push(`nagad_number=${m.nagad.number.trim()}`);
        if (m.instructions?.trim()) lines.push(`manual_instructions=${m.instructions.trim()}`);
      } else {
        lines.push("manual_payment=disabled");
      }
      // Delivery time presets. Format both ranges as "X-Y din" or "X din"
      // so the LLM can quote them verbatim. The customer-facing decision
      // (normal vs customised) is made elsewhere — here we just expose both.
      const dt = s.deliveryTimes;
      const fmtRange = (r: { minDays?: number; maxDays?: number } | undefined): string | null => {
        if (!r) return null;
        const min = r.minDays;
        const max = r.maxDays;
        if (min == null && max == null) return null;
        if (min != null && max != null && min !== max) return `${min}-${max} din`;
        const v = min ?? max;
        return v != null ? `${v} din` : null;
      };
      const normalRange = fmtRange(dt?.normal);
      const customisedRange = fmtRange(dt?.customised);
      if (normalRange) lines.push(`delivery_time_normal=${normalRange}`);
      if (customisedRange) lines.push(`delivery_time_customised=${customisedRange}`);
      if (!normalRange && !customisedRange) lines.push("delivery_time=not_set");
      if (s.businessProfile?.invoiceFooter?.trim()) {
        lines.push(`invoice_footer=${s.businessProfile.invoiceFooter.trim().slice(0, 200)}`);
      }
      return {
        ok: true,
        observation: lines.join(" | "),
        data: {
          deliveryChargeBdt: s.deliveryChargeBdt ?? null,
          advancePolicy: s.advancePolicy ?? null,
          legacyAdvancePaymentBdt: s.advancePaymentBdt ?? null,
          sslcommerzAvailable: ssl,
          manualPayment: m ?? null,
          deliveryTimes: dt ?? null,
        },
      };
    },
  },
  {
    name: "list_addons",
    description:
      "List the add-ons available for a specific product (when `sku` is given) or shop-wide enabled add-ons (when no sku). When `sku` is given, the result respects the per-product `addOnIds` opt-in list and any per-product price overrides — so name+number can be offered on jerseys but hidden on accessories. Pass `query` to filter (matches label, aliases, description, category). ALWAYS pass `sku` if you have one in context — never offer an add-on the product doesn't accept.",
    paramsSchema: AddonArgs,
    paramsHint: '{ "sku"?: string, "query"?: string, "category"?: string }',
    examples: [
      {
        when: "Customer is looking at SKU-arg-away and asks 'name number ache?'",
        call: { tool: "list_addons", args: { sku: "SKU-arg-away", query: "name number" } },
      },
      {
        when: "Customer asks generally 'ki ki add-on ache?'",
        call: { tool: "list_addons", args: {} },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = AddonArgs.parse(rawArgs);
      const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.input.tenantId },
        select: { settings: true },
      });
      const s = parseTenantSettings(tenant?.settings);

      let resolved: Array<{
        id: string;
        label: string;
        priceBdt: number;
        free: boolean;
        description?: string;
        aliases?: string[];
        category?: string;
        imageUrls?: string[];
        overridden?: boolean;
      }> = [];
      let scopeNote = "tenant-wide";

      if (args.sku) {
        const row = await prisma.productMapping.findUnique({
          where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: args.sku } },
        });
        if (!row) {
          return { ok: false, error: "sku_not_found", observation: `sku=${args.sku} not in catalog.` };
        }
        resolved = resolveProductAddons({ productMetadata: row.metadata, tenantSettings: s });
        scopeNote = `for sku=${args.sku}`;
        if (resolved.length === 0) {
          return {
            ok: true,
            observation: `No add-ons configured for sku=${args.sku}. Tell the customer this product doesn't have add-on options.`,
            data: [],
          };
        }
      } else {
        resolved = (s.addOns ?? [])
          .filter((a) => a && a.enabled !== false && a.label?.trim())
          .map((a) => ({
            id: a.id,
            label: a.label,
            priceBdt: a.free === true ? 0 : (a.priceBdt ?? 0),
            free: a.free === true,
            ...(a.description != null ? { description: a.description } : {}),
            ...(a.aliases != null ? { aliases: a.aliases } : {}),
            ...(a.category != null ? { category: a.category } : {}),
            ...(a.imageUrls != null && a.imageUrls.length > 0 ? { imageUrls: a.imageUrls } : {}),
          }));
      }

      const filtered = resolved.filter((a) => {
        if (args.category && a.category?.toLowerCase() !== args.category.toLowerCase()) return false;
        if (args.query) {
          return addonMatches(args.query, {
            label: a.label,
            ...(a.description != null ? { description: a.description } : {}),
            ...(a.aliases != null ? { aliases: a.aliases } : {}),
            ...(a.category != null ? { category: a.category } : {}),
          });
        }
        return true;
      });
      if (filtered.length === 0) {
        return {
          ok: true,
          observation: args.query
            ? `No add-on matches "${args.query}" ${scopeNote}. Tell the customer this add-on isn't offered ${args.sku ? "for this product" : "by the shop"}.`
            : `No enabled add-ons ${scopeNote}.`,
          data: [],
        };
      }
      const summary = filtered
        .map((a) => {
          const price = a.free ? "FREE" : `${a.priceBdt} BDT`;
          const aliases = a.aliases && a.aliases.length > 0 ? ` aliases=[${a.aliases.join(", ")}]` : "";
          const cat = a.category ? ` category=${a.category}` : "";
          const desc = a.description?.trim() ? ` desc=${a.description.trim().slice(0, 120)}` : "";
          const ov = a.overridden ? " (per-product override)" : "";
          const photos =
            a.imageUrls && a.imageUrls.length > 0
              ? ` photos=${a.imageUrls.length} (use send_addon_photos {label:"${a.label}"} to share)`
              : " photos=none";
          return `- ${a.label} (id=${a.id}): ${price}${ov}${cat}${aliases}${desc}${photos}`;
        })
        .join("\n");
      return {
        ok: true,
        observation: `add-ons (${scopeNote}):\n${summary}`,
        data: filtered,
      };
    },
  },
];
