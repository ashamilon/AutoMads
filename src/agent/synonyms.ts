/**
 * Banglish synonym map for the Messenger commerce agent.
 *
 * This module is consumed by:
 *   - `src/agent/tools/resolve.ts` (task 3.1) — for the TF-IDF tokenizer so that
 *     synonym hits (e.g. `rm jersey` → `real madrid jersey`) boost product scoring.
 *   - `src/agent/tools/catalog.ts` (existing `tokenize`) — same tokenizer plug-in.
 *
 * The public surface is intentionally small:
 *   - `BANGLISH_SYNONYMS` — canonical (English) phrase → list of casual / Banglish
 *     variants.
 *   - `expandQuery(q)` — append canonical equivalents of any matched variant to
 *     the query string. Idempotent: calling it twice is a no-op on the second
 *     call, because canonical phrases that are already present (as whole words)
 *     are not appended again.
 *   - `normaliseToken(t)` — single-token normaliser used inside whitespace
 *     tokenisers; it maps a Banglish variant to a single canonical word so the
 *     downstream tokeniser stays one-word-in / one-word-out.
 *
 * Multi-word variants (e.g. "rm jersey", "los blancos", "nam r number") are
 * matched only by `expandQuery`. `normaliseToken` is single-token only — see the
 * comment on that function for the rationale.
 */

/**
 * Internal source-of-truth table.
 *
 * For multi-word canonicals (e.g. "real madrid") we also pick a single
 * `canonicalToken` so that a single-token normaliser can collapse a Banglish
 * variant down to one word usable by a whitespace tokeniser. The choice favours
 * the most distinctive word from the canonical phrase (e.g. "real madrid" →
 * `madrid`, "manchester united" → `united`). For sizes the size code is used
 * (e.g. "extra large" → `xl`) so that catalog variant columns ("XL") still
 * match.
 */
const SYNONYM_DATA: ReadonlyArray<{
  /** Canonical English phrase, lower-case. May be multi-word. */
  canonical: string;
  /**
   * Single canonical word used by `normaliseToken`. For single-word canonicals
   * this equals `canonical`; for multi-word canonicals this is the most
   * distinctive constituent word.
   */
  canonicalToken: string;
  /** Casual / Banglish phrasings that map to `canonical`. Lower-case. */
  variants: ReadonlyArray<string>;
}> = [
  // --- Team / brand name shorthands -----------------------------------------
  { canonical: "real madrid", canonicalToken: "madrid", variants: ["rm", "rm jersey", "madrid", "los blancos"] },
  { canonical: "barcelona", canonicalToken: "barcelona", variants: ["barca", "fcb"] },
  { canonical: "argentina", canonicalToken: "argentina", variants: ["arg", "argentine", "albiceleste"] },
  { canonical: "brazil", canonicalToken: "brazil", variants: ["brasil", "bra"] },
  { canonical: "bangladesh", canonicalToken: "bangladesh", variants: ["bd", "bangla"] },
  { canonical: "manchester united", canonicalToken: "united", variants: ["man u", "mufc", "united"] },
  { canonical: "manchester city", canonicalToken: "city", variants: ["man city", "mcfc"] },
  { canonical: "liverpool", canonicalToken: "liverpool", variants: ["lfc", "the reds"] },

  // --- Product class shorthands ---------------------------------------------
  { canonical: "jersey", canonicalToken: "jersey", variants: ["kit", "tshirt", "tee", "shirt"] },
  { canonical: "boot", canonicalToken: "boot", variants: ["football boot", "soccer boot", "cleat", "studs"] },
  { canonical: "shorts", canonicalToken: "shorts", variants: ["half pant"] },
  { canonical: "tracksuit", canonicalToken: "tracksuit", variants: ["track", "track suit"] },

  // --- Casual yes / no Banglish ---------------------------------------------
  { canonical: "yes", canonicalToken: "yes", variants: ["ji", "ji bhai", "hae", "hyan", "acha", "thik ache"] },
  { canonical: "no", canonicalToken: "no", variants: ["na", "nai", "lagbe na"] },

  // --- Customisation hints --------------------------------------------------
  { canonical: "name and number", canonicalToken: "namenumber", variants: ["nam r number", "nam nambar", "name + number", "nam+number"] },
  { canonical: "official font", canonicalToken: "font", variants: ["premium font"] },
  { canonical: "patch", canonicalToken: "patch", variants: ["patches", "badge"] },

  // --- Size hints -----------------------------------------------------------
  { canonical: "small", canonicalToken: "small", variants: ["s"] },
  { canonical: "medium", canonicalToken: "medium", variants: ["m"] },
  { canonical: "large", canonicalToken: "large", variants: ["l"] },
  { canonical: "extra large", canonicalToken: "xl", variants: ["xl"] },
  { canonical: "double xl", canonicalToken: "xxl", variants: ["xxl"] },
];

/**
 * Public canonical → variant map. Other modules should treat this as read-only;
 * use `expandQuery` / `normaliseToken` for lookup rather than walking it
 * manually.
 *
 * @example
 *   BANGLISH_SYNONYMS["real madrid"]; // ["rm", "rm jersey", "madrid", "los blancos"]
 */
export const BANGLISH_SYNONYMS: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const entry of SYNONYM_DATA) {
    out[entry.canonical] = [...entry.variants];
  }
  return out;
})();

/**
 * Reverse map for `normaliseToken`: variant token (single word, alpha-numeric
 * + Bangla code-points only) → canonical single token.
 *
 * Multi-word variants (any with whitespace or punctuation, e.g. "rm jersey",
 * "los blancos", "name + number") are intentionally NOT registered here — they
 * are only reachable through `expandQuery`'s phrase-level scan.
 */
const VARIANT_TO_CANONICAL_TOKEN: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  const SINGLE_TOKEN_RE = /^[a-z0-9\u0980-\u09ff]+$/;
  for (const entry of SYNONYM_DATA) {
    for (const variant of entry.variants) {
      const lower = variant.toLowerCase();
      if (!SINGLE_TOKEN_RE.test(lower)) continue; // skip multi-word / punctuated
      if (!m.has(lower)) m.set(lower, entry.canonicalToken);
    }
    // Also register the canonicalToken → canonicalToken so `normaliseToken`
    // is idempotent when called on an already-canonical token.
    if (SINGLE_TOKEN_RE.test(entry.canonicalToken) && !m.has(entry.canonicalToken)) {
      m.set(entry.canonicalToken, entry.canonicalToken);
    }
  }
  return m;
})();

/** Escape a literal string for use inside a `RegExp`. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary aware "does this haystack contain `needle`" check.
 *
 * Uses a Unicode-aware token boundary (`[^a-z0-9\u0980-\u09ff]`) so Bangla
 * code-points count as word characters. Avoids JS's ASCII-only `\b`, which
 * would treat Bangla input incorrectly.
 */
function containsAsWords(haystackLower: string, needleLower: string): boolean {
  if (!needleLower) return false;
  const re = new RegExp(
    `(^|[^a-z0-9\\u0980-\\u09ff])${escapeRegex(needleLower)}([^a-z0-9\\u0980-\\u09ff]|$)`
  );
  return re.test(haystackLower);
}

/**
 * Expand a customer query by appending canonical equivalents of any matched
 * Banglish / casual variants. The original query is preserved verbatim at the
 * head so existing tokenisers still see the customer's wording.
 *
 * Idempotent: re-running on an already-expanded string is a no-op because
 * canonicals that are already present (as whole words) are not re-appended.
 *
 * @example
 *   expandQuery("rm jersey M");
 *   // → "rm jersey M real madrid medium"
 *   //   (contains tokens for "real", "madrid", "jersey", "medium")
 *
 * @example
 *   expandQuery("ji bhai dim ache");
 *   // → "ji bhai dim ache yes"
 *
 * @example
 *   // idempotent
 *   const once  = expandQuery("rm jersey M");
 *   const twice = expandQuery(once);
 *   // once === twice
 */
export function expandQuery(q: string): string {
  if (!q) return q;
  const lower = q.toLowerCase();
  const appendices: string[] = [];
  const seen = new Set<string>();

  for (const entry of SYNONYM_DATA) {
    if (seen.has(entry.canonical)) continue;
    // If the canonical phrase is already present, nothing to add.
    if (containsAsWords(lower, entry.canonical)) {
      seen.add(entry.canonical);
      continue;
    }
    for (const variant of entry.variants) {
      if (containsAsWords(lower, variant.toLowerCase())) {
        appendices.push(entry.canonical);
        seen.add(entry.canonical);
        break;
      }
    }
  }

  if (appendices.length === 0) return q;
  return `${q} ${appendices.join(" ")}`;
}

/**
 * Lower-case, strip punctuation, and replace a single token with its canonical
 * form when present in the synonym map.
 *
 * Single-token only by design. Multi-word variants (e.g. "nam r number",
 * "los blancos", "rm jersey") are handled by `expandQuery` — callers that need
 * to normalise such phrases SHOULD split the input on whitespace first and pass
 * each token through `normaliseToken`, accepting that multi-word semantics are
 * lost at the per-token granularity.
 *
 * Rationale for picking a single canonical word per multi-word canonical:
 *   - The downstream catalog tokeniser (`src/agent/tools/catalog.ts::tokenize`)
 *     splits on `[^a-z0-9\u0980-\u09ff]+` and keeps tokens of length ≥ 2.
 *   - A one-word-in / one-word-out contract keeps that tokeniser unchanged.
 *   - Where the canonical phrase has a more distinctive word (e.g. "real
 *     madrid" → `madrid`, "manchester united" → `united`), we map to that word
 *     to maximise recall against catalog rows that mention only the
 *     distinctive part. For sizes ("extra large" → `xl`), the size code is
 *     used because product variant columns store the code, not the phrase.
 *
 * @example
 *   normaliseToken("ji");          // "yes"
 *   normaliseToken("RM");          // "madrid"
 *   normaliseToken("M");           // "medium"
 *   normaliseToken("xl");          // "xl"
 *   normaliseToken("Jersey!");     // "jersey"
 *   normaliseToken("samosa");      // "samosa"   (unmapped, returned cleaned)
 *   normaliseToken("nam r number"); // "namrnumber" (multi-word — undefined; split first)
 */
export function normaliseToken(t: string): string {
  if (!t) return t;
  const cleaned = t.toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]+/g, "");
  if (!cleaned) return cleaned;
  const canonical = VARIANT_TO_CANONICAL_TOKEN.get(cleaned);
  return canonical ?? cleaned;
}
