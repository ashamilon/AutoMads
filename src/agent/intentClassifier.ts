/**
 * Deterministic intent classifier (Requirement 11.1, task 6.2).
 *
 * Pure function, no I/O. Supports both English and Banglish keyword / regex
 * patterns. The classifier is consumed by `src/agent/loop.ts` in the
 * `detectIntent` step (task 5.1). When the deterministic score falls below the
 * medium-confidence threshold from `src/agent/state.ts`, the LLM-driven router
 * can supply its own `intent_confidence` to supplement this score (task 6.2 of
 * `tasks.md`).
 *
 * **Scoring model (per task 6.2):**
 *   - `Score = min(1.0, base + presence_bonus)`
 *   - `presence_bonus = 0.4` when at least one strong-signal regex matches
 *     (phone-like number, "confirm koren", "TrxID").
 *   - Single weak keyword match → `0.4` (single-hit floor).
 *   - Two or more matching patterns lift the score to `1.0`.
 *   - No matches → `{ intent: "unknown", confidence_score: 0 }`.
 *
 * **Priority:** the pattern table is iterated top-to-bottom and the first
 * matching label wins the `intent` slot. More specific intents (profile,
 * confirm, payment) are placed above generic ones (greeting, browse) so that
 * casual greetings do not steal turns that contain order-relevant signals.
 */

/** Customer intent labels emitted by {@link classifyIntent}. */
export type IntentLabel =
  | "browse"
  | "add_item"
  | "modify_item"
  | "remove_item"
  | "ask_size"
  | "ask_photo"
  | "provide_profile"
  | "confirm_order"
  | "payment_query"
  | "delivery_query"
  | "greeting"
  | "escalate"
  | "unknown";

/** Result of a deterministic intent classification. */
export type IntentClassification = {
  /** Winning label by pattern priority. `"unknown"` when no pattern matched. */
  intent: IntentLabel;
  /** Confidence in the range `[0, 1]`. `0` when `intent === "unknown"`. */
  confidence_score: number;
  /** Tokens/phrases (verbatim substrings) that matched any pattern. */
  matched: string[];
};

type PatternEntry = {
  label: IntentLabel;
  regex: RegExp;
  /** When true, this pattern's match contributes the +0.4 strong-signal bonus. */
  strong?: boolean;
};

/**
 * Pattern table ordered by priority (most specific first). Each entry maps a
 * regex to an `IntentLabel`; the first matching label wins. Multiple matches —
 * across the same or different patterns — lift the score per the formula in
 * the file header.
 *
 * Each regex below uses ASCII word boundaries (`\b`) where appropriate. Bangla
 * code-points are not currently expected in inbound text (Banglish is typed in
 * Latin script), so `\b` is sufficient.
 */
const PATTERNS: ReadonlyArray<PatternEntry> = [
  // --- provide_profile ------------------------------------------------------
  // Strong signal: 11-digit Bangladeshi mobile (e.g. 01712345678).
  { label: "provide_profile", regex: /\b01\d{9}\b/, strong: true },
  // Weak signal: "phone: …", "address = …", "thikana …".
  {
    label: "provide_profile",
    regex: /(?:phone|mobile|number|address|thikana)\s*[:=]?\s*\S+/i,
  },

  // --- confirm_order --------------------------------------------------------
  // Strong signal: explicit "confirm koren".
  { label: "confirm_order", regex: /\bconfirm koren\b/i, strong: true },
  {
    label: "confirm_order",
    regex: /\b(order place|order final|haan korlam|done|okay korlam|ji nibo)\b/i,
  },

  // --- payment_query --------------------------------------------------------
  // Strong signal: customer-supplied transaction id.
  { label: "payment_query", regex: /\b(TrxID|trx)\b/i, strong: true },
  {
    label: "payment_query",
    regex: /\b(payment|bkash|nagad|kibhabe pay|pay korbo)\b/i,
  },

  // --- escalate -------------------------------------------------------------
  {
    label: "escalate",
    regex: /\b(manush|human|admin chai|talk to human|kotha bolte chai)\b/i,
  },

  // --- delivery_query -------------------------------------------------------
  {
    label: "delivery_query",
    regex: /\b(delivery|kobe pabo|kothay|pathao|courier|tracking)\b/i,
  },

  // --- remove_item ----------------------------------------------------------
  {
    label: "remove_item",
    regex: /\b(remove|baad dao|baad den|cancel koren|niye nibo na|niba na)\b/i,
  },

  // --- modify_item ----------------------------------------------------------
  {
    label: "modify_item",
    regex:
      /\b(change|change koren|onnotaa|alada|bodlao|swap|size [a-z]+ koren|make .* size)\b/i,
  },

  // --- ask_size -------------------------------------------------------------
  {
    label: "ask_size",
    regex: /\b(size|kon size|chest|length|measurement|chart|maap)\b/i,
  },

  // --- ask_photo ------------------------------------------------------------
  { label: "ask_photo", regex: /\b(chobi|picture|photo|image|kemon dekhte)\b/i },

  // --- add_item -------------------------------------------------------------
  {
    label: "add_item",
    regex: /\b(nibo|niye nibo|lagbe|chai|order korbo|niche chai|add koren|ekta dao)\b/i,
  },
  // Quantity pattern: "2 ta", "3ta".
  { label: "add_item", regex: /\b(\d+)\s*ta\b/i },

  // --- browse ---------------------------------------------------------------
  {
    label: "browse",
    regex: /\b(ki ki ache|dekhao|show korn|list dao|kichu dekhao)\b/i,
  },

  // --- greeting -------------------------------------------------------------
  {
    label: "greeting",
    regex: /\b(hi|hello|hey|salam|assalamu|kemon achen|kemon achho)\b/i,
  },
];

/**
 * Clone a pattern's regex with the global flag set, so `String.prototype.match`
 * returns *every* substring hit (not just the first). The original entries
 * keep readable, non-global flags for documentation purposes.
 */
function withGlobal(re: RegExp): RegExp {
  return re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
}

/**
 * Classify a single inbound customer message into an {@link IntentLabel}.
 *
 * Pure function: no I/O, no mutation of inputs.
 *
 * @param message Raw customer text (English or Banglish). Empty / non-string
 *   inputs return `unknown` with `confidence_score: 0`.
 *
 * @example
 *   classifyIntent("hi bhai");
 *   // → { intent: "greeting", confidence_score: 0.4, matched: ["hi"] }
 *
 * @example
 *   classifyIntent("phone: 01712345678");
 *   // → { intent: "provide_profile", confidence_score: 1.0,
 *   //     matched: ["01712345678", "phone: 01712345678"] }
 *
 * @example
 *   classifyIntent("ki ki ache dekhao");
 *   // → { intent: "browse", confidence_score: 1.0,
 *   //     matched: ["ki ki ache", "dekhao"] }
 */
export function classifyIntent(message: string): IntentClassification {
  if (typeof message !== "string" || message.length === 0) {
    return { intent: "unknown", confidence_score: 0, matched: [] };
  }

  const matched: string[] = [];
  let firstLabel: IntentLabel | null = null;
  let strongHit = false;

  for (const entry of PATTERNS) {
    const re = withGlobal(entry.regex);
    const hits = message.match(re);
    if (!hits || hits.length === 0) continue;
    if (firstLabel === null) firstLabel = entry.label;
    if (entry.strong) strongHit = true;
    for (const h of hits) matched.push(h);
  }

  if (firstLabel === null || matched.length === 0) {
    return { intent: "unknown", confidence_score: 0, matched: [] };
  }

  const presenceBonus = strongHit ? 0.4 : 0;
  const count = matched.length;
  // Single-hit floor of 0.4 (per task 6.2); two or more hits saturate the
  // base to 1.0 before the cap.
  const base = count === 1 ? 0.4 : count * 0.5;
  const score = Math.min(1.0, base + presenceBonus);

  return { intent: firstLabel, confidence_score: score, matched };
}

/*
 * Inline sanity checks (kept as comments — task 6.2 explicitly asks for a
 * "brief comment block, not actual tests"). Compile-time only documentation
 * of the expected outputs:
 *
 *   classifyIntent("")
 *     → { intent: "unknown", confidence_score: 0, matched: [] }
 *
 *   classifyIntent("hello")
 *     → { intent: "greeting", confidence_score: 0.4, matched: ["hello"] }
 *
 *   classifyIntent("ami 2 ta jersey nibo")
 *     → intent: "add_item", confidence_score: 1.0,
 *       matched contains "nibo" and "2 ta"
 *
 *   classifyIntent("size chart dekhao")
 *     → intent: "ask_size" (priority over browse), score 1.0,
 *       matched contains "size" and "dekhao"
 *
 *   classifyIntent("confirm koren")
 *     → intent: "confirm_order", score 0.8 (1 strong hit: 0.4 base + 0.4 bonus)
 *
 *   classifyIntent("phone: 01712345678 thikana dhaka")
 *     → intent: "provide_profile", score 1.0
 *       (strong phone match + weak phone/thikana matches)
 *
 *   classifyIntent("TrxID 9XB2K")
 *     → intent: "payment_query", score 0.8 (1 strong hit)
 *
 *   classifyIntent("baad dao oita")
 *     → intent: "remove_item", score 0.4, matched: ["baad dao"]
 *
 *   classifyIntent("admin chai please")
 *     → intent: "escalate", score 0.4, matched: ["admin chai"]
 *
 *   classifyIntent("kobe pabo bhai?")
 *     → intent: "delivery_query", score 0.4, matched: ["kobe pabo"]
 */
