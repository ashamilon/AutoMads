/**
 * Structured log emitters for the agent loop (task 11.2 / Req 15.4, 15.5).
 *
 * Two events are emitted from `loop.ts` around tool invocations and override
 * decisions, replacing the prior ad-hoc `logger.info` / `logger.warn` payloads
 * with one canonical shape:
 *
 *   {
 *     event:           "agent.tool_call" | "agent.override",
 *     tenantId, conversationId, turnId, iter, tool,
 *     args_redacted,                       // arg tree with PII / secrets removed
 *     result_id?,                          // best-effort id pulled from the tool result data
 *     latency_ms,                          // tool execution wall time
 *     // override-only:
 *     kind, reason
 *   }
 *
 * Redaction rules — never echo:
 *   • PII: phone numbers, addresses, emails, raw customer values written through
 *     `collect_customer_field` (`{ field: "phone", value: "01711223344" }`).
 *   • Secrets: any key name containing `token`, `secret`, `password`, `api_key`,
 *     `access_token`, `pageAccessToken`, `key`.
 *   • Defensive: any `value` field whose sibling `field` is `"phone" | "address"
 *     | "email" | "phoneNumber" | "mobile"`.
 *   • String values are truncated to `MAX_REDACTED_STRING_LEN` chars to keep
 *     log lines bounded; nothing here is parsed for content.
 *
 * Pure: this module imports only the shared logger. It is not on the hot DB
 * write path (task 10.2's `recordOverride` is the seam that ALSO writes
 * `AgentTrace` rows; the two surfaces are intentionally separate).
 */

import { logger } from "../utils/logger.js";

/** Truncate every string value below this length when building the redacted args tree. */
const MAX_REDACTED_STRING_LEN = 240;

/** Token used in place of any redacted value so the log stays JSON-safe. */
const REDACTED = "[REDACTED]";

/**
 * Key-name fragments that mark a value as sensitive. Compared case-insensitively
 * against the substring of the key. Keep this list conservative — a false
 * positive (over-redaction) is preferable to a false negative.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "access_key",
  "accesskey",
  "page_access_token",
  "pageaccesstoken",
  "cookie",
  "phone",
  "mobile",
  "address",
  "email",
  "ssn",
  "credit_card",
  "creditcard",
  "card_number",
  "cardnumber",
] as const;

/** Field values (in `{ field, value }` arg pairs) that imply `value` is PII. */
const PII_FIELD_VALUES = new Set(["phone", "address", "email", "mobile", "phonenumber"]);

/**
 * Return true when `key` looks sensitive. Case-insensitive substring match
 * against `SENSITIVE_KEY_FRAGMENTS`. Pure.
 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const frag of SENSITIVE_KEY_FRAGMENTS) {
    if (lower.includes(frag)) return true;
  }
  return false;
}

/** Bounded string: trim very long values so a runaway argument can't blow up the log line. */
function clampString(s: string): string {
  if (s.length <= MAX_REDACTED_STRING_LEN) return s;
  return s.slice(0, MAX_REDACTED_STRING_LEN) + `…(+${s.length - MAX_REDACTED_STRING_LEN}c)`;
}

/**
 * Recursively walk `value`, returning a structurally identical tree with sensitive
 * keys replaced by `REDACTED`. Arrays and primitives are passed through (with
 * strings clamped). Cycles are guarded by a depth limit so a maliciously crafted
 * arg cannot trigger a stack overflow.
 */
function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED; // pathological depth — truncate
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return clampString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    // Cap array length too — nothing in our tool surface needs more than ~32 entries
    // logged, and a redacted tree should never feed a downstream parser.
    const out: unknown[] = [];
    const cap = Math.min(value.length, 32);
    for (let i = 0; i < cap; i += 1) {
      out.push(redactValue(value[i], depth + 1));
    }
    if (value.length > cap) out.push(`…(+${value.length - cap} more)`);
    return out;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // PII heuristic: when an object has both `field` and `value` and `field` names a
    // PII slot (per the `collect_customer_field` tool), redact `value` regardless
    // of the `value` key's own naming.
    const fieldRaw = obj["field"];
    const piiByField =
      typeof fieldRaw === "string" && PII_FIELD_VALUES.has(fieldRaw.toLowerCase());
    for (const [k, v] of Object.entries(obj)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      if (piiByField && k === "value") {
        out[k] = REDACTED;
        continue;
      }
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  // Anything else (functions, symbols) — drop.
  return REDACTED;
}

/**
 * Redact a tool-args payload. Top-level values that are not objects are wrapped
 * so callers always see an object shape in logs.
 */
export function redactArgs(args: unknown): unknown {
  if (args === null || args === undefined) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return { value: redactValue(args) };
  }
  return redactValue(args);
}

/**
 * Best-effort extraction of a stable identifier from a tool's `data` payload.
 * The list mirrors the `data: { ... }` shapes used across `src/agent/tools/*.ts`:
 * `orderId` (confirm/payment/delivery/orders), `tranId` (confirm/paymentLink),
 * `line_id` (cart), `sku` (catalog/inventory/sizeChart/cart), `conversationId`
 * (session). Returns `null` when nothing useful is available so the log key
 * can be omitted entirely.
 */
export function extractResultId(data: unknown): string | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const candidates = ["orderId", "tranId", "id", "line_id", "sku", "conversationId"];
  for (const k of candidates) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Common identity fields included on every emitted event. */
export type StructuredLogContext = {
  tenantId: string;
  conversationId: string;
  turnId: string;
  iter: number;
};

/**
 * Emit one `agent.tool_call` event. Always logs at `info` level — these rows are
 * the per-turn audit trail and downstream analytics consume them.
 *
 * Inputs:
 *   • `tool`    — tool name as registered in `ToolRegistry`.
 *   • `args`    — raw tool args (will be redacted before emission).
 *   • `ok`      — tool result success flag (drives `result_id` extraction).
 *   • `data`    — tool result `data` payload (best-effort id source).
 *   • `latencyMs` — tool wall time in milliseconds.
 *   • `errorCode` — present when `ok=false` so failures are still indexable.
 */
export function logToolCall(args: {
  ctx: StructuredLogContext;
  tool: string;
  args: unknown;
  ok: boolean;
  data?: unknown;
  latencyMs: number;
  errorCode?: string;
}): void {
  const { ctx, tool, args: rawArgs, ok, data, latencyMs, errorCode } = args;
  const resultId = ok ? extractResultId(data) : null;
  logger.info(
    {
      event: "agent.tool_call",
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      iter: ctx.iter,
      tool,
      args_redacted: redactArgs(rawArgs),
      ...(resultId !== null ? { result_id: resultId } : {}),
      latency_ms: latencyMs,
      ok,
      ...(errorCode ? { error_code: errorCode } : {}),
    },
    "agent.tool_call",
  );
}

/**
 * Override kinds emitted by the loop. These names match the override taxonomy
 * documented in task 10.2 plus loop-specific guards (`anti_loop`, `router_error`).
 */
export type OverrideKind =
  | "anti_loop"
  | "anti_loop_nudge"
  | "anti_hallucination"
  | "banned_word"
  | "fsm_block"
  | "router_error";

/**
 * Emit one `agent.override` event. Logged at `warn` level — overrides indicate
 * the deterministic guards stepped in to correct the LLM. Operators rely on
 * these to spot regressions.
 */
export function logOverride(args: {
  ctx: StructuredLogContext;
  kind: OverrideKind;
  /** Tool name or `"(none)"` when the override is upstream of any tool call. */
  tool: string;
  /** Original args / payload that triggered the override (will be redacted). */
  args?: unknown;
  /** Short human-readable reason; rendered into the log message body. */
  reason: string;
  /** Optional tool result id when the override happened around a tool call. */
  resultId?: string | null;
  /** Optional latency when the override was emitted around an LLM / tool call. */
  latencyMs?: number;
}): void {
  const {
    ctx,
    kind,
    tool,
    args: rawArgs,
    reason,
    resultId,
    latencyMs,
  } = args;
  logger.warn(
    {
      event: "agent.override",
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      iter: ctx.iter,
      tool,
      kind,
      reason,
      ...(rawArgs !== undefined ? { args_redacted: redactArgs(rawArgs) } : {}),
      ...(resultId ? { result_id: resultId } : {}),
      ...(typeof latencyMs === "number" ? { latency_ms: latencyMs } : {}),
    },
    "agent.override",
  );
}

// Internal helpers exposed for unit tests.
export const __test = { isSensitiveKey, redactValue, clampString, MAX_REDACTED_STRING_LEN };
