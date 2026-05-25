/**
 * Task 5.2 verification — `persistTurnTrace` writes one `AgentTrace` row per
 * pipeline step (not just per tool execution), and every row's `args` JSON
 * column carries the new step-level metadata: `step`, `fsmState`,
 * `confidenceLevel`, and the `confidence_scores` triple.
 *
 * Coverage anchors (Req 5.2, 5.3, 11.6, 15.1, 15.2):
 *   - Build a fake `AgentRunOutcome` with one `AgentStepLog` per named pipeline
 *     stage (10 rows total).
 *   - Stub `prisma.agentTrace.createMany` / `.create` with an in-memory
 *     recorder so the test never touches Postgres.
 *   - Assert exactly 10 rows persisted, with distinct `args.step` values
 *     covering the full pipeline.
 *   - Assert every row's `args` carries a populated `fsmState` AND a numeric
 *     `confidenceLevel`.
 *   - Assert non-tool stages persist with `tool === "(step)"` while tool
 *     stages keep the tool name.
 *
 * Runnable via `npx tsx`. Same self-driving harness pattern as the sibling
 * tests under this folder — no external runner needed.
 *
 *     npx tsx src/agent/__tests__/agentTraceRows.test.ts
 *
 * The Prisma stubs are restored in a `finally` block so other test files that
 * import `prisma` afterwards see the real client again.
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

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type TestCase = { name: string; run: () => Promise<void> | void };
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

// ---------------------------------------------------------------------------
// Prisma stubs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInput(): AgentTurnInput {
  return {
    tenantId: "tenant-task-5-2",
    tenantSlug: "demo",
    psid: "psid-task-5-2",
    conversationId: "conv-task-5-2",
    userText: "argentina jersey nibo",
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
}

/**
 * Stage → tool name. Non-tool stages persist with `tool="(step)"` per the task
 * brief; the LLM stages (`choose_action`, `choose_tools`, `generate_response`)
 * carry a real tool name on the row to match what `loop.ts` emits today.
 */
const PIPELINE: Array<{ step: AgentLoopStep; tool: string }> = [
  { step: "observe_input", tool: "(step)" },
  { step: "retrieve_session", tool: "(step)" },
  { step: "retrieve_cart", tool: "(step)" },
  { step: "detect_intent", tool: "(step)" },
  { step: "detect_missing_info", tool: "(step)" },
  { step: "choose_action", tool: "search_catalog" },
  { step: "choose_tools", tool: "search_catalog" },
  { step: "verify_pre_response", tool: "search_catalog" },
  { step: "generate_response", tool: "search_catalog" },
  { step: "save_memory", tool: "(step)" },
];

/** Build a 10-step `AgentRunOutcome` covering every named pipeline stage. */
function makeFullPipelineOutcome(args: {
  fsmState: AgentStepLog["fsmState"];
  confidenceLevel: number;
}): AgentRunOutcome {
  const steps: AgentStepLog[] = PIPELINE.map((p, idx) => ({
    iter: 1,
    step: p.step,
    tool: p.tool,
    args: { idx, hint: `${p.step} payload` },
    ok: true,
    observation: `${p.step} ok`,
    llmLatencyMs: p.tool === "(step)" ? 0 : 12,
    toolLatencyMs: p.tool === "(step)" ? 0 : 8,
    fsmState: args.fsmState,
    confidenceLevel: args.confidenceLevel,
    confidence_scores: {
      product_match: 0.9,
      intent: args.confidenceLevel,
      order_completeness: 0.95,
    },
  }));
  return { steps, reason: "terminal", reply: "ok" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("persistTurnTrace writes one row per step (10 rows for one full iter)", async () => {
  resetCaptured();
  const outcome = makeFullPipelineOutcome({ fsmState: "BROWSING", confidenceLevel: 0.84 });

  await persistTurnTrace({ input: makeInput(), turnId: "t-rows-1", outcome });

  assert.equal(
    captured.length,
    10,
    `expected 10 persisted rows for one full iter, got ${captured.length}`,
  );

  // Distinct step values, in the exact pipeline order.
  const persistedSteps = captured.map((r) => (r.args as Record<string, unknown>)["step"] as string);
  const distinct = new Set(persistedSteps);
  assert.equal(distinct.size, 10, `expected 10 distinct step values, got ${distinct.size}`);
  assert.deepEqual(
    persistedSteps,
    PIPELINE.map((p) => p.step),
    "persisted step order should match the emitted pipeline order",
  );
});

test("every persisted row has populated args.fsmState and numeric args.confidenceLevel", async () => {
  resetCaptured();
  const outcome = makeFullPipelineOutcome({
    fsmState: "CART_BUILDING",
    confidenceLevel: 0.71,
  });

  await persistTurnTrace({ input: makeInput(), turnId: "t-rows-2", outcome });

  assert.equal(captured.length, 10);
  for (const row of captured) {
    const a = row.args as Record<string, unknown>;
    assert.equal(
      a["fsmState"],
      "CART_BUILDING",
      `row tool="${row.tool}" step="${a["step"] as string}" must carry fsmState=CART_BUILDING`,
    );
    assert.equal(
      typeof a["confidenceLevel"],
      "number",
      `row tool="${row.tool}" step="${a["step"] as string}" must carry a numeric confidenceLevel`,
    );
    assert.equal(a["confidenceLevel"], 0.71);
    const triple = a["confidence_scores"] as Record<string, unknown>;
    assert.ok(triple && typeof triple === "object", "args.confidence_scores must be an object");
    assert.equal(typeof triple["product_match"], "number");
    assert.equal(typeof triple["intent"], "number");
    assert.equal(typeof triple["order_completeness"], "number");
  }
});

test("non-tool stages persist with tool='(step)' while tool stages keep the tool name", async () => {
  resetCaptured();
  const outcome = makeFullPipelineOutcome({ fsmState: "BROWSING", confidenceLevel: 0.9 });

  await persistTurnTrace({ input: makeInput(), turnId: "t-rows-3", outcome });

  // Build a step → row index from the captured rows so we can compare against
  // the PIPELINE expectation table.
  for (const row of captured) {
    const stepName = (row.args as Record<string, unknown>)["step"] as string;
    const expected = PIPELINE.find((p) => p.step === stepName);
    assert.ok(expected, `unexpected step persisted: ${stepName}`);
    assert.equal(
      row.tool,
      expected.tool,
      `step="${stepName}" expected tool="${expected.tool}" but got tool="${row.tool}"`,
    );
  }
});

test("only the LAST row carries finalReason; earlier rows leave it null", async () => {
  resetCaptured();
  const outcome = makeFullPipelineOutcome({ fsmState: "BROWSING", confidenceLevel: 0.9 });

  await persistTurnTrace({ input: makeInput(), turnId: "t-rows-4", outcome });

  const finalReasons = captured.map((r) => r.finalReason);
  // First nine rows: null; last row: "terminal".
  for (let i = 0; i < 9; i += 1) {
    assert.equal(
      finalReasons[i],
      null,
      `row ${i} (step="${(captured[i]!.args as Record<string, unknown>)["step"] as string}") should have finalReason=null`,
    );
  }
  assert.equal(finalReasons[9], "terminal", "last row should carry finalReason='terminal'");
});

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  try {
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
  } finally {
    // Restore the real Prisma client methods so sibling tests imported in the
    // same process don't pick up our recorder.
    (prisma.agentTrace as unknown as { createMany: typeof prisma.agentTrace.createMany }).createMany =
      realCreateMany;
    (prisma.agentTrace as unknown as { create: typeof prisma.agentTrace.create }).create =
      realCreate;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
