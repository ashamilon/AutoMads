/**
 * Anti-Loop Guard test (task 5.3, Reqs 8.5, 12.6, 14.5).
 *
 * Two cases drive `runIterPipeline` with a stubbed router that picks `reply`
 * with a slot-question text ("Apnar address ta din please?"):
 *
 *   Case A — `missing_information: [{ slot: "address", attempts: 2 }]` is
 *            already at the cap. The guard MUST swap the reply for the
 *            FSM-aware fallback and the `verify_pre_response` row MUST carry
 *            an `antiLoop: true` marker. The customer-facing text is the
 *            fallback summary, NOT the original address question.
 *
 *   Case B — `missing_information: [{ slot: "address", attempts: 0 }]`. Same
 *            stubbed reply. The reply IS the original "address ta din" text
 *            (no override) and after the iter the slot's `attempts` is 1
 *            (incremented).
 *
 * Run via:
 *
 *     npx tsx src/agent/__tests__/antiLoopGuard.test.ts
 */

import assert from "node:assert/strict";

// --- Stub axios BEFORE importing the loop module ---------------------------
// The loop's router calls `axios.post(... /api/chat ...)` lazily; install a
// stub that returns a canned `reply` decision asking for the address slot.
// Messenger sends from the reply tool's terminal handler are intercepted with
// a fake 200 so the test never hits the network.
import axios from "axios";

const originalPost = axios.post.bind(axios);
type AnyAxios = typeof axios;
const axiosPatched = axios as AnyAxios & { post: typeof axios.post };

/**
 * Install an axios.post stub that returns the supplied router decision for
 * any `/api/chat` call and a fake 200 for everything else (Messenger sends).
 */
function installRouterStub(decision: { tool: string; args: Record<string, unknown>; thought?: string }): void {
  axiosPatched.post = (async (url: string, body: unknown) => {
    void body;
    if (url.includes("/api/chat")) {
      return {
        data: {
          message: {
            content: JSON.stringify({
              thought: decision.thought ?? "stub",
              tool: decision.tool,
              args: decision.args,
            }),
          },
        },
      } as unknown as ReturnType<typeof axios.post>;
    }
    return { data: { message_id: "mid_stub", recipient_id: "psid_stub" } } as unknown as ReturnType<
      typeof axios.post
    >;
  }) as unknown as typeof axios.post;
}

installRouterStub({ tool: "reply", args: { text: "init" } });

// --- Static imports — module load happens AFTER the axios stub above -------
import { runIterPipeline } from "../loop.js";
import { MAX_SLOT_ATTEMPTS } from "../state.js";
import type { AgentSnapshot, AgentStepLog, AgentTurnInput } from "../types.js";

function restoreAxios(): void {
  axiosPatched.post = originalPost as unknown as typeof axios.post;
}

// --- Test fixtures ---------------------------------------------------------

/**
 * Build a snapshot with a single order-level missing slot for `address`. The
 * `attempts` count is supplied by the caller so the same factory drives both
 * the at-cap and below-cap test cases.
 */
function makeSnapshotWithAddressSlot(attempts: number): AgentSnapshot {
  return {
    cart: [
      {
        sku: "ARG-HOME-24",
        product: "Argentina Home Jersey",
        quantity: 1,
        line_id: "line-J",
        size: "L",
        unitPriceBdt: 1500,
      },
    ],
    profile: {},
    shownSkus: [],
    lastShown: [],
    active_goal: null,
    order_state: "ADDRESS_COLLECTION",
    missing_information: [{ slot: "address", attempts }],
    confirmed_information: {},
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
  };
}

function makeInput(userText: string): AgentTurnInput {
  return {
    tenantId: "t_anti_loop",
    tenantSlug: "anti",
    // SIM_ prefix → `isSimulatorPsid` short-circuits Messenger sends so the
    // reply tool's terminal handler doesn't try to hit Graph API.
    psid: "SIM_anti",
    conversationId: "", // empty so saveSnapshot is a no-op (no DB roundtrip)
    userText,
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
}

const ADDRESS_QUESTION_TEXT = "Apnar address ta din please?";

// --- Tiny tsx-runnable harness --------------------------------------------

type TestCase = { name: string; run: () => Promise<void> };
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

function findStep(steps: AgentStepLog[], step: AgentStepLog["step"]): AgentStepLog {
  const row = steps.find((s) => s.step === step);
  assert.ok(row, `expected a ${step ?? "(none)"} step in the pipeline output`);
  return row;
}

// --- Sanity check ---------------------------------------------------------

test("MAX_SLOT_ATTEMPTS is exposed as 2 (sanity)", async () => {
  // The guard fires when `attempts >= MAX_SLOT_ATTEMPTS`, so the test fixtures
  // below assume MAX_SLOT_ATTEMPTS === 2. Pin it here so a future change to
  // the constant breaks this test loudly instead of silently changing
  // behaviour expectations.
  assert.equal(MAX_SLOT_ATTEMPTS, 2);
});

// --- Tests ----------------------------------------------------------------

test(
  "case A: attempts >= MAX_SLOT_ATTEMPTS → reply swapped for FSM-aware fallback",
  async () => {
    installRouterStub({
      tool: "reply",
      args: { text: ADDRESS_QUESTION_TEXT },
      thought: "ask for address (third try)",
    });

    const snapshot = makeSnapshotWithAddressSlot(MAX_SLOT_ATTEMPTS);
    const result = await runIterPipeline({
      input: makeInput("ji"),
      history: [],
      snapshot,
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_anti_loop_caseA",
    });

    // verify_pre_response row carries the anti_loop override marker.
    const verify = findStep(result.steps, "verify_pre_response");
    const verifyArgs = verify.args as Record<string, unknown>;
    assert.equal(
      verifyArgs.antiLoop,
      true,
      `verify_pre_response.args.antiLoop must be true when guard fires; got ${JSON.stringify(verifyArgs)}`,
    );
    assert.equal(
      verify.tool,
      "reply",
      `verify_pre_response.tool must remain reply, got ${verify.tool}`,
    );

    // The terminal reply text is the fallback summary, NOT the original address question.
    assert.equal(result.terminal, true, "the reply tool should terminate the iteration");
    assert.ok(result.reply, "a reply text must be produced");
    const replyText = result.reply ?? "";
    assert.notEqual(
      replyText,
      ADDRESS_QUESTION_TEXT,
      `reply must not be the original address question, got: ${replyText}`,
    );
    // Fallback should reference the slot in the message body.
    assert.ok(
      /address/i.test(replyText),
      `fallback reply should mention the troublesome slot, got: ${replyText}`,
    );
    // Fallback summarises the cart so the customer doesn't feel reset (Req 12.1).
    assert.ok(
      /jersey/i.test(replyText),
      `fallback reply should summarise understood cart items, got: ${replyText}`,
    );
  },
);

test(
  "case B: attempts < MAX_SLOT_ATTEMPTS → reply unchanged; attempts is incremented",
  async () => {
    installRouterStub({
      tool: "reply",
      args: { text: ADDRESS_QUESTION_TEXT },
      thought: "ask for address (first try)",
    });

    const snapshot = makeSnapshotWithAddressSlot(0);
    const result = await runIterPipeline({
      input: makeInput("ji"),
      history: [],
      snapshot,
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_anti_loop_caseB",
    });

    // verify_pre_response row should NOT carry the anti_loop marker (the
    // guard only increments `attempts`, it doesn't override the reply).
    const verify = findStep(result.steps, "verify_pre_response");
    const verifyArgs = verify.args as Record<string, unknown>;
    assert.notEqual(
      verifyArgs.antiLoop,
      true,
      `verify_pre_response.args.antiLoop must NOT be true on a below-cap turn; got ${JSON.stringify(verifyArgs)}`,
    );

    // The reply IS the original address question text (no override).
    assert.equal(result.terminal, true, "the reply tool should terminate the iteration");
    assert.equal(
      result.reply,
      ADDRESS_QUESTION_TEXT,
      `reply text must be the original address question, got: ${result.reply}`,
    );

    // The working snapshot's address slot now has attempts=1.
    const addressSlot = result.snapshot.missing_information.find((s) => s.slot === "address");
    assert.ok(addressSlot, "address slot must still be in missing_information");
    assert.equal(
      addressSlot?.attempts,
      1,
      `address slot's attempts must be incremented to 1, got ${addressSlot?.attempts}`,
    );
  },
);

// --- Runner ---------------------------------------------------------------

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
    restoreAxios();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
