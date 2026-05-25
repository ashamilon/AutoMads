/**
 * Deterministic Reference_Resolution module (Requirements §9.1–§9.6, Task 4.1).
 *
 * Resolves customer pronouns, ordinal references, color/attribute hints, and product
 * codes — `prothom ta`, `1 ta`, `first one`, `second ta`, `3rd one`, `the red one`,
 * `make the boot size 42`, `WC26 ta`, etc. — to a specific cart `line_id` or catalog
 * `product_id` from the current `AgentSnapshot`.
 *
 * The implementation is intentionally deterministic TypeScript with NO LLM call
 * (Req 9.1) and NO Prisma / I/O — pure function. The loop is the only writer to
 * `recent_references`; this module only emits an `onResolve` callback.
 *
 * **Lookup priority** (first match wins; later branches do not run):
 *   1. `lastShown` ordinal — `prothom ta`, `1 ta`, `first one`, `2`, `second ta`,
 *      `3rd one`. Banglish ordinals: prothom=1, ditiyo=2, tritiyo=3, chaturtho=4,
 *      ponchom=5. Returns `{ kind: "product", product_id: lastShown[idx].sku,
 *      confidence_score: 1.0 }`.
 *   2. Cart ordinal — same patterns, but addressed against `snapshot.cart`. Returns
 *      `{ kind: "line", line_id: cart[idx].line_id, confidence_score: 1.0 }`.
 *   3. Cart attribute match — `make the boot size 42` matches cart line whose
 *      `product` contains `boot` (case-insensitive); `the red one` matches color
 *      tokens (red/blue/black/white/green/yellow/etc.) against `addOns[*].value`
 *      and `product`. Returns `{ kind: "line", confidence_score: 0.85 }` when
 *      exactly one line matches; `0.5` when ambiguous (multiple matches).
 *   4. Product code match in `lastShown[*].label` — `WC26 ta` resolves to the
 *      lastShown row whose label contains `WC26` (case-insensitive). Returns
 *      `{ kind: "product", confidence_score: 1.0 }`.
 *   5. Fuzzy match against cart `product` names — token-overlap score per line.
 *      Returns `{ kind: "line", confidence_score: <score> }` ONLY when the top
 *      match score is `>= 0.8` AND beats the runner-up by `>= 0.1`.
 *
 * Returns `{ kind: "none", confidence_score: 0 }` if nothing matches.
 *
 * The `debug` field on every result is a short string explaining which branch
 * fired and the relevant scores — useful for `AgentTrace` rows and unit tests.
 */

import type { AgentRecentReference, AgentSnapshot } from "./types.js";

/**
 * Outcome of a single resolution attempt. `kind === "none"` means the resolver could
 * not match the phrase to any in-snapshot target above the floor confidence.
 *
 * Per task 4.1, the `debug` field is a free-form short string summarising which
 * priority branch fired, useful for `AgentTrace` audits and test assertions.
 */
export type ReferenceResolution =
  | {
      kind: "line";
      line_id: string;
      confidence_score: number;
      /** Free-form trace describing which priority branch fired and why. */
      debug: string;
    }
  | {
      kind: "product";
      product_id: string;
      confidence_score: number;
      debug: string;
    }
  | {
      kind: "none";
      confidence_score: 0;
      debug: string;
    };

/**
 * Optional callbacks the resolver invokes during a resolution. Kept as a separate
 * parameter object so the resolver itself stays pure (no snapshot mutation, no DB I/O):
 * the LOOP is the only writer of `snapshot.recent_references` per Req 9.6.
 *
 * - `onResolve`: fired exactly once at the end of a successful resolution
 *   (`kind !== "none"`). The loop wires this to `appendRecentReference` and persists
 *   the resulting snapshot. Implementations should be cheap and synchronous.
 */
export type ResolveReferenceOptions = {
  onResolve?: (ref: AgentRecentReference) => void;
};

// ---------------------------------------------------------------------------
// Ordinal extraction helpers
// ---------------------------------------------------------------------------

/**
 * Banglish + English ordinal-WORD lookup. Each key is a single lowercased token
 * the message may contain; the value is the 1-based ordinal it maps to.
 *
 * Banglish: prothom=1, ditiyo=2 (also dvitiyo), tritiyo=3, chaturtho=4, ponchom=5.
 * English: first..tenth.
 */
const ORDINAL_WORDS: Readonly<Record<string, number>> = Object.freeze({
  prothom: 1,
  prothomta: 1,
  first: 1,
  ditiyo: 2,
  dvitiyo: 2,
  ditiyota: 2,
  second: 2,
  tritiyo: 3,
  tritiyota: 3,
  third: 3,
  chaturtho: 4,
  chaturthota: 4,
  fourth: 4,
  ponchom: 5,
  ponchomta: 5,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
});

/**
 * Regex matching `1st`, `2nd`, `3rd`, `4th`, etc. Capture group 1 is the digit.
 * Exported for tests so the boundary cases stay pinned.
 */
export const ORDINAL_SUFFIX_RE = /\b(\d{1,2})(?:st|nd|rd|th)\b/i;

/**
 * Regex matching `N ta` / `N na` / `N no` / `N number` / `N item` / `N one` /
 * `N product` — the Banglish "Nth" indicator. Capture group 1 is the digit.
 * Exported for tests.
 */
export const ORDINAL_BANGLISH_RE = /\b(\d{1,2})\s+(?:ta|na|no|number|item|one|product)\b/i;

/**
 * Tokens that, when they appear immediately BEFORE a bare digit, signal that the
 * digit is an attribute value (size, quantity, price, count) — NOT an ordinal.
 * Used by `extractOrdinalIndex` to avoid misreading `size 42` as the 42nd item.
 */
const ATTRIBUTE_PRECEDERS: ReadonlySet<string> = new Set([
  "size",
  "qty",
  "quantity",
  "amount",
  "price",
  "tk",
  "taka",
  "bdt",
  "tk.",
  "rs",
  "rs.",
  "age",
  "year",
  "years",
]);

/**
 * Extract a 1-based ordinal index from a customer message, or return `null` if
 * no ordinal indicator is present.
 *
 * Strategy (first match wins):
 *   1. ORDINAL_WORDS — single-word ordinals (`prothom`, `first`, `second`, ...).
 *   2. ORDINAL_SUFFIX_RE — `1st`, `2nd`, `3rd`, `4th`.
 *   3. ORDINAL_BANGLISH_RE — `1 ta`, `2 number`, `3 one`, etc.
 *   4. Bare digit — ONLY when not preceded by an attribute word (size/qty/price)
 *      and only for digits 1..10 to avoid false positives on phone numbers etc.
 *
 * Returns `{ index, matchedText }` so the debug string can quote the exact span
 * that fired.
 */
export function extractOrdinalIndex(
  message: string,
): { index: number; matchedText: string } | null {
  if (!message) return null;
  const lc = message.toLowerCase();

  // 1. Word-based ordinals — match against tokenised words to avoid partial-substring hits.
  const tokens = lc.split(/[^a-z0-9\u0980-\u09ff]+/g).filter(Boolean);
  for (const t of tokens) {
    const idx = ORDINAL_WORDS[t];
    if (typeof idx === "number") {
      return { index: idx, matchedText: t };
    }
  }

  // 2. Numeric suffix: 1st / 2nd / 3rd / 4th.
  const suffix = ORDINAL_SUFFIX_RE.exec(lc);
  if (suffix && suffix[1]) {
    const n = Number.parseInt(suffix[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 50) {
      return { index: n, matchedText: suffix[0] };
    }
  }

  // 3. Banglish indicator: `1 ta`, `2 number`, `3 item`, ...
  const banglish = ORDINAL_BANGLISH_RE.exec(lc);
  if (banglish && banglish[1]) {
    const n = Number.parseInt(banglish[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 50) {
      return { index: n, matchedText: banglish[0] };
    }
  }

  // 4. Bare digit — last resort. Only digits 1..10, and only when the prior token
  //    is NOT an attribute word (`size 42` MUST NOT resolve to ordinal 42).
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t || !/^\d+$/.test(t)) continue;
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n < 1 || n > 10) continue;
    const prev = i > 0 ? tokens[i - 1] ?? "" : "";
    if (ATTRIBUTE_PRECEDERS.has(prev)) continue;
    return { index: n, matchedText: t };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tokenisation + stopwords (shared by attribute match + fuzzy match)
// ---------------------------------------------------------------------------

/**
 * Split a string into lowercased tokens matching the same rules as the catalog
 * tokenizer (alpha-numeric + Bangla code points, length >= 2). Pure function;
 * order is preserved.
 */
function tokenizeMessage(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/g)
    .filter((t) => t.length >= 2);
}

/**
 * Stopwords that should NEVER drive an attribute or fuzzy match by themselves.
 * Includes English determiners/verbs and Banglish filler words. Generic product
 * classes like "jersey" / "boot" are NOT stopwords because they ARE the
 * disambiguator the customer uses (`make the boot size 42`).
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "one",
  "ones",
  "it",
  "its",
  "to",
  "of",
  "for",
  "and",
  "or",
  "with",
  "make",
  "change",
  "modify",
  "set",
  "please",
  "want",
  "give",
  "need",
  "size",
  "qty",
  "quantity",
  "price",
  "ta",
  "na",
  "no",
  "number",
  "item",
  "product",
  "lagbe",
  "chai",
  "dao",
  "dorkar",
  "ami",
  "tumi",
  "apni",
  "nibo",
  "nite",
  "korte",
  "korbo",
  "ki",
  "ki.",
  "kintu",
  "valo",
  "ekta",
  "duita",
]);

/**
 * Common color tokens (English + Banglish-friendly). Used by priority 3 to
 * detect references like "the red one" / "the lal ta".
 */
const COLOR_TOKENS: ReadonlySet<string> = new Set([
  "red",
  "blue",
  "black",
  "white",
  "green",
  "yellow",
  "orange",
  "purple",
  "pink",
  "navy",
  "grey",
  "gray",
  "brown",
  "lal",
  "shada",
  "kalo",
  "shobuj",
  "holud",
]);

/**
 * Regex matching a SKU-shaped product code: 2..6 letters followed by an optional
 * dash/space and 1..5 digits, e.g. `WC26`, `RM-23`, `BCS21`. Capture group 1 is
 * the prefix; group 2 is the suffix. Exported for tests.
 *
 * Used by priority 4 (product code match in `lastShown[*].label`).
 */
export const PRODUCT_CODE_RE = /\b([a-z]{2,6})[-\s]?(\d{1,5})\b/gi;

/**
 * Extract uppercase product codes from a message (e.g. `WC26`, `RM-23` →
 * `["WC26", "RM23"]`). Codes are normalised to uppercase, no separator, so
 * downstream matching is case-insensitive and tolerant of `WC-26` vs `WC26`.
 */
function extractProductCodes(message: string): string[] {
  const out: string[] = [];
  // Reset lastIndex because PRODUCT_CODE_RE is global and shared at module scope.
  PRODUCT_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRODUCT_CODE_RE.exec(message)) !== null) {
    if (!m[1] || !m[2]) continue;
    out.push(`${m[1]}${m[2]}`.toUpperCase());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cart-line scoring helpers
// ---------------------------------------------------------------------------

/**
 * Build the searchable token set for a cart line. Combines `product`, `size`, and
 * `addOns[*].label`/`addOns[*].value`. Stopwords are NOT removed here so the
 * attribute matcher can see things like color tokens that live in addOn values
 * (e.g. `value: "red"`).
 */
function lineTokens(
  line: AgentSnapshot["cart"][number],
): { all: Set<string>; productOnly: Set<string>; addOnValues: Set<string> } {
  const productOnly = new Set(tokenizeMessage(line.product ?? ""));
  const addOnValues = new Set<string>();
  if (Array.isArray(line.addOns)) {
    for (const a of line.addOns) {
      if (typeof a?.value === "string") {
        for (const t of tokenizeMessage(a.value)) addOnValues.add(t);
      }
      if (typeof a?.label === "string") {
        for (const t of tokenizeMessage(a.label)) addOnValues.add(t);
      }
    }
  }
  const all = new Set<string>([...productOnly, ...addOnValues]);
  if (typeof line.size === "string") {
    for (const t of tokenizeMessage(line.size)) all.add(t);
  }
  return { all, productOnly, addOnValues };
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Build a successful resolution result and, when supplied, fire `onResolve` with
 * an `AgentRecentReference` describing the resolution. The loop wires `onResolve`
 * to `appendRecentReference` so successful resolutions are persisted into the
 * snapshot's `recent_references` ring buffer (Req 9.6).
 */
function emitResolved<R extends ReferenceResolution & { kind: "line" | "product" }>(
  result: R,
  phrase: string,
  options: ResolveReferenceOptions,
): R {
  if (typeof options.onResolve === "function") {
    const ref: AgentRecentReference = {
      phrase: phrase.slice(0, 200),
      target_kind: result.kind,
      target_id: result.kind === "line" ? result.line_id : result.product_id,
      ts: new Date().toISOString(),
    };
    try {
      options.onResolve(ref);
    } catch {
      // Defensive: never let an `onResolve` throw escape the resolver. The
      // caller (loop) is responsible for handling persistence errors itself.
    }
  }
  return result;
}

/**
 * Resolve a customer phrase to a cart line or catalog product using deterministic
 * rules. Pure function — never mutates `snapshot`, never does I/O.
 *
 * @param snapshot - Current snapshot; the resolver reads `cart`, `lastShown`, and
 *                   `recent_references` but never mutates them.
 * @param message - Raw customer text (Banglish-friendly).
 * @param options - Optional callbacks (see {@link ResolveReferenceOptions}).
 * @returns A {@link ReferenceResolution} discriminated union. Callers gate cart
 *          mutations on `confidence_score >= CONFIDENCE_THRESHOLDS.high` (task 4.3).
 */
export function resolveReference(
  snapshot: AgentSnapshot,
  message: string,
  options: ResolveReferenceOptions = {},
): ReferenceResolution {
  if (!message || typeof message !== "string") {
    return { kind: "none", confidence_score: 0, debug: "empty_message" };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return { kind: "none", confidence_score: 0, debug: "blank_message" };
  }

  const ordinal = extractOrdinalIndex(trimmed);
  const lastShown = Array.isArray(snapshot.lastShown) ? snapshot.lastShown : [];
  const cart = snapshot.cart;

  // ---- Priority 1: lastShown ordinal -------------------------------------
  if (ordinal && lastShown.length > 0) {
    const idx = ordinal.index - 1; // 1-based -> 0-based
    if (idx >= 0 && idx < lastShown.length) {
      const target = lastShown[idx];
      if (target && target.sku) {
        return emitResolved(
          {
            kind: "product",
            product_id: target.sku,
            confidence_score: 1.0,
            debug: `priority1_lastShown_ordinal: matched "${ordinal.matchedText}" -> index=${idx} sku=${target.sku} (lastShown.length=${lastShown.length})`,
          },
          trimmed,
          options,
        );
      }
    }
    // Fall through — out-of-range index. Try cart ordinal next.
  }

  // ---- Priority 2: cart ordinal ------------------------------------------
  if (ordinal && cart.length > 0) {
    const idx = ordinal.index - 1;
    if (idx >= 0 && idx < cart.length) {
      const target = cart[idx];
      if (target && target.line_id) {
        return emitResolved(
          {
            kind: "line",
            line_id: target.line_id,
            confidence_score: 1.0,
            debug: `priority2_cart_ordinal: matched "${ordinal.matchedText}" -> index=${idx} line_id=${target.line_id} (cart.length=${cart.length})`,
          },
          trimmed,
          options,
        );
      }
    }
    // Fall through — out-of-range cart index.
  }

  // ---- Priority 3: cart attribute match ----------------------------------
  // Tokenise the message and drop stopwords. For each cart line, score on
  // overlap with that line's product / addOns / size tokens. Color tokens get
  // an extra boost so "the red one" reliably picks the line whose addOn value
  // is "red".
  if (cart.length > 0) {
    const messageTokens = new Set(tokenizeMessage(trimmed));
    const significantTokens = new Set<string>();
    for (const t of messageTokens) {
      if (!STOPWORDS.has(t)) significantTokens.add(t);
    }

    if (significantTokens.size > 0) {
      type LineMatch = {
        line_id: string;
        productHits: string[];
        addOnHits: string[];
        colorHits: string[];
        score: number;
      };
      const matches: LineMatch[] = [];
      for (const line of cart) {
        const tokens = lineTokens(line);
        const productHits: string[] = [];
        const addOnHits: string[] = [];
        const colorHits: string[] = [];
        for (const t of significantTokens) {
          // Color tokens: prefer addOn values, then fall back to product/size.
          if (COLOR_TOKENS.has(t)) {
            if (tokens.addOnValues.has(t) || tokens.all.has(t)) {
              colorHits.push(t);
            }
            continue;
          }
          if (tokens.productOnly.has(t)) {
            productHits.push(t);
          } else if (tokens.addOnValues.has(t)) {
            addOnHits.push(t);
          }
        }
        const score = productHits.length + addOnHits.length + colorHits.length;
        if (score > 0) {
          matches.push({
            line_id: line.line_id,
            productHits,
            addOnHits,
            colorHits,
            score,
          });
        }
      }

      if (matches.length === 1) {
        const m = matches[0]!;
        return emitResolved(
          {
            kind: "line",
            line_id: m.line_id,
            confidence_score: 0.85,
            debug: `priority3_cart_attribute: unique match line_id=${m.line_id} hits={product:[${m.productHits.join(",")}],addOn:[${m.addOnHits.join(",")}],color:[${m.colorHits.join(",")}]}`,
          },
          trimmed,
          options,
        );
      }
      if (matches.length > 1) {
        // Ambiguous — pick the highest-scoring line, but lower the confidence so
        // the loop will ask the customer to disambiguate (Req 9.5).
        matches.sort((a, b) => b.score - a.score);
        const top = matches[0]!;
        const second = matches[1]!;
        // If the top scores by at least 2 over the runner-up, treat as a softer
        // "probable" match (0.65); otherwise fully ambiguous (0.5).
        const conf = top.score - second.score >= 2 ? 0.65 : 0.5;
        return emitResolved(
          {
            kind: "line",
            line_id: top.line_id,
            confidence_score: conf,
            debug: `priority3_cart_attribute: ambiguous (${matches.length} matches; top.score=${top.score}, runnerUp.score=${second.score}) -> line_id=${top.line_id}`,
          },
          trimmed,
          options,
        );
      }
    }
  }

  // ---- Priority 4: product code match in lastShown labels ----------------
  if (lastShown.length > 0) {
    const codes = extractProductCodes(trimmed);
    if (codes.length > 0) {
      // Build a normalised representation of each lastShown label that strips
      // separators so `WC-26` in a label still matches `WC26` from the message.
      for (const code of codes) {
        const codeNorm = code.toUpperCase();
        for (const row of lastShown) {
          const labelNorm = String(row.label ?? "")
            .toUpperCase()
            .replace(/[-\s]/g, "");
          if (labelNorm.includes(codeNorm)) {
            return emitResolved(
              {
                kind: "product",
                product_id: row.sku,
                confidence_score: 1.0,
                debug: `priority4_product_code: matched code="${code}" in label="${row.label}" -> sku=${row.sku}`,
              },
              trimmed,
              options,
            );
          }
        }
      }
    }
  }

  // ---- Priority 5: fuzzy token-overlap match against cart product names --
  if (cart.length > 0) {
    const messageTokens = new Set(
      tokenizeMessage(trimmed).filter((t) => !STOPWORDS.has(t)),
    );
    if (messageTokens.size > 0) {
      type FuzzyScore = { line_id: string; score: number; overlap: number; lineSize: number };
      const scores: FuzzyScore[] = [];
      for (const line of cart) {
        const lt = new Set(
          tokenizeMessage(line.product ?? "").filter((t) => !STOPWORDS.has(t)),
        );
        if (lt.size === 0) continue;
        let overlap = 0;
        for (const t of lt) if (messageTokens.has(t)) overlap += 1;
        // Containment-style score: how much of the line's product name appears
        // in the customer's message. This rewards "real madrid jersey" matching
        // a line called "Real Madrid Home Jersey" even when the customer skips
        // "Home". Bounded to [0, 1].
        const score = overlap / lt.size;
        scores.push({ line_id: line.line_id, score, overlap, lineSize: lt.size });
      }
      if (scores.length > 0) {
        scores.sort((a, b) => b.score - a.score);
        const top = scores[0]!;
        const second = scores[1];
        const margin = second ? top.score - second.score : top.score;
        if (top.score >= 0.8 && margin >= 0.1) {
          return emitResolved(
            {
              kind: "line",
              line_id: top.line_id,
              confidence_score: top.score,
              debug: `priority5_fuzzy_cart: line_id=${top.line_id} score=${top.score.toFixed(3)} overlap=${top.overlap}/${top.lineSize} margin=${margin.toFixed(3)}`,
            },
            trimmed,
            options,
          );
        }
        return {
          kind: "none",
          confidence_score: 0,
          debug: `priority5_fuzzy_cart_below_threshold: top.score=${top.score.toFixed(3)} margin=${margin.toFixed(3)} (need score>=0.8 AND margin>=0.1)`,
        };
      }
    }
  }

  return {
    kind: "none",
    confidence_score: 0,
    debug: `no_match: ordinal=${ordinal ? ordinal.matchedText : "none"} lastShown.length=${lastShown.length} cart.length=${cart.length}`,
  };
}
