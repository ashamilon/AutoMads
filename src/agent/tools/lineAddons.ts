import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { resolveProductAddons } from "../addonResolver.js";
import { recomputeStructuredCart } from "../state.js";
import type { AgentCartAddOn, ToolDef } from "../types.js";
import { syncLineSlots } from "./missingSlots.js";

function asMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

const Args = z.object({
  sku: z.string().min(1).max(80),
  /** When omitted, this clears all add-ons for the line. */
  addOnIds: z.array(z.string().min(1).max(64)).max(10).optional().default([]),
  /**
   * Optional customer-supplied values keyed by add-on id (e.g. {"name-number": "Limon 10"}).
   * Used for slot-filled add-ons like Name + Number.
   */
  values: z.record(z.string(), z.string().min(1).max(120)).optional(),
});

export const lineAddonTools: ToolDef[] = [
  {
    name: "set_line_addons",
    description:
      "Attach (or clear) add-ons on a cart line. Validates each add-on against the product's resolved add-on list (per-product opt-in + overrides) and rejects unknown ids. Use AFTER add_to_cart, before confirm_order. Pass `values` for slot-filled add-ons (name + number, etc.).",
    paramsSchema: Args,
    paramsHint: '{ "sku": string, "addOnIds": string[], "values"?: { [id]: string } }',
    examples: [
      {
        when: "Customer wants 'name + number' on the Argentina jersey with 'Limon 10'",
        call: {
          tool: "set_line_addons",
          args: { sku: "SKU-arg", addOnIds: ["name-number"], values: { "name-number": "Limon 10" } },
        },
      },
      {
        when: "Customer wants both name+number and official font",
        call: {
          tool: "set_line_addons",
          args: {
            sku: "SKU-arg",
            addOnIds: ["name-number", "official-font"],
            values: { "name-number": "Messi 10" },
          },
        },
      },
      {
        when: "Customer changes their mind: remove all add-ons",
        call: { tool: "set_line_addons", args: { sku: "SKU-arg", addOnIds: [] } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = Args.parse(rawArgs);
      const lineIdx = ctx.snapshot.cart.findIndex((c) => c.sku === args.sku);
      if (lineIdx < 0) {
        return {
          ok: false,
          error: "sku_not_in_cart",
          observation: `sku=${args.sku} not in cart. add_to_cart first, then attach add-ons.`,
        };
      }
      const tenant = await prisma.tenant
        .findUnique({ where: { id: ctx.input.tenantId }, select: { settings: true } })
        .catch(() => null);
      const settings = parseTenantSettings(tenant?.settings);
      const row = await prisma.productMapping.findUnique({
        where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: args.sku } },
      });
      if (!row) {
        return { ok: false, error: "sku_not_found", observation: `sku=${args.sku} not in catalog.` };
      }
      const allowed = resolveProductAddons({ productMetadata: row.metadata, tenantSettings: settings });
      const allowedById = new Map(allowed.map((a) => [a.id, a] as const));

      // Resolve a customer-supplied id (or alias) to an actual product add-on.
      // The router often passes canonical ids like "name-number" or "official-font" while the
      // tenant's add-on registry has auto-generated slugs like "addon-mowxbj8d-c93q". We match
      // on aliases, label tokens, and well-known canonical names so the slot-fill survives.
      function resolveAlias(idOrAlias: string): typeof allowed[number] | null {
        const direct = allowedById.get(idOrAlias);
        if (direct) return direct;
        const needle = idOrAlias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (!needle) return null;
        const wantsNameNumber = /\bname\s*number\b|\bnam\s*number\b|\bname\b\s*\bnumber\b/.test(needle);
        const wantsOfficialFont = /\bofficial\s*font\b|\bpremium\s*font\b/.test(needle);
        const wantsPatch = /\bpatch(?:es)?\b/.test(needle);
        for (const a of allowed) {
          const blob = `${a.label} ${(a.aliases ?? []).join(" ")}`.toLowerCase();
          if (wantsNameNumber && /\b(name\s*\+?\s*number|nam\s*\+?\s*number|name\s*number|nam\s*number)\b/.test(blob))
            return a;
          if (wantsOfficialFont && /\b(official\s*font|premium\s*font)\b/.test(blob)) return a;
          if (wantsPatch && /\bpatch/.test(blob)) return a;
          // Token overlap fallback: any meaningful query token appears in label/alias.
          const tokens = needle.split(/\s+/).filter((t) => t.length >= 3);
          if (tokens.length > 0 && tokens.every((t) => blob.includes(t))) return a;
        }
        return null;
      }

      const resolved: AgentCartAddOn[] = [];
      const rejected: string[] = [];
      for (const id of args.addOnIds) {
        const def = resolveAlias(id);
        if (!def) {
          rejected.push(id);
          continue;
        }
        const ao: AgentCartAddOn = { id: def.id, label: def.label, priceBdt: def.priceBdt };
        // Look up the value either by the original requested id, by the resolved id, or by
        // any of the def's aliases. Customers may have given the value under "name-number" while
        // the actual id is "addon-…".
        const valueKeys = [id, def.id, ...(def.aliases ?? [])];
        let value: string | undefined;
        for (const k of valueKeys) {
          const v = args.values?.[k]?.trim();
          if (v) {
            value = v;
            break;
          }
        }
        if (value) ao.value = value;
        resolved.push(ao);
      }

      if (rejected.length > 0) {
        return {
          ok: false,
          error: "addon_not_allowed",
          observation:
            `Add-on(s) not available for sku=${args.sku}: ${rejected.join(", ")}. ` +
            `Allowed: ${allowed.map((a) => a.id).join(", ") || "(none)"}.`,
        };
      }

      const next = ctx.snapshot.cart.slice();
      const cur = next[lineIdx]!;
      const updated = { ...cur };
      if (resolved.length > 0) updated.addOns = resolved;
      else delete updated.addOns;
      next[lineIdx] = updated;
      // Sync per-line slots: if the customer just supplied a value for a slot-filled
      // add-on (e.g. name+number = "Limon 10"), `syncLineSlots` removes the slot from
      // `missing_information` and writes the value into `confirmed_information[line_id]`.
      // If they ATTACHED a slot-filled add-on without supplying a value, the slot is
      // newly tracked in `missing_information`.
      const meta = asMeta(row.metadata);
      const next2 = syncLineSlots({ ...ctx.snapshot, cart: next }, cur.line_id, meta);
      // Refresh structured-cart totals so add-on price changes update subtotal/line_total
      // (Req §2.3, §2.5). Add-on prices fold into `line_total = (unitPrice + sum(addOn)) * qty`.
      const withTotals = recomputeStructuredCart(next2);
      await ctx.saveSnapshot(withTotals);

      const summary =
        resolved.length === 0
          ? "(no add-ons)"
          : resolved
              .map(
                (a) =>
                  `${a.label}${a.priceBdt === 0 ? " (FREE)" : ` +${a.priceBdt} BDT`}${
                    a.value ? ` value="${a.value}"` : ""
                  }`,
              )
              .join(", ");
      return {
        ok: true,
        observation: `Line ${args.sku} add-ons updated: ${summary}.`,
      };
    },
  },
];
