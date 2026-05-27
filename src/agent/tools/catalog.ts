import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { resolveProductAddons } from "../addonResolver.js";
import {
  isGeneric,
  normaliseScore,
  scoreProductRows,
  tokenize,
} from "../productScorer.js";
import { expandQuery } from "../synonyms.js";
import type { ToolDef } from "../types.js";

// `normaliseScore` lives in `../productScorer.js` (task 3.1). Re-exported here
// so the existing `searchCatalogConfidence.test.ts` import path keeps working
// without touching that file. New callers SHOULD import from `productScorer.js`
// or `./resolve.js` directly.
export { normaliseScore };

const SearchArgs = z.object({
  query: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(8).optional().default(5),
});

const GetArgs = z.object({
  sku: z.string().min(1).max(80),
});

type Meta = Record<string, unknown>;

function readMeta(raw: unknown): Meta {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Meta;
  return {};
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type Card = {
  sku: string;
  label: string;
  priceBdt: number | null;
  stock: number | null;
  sizes: string[];
  isActive: boolean;
  /**
   * Per-row TF-IDF score normalised against the top scored row in the same
   * `search_catalog` / `resolve_product_name` call, in `[0, 1]`. The top row carries
   * `confidence_score === 1.0`; weaker alternatives carry strictly lower scores in
   * `(0, 1)`. Consumed downstream by the confidence-gated clarification flow
   * (Req 11.4) and the high-confidence guard on cart mutations (Req 4.5).
   */
  confidence_score: number;
};

function rowToCard(
  row: { clientSku: string; facebookLabel: string | null; metadata: unknown },
  confidence_score = 0,
): Card {
  const meta = readMeta(row.metadata);
  const priceBdt = coerceNumber(meta["price"] ?? meta["unitPriceBdt"]);
  const stock = coerceNumber(meta["stock"]);
  const rawSizes = meta["availableSizes"] ?? meta["sizes"];
  const sizes: string[] = Array.isArray(rawSizes)
    ? rawSizes.map((s) => String(s ?? "").trim()).filter(Boolean)
    : typeof rawSizes === "string"
      ? rawSizes
          .split(/[|,/]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const isActive = meta["isActive"] !== false && meta["is_active"] !== false;
  return {
    sku: row.clientSku,
    label: row.facebookLabel ?? String(meta["name"] ?? row.clientSku),
    priceBdt,
    stock,
    sizes,
    isActive,
    confidence_score,
  };
}

export const catalogTools: ToolDef[] = [
  {
    name: "search_catalog",
    description:
      "Search this shop's product catalog by free text. Returns up to 'limit' best matches as a list with sku, label, price (BDT), stock, sizes. Always call this before quoting any product to the customer.",
    paramsSchema: SearchArgs,
    paramsHint: '{ "query": string, "limit"?: number(1-8) }',
    examples: [
      {
        when: "Customer says 'argentina jersey ache?'",
        call: { tool: "search_catalog", args: { query: "argentina jersey", limit: 5 } },
      },
      {
        when: "Customer says 'real madrid kit dam?'",
        call: { tool: "search_catalog", args: { query: "real madrid kit", limit: 3 } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = SearchArgs.parse(rawArgs);
      const rows = await prisma.productMapping.findMany({
        where: { tenantId: ctx.input.tenantId },
        take: 600,
        orderBy: { clientSku: "asc" },
      });
      if (rows.length === 0) {
        return {
          ok: true,
          observation: `Catalog is empty. Tell the customer to wait — no products configured yet.`,
          data: [],
        };
      }

      // Apply Banglish synonym expansion before scoring so casual phrasings (e.g.
      // `rm jersey`, `arg`, `ji`) match canonical catalog terms. `scoreProductRows`
      // also calls `expandQuery` internally; running it here keeps `qTokens` /
      // `docFreq` derived from the same expanded text the disambiguation guard
      // below uses, and `expandQuery` is idempotent so the inner call is a no-op.
      const expandedQuery = expandQuery(args.query);
      const scored = scoreProductRows(expandedQuery, rows);
      const qTokens = tokenize(expandedQuery);
      // Document frequency is needed for the disambiguation guard below — it
      // checks whether at least one query token is rare enough to disambiguate.
      const docFreq = new Map<string, number>();
      for (const r of rows) {
        const meta = readMeta(r.metadata);
        const blob = `${r.facebookLabel ?? ""} ${String(meta["name"] ?? "")} ${String(meta["tags"] ?? "")} ${String(meta["categoryName"] ?? "")}`.toLowerCase();
        for (const t of new Set(tokenize(blob))) {
          docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        }
      }
      const totalDocs = rows.length;

      // Top score drives normalisation so every Card carries a `confidence_score` in [0, 1]
      // (Req 11.1, 4.4). Top row → 1.0 by construction; weaker rows → strictly lower in (0, 1).
      const topScore = scored.length > 0 ? scored[0]!.score : 0;
      const ranked = scored
        .slice(0, args.limit)
        .map((x) => rowToCard(x.row, normaliseScore(topScore, x.score)));

      const newShown = Array.from(new Set([...ranked.map((r) => r.sku), ...ctx.snapshot.shownSkus])).slice(0, 12);
      // Track the EXACT ordered list shown to the customer in this turn so the next turn
      // can resolve "ei ta nibo" / "1 ta" / "prothom ta" without re-searching.
      const lastShown = ranked.map((r) => ({ sku: r.sku, label: r.label }));
      await ctx.saveSnapshot({ ...ctx.snapshot, shownSkus: newShown, lastShown });

      if (ranked.length === 0) {
        return {
          ok: true,
          observation: `No catalog match for "${args.query}". Tell the customer this product is not in the shop.`,
          data: [],
        };
      }

      // Disambiguation hint: only fire when the customer's query was actually ambiguous —
      // i.e. when the top result does NOT clearly own the distinctive tokens.
      //
      // Conditions that all must hold for "multiple close matches":
      //   - More than one row scored
      //   - Top and runner-up are within 1.0 score points (tight cluster)
      //   - The query had at least one distinctive token
      //   - The TOP row did NOT match strictly more distinctive label tokens than the runner-up.
      //     If "argentina terrace kit" → top has [argentina, terrace] in label, runner-up has
      //     only [argentina], the top's `distinctiveLabelHits` = 2 vs runner-up = 1, so the
      //     top clearly owns the query and we should NOT mark it ambiguous.
      const top = scored[0];
      const second = scored[1];
      const queryDistinctiveCount = qTokens.filter((t) => !isGeneric(t)).length;
      const topOwnsDistinctive =
        Boolean(top) &&
        Boolean(second) &&
        queryDistinctiveCount > 0 &&
        top!.distinctiveLabelHits > second!.distinctiveLabelHits;
      const close = scored
        .slice(0, Math.min(scored.length, 4))
        .filter((x) => (top?.score ?? 0) - x.score < 1.0).length;
      const hasDistinctive = qTokens.some(
        (t) => !isGeneric(t) && (docFreq.get(t) ?? totalDocs) < totalDocs * 0.6,
      );
      const ambiguous = ranked.length > 1 && close >= 2 && hasDistinctive && !topOwnsDistinctive;

      // Load tenant settings ONCE so we can surface a per-row add-on summary
      // alongside the catalog hits. Without this, the LLM only sees the row
      // labels and prices and can hallucinate name+number / customisation
      // when the merchant has it disabled. After this change, every row in
      // the search summary either reads `addons=none` or explicitly lists
      // the resolved add-ons and prices — same source of truth as
      // `get_product_details` and `list_addons`.
      const tenantForAddons = await prisma.tenant
        .findUnique({
          where: { id: ctx.input.tenantId },
          select: { settings: true },
        })
        .catch(() => null);
      const settingsForAddons = parseTenantSettings(tenantForAddons?.settings);

      const summary = ranked
        .map((r, i) => {
          const rowForAddons = rows.find((x) => x.clientSku === r.sku);
          const resolvedAddons = rowForAddons
            ? resolveProductAddons({
                productMetadata: rowForAddons.metadata,
                tenantSettings: settingsForAddons,
              })
            : [];
          const addonsBit =
            resolvedAddons.length === 0
              ? ", addons=none"
              : `, addons=${resolvedAddons
                  .map((a) => `${a.label}${a.free ? "(FREE)" : ` +${a.priceBdt}BDT`}`)
                  .join(",")}`;
          return `${i + 1}. [${r.sku}] ${r.label} — ${
            r.priceBdt != null ? `${r.priceBdt} BDT` : "price n/a"
          }${r.stock != null ? `, stock=${r.stock}` : ""}${
            r.sizes.length ? `, sizes=${r.sizes.join("/")}` : ""
          }${r.isActive ? "" : " (INACTIVE)"}${addonsBit}`;
        })
        .join("\n");

      const observation = ambiguous
        ? `search_catalog hits (multiple close matches — DO NOT assume one; ask the customer to pick by name or reply with the number):\n${summary}`
        : `search_catalog hits:\n${summary}`;

      return { ok: true, observation, data: ranked };
    },
  },
  {
    name: "get_product_details",
    description:
      "Fetch authoritative details (price, stock, sizes, description) for ONE sku. Use after search_catalog when you need to answer a specific product question or before adding to cart.",
    paramsSchema: GetArgs,
    paramsHint: '{ "sku": string }',
    examples: [
      {
        when: "Customer asks 'eta er M size ache?' after search_catalog returned sku SKU-1234",
        call: { tool: "get_product_details", args: { sku: "SKU-1234" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = GetArgs.parse(rawArgs);
      const row = await prisma.productMapping.findUnique({
        where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: args.sku } },
      });
      if (!row) {
        return { ok: false, error: "sku_not_found", observation: `No product with sku=${args.sku} in catalog.` };
      }
      const card = rowToCard(row);
      const meta = readMeta(row.metadata);
      const desc = String(meta["description"] ?? meta["short_description"] ?? "").trim();

      // Resolve which add-ons apply to THIS product (per-product opt-in / overrides).
      const tenant = await prisma.tenant
        .findUnique({ where: { id: ctx.input.tenantId }, select: { settings: true } })
        .catch(() => null);
      const settings = parseTenantSettings(tenant?.settings);
      const productAddOns = resolveProductAddons({ productMetadata: row.metadata, tenantSettings: settings });
      const addonLine =
        productAddOns.length === 0
          ? "addons=none"
          : `addons=${productAddOns.map((a) => `${a.label}${a.free ? "(FREE)" : ` +${a.priceBdt}BDT`}`).join(", ")}`;

      const lines = [
        `sku=${card.sku} label=${card.label}`,
        card.priceBdt != null ? `price=${card.priceBdt} BDT` : "price n/a",
        card.stock != null ? `stock=${card.stock}` : "stock n/a",
        card.sizes.length ? `sizes=${card.sizes.join("/")}` : "sizes n/a",
        card.isActive ? "status=active" : "status=INACTIVE",
        addonLine,
        // Hint to the router that a separate tool exists, so it doesn't loop on get_product_details.
        "size_chart_available_via=get_size_chart",
        desc ? `desc=${desc.slice(0, 300)}` : "",
      ].filter(Boolean);
      return {
        ok: true,
        observation: lines.join(" | "),
        data: { ...card, description: desc, addOns: productAddOns },
      };
    },
  },
];
