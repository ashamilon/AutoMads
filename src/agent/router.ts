import axios from "axios";
import { z } from "zod";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { parseJsonObjectFromLlmContent } from "../llm/ollamaService.js";
import { AGENT_OUTPUT_SCHEMA_HINT, AGENT_SYSTEM_PROMPT } from "./prompts.js";
import type {
  AgentSnapshot,
  AgentStepLog,
  AgentTurnInput,
  ToolDef,
} from "./types.js";

const ROUTER_OUTPUT_SCHEMA = z.object({
  thought: z.string().max(400).optional().default(""),
  tool: z.string().min(1).max(80),
  args: z.record(z.unknown()).optional().default({}),
});

export type RouterDecision = z.infer<typeof ROUTER_OUTPUT_SCHEMA>;

export type RouterOk = { decision: RouterDecision; latencyMs: number; raw: string };
export type RouterErr = { error: string; latencyMs: number; raw: string };
export type RouterResponse = RouterOk | RouterErr;

/**
 * Render the LLM-facing tool catalog block, one entry per canonical tool.
 *
 * Exported so the alias-registration test (`src/agent/__tests__/toolAliases.test.ts`)
 * can verify that alias names from task 7.1 are filtered out — the prompt budget
 * shouldn't carry two entries for the same handler.
 */
export function renderToolCatalog(tools: ToolDef[]): string {
  // Skip alias entries (task 7.1) — they share a handler with their canonical tool,
  // so listing both would just bloat the prompt with duplicate descriptions and
  // give the LLM two equally valid names for the same action.
  return tools
    .filter((t) => !t.aliasOf)
    .map((t) => {
      const exBlock =
        t.examples && t.examples.length > 0
          ? "\n  Examples:\n" +
            t.examples.map((e) => `    - When ${e.when}: ${JSON.stringify(e.call)}`).join("\n")
          : "";
      return `- ${t.name}: ${t.description}\n  args: ${t.paramsHint}${exBlock}`;
    })
    .join("\n\n");
}

function renderHistory(history: Array<{ role: "user" | "assistant"; text: string }>): string {
  if (history.length === 0) return "(no prior turns)";
  return history
    .slice(-10)
    .map((h) => `${h.role === "user" ? "Customer" : "Shop"}: ${h.text.replace(/\s+/g, " ").slice(0, 280)}`)
    .join("\n");
}

/**
 * Render the in-flight `AgentSnapshot` into the structured CONTEXT block the router LLM sees.
 *
 * The output is sectioned into discrete blocks (each separated by a blank line) so the LLM can
 * skim only the parts it needs:
 *   1. Order state (+ active goal when set)
 *   2. Cart (with `line_id` per line and a `Subtotal` footer when any line has a unit price)
 *   3. Customer profile
 *   4. Missing information (slot bullets — per-line slots include their `line_id`)
 *   5. Confirmed information (compact `line <id> → key=value` list, capped at 10 entries)
 *   6. Recent references (last 5 deterministic resolutions)
 *   7. Confidence (only emitted when below 1.0 — saves tokens on the happy path)
 *   8. Recently shown SKUs (preserved — anti-hallucination grounding pool)
 *   9. Last numbered list (preserved — the resolver and prompt still reference this for
 *      ordinal references like "prothom ta" / "1 ta")
 *
 * Render output is intentionally bounded: `confirmed_information` is truncated to the first ~10
 * top-level entries and `recent_references` to the last 5 so a typical 3-line cart fits well
 * under a 4k-token prompt budget.
 */
function renderSnapshot(snap: AgentSnapshot): string {
  const parts: string[] = [];

  // 1. Order state (+ optional active goal)
  const orderStateLines: string[] = [`Order state: ${snap.order_state}`];
  if (snap.active_goal) orderStateLines.push(`Active goal: ${snap.active_goal}`);
  parts.push(orderStateLines.join("\n"));

  // 2. Cart with line_id and subtotal
  if (snap.cart.length > 0) {
    const lines = snap.cart.map(
      (c) =>
        `- ${c.product} [sku=${c.sku}] [line_id=${c.line_id}] x${c.quantity}${
          c.size ? ` size=${c.size}` : ""
        }${c.unitPriceBdt != null ? ` @ ${c.unitPriceBdt} BDT` : ""}`,
    );
    let cartBlock = `Cart (${snap.cart.length} item(s)):\n` + lines.join("\n");
    const hasPriced = snap.cart.some((c) => c.unitPriceBdt != null);
    if (hasPriced) {
      const subtotal = snap.cart.reduce((sum, c) => {
        if (c.unitPriceBdt == null) return sum;
        return sum + c.unitPriceBdt * c.quantity;
      }, 0);
      cartBlock += `\nSubtotal: ${subtotal} BDT`;
    }
    parts.push(cartBlock);
  } else {
    parts.push("Cart: empty");
  }

  // 3. Customer profile (unchanged)
  const p = snap.profile;
  if (p.name || p.phone || p.address) {
    parts.push(
      `Customer profile: ${[
        p.name && `name=${p.name}`,
        p.phone && `phone=${p.phone}`,
        p.address && `address=${p.address}`,
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  } else {
    parts.push("Customer profile: unknown");
  }

  // 4. Missing information — only when non-empty
  if (snap.missing_information.length > 0) {
    const bullets = snap.missing_information.map((m) =>
      m.line_id
        ? `- ${m.slot} (line_id=${m.line_id}, attempts=${m.attempts})`
        : `- ${m.slot} (attempts=${m.attempts})`,
    );
    parts.push("Missing information:\n" + bullets.join("\n"));
  }

  // 5. Confirmed information — only when at least one key has slot values, truncated to 10 entries
  const confirmedKeys = Object.keys(snap.confirmed_information);
  if (confirmedKeys.length > 0) {
    const entries: string[] = [];
    for (const key of confirmedKeys) {
      const slots = snap.confirmed_information[key];
      if (!slots) continue;
      const slotPairs = Object.entries(slots).map(
        ([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`,
      );
      if (slotPairs.length === 0) continue;
      const label = key === "order" ? "order" : `line ${key}`;
      entries.push(`${label} → ${slotPairs.join(", ")}`);
      if (entries.length >= 10) break;
    }
    if (entries.length > 0) parts.push("Confirmed: " + entries.join("; "));
  }

  // 6. Recent references — only when non-empty, last 5
  if (snap.recent_references.length > 0) {
    const refs = snap.recent_references.slice(-5);
    parts.push(
      "Recent references:\n" +
        refs.map((r) => `- ${r.phrase} → ${r.target_kind}:${r.target_id}`).join("\n"),
    );
  }

  // 7. Confidence — only when below 1.0
  if (snap.confidence_level < 1.0) {
    parts.push(`Confidence: ${snap.confidence_level.toFixed(2)}`);
  }

  // 8. shownSkus (preserved)
  if (snap.shownSkus.length > 0) parts.push(`Recently shown SKUs: ${snap.shownSkus.join(", ")}`);

  // 9. lastShown numbered list (preserved — resolver and prompt still reference it for ordinals)
  if (snap.lastShown && snap.lastShown.length > 0) {
    parts.push(
      "Last numbered list shown to customer (use these SKUs when they say 'ei ta', 'prothom ta', '1 ta', 'first one', '2 ta', etc.):\n" +
        snap.lastShown.map((r, i) => `  ${i + 1}. [${r.sku}] ${r.label}`).join("\n"),
    );
  }

  return parts.join("\n\n");
}

function renderTrace(steps: AgentStepLog[]): string {
  if (steps.length === 0) return "(no tools called yet this turn)";
  return steps
    .map(
      (s) =>
        `[${s.iter}] tool=${s.tool} ok=${s.ok} obs=${s.observation.replace(/\s+/g, " ").slice(0, 280)}`,
    )
    .join("\n");
}

export async function askRouter(args: {
  input: AgentTurnInput;
  tools: ToolDef[];
  snapshot: AgentSnapshot;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  steps: AgentStepLog[];
  /** When true, include a corrective hint pushing JSON-only output. */
  retry?: boolean;
}): Promise<RouterResponse> {
  const userBlock = [
    "CONTEXT:",
    renderSnapshot(args.snapshot),
    "",
    "RECENT CONVERSATION (oldest → newest):",
    renderHistory(args.history),
    "",
    "TOOLS YOU'VE ALREADY CALLED THIS TURN:",
    renderTrace(args.steps),
    "",
    "AVAILABLE TOOLS:",
    renderToolCatalog(args.tools),
    "",
    AGENT_OUTPUT_SCHEMA_HINT,
    "",
    `Customer's latest message: """${args.input.userText.slice(0, 1200)}"""`,
    args.input.imageUrls.length > 0 ? `(Customer also sent ${args.input.imageUrls.length} image(s))` : "",
    "",
    args.retry
      ? "Your previous reply was not valid JSON or referenced an unknown tool. Output ONE valid JSON object only — no markdown, no prose."
      : "Now choose the next tool. Output ONE JSON object only.",
  ]
    .filter(Boolean)
    .join("\n");

  const t0 = Date.now();
  let raw = "";
  try {
    const res = await axios.post(
      `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
      {
        model: config.ollamaModel,
        messages: [
          { role: "system", content: AGENT_SYSTEM_PROMPT },
          { role: "user", content: userBlock },
        ],
        stream: false,
        format: "json",
        options: { temperature: 0.1, num_predict: 320 },
      },
      { timeout: Math.min(config.ollamaTimeoutMs, 60_000) },
    );
    const content = res.data?.message?.content;
    raw = typeof content === "string" ? content : JSON.stringify(content ?? null);
    let parsed: unknown;
    try {
      parsed = parseJsonObjectFromLlmContent(content);
    } catch (parseErr) {
      return {
        error: `router_json_parse_failed: ${String(parseErr).slice(0, 160)}`,
        latencyMs: Date.now() - t0,
        raw,
      };
    }
    const dec = ROUTER_OUTPUT_SCHEMA.safeParse(parsed);
    if (!dec.success) {
      return {
        error: `router_schema_invalid: ${dec.error.message.slice(0, 200)}`,
        latencyMs: Date.now() - t0,
        raw,
      };
    }
    return { decision: dec.data, latencyMs: Date.now() - t0, raw };
  } catch (e) {
    logger.warn({ e: String(e) }, "agent.askRouter call failed");
    return { error: `router_call_failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - t0, raw };
  }
}
