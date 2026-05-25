/**
 * Trace persistence tests for task 5.2 (Req 5.2, 5.3, 11.6, 15.1, 15.2).
 *
 * Verifies that:
 *   1. `persistTurnTrace` writes one `AgentTrace` row per `AgentStepLog`, not just one
 *      per tool execution.
 *   2. Every row's `args` JSON column carries the `fsmState`, `confidenceLevel`, and
 *      `confidence_scores` keys so downstream replay tooling has a populated
 *      `confidenceLevel` on every persisted step.
 *   3. The `step` name from each `AgentStepLog` is mirrored into the `args` payload so
 *      SQL queries can filter by named pipeline stage without joining a sibling table.
 *
 * Same `tsx`-runnable pattern as the other agent tests (no external runner). Run via:
 *
 *     npx tsx src/agent/__tests__/trace.confidence.test.ts
 *
 * We stub `prisma.agentTrace.createMany` (and the fallback single-row `.create`) with
 * an in-memory recorder so the test stays hermetic. Stubs are restored after the suite.
 */

import assert from "node:assert/strict";
import { prisma } from "../../db/prisma.js";
import { persistTurnTrace } from "../trace.js";
import type {
  AgentLoopStep,
  AgentRunOutcome,
  AgentStepLog,
  AgentTurnInput,
} from "../types.js";

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

// ---- Prisma stubs ---------------------------------------------------------

type RecordedRow = {
  tenantId: string;
  conversationId: string;
  psid: string;
  turnId: string;
  iter: number;
  tool: string;
  thought: string | null;
  args: unknown;
  ok: boolean;
  observation: string;
  errorCode: string | null;
  llmLatencyMs: number;
  toolLatencyMs: number;
  finalReason: string | null;
};

const captured: RecordedRow[] = [];

const realCreateMany = prisma.agentTrace.createMany.bind(prisma.agentTrace);
const realCreate = prisma.agentTrace.create.bind(prisma.agentTrace);

(prisma.agentTrace as unknown as { createMany: typeof prisma.agentTrace.createMany }).createMany =
  (async (args: { data: RecordedRow[] }) => {
    for (const row of args.data) captured.push(row);
    return { count: args.data.length };
  }) as unknown as typeof prisma.agentTrace.createMany;

(prisma.agentTrace as unknown as { create: typeof prisma.agentTrace.create }).create = (async (
  args: { data: RecordedRow },
) => {
  captured.push(args.data);
  return args.data as unknown as ReturnType<typeof prisma.agentTrace.create>;
}) as unknown as typeof prisma.agentTrace.create;

function resetCaptured(): void {
  captured.length = 0;
}

// ---- Fixtures -------------------------------------------------------------

function makeInput(): AgentTurnInput {
  return {
    tenantId: "tenant-1",
    tenantSlug: "demo",
    psid: "psid-1",
    conversationId: "conv-1",
    userText: "hello",
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
}

const STEP_NAMES: AgentLoopStep[] = [
  "observe_input",
  "retrieve_session",
  "retrieve_cart",
  "detect_intent",
  "detect_missing_info",
  "choose_action",
  "choose_tools",
  "verify_pre_response",
  "generate_response",
  "save_memory",
];

/** Build a fully-populated step row carrying the new task-5.2 fields. */
function makeStep(args: {
  iter: number;
  step: AgentLoopStep;
  tool?: string;
  argsPayload?: Record<string, unknown>;
  ok?: boolean;
  observation?: string;
  fsmState?: AgentStepLog["fsmState"];
  confidenceLevel?: number;
  confidenceScores?: AgentStepLog["confidence_scores"];
}): AgentStepLog {
  return {
    iter: args.iter,
    step: args.step,
    tool: args.tool ?? "(step)",
    args: args.argsPayload ?? {},
    ok: args.ok ?? true,
    observation: args.observation ?? `${args.step} ok`,
    llmLatencyMs: 0,
    toolLatencyMs: 0,
    fsmState: args.fsmState ?? "BROWSING",
    confidenceLevel: args.confidenceLevel ?? 0.92,
    confidence_scores: args.confidenceScores ?? {
      product_match: 0.95,
      intent: 0.92,
      order_completeness: 1.0,
    },
  };
}

// ---- Tests ----------------------------------------------------------------

test("persistTurnTrace writes one row per step (≥10 rows for a full pipeline iter)", async () => {
  resetCaptured();
  const steps: AgentStepLog[] = STEP_NAMES.map((name, i) =>
    makeStep({ iter: 1, step: name, argsPayload: { idx: i } }),
  );
  const outcome: AgentRunOutcome = { steps, reason: "terminal", reply: "hi" };

  await persistTurnTrace({ input: makeInput(), turnId: "turn-1", outcome });

  assert.equal(
    captured.length,
    10,
    `expected 10 persisted rows for one full iter, got ${captured.length}`,
  );

  const persistedStepNames = captured.map((r) => {
    const a = r.args as Record<string, unknown>;
    return a["step"] as string;
  });
  assert.deepEqual(
    persistedStepNames,
    STEP_NAMES,
    `persisted step order should match emitted order, got: ${JSON.stringify(persistedStepNames)}`,
  );
});

test("every persisted row carries fsmState, confidenceLevel, and confidence_scores in args", async () => {
  resetCaptured();
  const steps: AgentStepLog[] = STEP_NAMES.map((name) =>
    makeStep({
      iter: 1,
      step: name,
      fsmState: "CART_BUILDING",
      confidenceLevel: 0.73,
      confidenceScores: { product_match: 0.85, intent: 0.73, order_completeness: 0.9 },
    }),
  );
  const outcome: AgentRunOutcome = { steps, reason: "terminal", reply: null };

  await persistTurnTrace({ input: makeInput(), turnId: "turn-2", outcome });

  for (const row of captured) {
    const a = row.args as Record<string, unknown>;
    assert.equal(
      a["fsmState"],
      "CART_BUILDING",
      `row for tool="${row.tool}" should have fsmState=CART_BUILDING in args`,
    );
    assert.equal(
      typeof a["confidenceLevel"],
      "number",
      `row for tool="${row.tool}" should have a numeric confidenceLevel in args`,
    );
    assert.equal(
      a["confidenceLevel"],
      0.73,
      `row for tool="${row.tool}" should have confidenceLevel=0.73`,
    );
    const triple = a["confidence_scores"] as Record<string, unknown>;
    assert.ok(triple && typeof triple === "object", "confidence_scores must be an object");
    assert.equal(triple["product_match"], 0.85);
    assert.equal(triple["intent"], 0.73);
    assert.equal(triple["order_completeness"], 0.9);
  }
});

test("persisted args preserves the step's original payload alongside the new keys", async () => {
  resetCaptured();
  const steps: AgentStepLog[] = [
    makeStep({
      iter: 1,
      step: "generate_response",
      tool: "search_catalog",
      argsPayload: { q: "argentina jersey", limit: 5 },
      observation: "found 3 candidates",
    }),
  ];
  const outcome: AgentRunOutcome = { steps, reason: "terminal", reply: null };

  await persistTurnTrace({ input: makeInput(), turnId: "turn-3", outcome });

  assert.equal(captured.length, 1);
  const a = captured[0]!.args as Record<string, unknown>;
  // Original payload preserved.
  assert.equal(a["q"], "argentina jersey");
  assert.equal(a["limit"], 5);
  // New keys present.
  assert.equal(a["fsmState"], "BROWSING");
  assert.equal(typeof a["confidenceLevel"], "number");
  assert.equal(a["step"], "generate_response");
});

test("a non-object args payload is preserved under args.value alongside the new keys", async () => {
  resetCaptured();
  const stepWithScalarArgs: AgentStepLog = {
    iter: 1,
    step: "observe_input",
    tool: "(step)",
    args: "scalar-payload" as unknown,
    ok: true,
    observation: "obs",
    llmLatencyMs: 0,
    toolLatencyMs: 0,
    fsmState: "PRODUCT_SELECTION",
    confidenceLevel: 0.6,
    confidence_scores: { product_match: 0.7, intent: 0.6, order_completeness: 0.8 },
  };

  await persistTurnTrace({
    input: makeInput(),
    turnId: "turn-4",
    outcome: { steps: [stepWithScalarArgs], reason: "terminal", reply: null },
  });

  assert.equal(captured.length, 1);
  const a = captured[0]!.args as Record<string, unknown>;
  assert.equal(a["value"], "scalar-payload", "scalar payload should land under args.value");
  assert.equal(a["fsmState"], "PRODUCT_SELECTION");
  assert.equal(a["confidenceLevel"], 0.6);
});

test("rows without the new fields still persist (legacy path keeps working)", async () => {
  resetCaptured();
  const legacyStep: AgentStepLog = {
    iter: 1,
    step: "observe_input",
    tool: "(step)",
    args: { hello: "world" },
    ok: true,
    observation: "legacy",
    llmLatencyMs: 0,
    toolLatencyMs: 0,
    // intentionally NO fsmState / confidenceLevel / confidence_scores
  };
  await persistTurnTrace({
    input: makeInput(),
    turnId: "turn-5",
    outcome: { steps: [legacyStep], reason: "terminal", reply: null },
  });

  assert.equal(captured.length, 1);
  const a = captured[0]!.args as Record<string, unknown>;
  assert.equal(a["hello"], "world");
  assert.equal(a["step"], "observe_input");
  // The new keys are absent — the trace writer must not invent values.
  assert.equal("fsmState" in a, false);
  assert.equal("confidenceLevel" in a, false);
  assert.equal("confidence_scores" in a, false);
});

// ---- Driver ---------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      failed += 1;
    }
  }

  // Restore Prisma stubs so sibling test files don't see our recorder.
  (prisma.agentTrace as unknown as { createMany: typeof prisma.agentTrace.createMany }).createMany =
    realCreateMany;
  (prisma.agentTrace as unknown as { create: typeof prisma.agentTrace.create }).create = realCreate;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
