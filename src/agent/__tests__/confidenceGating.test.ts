/**
 * Composite-confidence gating test (task 6.4 / Reqs 11.4, 11.5, 11.6).
 *
 * `verify_pre_response` writes
 * `min(product_match, intent, order_completeness)` into
 * `snapshot.confidence_level` and then applies two independent gates:
 *
 *   (a) below medium → override the chosen tool to a clarification `reply`
 *       (Req 11.4). Skipped when an upstream guard already routed to a
 *       reply (anti-loop / resolver / FSM).
 *
 *   (b) below high AND fsm === FINAL_CONFIRMATION → roll the FSM back to
 *       `ORDER_REVIEW` so the loop re-confirms the cart before letting the
 *       customer finalise (Req 11.5).
 *
 * Two cases drive `runIterPipeline`:
 *
 *   Case A — Cart non-empty with `missing_information` carrying 5 slots so
 *            `computeOrderCompleteness` lands at ~0.4 (cart + profile credits
 *            only; missing-slots, payment, and review credits all withheld).
 *            Composite collapses to 0.4 (`min(1.0, 0.7, 0.4)`), well below
 *            the medium threshold of 0.55. The router is stubbed to pick
 *            `add_to_cart` with a grounded sku, and the user message is the
 *            ordinal phrase `"first one"` so the deterministic
 *            reference-resolver returns `kind:"product"` with confidence
 *            1.0 (it MUST NOT route to a clarification reply itself —
 *            otherwise the resolver-override would shadow the medium gate).
 *            The verify_pre_response row MUST carry
 *            `args.confidenceBlock === "below_medium"`, `tool === "reply"`,
 *            and the reply text is the canonical clarification string.
 *
 *   Case B — Snapshot at `FINAL_CONFIRMATION` with everything required for
 *            FSM to PASS the `confirm_order` precondition: profile complete,
 *            cart non-empty (with size), `missing_information` empty.
 *            `computeOrderCompleteness` lands at 1.0 BUT the placeholder
 *            intent classifier in `detect_intent` always emits 0.7 — so
 *            composite = `min(1.0, 0.7, 1.0) = 0.7`, below the high
 *            threshold of 0.8 but above medium 0.55. Router stubbed to pick
 *            `confirm_order`. FSM precondition for FINAL_CONFIRMATION
 *            (profile complete + cart non-empty + missing_information empty)
 *            is satisfied, so the FSM block does NOT fire. The composite
 *            gate must roll the FSM back to `ORDER_REVIEW`. We assert
 *            `verify_pre_response.args.confidenceRollback === true` and
 *            `result.snapshot.order_state === "ORDER_REVIEW"`.
 *
 *            (The task brief's "~3 missing slots" framing is incompatible
 *            with `confirm_order` passing FSM — the FINAL_CONFIRMATION
 *            precondition requires `missing_information.length === 0`. The
 *            placeholder intent score does the same job here: it pulls the
 *            composite below high without relying on order_completeness.)
 *
 * Run via:
 *
 *     npx tsx src/agent/__tests__/confidenceGating.test.ts
 */

import assert from "node:assert/strict";

// --- Stub axios BEFORE importing the loop module -------------------------
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

// --- Static imports — module load happens AFTER the axios stub above -----
import { runIterPipeline } from "../loop.js";
import type { AgentSnapshot, AgentStepLog, AgentTurnInput } from "../types.js";

function restoreAxios(): void {
  axiosPatched.post = originalPost as unknown as typeof axios.post;
}

// --- Test fixtures -------------------------------------------------------

function makeInput(userText: string): AgentTurnInput {
  return {
    tenantId: "t_conf",
    tenantSlug: "conf",
    // SIM_ prefix → `isSimulatorPsid` short-circuits Messenger sends.
    psid: "SIM_conf",
    conversationId: "", // empty so saveSnapshot is a no-op
    userText,
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
}

/**
 * Snapshot for Case A — cart non-empty, profile complete, FIVE
 * missing-information slots so `computeOrderCompleteness` lands at:
 *
 *   0.2 (cart non-empty)
 * + 0.0 (missing_information non-empty)
 * + 0.2 (profile complete)
 * + 0.0 (no payment_method confirmed)
 * + 0.0 (BROWSING/CART_BUILDING — has not reached review)
 * = 0.4
 *
 * `lastShown` carries one product so the user's `"first one"` ordinal
 * resolves to `kind:"product"` with confidence 1.0 — the resolver overlay
 * runs cleanly and does NOT route to a clarification of its own, leaving
 * the composite-confidence gate as the thing under test.
 */
function snapshotCaseA(): AgentSnapshot {
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
    profile: { name: "Asham", phone: "01700000000", address: "Dhaka" },
    shownSkus: ["ARG-HOME-24"],
    lastShown: [{ sku: "ARG-HOME-24", label: "Argentina Home Jersey" }],
    active_goal: null,
    order_state: "CART_BUILDING",
    // Five slots — the count is what drives completeness below medium. The
    // exact slot ids don't matter for the gate; we use generic placeholders.
    missing_information: [
      { slot: "size", attempts: 0 },
      { slot: "color", attempts: 0 },
      { slot: "delivery_window", attempts: 0 },
      { slot: "gift_wrap", attempts: 0 },
      { slot: "note", attempts: 0 },
    ],
    confirmed_information: {},
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
  };
}

/**
 * Snapshot for Case B — at FINAL_CONFIRMATION with everything required for
 * the `confirm_order` FSM precondition to pass (profile complete + cart
 * non-empty with sizes + missing_information empty + payment_method
 * confirmed). Composite is driven below high by the deterministic
 * `detect_intent` placeholder (0.7), not by completeness.
 */
function snapshotCaseB(): AgentSnapshot {
  return {
    cart: [
      {
        sku: "BRA-HOME-24",
        product: "Brazil Home Jersey",
        quantity: 1,
        line_id: "line-B",
        size: "M",
        unitPriceBdt: 1700,
      },
    ],
    profile: { name: "Asham", phone: "01700000000", address: "Dhaka" },
    shownSkus: ["BRA-HOME-24"],
    lastShown: [],
    active_goal: null,
    order_state: "FINAL_CONFIRMATION",
    missing_information: [],
    confirmed_information: { order: { payment_method: "cod" } },
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
  };
}

// --- Tiny tsx-runnable harness -------------------------------------------

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

// --- Tests ---------------------------------------------------------------

test(
  "case A: comprehension < medium → confidenceBlock=below_medium, tool flips to reply with clarification text",
  async () => {
    // Router picks add_to_cart with the grounded sku. The user's `"first one"`
    // phrase resolves via the lastShown ordinal branch with confidence 1.0,
    // so the resolver overlay runs WITHOUT producing its own override —
    // letting the composite-confidence gate be the thing that fires.
    //
    // The medium gate is scoped to comprehension = `min(product_match, intent)`
    // (Req 11.4), so we seed `iterCtx.confidenceScores.product_match = 0.3`
    // to simulate a low-quality resolver match. The placeholder intent
    // classifier always emits 0.7, so the comprehension floor here is 0.3 —
    // well below the medium threshold of 0.55.
    installRouterStub({
      tool: "add_to_cart",
      args: { sku: "ARG-HOME-24", quantity: 1 },
      thought: "stub",
    });

    const result = await runIterPipeline({
      input: makeInput("first one"),
      history: [],
      snapshot: snapshotCaseA(),
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_conf_caseA",
      iterCtx: {
        bootstrapDone: false,
        detectedIntent: { intent: "unknown", confidence_score: 0.5 },
        classifierAvailable: false,
        router: null,
        composite: 1.0,
        // product_match seeded LOW to simulate a fuzzy / low-quality resolver
        // match. The pipeline preserves whatever's in iterCtx through
        // detect_intent (which only sets intent), so by verify_pre_response
        // the comprehension floor is min(0.3, 0.7) = 0.3 < 0.55 medium.
        confidenceScores: { product_match: 0.3, intent: 0.7, order_completeness: 1.0 },
        effectiveTool: "",
        effectiveArgs: {},
        workingSnapshot: snapshotCaseA(),
        lastToolResult: null,
        lastToolLatencyMs: 0,
      },
    });

    const verify = findStep(result.steps, "verify_pre_response");
    const verifyArgs = verify.args as Record<string, unknown>;

    assert.equal(
      verifyArgs.confidenceBlock,
      "below_medium",
      `verify_pre_response.args.confidenceBlock must be "below_medium"; got ${JSON.stringify(verifyArgs)}`,
    );
    assert.equal(
      verify.tool,
      "reply",
      `verify_pre_response.tool must be overridden to reply; got ${verify.tool}`,
    );

    // Composite must reflect the floor of (1.0 product_match, 0.7 intent,
    // 0.4 completeness) → 0.4, well below the medium threshold of 0.55.
    assert.ok(
      typeof verify.confidenceLevel === "number" && verify.confidenceLevel < 0.55,
      `verify_pre_response.confidenceLevel must be < 0.55; got ${verify.confidenceLevel}`,
    );

    // The clarification reply text — pinned exactly so any drift in the
    // canonical wording is caught here.
    const replyText = String(result.reply ?? "");
    assert.equal(
      replyText,
      "Ektu confused — apnar last message ta arekbar bolben please?",
      `clarification reply text must be the canonical Banglish phrasing; got: ${replyText}`,
    );

    // The reply tool is terminal — the iteration ends here.
    assert.equal(result.terminal, true, "the override-to-reply must terminate the iteration");

    // Cart and FSM are unchanged — gating routes the action only.
    assert.equal(
      result.snapshot.cart.length,
      1,
      `cart must remain unchanged when blocked, got ${result.snapshot.cart.length}`,
    );
    assert.equal(
      result.snapshot.order_state,
      "CART_BUILDING",
      `order_state must stay at CART_BUILDING when blocked, got ${result.snapshot.order_state}`,
    );
  },
);

test(
  "case B: composite < high at FINAL_CONFIRMATION → confidenceRollback=true, snapshot rolls back to ORDER_REVIEW",
  async () => {
    // Router picks confirm_order. FSM precondition for FINAL_CONFIRMATION
    // is satisfied (profile complete, cart non-empty with size,
    // missing_information empty), so the FSM block does NOT fire. The
    // composite gate fires because the placeholder intent score (0.7)
    // pulls the composite below the high threshold (0.8).
    installRouterStub({
      tool: "confirm_order",
      args: {},
      thought: "finalise",
    });

    const result = await runIterPipeline({
      // User text needs to lexically trigger the placeholder intent classifier
      // so we get a deterministic 0.7 (any of the heuristics work — `chai`
      // matches the purchase regex).
      input: makeInput("confirm korte chai"),
      history: [],
      snapshot: snapshotCaseB(),
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_conf_caseB",
    });

    const verify = findStep(result.steps, "verify_pre_response");
    const verifyArgs = verify.args as Record<string, unknown>;

    // The FSM block MUST NOT have fired — the precondition is met.
    assert.notEqual(
      verifyArgs.fsmBlocked,
      true,
      `verify_pre_response.args.fsmBlocked must be false when FINAL_CONFIRMATION precondition is met; got ${JSON.stringify(verifyArgs)}`,
    );

    assert.equal(
      verifyArgs.confidenceRollback,
      true,
      `verify_pre_response.args.confidenceRollback must be true; got ${JSON.stringify(verifyArgs)}`,
    );

    // Composite must be < high (0.8) — bounded above by the placeholder
    // intent score of 0.7.
    assert.ok(
      typeof verify.confidenceLevel === "number" && verify.confidenceLevel < 0.8,
      `verify_pre_response.confidenceLevel must be < 0.8; got ${verify.confidenceLevel}`,
    );

    // Snapshot must show the rollback persisted through save_memory.
    assert.equal(
      result.snapshot.order_state,
      "ORDER_REVIEW",
      `result.snapshot.order_state must be ORDER_REVIEW after rollback; got ${result.snapshot.order_state}`,
    );

    // Confidence-level on the snapshot must reflect the composite that
    // drove the rollback.
    assert.ok(
      typeof result.snapshot.confidence_level === "number" &&
        result.snapshot.confidence_level < 0.8,
      `snapshot.confidence_level must be < 0.8 after rollback; got ${result.snapshot.confidence_level}`,
    );
  },
);

// --- Runner --------------------------------------------------------------

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
