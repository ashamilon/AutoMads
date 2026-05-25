/**
 * Tests for `recordOverride` (task 10.2; Requirements §10.6, §15.5).
 *
 * Verifies that:
 *   1. A captured `AgentTrace` row carries `tool="(override)"`, `errorCode=<kind>`,
 *      `observation=<corrected>`, and `args = { original, kind }`.
 *   2. The function does NOT throw when the Prisma client rejects (the override
 *      writer sits on the user-visible reply path and must be best-effort).
 *
 * Same `tsx`-runnable pattern as the other agent tests (no external runner). Run via:
 *
 *     npx tsx src/agent/__tests__/recordOverride.test.ts
 *
 * We stub `prisma.agentTrace.create` with an in-memory recorder so the test stays
 * hermetic. The stub is restored after the suite.
 */

import assert from "node:assert/strict";
import { prisma } from "../../db/prisma.js";
import { recordOverride } from "../trace.js";

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
};

const captured: RecordedRow[] = [];
let nextRejection: Error | null = null;

const realCreate = prisma.agentTrace.create.bind(prisma.agentTrace);

(prisma.agentTrace as unknown as { create: typeof prisma.agentTrace.create }).create = (async (
  args: { data: RecordedRow },
) => {
  if (nextRejection) {
    const err = nextRejection;
    nextRejection = null;
    throw err;
  }
  captured.push(args.data);
  return args.data as unknown as ReturnType<typeof prisma.agentTrace.create>;
}) as unknown as typeof prisma.agentTrace.create;

function resetCaptured(): void {
  captured.length = 0;
  nextRejection = null;
}

// ---- Tests ----------------------------------------------------------------

test("recordOverride writes a row with tool=(override), errorCode=banned_word, original/kind in args", async () => {
  resetCaptured();

  await recordOverride({
    tenantId: "tenant-1",
    conversationId: "conv-1",
    psid: "psid-1",
    turnId: "turn-1",
    iter: 4,
    kind: "banned_word",
    original: "checkout korte parben",
    corrected: "order confirm korte parben",
    reason: "reply filter rewrote banned word 'checkout'",
  });

  assert.equal(captured.length, 1, "expected exactly one persisted row");
  const row = captured[0]!;

  assert.equal(row.tool, "(override)", `tool should be "(override)", got ${row.tool}`);
  assert.equal(row.errorCode, "banned_word", `errorCode should be the override kind`);
  assert.equal(
    row.observation,
    "order confirm korte parben",
    "observation should hold the corrected text",
  );
  assert.equal(row.ok, false, "override rows are corrections; ok must be false");
  assert.equal(row.tenantId, "tenant-1");
  assert.equal(row.conversationId, "conv-1");
  assert.equal(row.psid, "psid-1");
  assert.equal(row.turnId, "turn-1");
  assert.equal(row.iter, 4);
  assert.equal(row.thought, "reply filter rewrote banned word 'checkout'");

  const a = row.args as Record<string, unknown>;
  assert.ok(a && typeof a === "object", "args must be an object");
  assert.equal(
    a["original"],
    "checkout korte parben",
    "args.original must hold the pre-correction text",
  );
  assert.equal(a["kind"], "banned_word", "args.kind must mirror the override kind");
});

test("recordOverride accepts an explicit tool override (e.g. (anti_loop))", async () => {
  resetCaptured();

  await recordOverride({
    tenantId: "tenant-1",
    conversationId: "conv-1",
    psid: "psid-1",
    turnId: "turn-2",
    iter: 1,
    kind: "anti_loop",
    original: "size kon ta lagbe?",
    corrected: "skipping repeated slot",
    reason: "MAX_SLOT_ATTEMPTS exceeded for size",
    tool: "(anti_loop)",
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.tool, "(anti_loop)", "explicit tool override should win");
  assert.equal(captured[0]!.errorCode, "anti_loop");
});

test("recordOverride does NOT throw when Prisma rejects (best-effort behaviour)", async () => {
  resetCaptured();
  nextRejection = new Error("simulated prisma failure");

  // The function returns a Promise<void> and must resolve, not reject.
  await assert.doesNotReject(async () => {
    await recordOverride({
      tenantId: "tenant-1",
      conversationId: "conv-1",
      psid: "psid-1",
      turnId: "turn-3",
      iter: 0,
      kind: "anti_hallucination",
      original: "add SKU-FAKE",
      corrected: "add SKU-REAL",
      reason: "SKU grounding guard rewrote hallucinated sku",
    });
  });

  // Nothing should have been captured because the create() call rejected.
  assert.equal(captured.length, 0, "no row should be captured when Prisma rejects");
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

  // Restore the Prisma stub so sibling test files don't see our recorder.
  (prisma.agentTrace as unknown as { create: typeof prisma.agentTrace.create }).create = realCreate;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
