/**
 * FSM transition enforcement test (task 5.4, Reqs 7.4, 7.5, 7.6).
 *
 * Two cases drive `runIterPipeline`:
 *
 *   Case A — Snapshot at `FINAL_CONFIRMATION` with profile incomplete (no
 *            address) and a non-empty cart. Stub the router to pick
 *            `confirm_order`. The implied FSM target for `confirm_order` is
 *            `FINAL_CONFIRMATION`. `canTransition(FINAL_CONFIRMATION,
 *            FINAL_CONFIRMATION, snapshot)` must FAIL because the profile is
 *            incomplete (precondition `FINAL_CONFIRMATION_precondition_profile_incomplete`).
 *            The loop MUST override the action by routing to a `reply` whose
 *            text mentions the missing precondition (e.g. "address"), and the
 *            verify_pre_response trace row MUST carry `fsmBlocked: true`.
 *
 *   Case B — Snapshot at `ORDER_COMPLETE` with a populated cart. After
 *            `saveMemory`, the snapshot's cart MUST be empty and order_state
 *            MUST be `BROWSING` (Req 7.6 reset).
 *
 * Run via:
 *
 *     npx tsx src/agent/__tests__/fsmEnforcement.test.ts
 */

import assert from "node:assert/strict";

// --- Stub axios BEFORE importing the loop module ---------------------------
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
import type { AgentSnapshot, AgentStepLog, AgentTurnInput } from "../types.js";

function restoreAxios(): void {
  axiosPatched.post = originalPost as unknown as typeof axios.post;
}

// --- Test fixtures ---------------------------------------------------------

function makeInput(userText: string): AgentTurnInput {
  return {
    tenantId: "t_fsm",
    tenantSlug: "fsm",
    // SIM_ prefix → `isSimulatorPsid` short-circuits Messenger sends.
    psid: "SIM_fsm",
    conversationId: "", // empty so saveSnapshot is a no-op
    userText,
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
}

/** Snapshot in FINAL_CONFIRMATION with profile incomplete (no address) and a populated cart. */
function snapshotAtFinalConfirmationMissingAddress(): AgentSnapshot {
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
    profile: { name: "Asham", phone: "01700000000" }, // address missing
    shownSkus: [],
    lastShown: [],
    active_goal: null,
    order_state: "FINAL_CONFIRMATION",
    missing_information: [],
    confirmed_information: {},
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
  };
}

/** Snapshot already at ORDER_COMPLETE with a populated cart (Req 7.6 reset target). */
function snapshotAtOrderComplete(): AgentSnapshot {
  return {
    cart: [
      {
        sku: "BRA-HOME-24",
        product: "Brazil Home Jersey",
        quantity: 2,
        line_id: "line-B",
        size: "M",
        unitPriceBdt: 1700,
      },
    ],
    profile: { name: "Asham", phone: "01700000000", address: "Dhaka" },
    shownSkus: [],
    lastShown: [],
    active_goal: null,
    order_state: "ORDER_COMPLETE",
    missing_information: [],
    confirmed_information: { order: { payment_method: "cod" } },
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
  };
}

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

// --- Tests ----------------------------------------------------------------

test(
  "case A: confirm_order with missing address → fsm_block override to reply",
  async () => {
    installRouterStub({
      tool: "confirm_order",
      args: {},
      thought: "let's finalise the order",
    });

    const snapshot = snapshotAtFinalConfirmationMissingAddress();
    const result = await runIterPipeline({
      input: makeInput("confirm korun"),
      history: [],
      snapshot,
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_fsm_caseA",
    });

    const verify = findStep(result.steps, "verify_pre_response");
    const verifyArgs = verify.args as Record<string, unknown>;

    assert.equal(
      verifyArgs.fsmBlocked,
      true,
      `verify_pre_response.args.fsmBlocked must be true; got ${JSON.stringify(verifyArgs)}`,
    );
    assert.equal(
      verify.tool,
      "reply",
      `verify_pre_response.tool must be overridden to reply, got ${verify.tool}`,
    );

    // The override reason should reference the FINAL_CONFIRMATION precondition.
    const fsmReason = String(verifyArgs.fsmReason ?? "");
    assert.match(
      fsmReason,
      /FINAL_CONFIRMATION_precondition_profile_incomplete/,
      `fsmReason should mention the precondition; got: ${fsmReason}`,
    );

    // The terminal reply text MUST mention the missing precondition (address).
    assert.equal(result.terminal, true, "the override reply tool should terminate the iteration");
    const replyText = String(result.reply ?? "");
    assert.ok(
      /address/i.test(replyText),
      `reply must mention the missing precondition (address), got: ${replyText}`,
    );

    // The cart and FSM state on the snapshot are UNCHANGED — the override
    // only routes the action, it does not mutate cart or order_state itself.
    assert.equal(
      result.snapshot.order_state,
      "FINAL_CONFIRMATION",
      `order_state must stay at FINAL_CONFIRMATION when blocked, got ${result.snapshot.order_state}`,
    );
    assert.equal(
      result.snapshot.cart.length,
      1,
      `cart must remain populated when blocked, got ${result.snapshot.cart.length}`,
    );
  },
);

test(
  "case B: ORDER_COMPLETE → saveMemory clears cart and resets to BROWSING",
  async () => {
    // Stub the router with a benign reply — generate_response will run, then
    // saveMemory observes order_state === ORDER_COMPLETE and applies the reset.
    installRouterStub({
      tool: "reply",
      args: { text: "Order complete dhonnobad!" },
      thought: "wrap up",
    });

    const snapshot = snapshotAtOrderComplete();
    const result = await runIterPipeline({
      input: makeInput("ji thanks"),
      history: [],
      snapshot,
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_fsm_caseB",
    });

    // After saveMemory, the snapshot MUST be reset per Req 7.6.
    assert.deepEqual(
      result.snapshot.cart,
      [],
      `cart must be cleared after ORDER_COMPLETE reset, got ${JSON.stringify(result.snapshot.cart)}`,
    );
    assert.equal(
      result.snapshot.order_state,
      "BROWSING",
      `order_state must be BROWSING after reset, got ${result.snapshot.order_state}`,
    );

    // save_memory observation should reflect the post-reset cart length and FSM state.
    const save = findStep(result.steps, "save_memory");
    const saveArgs = save.args as Record<string, unknown>;
    assert.equal(
      saveArgs.cart,
      0,
      `save_memory.args.cart must be 0 after reset, got ${saveArgs.cart}`,
    );
    assert.equal(
      saveArgs.fsm,
      "BROWSING",
      `save_memory.args.fsm must be BROWSING after reset, got ${saveArgs.fsm}`,
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
