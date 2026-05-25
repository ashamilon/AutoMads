import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import type { AgentRunOutcome, AgentStepLog, AgentTurnInput } from "./types.js";

export function newTurnId(): string {
  return `t_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/**
 * Persist all steps of one agent turn for replay/debugging. Best-effort — failure here
 * must never fail the user-visible reply.
 */
export async function persistTurnTrace(args: {
  input: AgentTurnInput;
  turnId: string;
  outcome: AgentRunOutcome;
}): Promise<void> {
  const { input, turnId, outcome } = args;
  if (outcome.steps.length === 0) {
    // Even an empty turn (router_error before first step) deserves a row so we can audit it.
    await prisma.agentTrace
      .create({
        data: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          psid: input.psid,
          turnId,
          iter: 0,
          tool: "(none)",
          ok: false,
          observation: "no steps executed",
          finalReason: outcome.reason,
        },
      })
      .catch((e: unknown) => logger.warn({ e: String(e) }, "agentTrace persist failed"));
    return;
  }

  const lastIdx = outcome.steps.length - 1;
  const rows = outcome.steps.map((s, i) => stepToRow({ input, turnId, step: s, finalReason: i === lastIdx ? outcome.reason : null }));
  await prisma.agentTrace
    .createMany({ data: rows })
    .catch((e: unknown) => logger.warn({ e: String(e) }, "agentTrace persist (bulk) failed"));
}

function stepToRow(args: {
  input: AgentTurnInput;
  turnId: string;
  step: AgentStepLog;
  finalReason: AgentRunOutcome["reason"] | null;
}) {
  const { input, turnId, step, finalReason } = args;
  // Per Req 15.1 and task 5.2, every persisted step row carries the FSM state and
  // composite confidence score. We merge them into the `args` JSON column so the
  // existing `AgentTrace` schema (`args Json?`) does not need a migration. The base
  // `args` payload from the step is preserved verbatim; the new keys are added on
  // top under stable names so replay tooling has a known shape to read.
  const baseArgs =
    step.args && typeof step.args === "object" && !Array.isArray(step.args)
      ? (step.args as Record<string, unknown>)
      : { value: step.args };
  const enrichedArgs: Record<string, unknown> = { ...baseArgs };
  if (step.fsmState !== undefined) {
    enrichedArgs["fsmState"] = step.fsmState;
  }
  if (step.confidenceLevel !== undefined) {
    enrichedArgs["confidenceLevel"] = step.confidenceLevel;
  }
  if (step.confidence_scores !== undefined) {
    enrichedArgs["confidence_scores"] = step.confidence_scores;
  }
  if (step.step !== undefined) {
    // Mirror the named pipeline step into args too — `tool` is already "(step)" for
    // deterministic stages, so keeping the name in the JSON payload makes filtering
    // by step name in SQL straightforward.
    enrichedArgs["step"] = step.step;
  }
  return {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    psid: input.psid,
    turnId,
    iter: step.iter,
    tool: step.tool,
    thought: step.thought ?? null,
    args: enrichedArgs as Prisma.InputJsonValue,
    ok: step.ok,
    observation: step.observation.slice(0, 4000),
    errorCode: !step.ok && step.observation ? step.observation.split(":")[0]?.slice(0, 80) ?? null : null,
    llmLatencyMs: step.llmLatencyMs,
    toolLatencyMs: step.toolLatencyMs,
    finalReason: finalReason ?? null,
  };
}

/**
 * Override kinds emitted by the deterministic guard layers (Requirements §10.6, §15.5).
 *
 * - `anti_hallucination`: the SKU-grounding guard rewrote a cart-mutation arg the LLM
 *   produced (task 3.4).
 * - `anti_loop`: the loop refused to re-ask a slot already exceeded `MAX_SLOT_ATTEMPTS`
 *   (task 5.3).
 * - `banned_word`: the reply filter rewrote forbidden vocabulary in the outbound text
 *   (task 5.4 / 10.1).
 * - `fsm_block`: the FSM rejected an LLM-suggested transition and forced the next
 *   deterministic state (task 5.3).
 */
export type AgentOverrideKind = "anti_hallucination" | "anti_loop" | "banned_word" | "fsm_block";

/**
 * Persist a single deterministic-override event as an `AgentTrace` row.
 *
 * Sits on the user-visible reply path — must be best-effort. Any Prisma failure is
 * swallowed and logged via `logger.warn`; the function never throws.
 *
 * Schema mapping (per task 10.2 / Requirements §10.6, §15.5):
 *   - `tool`         = `args.tool ?? "(override)"` so admin tooling can filter override rows.
 *   - `args`         = `{ original, kind }` JSON so the pre-correction text is preserved.
 *   - `observation`  = the corrected text the agent will actually emit.
 *   - `errorCode`    = the override kind, e.g. `"banned_word"`, for SQL-level filtering.
 *   - `thought`      = the human-readable `reason` describing why the override fired.
 *   - `ok`           = `false` — overrides represent corrections, not normal tool success.
 */
export async function recordOverride(args: {
  tenantId: string;
  conversationId: string;
  psid: string;
  turnId: string;
  iter: number;
  kind: AgentOverrideKind;
  original: string;
  corrected: string;
  reason: string;
  tool?: string;
}): Promise<void> {
  const payload: Prisma.InputJsonValue = {
    original: args.original,
    kind: args.kind,
  };
  await prisma.agentTrace
    .create({
      data: {
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        psid: args.psid,
        turnId: args.turnId,
        iter: args.iter,
        tool: args.tool ?? "(override)",
        thought: args.reason,
        args: payload,
        ok: false,
        observation: args.corrected.slice(0, 4000),
        errorCode: args.kind,
      },
    })
    .catch((e: unknown) => logger.warn({ e: String(e), kind: args.kind }, "agentTrace recordOverride failed"));
}
