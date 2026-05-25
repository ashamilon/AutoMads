/**
 * Defense-in-depth: even with a strict prompt rule, the model occasionally leaks tool-internal
 * jargon ("cart", "checkout", "select") into customer-facing replies. This filter rewrites those
 * words into Banglish-friendly substitutes before the message goes out.
 *
 * Two surfaces are exported:
 *
 *   1. `sanitizeCustomerReply(text)` — the legacy banned-word-only stripper. Existing callers
 *      (`tools/reply.ts`, `runner.ts` fallback path) continue to use it as-is.
 *
 *   2. `filterReply(text, lastVerifiedToolResults, traceSteps)` — the full three-pass guard
 *      used by the AgentLoop's `generateResponse` step (wired in task 10.2):
 *        • Pass 1: banned-word substitution (delegates to `sanitizeCustomerReply`).
 *        • Pass 2: anti-hallucination — strip product-attribute claims (price, size) that are
 *                  not grounded in any verified tool result this turn.
 *        • Pass 3: confirmation-phrase block — rewrite "order confirmed" / "payment received" /
 *                  Banglish equivalents unless a `create_order` step succeeded earlier in the
 *                  turn (Req 10.3 — never confirm before the order is persisted).
 *      Every modification is recorded in the returned `overrides[]` so task 10.2's
 *      `recordOverride` helper can persist a per-override `AgentTrace` row (Req 10.6).
 *
 * Whole-word matches only, case-insensitive. Apostrophed contractions handled separately.
 */

type Replacement = {
  pattern: RegExp;
  /** Replacement that preserves the original capitalisation pattern (lower / Title / UPPER). */
  replace: (match: string) => string;
};

function preserveCase(replacement: string, original: string): string {
  if (!original) return replacement;
  if (original === original.toUpperCase() && original.length >= 2) return replacement.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

const REPLACEMENTS: Replacement[] = [
  // "cart" / "carts"
  {
    pattern: /\bcarts?\b/gi,
    replace: (m) => preserveCase("list", m),
  },
  // "checkout" (one word) / "check out" (rare)
  {
    pattern: /\bcheck[ -]?outs?\b/gi,
    replace: (m) => preserveCase("order confirm", m),
  },
  // "selected" → "nilam" (we noted it)
  {
    pattern: /\bselected\b/gi,
    replace: (m) => preserveCase("nilam", m),
  },
  // "selection" / "selections" → "list"
  {
    pattern: /\bselections?\b/gi,
    replace: (m) => preserveCase("list", m),
  },
  // bare "select" — verb usage. Replace with "choose koren"; keeps casing.
  {
    pattern: /\bselect\b/gi,
    replace: (m) => preserveCase("choose koren", m),
  },
];

export function sanitizeCustomerReply(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, replace } of REPLACEMENTS) {
    out = out.replace(pattern, replace);
  }
  // Tidy up any double spaces the substitutions might create.
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1");
}

// ─────────────────────────────────────────────────────────────────────────────
// filterReply — full three-pass guard. Wired by task 10.2 (loop) + task 10.2
// (override logging). Pure: takes plain inputs, returns the cleaned text and a
// list of override descriptors. No DB / logger access here.
// ─────────────────────────────────────────────────────────────────────────────

/** A single modification made by `filterReply`. One row per replacement / block. */
export type FilterOverride =
  | { kind: "banned_word"; from: string; to: string }
  | { kind: "anti_hallucination"; attribute: string; value: string }
  | { kind: "confirmation_block"; phrase: string };

export type FilterReplyResult = { text: string; overrides: FilterOverride[] };

/** Verified tool results passed in from the AgentLoop. Only `observation` + `data` are read. */
export type VerifiedToolResult = {
  name: string;
  observation: string;
  data?: unknown;
};

/** Slimmed-down trace step shape. The only fields the confirmation guard needs. */
export type FilterTraceStep = {
  tool: string;
  ok: boolean;
  data?: unknown;
};

/**
 * Price tokens we look for. Three alternatives, each capturing the numeric portion:
 *   1. "500 BDT" / "500BDT"
 *   2. "500 tk"  / "500tk"
 *   3. "৳500"   / "৳ 500"
 */
const PRICE_PATTERN = /(\d+)\s*BDT\b|(\d+)\s*tk\b|৳\s*(\d+)/gi;

/**
 * Size-claim contexts. We only flag size tokens that appear in an obvious size
 * context to keep false-positive rate low (Req: "be conservative — leave the text
 * alone when you can't tell"). A bare "L" elsewhere in the reply is ignored.
 */
const SIZE_TOKEN = "(XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL)";
const SIZE_CLAIM_PATTERN = new RegExp(
  // "size L" / "size: L" / "size - L"
  `\\bsize\\s*[:\\-]?\\s*${SIZE_TOKEN}\\b` +
    // OR "L size"
    `|\\b${SIZE_TOKEN}\\s+size\\b` +
    // OR "L ache" / "L ase" — Banglish "L is in stock"
    `|\\b${SIZE_TOKEN}\\s+(?:ache|ase)\\b`,
  "gi",
);

/**
 * Confirmation phrases — exactly the set called out by task 10.1. If any of these
 * appears in the reply AND no `create_order` succeeded earlier in the turn, replace
 * the entire reply with a safe pre-confirmation prompt.
 */
const CONFIRMATION_PATTERN =
  /order confirmed|thank you for your purchase|payment received|payment confirm|order place hoye gechhe|order final hoye gechhe|order successful/i;

const CONFIRMATION_FALLBACK_TEXT = "Apnar order list ready, confirm korben?";
const PRICE_PLACEHOLDER = "dam admin verify kore janabe";
const SIZE_PLACEHOLDER = "size info admin theke confirm korbo";

/**
 * Build a single lower-cased haystack from every verified tool result this turn.
 * We search this string for price digits / size tokens to decide whether a claim
 * in the LLM reply is grounded. JSON-stringifying `data` is intentionally cheap
 * and lossless — we just need the digits and tokens to appear somewhere.
 */
function buildToolHaystack(results: ReadonlyArray<VerifiedToolResult>): string {
  if (results.length === 0) return "";
  const parts: string[] = [];
  for (const r of results) {
    if (r.observation) parts.push(r.observation);
    if (typeof r.data !== "undefined" && r.data !== null) {
      try {
        parts.push(JSON.stringify(r.data));
      } catch {
        // Circular / non-serialisable — skip; the observation alone is the fallback grounding source.
      }
    }
  }
  return parts.join("\n").toLowerCase();
}

/**
 * Pass 1 — collect override rows for every banned-word match before delegating
 * the actual rewrite to `sanitizeCustomerReply` (single source of truth for the
 * substitution logic). Returning `to` lets the caller render a useful diff.
 */
function applyBannedWordPass(text: string): FilterReplyResult {
  const overrides: FilterOverride[] = [];
  for (const { pattern, replace } of REPLACEMENTS) {
    // `.match` with the /g flag yields every occurrence as a plain string, in order.
    const matches = text.match(pattern);
    if (!matches) continue;
    for (const m of matches) {
      overrides.push({ kind: "banned_word", from: m, to: replace(m) });
    }
  }
  return { text: sanitizeCustomerReply(text), overrides };
}

/**
 * Pass 2 — strip ungrounded product-attribute claims. Only price and size are
 * checked; both are conservative (we leave text alone when we can't tell).
 */
function applyAntiHallucinationPass(text: string, haystack: string): FilterReplyResult {
  const overrides: FilterOverride[] = [];
  let out = text;

  // 2a — Price tokens.
  // Track which raw tokens we've already replaced so two identical occurrences only get one
  // global substitution but each occurrence still earns its own override row (audit trail).
  const replacedPriceTokens = new Set<string>();
  for (const match of text.matchAll(PRICE_PATTERN)) {
    const tokenRaw = match[0];
    const digits = match[1] ?? match[2] ?? match[3] ?? "";
    if (!digits) continue;
    if (haystack.includes(digits)) continue; // grounded — leave alone
    overrides.push({ kind: "anti_hallucination", attribute: "price", value: tokenRaw });
    if (!replacedPriceTokens.has(tokenRaw)) {
      // Replace every textual occurrence of this raw price token in the running output.
      out = out.split(tokenRaw).join(PRICE_PLACEHOLDER);
      replacedPriceTokens.add(tokenRaw);
    }
  }

  // 2b — Size tokens. Only flag when in a clear size-claim context.
  const replacedSizeClaims = new Set<string>();
  for (const match of text.matchAll(SIZE_CLAIM_PATTERN)) {
    const fullClaim = match[0];
    // Only one of the alternation groups will be populated per match.
    const sizeRaw = (match[1] ?? match[2] ?? match[3] ?? "").toUpperCase();
    if (!sizeRaw) continue;
    // Grounded if the size appears as a standalone token in any verified tool result.
    const grounded = new RegExp(`\\b${sizeRaw}\\b`, "i").test(haystack);
    if (grounded) continue;
    overrides.push({ kind: "anti_hallucination", attribute: "size", value: sizeRaw });
    if (!replacedSizeClaims.has(fullClaim)) {
      out = out.split(fullClaim).join(SIZE_PLACEHOLDER);
      replacedSizeClaims.add(fullClaim);
    }
  }

  return { text: out, overrides };
}

/**
 * Pass 3 — confirmation block. If the reply claims the order is confirmed but
 * no `create_order` step succeeded this turn, replace the entire reply with the
 * pre-confirmation prompt. Returning the matched phrase gives task 10.2 a
 * useful audit value to persist.
 */
function applyConfirmationBlockPass(
  text: string,
  traceSteps: ReadonlyArray<FilterTraceStep>,
): FilterReplyResult {
  const match = CONFIRMATION_PATTERN.exec(text);
  if (!match) return { text, overrides: [] };
  const hasSuccessfulCreateOrder = traceSteps.some(
    (s) => s.tool === "create_order" && s.ok === true,
  );
  if (hasSuccessfulCreateOrder) {
    // The order was actually persisted — the confirmation phrase is grounded. Leave alone.
    return { text, overrides: [] };
  }
  return {
    text: CONFIRMATION_FALLBACK_TEXT,
    overrides: [{ kind: "confirmation_block", phrase: match[0] }],
  };
}

/**
 * Run all three passes in order and aggregate the overrides. The passes are
 * intentionally sequential: pass 1 may rewrite a banned word that pass 2 then
 * scans, and pass 3's wholesale rewrite (when triggered) supersedes any text
 * still being processed — but the override rows from earlier passes are kept
 * for the audit trail.
 *
 * Inputs:
 *   • `text` — the LLM-proposed customer-facing reply.
 *   • `lastVerifiedToolResults` — every tool result observed this turn that the
 *     loop considers verified (i.e. `ok=true`). Used to ground price / size
 *     claims.
 *   • `traceSteps` — the per-step trace captured this turn. Only `tool` and
 *     `ok` are read; `data` is accepted for forward compat (e.g. checking the
 *     persisted order id later).
 */
export function filterReply(
  text: string,
  lastVerifiedToolResults: ReadonlyArray<VerifiedToolResult>,
  traceSteps: ReadonlyArray<FilterTraceStep>,
): FilterReplyResult {
  if (!text) return { text, overrides: [] };

  const overrides: FilterOverride[] = [];

  // Pass 1 — banned words.
  const banned = applyBannedWordPass(text);
  let working = banned.text;
  overrides.push(...banned.overrides);

  // Pass 2 — anti-hallucination.
  const haystack = buildToolHaystack(lastVerifiedToolResults);
  const antiHall = applyAntiHallucinationPass(working, haystack);
  working = antiHall.text;
  overrides.push(...antiHall.overrides);

  // Pass 3 — confirmation block. May replace the whole reply.
  const confirm = applyConfirmationBlockPass(working, traceSteps);
  working = confirm.text;
  overrides.push(...confirm.overrides);

  return { text: working, overrides };
}
