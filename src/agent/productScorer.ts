/**
 * Shared TF-IDF scoring pipeline used by `search_catalog` (in
 * `src/agent/tools/catalog.ts`) and `resolve_product_name` (in
 * `src/agent/tools/resolve.ts`). Lifted here so both tools score rows the same
 * way and a future tweak (e.g. weight changes, generic-word list updates) only
 * needs to land in one place.
 *
 * The pipeline is deterministic and synchronous:
 *
 *   1. `expandQuery` from `./synonyms.js` runs once at the top of `scoreProductRows`
 *      so Banglish / casual variants (e.g. `rm jersey`, `ji`, `arg`) score against
 *      their canonical English equivalents (e.g. `real madrid`, `yes`, `argentina`).
 *      Running it once on the query (rather than inside `tokenize`) keeps the
 *      tokeniser cheap and ensures we don't re-expand each row's blob on every
 *      call.
 *   2. `tokenize` splits on Unicode-aware boundaries and keeps tokens ≥ 2 chars.
 *   3. `buildDocumentBlobs` turns each catalog row's label + metadata into a token
 *      set keyed by `clientSku`.
 *   4. `scoreRow` weighs phrase/bigram bonuses, IDF-weighted token overlap with a
 *      label-position multiplier, distinctive-coverage bonus, and a no-distinctive
 *      penalty.
 *   5. `normaliseScore` maps a row's raw score onto `[0, 1]` against the top score
 *      so every consumer can expose a `confidence_score` without recomputing the
 *      normalisation rule.
 *
 * Public surface:
 *   - `tokenize`, `GENERIC_TOKENS`, `isGeneric`, `buildDocumentBlobs`, `scoreRow`
 *     for callers that need the low-level helpers.
 *   - `scoreProductRows(query, rows)` runs the whole pipeline against a list of
 *     `ProductMapping`-shaped rows and returns the rows sorted by score descending,
 *     filtered to non-zero scores.
 *   - `normaliseScore(top, score)` clamps `score / max(top, ε)` to `[0, 1]`.
 */

import { expandQuery } from "./synonyms.js";

/**
 * Minimal row shape the scorer needs. Matches the columns we read from
 * `prisma.productMapping` so callers can hand us raw query results without
 * remapping.
 */
export type ProductRow = {
  clientSku: string;
  facebookLabel: string | null;
  metadata: unknown;
};

/**
 * One scored row, returned by `scoreProductRows` sorted by `score` descending.
 *
 * The `R` type parameter is the caller's row shape — typically
 * `prisma.productMapping`'s output, which has more fields (e.g. `id`,
 * `tenantId`) than the minimal `ProductRow` contract. Threading it through
 * means callers can read those extra fields off `row` without a cast.
 *
 * - `row` is the original input row, unchanged.
 * - `score` is the raw TF-IDF-style score from `scoreRow` (always > 0 in the
 *   returned array — zero-score rows are filtered out).
 * - `distinctiveLabelHits` is how many distinctive (non-generic) query tokens
 *   appeared in the row's label. `search_catalog` uses this to decide whether
 *   the top row clearly owns the query.
 */
export type ScoredRow<R extends ProductRow = ProductRow> = {
  row: R;
  score: number;
  distinctiveLabelHits: number;
};

function readMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * Lower-case, Unicode-aware token split. Keeps tokens ≥ 2 characters so noise
 * particles (`a`, `e`, single Bangla letters) don't blow up the IDF.
 *
 * Note: this tokeniser does NOT call `expandQuery`. Synonym expansion is done
 * once in `scoreProductRows` against the raw query string so we don't pay for
 * it on every row's blob.
 */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/g)
    .filter((t) => t.length >= 2);
}

/**
 * Words that don't help disambiguate. They still count for overlap (capped at a
 * tiny weight), but never as a "distinctive" hit. If a query contains ONLY
 * generic words, scoring falls back to plain overlap.
 */
export const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "jersey",
  "kit",
  "shirt",
  "tshirt",
  "tee",
  "football",
  "soccer",
  "team",
  "the",
  "a",
  "an",
  "ache",
  "lagbe",
  "chai",
  "dorkar",
  "nibo",
  "nite",
  "buy",
  "give",
  "show",
  "dekhao",
  "dekhan",
  "available",
  "stock",
  "size",
  "version",
]);

export function isGeneric(t: string): boolean {
  return GENERIC_TOKENS.has(t);
}

/**
 * Build the per-row token blob (label + metadata name + tags + categoryName).
 * The blob is what `scoreRow` matches against; `rowLabel` is passed separately
 * so phrase / bigram bonuses can prefer matches that hit the customer-facing
 * label (rather than buried metadata).
 */
export function buildDocumentBlobs<R extends ProductRow>(rows: R[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const meta = readMeta(r.metadata);
    const blob = `${r.facebookLabel ?? ""} ${String(meta["name"] ?? "")} ${String(meta["tags"] ?? "")} ${String(meta["categoryName"] ?? "")}`.toLowerCase();
    out.set(r.clientSku, new Set(tokenize(blob)));
  }
  return out;
}

/**
 * Score a single row against the query.
 *
 * - Exact (or near-exact) phrase appearance in the label/blob → strong bonus.
 * - Each query token contributes a weight = log(N / docFreq) — rare tokens beat
 *   generic ones. Distinctive tokens (terrace, retro, gk, sleeve, away…) score
 *   way higher than common tokens like "argentina".
 * - Generic tokens still count, but at a flat 0.4× weight cap.
 * - "Whole label contains query tokens in order" (phrase-ish) → additional bonus.
 */
export function scoreRow(args: {
  query: string;
  qTokens: string[];
  rowBlob: Set<string>;
  rowLabel: string;
  docFreq: Map<string, number>;
  totalDocs: number;
}): { score: number; distinctiveLabelHits: number } {
  const { query, qTokens, rowBlob, rowLabel, docFreq, totalDocs } = args;
  if (qTokens.length === 0) return { score: 0, distinctiveLabelHits: 0 };
  const labelLower = rowLabel.toLowerCase();
  const queryLower = query.toLowerCase().trim();

  // 1. Phrase / substring bonus — strongest signal.
  let phraseBonus = 0;
  if (queryLower.length >= 4 && labelLower.includes(queryLower)) phraseBonus += 4;

  // Multi-word phrase fragments (sliding 2-grams) — partial phrase still helps.
  const distinctiveQ = qTokens.filter((t) => !isGeneric(t));
  for (let i = 0; i < distinctiveQ.length - 1; i++) {
    const bigram = `${distinctiveQ[i]} ${distinctiveQ[i + 1]}`;
    if (labelLower.includes(bigram)) phraseBonus += 1.2;
  }

  // 2. Per-token weighted overlap. Distinctive tokens that appear in the LABEL
  //    specifically (not just metadata blob) get an extra multiplier.
  let overlap = 0;
  let matchedDistinctive = 0;
  let matchedDistinctiveInLabel = 0;
  for (const t of qTokens) {
    if (!rowBlob.has(t)) continue;
    const df = docFreq.get(t) ?? 1;
    const idf = Math.max(0.05, Math.log((totalDocs + 1) / (df + 0.5)));
    const inLabel = labelLower.includes(t);
    const weight = isGeneric(t) ? Math.min(idf, 0.4) : idf;
    const labelMul = !isGeneric(t) && inLabel ? 1.8 : 1;
    overlap += weight * labelMul;
    if (!isGeneric(t)) {
      matchedDistinctive += 1;
      if (inLabel) matchedDistinctiveInLabel += 1;
    }
  }

  // 3. Coverage bonus only counts DISTINCTIVE matches in the label.
  const coverage = distinctiveQ.length > 0 ? matchedDistinctiveInLabel / distinctiveQ.length : 0;

  // 4. Penalty: query had distinctive tokens, this row matched none of them.
  const distinctivePenalty =
    distinctiveQ.length > 0 && matchedDistinctive === 0 ? -1.5 : 0;

  return {
    score: phraseBonus + overlap + coverage * 0.6 + distinctivePenalty,
    distinctiveLabelHits: matchedDistinctiveInLabel,
  };
}

/**
 * Run the full scoring pipeline against a list of `ProductMapping`-shaped rows.
 *
 * Steps:
 *   1. Apply `expandQuery` (Banglish synonym expansion) to the raw query so
 *      `rm jersey` / `arg jersey` etc. score against `real madrid` / `argentina`.
 *   2. Tokenise the expanded query.
 *   3. Build per-row blobs and the document-frequency map.
 *   4. Score every row, drop zero-score rows, sort by score descending.
 *
 * Returns `[]` when `rows` is empty or no row scored above zero. The caller is
 * responsible for slicing to `limit`, normalising scores via `normaliseScore`,
 * and projecting rows into whatever output shape its tool exposes.
 */
export function scoreProductRows<R extends ProductRow>(query: string, rows: R[]): ScoredRow<R>[] {
  if (rows.length === 0) return [];
  // Apply Banglish synonym expansion once at the top so every downstream step
  // sees the canonicalised query. `expandQuery` is idempotent so re-expansion
  // by callers that pre-expand is safe.
  const expanded = expandQuery(query);
  const qTokens = tokenize(expanded);
  if (qTokens.length === 0) return [];

  const blobsBySku = buildDocumentBlobs(rows);

  // Document frequency for IDF.
  const docFreq = new Map<string, number>();
  for (const tokens of blobsBySku.values()) {
    for (const t of tokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const totalDocs = rows.length;

  const scored: ScoredRow<R>[] = [];
  for (const r of rows) {
    const result = scoreRow({
      query: expanded,
      qTokens,
      rowBlob: blobsBySku.get(r.clientSku) ?? new Set<string>(),
      rowLabel: r.facebookLabel ?? r.clientSku,
      docFreq,
      totalDocs,
    });
    if (result.score > 0) {
      scored.push({ row: r, score: result.score, distinctiveLabelHits: result.distinctiveLabelHits });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Normalise a per-row score against the top score so consumers can expose a
 * `confidence_score` in the closed interval `[0, 1]` (Requirements §11.1, §4.4).
 *
 * Definition: `score / max(top, 1e-6)` clamped to `[0, 1]`. The 1e-6 floor
 * avoids divide-by-zero when the entire scored set is empty or all scores are 0;
 * in that case the helper returns `0` for any non-positive `score`. The clamp at
 * `1` defends against callers that pass a score larger than `top`.
 *
 * The top row will always have `confidence_score === 1.0` because `score === top`.
 */
export function normaliseScore(top: number, score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  const denom = Math.max(top, 1e-6);
  const ratio = score / denom;
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 1) return 1;
  return ratio;
}
