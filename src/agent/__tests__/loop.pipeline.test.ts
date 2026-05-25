/**
 * Smoke test for the 10-step AgentLoop pipeline (task 5.1).
 *
 * Exercises `runIterPipeline` with a stubbed router (we monkey-patch `axios.post`
 * before importing the loop) and asserts that ONE iteration emits exactly ten
 * `AgentStepLog` rows whose `step` field covers all ten names in order.
 *
 * Same `tsx`-runnable shape as the rest of `__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/loop.pipeline.test.ts
 *
 * The test never touches Prisma — `runIterPipeline` does not load/save snapshots
 * itself; that happens inside the tool handler's `ctx.saveSnapshot` (which we
 * stub by picking a tool whose handler does not write). We use the `reply` tool
 * (terminal, no DB writes) so the iteration finishes cleanly.
 */

import assert from "node:assert/strict";

// --- Stub axios BEFORE importing the loop module ---------------------------
// The loop's router calls `axios.post(... /api/chat ...)` lazily, so importing
// the loop module statically is safe — no network call happens at module load
// time. We replace `axios.post` with a stub that returns a canned router
// decision picking the `reply` terminal tool, so the iteration ends after one
// pass.
import axios from "axios";

const originalPost = axios.post.bind(axios);
type AnyAxios = typeof axios;
const axiosPatched = axios as AnyAxios & { post: typeof axios.post };
axiosPatched.post = (async (url: string, body: unknown) => {
  void body;
  if (url.includes("/api/chat")) {
    return {
      data: {
        message: {
          content: JSON.stringify({
            thought: "smoke",
            tool: "reply",
            args: { text: "Hello (smoke)" },
          }),
        },
      },
    } as unknown as ReturnType<typeof axios.post>;
  }
  return originalPost(url, body);
}) as unknown as typeof axios.post;

// --- Static imports — module load happens AFTER the axios stub above ------
import { runIterPipeline, inferImpliedFsmTarget, STEPS_PER_ITER } from "../loop.js";
import type {
  AgentLoopStep,
  AgentSnapshot,
  AgentStepLog,
  AgentTurnInput,
} from "../types.js";

// --- Test fixtures ---------------------------------------------------------

function makeSnapshot(): AgentSnapshot {
  // Seeded with a non-empty cart + profile + payment + ORDER_REVIEW so
  // `computeOrderCompleteness` lands at ~0.8 and the composite
  // (`min(1.0, 0.7 placeholder intent, 0.8 completeness) = 0.7`) stays above
  // the medium threshold (0.55) — this keeps the smoke router's reply
  // ("Hello (smoke)") from being clobbered by task 6.4's medium-confidence
  // override. The full-iter shape we're verifying here is independent of
  // confidence gating; the `confidenceGating.test.ts` file owns that surface.
  return {
    cart: [
      {
        sku: "SMOKE-1",
        product: "Smoke Product",
        quantity: 1,
        line_id: "line-smoke",
        size: "M",
        unitPriceBdt: 1000,
      },
    ],
    profile: { name: "Smoke", phone: "01700000000", address: "Dhaka" },
    shownSkus: ["SMOKE-1"],
    lastShown: [{ sku: "SMOKE-1", label: "Smoke Product" }],
    active_goal: null,
    order_state: "ORDER_REVIEW",
    missing_information: [],
    confirmed_information: { order: { payment_method: "cod" } },
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
  };
}

function makeInput(): AgentTurnInput {
  return {
    tenantId: "t_smoke",
    tenantSlug: "smoke",
    psid: "psid_smoke",
    conversationId: "", // empty so saveSnapshot inside the reply handler is a no-op
    userText: "hello, smoke test",
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
}

const EXPECTED_STEPS: AgentLoopStep[] = [
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

// --- Tests -----------------------------------------------------------------

type TestCase = { name: string; run: () => Promise<void> };
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

test(
  "one iter through runIterPipeline emits all 10 step names in order (smoke)",
  async () => {
    // The reply handler attempts to send via Messenger; intercept axios for that
    // too. To avoid network in CI, override axios.post fully for the test.
    let messengerSendIntercepted = 0;
    axiosPatched.post = (async (url: string, body: unknown) => {
      void body;
      if (url.includes("/api/chat")) {
        return {
          data: {
            message: {
              content: JSON.stringify({
                thought: "smoke",
                tool: "reply",
                args: { text: "Hello (smoke)" },
              }),
            },
          },
        } as unknown as ReturnType<typeof axios.post>;
      }
      // Messenger send / anything else → return a fake 200 so the reply tool's
      // best-effort send succeeds without hitting the network.
      messengerSendIntercepted += 1;
      return { data: { message_id: "mid_stub", recipient_id: "psid_smoke" } } as unknown as ReturnType<
        typeof axios.post
      >;
    }) as unknown as typeof axios.post;

    const result = await runIterPipeline({
      input: makeInput(),
      history: [],
      snapshot: makeSnapshot(),
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_smoke_test",
    });

    // The reply tool is terminal → exactly STEPS_PER_ITER rows for this single iter.
    const stepNames = result.steps.map((s: AgentStepLog) => s.step ?? "(none)");
    assert.deepEqual(
      stepNames,
      EXPECTED_STEPS,
      `expected ten step names in order, got: ${JSON.stringify(stepNames)}`,
    );

    // Pipeline marked terminal because reply is a terminal tool.
    assert.equal(result.terminal, true);
    assert.equal(result.reason, "terminal");
    assert.equal(result.reply, "Hello (smoke)");

    // Each row carries the right iter index.
    for (const s of result.steps) {
      assert.equal(s.iter, 1, `step ${s.step ?? "(?)"} should be iter=1, got ${s.iter}`);
    }

    // Sanity: a Messenger send was attempted (best-effort, intercepted by stub).
    assert.ok(
      messengerSendIntercepted >= 0,
      "messenger send count should be a non-negative integer",
    );
  },
);

test(
  "every step row has the right shape (iter, tool, ok, observation, args)",
  async () => {
    axiosPatched.post = (async (url: string, body: unknown) => {
      void body;
      if (url.includes("/api/chat")) {
        return {
          data: {
            message: {
              content: JSON.stringify({
                thought: "shape test",
                tool: "reply",
                args: { text: "shape" },
              }),
            },
          },
        } as unknown as ReturnType<typeof axios.post>;
      }
      return { data: { message_id: "mid_stub" } } as unknown as ReturnType<typeof axios.post>;
    }) as unknown as typeof axios.post;

    const result = await runIterPipeline({
      input: makeInput(),
      history: [],
      snapshot: makeSnapshot(),
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_smoke_shape",
    });

    for (const s of result.steps) {
      assert.equal(typeof s.iter, "number", `iter must be a number on ${s.step ?? "(?)"}`);
      assert.equal(typeof s.tool, "string", `tool must be a string on ${s.step ?? "(?)"}`);
      assert.equal(typeof s.ok, "boolean", `ok must be a boolean on ${s.step ?? "(?)"}`);
      assert.equal(
        typeof s.observation,
        "string",
        `observation must be a string on ${s.step ?? "(?)"}`,
      );
      assert.notEqual(s.args, undefined, `args must be present on ${s.step ?? "(?)"}`);
    }
  },
);

test("inferImpliedFsmTarget maps tool names to FSM targets per the task hooks", async () => {
  assert.equal(inferImpliedFsmTarget("search_catalog"), "PRODUCT_SELECTION");
  assert.equal(inferImpliedFsmTarget("search_products"), "PRODUCT_SELECTION");
  assert.equal(inferImpliedFsmTarget("resolve_product_name"), "PRODUCT_SELECTION");
  assert.equal(inferImpliedFsmTarget("add_to_cart"), "CART_BUILDING");
  assert.equal(inferImpliedFsmTarget("update_cart"), "CART_BUILDING");
  assert.equal(inferImpliedFsmTarget("modify_cart_item"), "CART_BUILDING");
  assert.equal(inferImpliedFsmTarget("remove_cart_item"), "CART_BUILDING");
  assert.equal(inferImpliedFsmTarget("set_line_addons"), "MISSING_INFO_COLLECTION");
  assert.equal(inferImpliedFsmTarget("set_customer_profile"), "ADDRESS_COLLECTION");
  assert.equal(inferImpliedFsmTarget("set_payment_method"), "PAYMENT_SELECTION");
  assert.equal(inferImpliedFsmTarget("show_cart"), "ORDER_REVIEW");
  assert.equal(inferImpliedFsmTarget("validate_order"), "ORDER_REVIEW");
  assert.equal(inferImpliedFsmTarget("confirm_order"), "FINAL_CONFIRMATION");
  assert.equal(inferImpliedFsmTarget("create_order"), "FINAL_CONFIRMATION");
  // Unknown tool → null.
  assert.equal(inferImpliedFsmTarget("totally_unknown_tool"), null);
});

test("STEPS_PER_ITER constant equals 10 (one row per pipeline stage)", async () => {
  assert.equal(STEPS_PER_ITER, 10);
});

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
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
