/**
 * Per-conversation address-style detector.
 *
 * Reads the customer's most recent inbound text and infers which address
 * style they're using to refer to themselves (and to the agent). When a
 * confident cue is found, the result is persisted on
 * `MessengerConversation.preferences.addressStyle` so subsequent turns
 * stay consistent — the agent shouldn't keep flipping between "Vaiya"
 * and "Apu" mid-conversation just because the customer's later messages
 * are ambiguous.
 *
 * The detector is deterministic and conservative: only emit a confident
 * style when the cue is unambiguous. When unsure, return `null` so the
 * caller falls back to the tenant default / platform default.
 *
 * Maps to: R5.1, R7.1, R18.7.
 */

import type { ResolvedAddress } from "./types.js";

/**
 * Cue → address mapping.
 *
 * Each entry lists the regex(es) that signal a particular address.
 * Multi-word phrases first so they win over single-word fallbacks
 * ("apa moni" > "apa"). All matchers run case-insensitive and use
 * word boundaries to avoid catching things like "vaiyam" or "sirjon".
 */
interface CueRule {
  style: ResolvedAddress;
  patterns: ReadonlyArray<RegExp>;
}

const CUE_RULES: ReadonlyArray<CueRule> = [
  // ─── Most specific multi-word forms first ────────────────────────────────
  {
    style: "apu",
    patterns: [
      /\bapa[\s-]?moni\b/i,
      /\bapuni\b/i,
    ],
  },
  {
    style: "madam",
    patterns: [/\bma['']?am\b/i, /\bmadam\b/i],
  },
  // ─── Single-word forms ───────────────────────────────────────────────────
  {
    style: "apu",
    patterns: [/\bapu\b/i, /\bapa\b/i, /\bdidi\b/i],
  },
  {
    style: "bhaiya",
    patterns: [
      /\bvaiya\b/i,
      /\bbhaiya\b/i,
      /\bvaia\b/i,
      /\bbhai\b/i,
      /\bvai\b/i,
      /\bbro\b/i,
      /\bbrother\b/i,
    ],
  },
  {
    style: "sir",
    patterns: [/\bsir\b/i, /\bboss\b/i],
  },
  {
    style: "bondhu",
    patterns: [/\bbondhu\b/i, /\bdost\b/i, /\bfriend\b/i],
  },
];

/**
 * Detect a confident address style from a single inbound message. Returns
 * `null` when no recognisable cue is present.
 *
 * Pure: no DB, no logger, idempotent. The caller is responsible for
 * persisting the result if it wants to lock the conversation.
 */
export function detectAddressFromMessage(
  text: string | null | undefined,
): ResolvedAddress | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  for (const rule of CUE_RULES) {
    if (rule.patterns.some((re) => re.test(trimmed))) {
      return rule.style;
    }
  }
  return null;
}

/**
 * Detect from a list of recent messages, newest first. Walks the list in
 * order and returns the first confident hit. Used when the loop wants to
 * lock an address style for a conversation that has 2-3 messages of
 * history but didn't trigger on the first message alone.
 *
 * The cap of 5 messages is chosen so we don't keep re-evaluating after
 * the conversation has settled — once locked on
 * `MessengerConversation.preferences.addressStyle`, callers should skip
 * this entirely.
 */
export function detectAddressFromHistory(
  messages: ReadonlyArray<string>,
): ResolvedAddress | null {
  for (const msg of messages.slice(0, 5)) {
    const hit = detectAddressFromMessage(msg);
    if (hit) return hit;
  }
  return null;
}
