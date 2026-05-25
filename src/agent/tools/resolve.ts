/**
 * Tools that resolve customer phrasing to authoritative catalog identifiers.
 *
 * Currently registers `resolve_product_name` (task 3.1). `check_inventory` will
 * land here once task 3.2 is complete.
 *
 * Both this tool and `search_catalog` (in `./catalog.ts`) consume the shared
 * scoring pipeline in `src/agent/productScorer.ts` so a future change to the
 * TF-IDF weights / generic-token list / Banglish expansion lands in one place.
 *
 * `normaliseScore` is also re-exported here so that tests and callers that
 * imported it from `./resolve.js` (e.g. `searchCatalogConfidence.test.ts`) keep
 * compiling without touching their import paths.
 */

import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { normaliseScore, scoreProductRows } from "../productScorer.js";
import { expandQuery } from "../synonyms.js";
import type { ToolDef } from "../types.js";

export { normaliseScore };

const ResolveArgs = z.object({
  query: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(8).optional().default(5),
});

/**
 * Single candidate returned to the agent. `product_id` is the canonical
 * `ProductMapping.id` from Prisma — the agent uses it (alongside `clientSku`,
 * surfaced in the observation) when looking up further details.
 */
type ResolveCandidate = {
  /** Prisma `ProductMapping.id` (cuid). Always references a row in the active tenant catalog. */
  product_id: string;
  /** Customer-facing label — `facebookLabel` if set, else the SKU. */
  product_name: string;
  /** Score in `[0, 1]`, normalised against the top-scored row. Top → 1.0; weaker → strictly lower. */
  confidence_score: number;
  /** SKU exposed so callers can hand it to `get_product_details` / `add_to_cart`. */
  sku: string;
};

export const resolveTools: ToolDef[] = [
  {
    name: "resolve_product_name",
    description:
      "Resolve a customer's free-text product mention (including Banglish / fuzzy phrasings) to candidate products in the active tenant catalog. Returns up to 'limit' candidates ranked by confidence_score in [0,1]. Prefer this over search_catalog when you need a structured product_id with a confidence band — e.g. before any cart mutation.",
    paramsSchema: ResolveArgs,
    paramsHint: '{ "query": string, "limit"?: number(1-8) }',
    examples: [
      {
        when: "Customer says 'rm jersey M' (Banglish: rm = real madrid)",
        call: { tool: "resolve_product_name", args: { query: "rm jersey M", limit: 5 } },
      },
      {
        when: "Customer asks 'argentina terrace kit ache?'",
        call: { tool: "resolve_product_name", args: { query: "argentina terrace kit", limit: 3 } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = ResolveArgs.parse(rawArgs);

      // Pull the active tenant catalog. The Prisma `where: { tenantId }` already
      // enforces Req 4.6 — we only score rows owned by the current tenant, so
      // any `product_id` we return is, by construction, present in the active
      // tenant catalog. The tenant cap of 600 mirrors `search_catalog` for
      // memory safety.
      const rows = await prisma.productMapping.findMany({
        where: { tenantId: ctx.input.tenantId },
        take: 600,
        orderBy: { clientSku: "asc" },
      });
      if (rows.length === 0) {
        return {
          ok: true,
          observation: "Catalog is empty. No products to resolve against.",
          data: [],
        };
      }

      // `scoreProductRows` already runs `expandQuery` internally (idempotent).
      // We expand once here too so the observation echoes the canonicalised
      // query the scorer actually used — useful for debugging Banglish hits.
      const expanded = expandQuery(args.query);
      const scored = scoreProductRows(expanded, rows);

      if (scored.length === 0) {
        return {
          ok: true,
          observation: `resolve_product_name: no candidate matched "${args.query}".`,
          data: [],
        };
      }

      const topScore = scored[0]!.score;

      // Normalise every row's raw score against `topScore` via the shared helper
      // so `resolve_product_name` and `search_catalog` use one definition of
      // `confidence_score` (Req 11.1, 4.4). `scoreProductRows` already filters
      // out zero-score rows, so the top row is guaranteed to land at 1.0 and any
      // single-result case naturally collapses to `normaliseScore(top, top) = 1`.
      const candidates: ResolveCandidate[] = scored.slice(0, args.limit).map((s) => ({
        product_id: s.row.id,
        product_name: s.row.facebookLabel ?? s.row.clientSku,
        confidence_score: normaliseScore(topScore, s.score),
        sku: s.row.clientSku,
      }));

      const summary = candidates
        .map(
          (c, i) =>
            `${i + 1}. [${c.sku}] ${c.product_name} — confidence=${c.confidence_score.toFixed(3)}`,
        )
        .join("\n");

      const observation =
        candidates.length === 1
          ? `resolve_product_name: 1 candidate for "${args.query}" (expanded="${expanded}"):\n${summary}`
          : `resolve_product_name: ${candidates.length} candidates for "${args.query}" (expanded="${expanded}", ranked by confidence):\n${summary}`;

      return { ok: true, observation, data: candidates };
    },
  },
];
