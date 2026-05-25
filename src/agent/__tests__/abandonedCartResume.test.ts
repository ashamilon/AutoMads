/**
 * Tests for the abandoned-cart resume preamble (task 9.2 — Req 13.4).
 *
 * Same `tsx`-runnable harness used by the rest of `src/agent/__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/abandonedCartResume.test.ts
 *
 * Pins the decision table for `buildResumePreamble`, the pure helper extracted
 * from `runner.ts` so the resume logic is testable without spinning up the full
 * LangGraph loop. The runner wires this helper into `runAgentInbound` between
 * `loadHistory` and `runAgentTurn`, so a non-null preamble here is exactly what
 * the loop will see in `history` on the next turn.
 *
 *  • Non-empty cart + in-flight FSM (CART_BUILDING / MISSING_INFO_COLLECTION /
 *    ADDRESS_COLLECTION / PAYMENT_SELECTION) + idle gap in [30 min, 24h]
 *      → returns a short Banglish preamble naming the cart contents.
 *  • Empty cart                  → returns null (nothing to resume).
 *  • Non-resumable FSM state     → returns null (no in-flight order).
 *  • Idle gap < 30 min           → returns null (still in the same session).
 *  • Idle gap > 24h              → returns null (snapshot is stale, treat as fresh).
 *  • Missing `lastUserMsgAt`     → falls back to recent_references[last].ts.
 *
 * The "12h-old snapshot at ADDRESS_COLLECTION → next reply is an address question"
 * scenario from the task verification checklist is covered by the FSM-loop
 * integration tests (`loop.pipeline.test.ts`, `fsmEnforcement.test.ts`) — once
 * the FSM is loaded as ADDRESS_COLLECTION, the loop's deterministic transition
 * table forbids skipping ahead, so the next router action is bounded to the
 * address-collection branch. This file's job is to pin that the resume
 * PREAMBLE itself is generated correctly; the loop then resumes naturally
 * because the FSM was persisted (Req 13.4).
 */

import assert from "node:assert/strict";
import { buildResumePreamble } from "../runner.js";
import {
  ABANDONED_CART_TIMEOUT_MS,
  type OrderFSMState,
} from "../state.js";
import type { AgentSnapshot } from "../types.js";

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

// ---------- snapshot fixture helpers ----------

function makeSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    cart: [],
    profile: {},
    shownSkus: [],
    lastShown: [],
    active_goal: null,
    order_state: "BROWSING",
    missing_information: [],
    confirmed_information: {},
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
    ...overrides,
  };
}

const realMadrid = {
  line_id: "L1",
  sku: "RM-HOME-24",
  product: "Real Madrid Home Jersey",
  quantity: 1,
  size: "L",
  unitPriceBdt: 1450,
};

const argentina = {
  line_id: "L2",
  sku: "ARG-AWAY-24",
  product: "Argentina Away Jersey",
  quantity: 2,
  size: "M",
  unitPriceBdt: 1300,
};

const NOW = new Date("2024-09-15T18:00:00.000Z");
const TWELVE_HOURS_AGO = new Date(NOW.getTime() - 12 * 60 * 60 * 1000);
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
const FIVE_MIN_AGO = new Date(NOW.getTime() - 5 * 60 * 1000);
const TWO_DAYS_AGO = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);

// ---------- pure helper tests ----------

const RESUMABLE_STATES: OrderFSMState[] = [
  "CART_BUILDING",
  "MISSING_INFO_COLLECTION",
  "ADDRESS_COLLECTION",
  "PAYMENT_SELECTION",
];

for (const state of RESUMABLE_STATES) {
  test(`returns a non-empty preamble naming the cart when FSM=${state} and gap=12h`, () => {
    const snap = makeSnapshot({ cart: [realMadrid], order_state: state });
    const out = buildResumePreamble(snap, TWELVE_HOURS_AGO, NOW);
    assert.ok(out, `expected a preamble for ${state}`);
    assert.ok(typeof out === "string" && out.length > 0);
    // The product label must appear so the customer sees what they had.
    assert.ok(
      out.includes("Real Madrid Home Jersey"),
      `preamble should mention the cart product: ${out}`,
    );
    // The Banglish framing must signal "resume" rather than "fresh greeting".
    assert.ok(
      /age\s+er|continue|ekhono|ache/i.test(out),
      `preamble should read as a resume cue: ${out}`,
    );
  });
}

const NON_RESUMABLE_STATES: OrderFSMState[] = [
  "BROWSING",
  "PRODUCT_SELECTION",
  "ORDER_REVIEW",
  "FINAL_CONFIRMATION",
  "ORDER_COMPLETE",
];

for (const state of NON_RESUMABLE_STATES) {
  test(`returns null for non-resumable FSM=${state} even with a non-empty cart`, () => {
    const snap = makeSnapshot({ cart: [realMadrid], order_state: state });
    const out = buildResumePreamble(snap, TWELVE_HOURS_AGO, NOW);
    assert.equal(out, null, `expected null for ${state}, got: ${out}`);
  });
}

test("returns null when cart is empty regardless of FSM state", () => {
  const snap = makeSnapshot({ cart: [], order_state: "ADDRESS_COLLECTION" });
  const out = buildResumePreamble(snap, TWELVE_HOURS_AGO, NOW);
  assert.equal(out, null);
});

test("returns null when the idle gap is below the 30-minute lower bound", () => {
  const snap = makeSnapshot({ cart: [realMadrid], order_state: "ADDRESS_COLLECTION" });
  const out = buildResumePreamble(snap, FIVE_MIN_AGO, NOW);
  assert.equal(
    out,
    null,
    "5 minutes ago should be treated as 'still in session', not a resume",
  );
});

test("returns null when the idle gap exceeds the 24h abandoned-cart timeout", () => {
  const snap = makeSnapshot({ cart: [realMadrid], order_state: "ADDRESS_COLLECTION" });
  const out = buildResumePreamble(snap, TWO_DAYS_AGO, NOW);
  assert.equal(
    out,
    null,
    "48h ago is past ABANDONED_CART_TIMEOUT_MS, snapshot is stale",
  );
});

test("returns a preamble at the upper boundary (exactly 24h ago)", () => {
  const snap = makeSnapshot({ cart: [realMadrid], order_state: "CART_BUILDING" });
  const exactly24h = new Date(NOW.getTime() - ABANDONED_CART_TIMEOUT_MS);
  const out = buildResumePreamble(snap, exactly24h, NOW);
  assert.ok(out, "boundary value (=24h) must still resume");
});

test("returns a preamble at the lower boundary (exactly 30 minutes ago)", () => {
  const snap = makeSnapshot({ cart: [realMadrid], order_state: "CART_BUILDING" });
  const exactly30m = new Date(NOW.getTime() - 30 * 60 * 1000);
  const out = buildResumePreamble(snap, exactly30m, NOW);
  assert.ok(out, "boundary value (=30 min) must still resume");
});

test("falls back to recent_references[last].ts when lastUserMsgAt is missing", () => {
  const snap = makeSnapshot({
    cart: [realMadrid],
    order_state: "ADDRESS_COLLECTION",
    recent_references: [
      {
        phrase: "first one",
        target_kind: "line",
        target_id: "L1",
        ts: TWO_HOURS_AGO.toISOString(),
      },
    ],
  });
  const out = buildResumePreamble(snap, null, NOW);
  assert.ok(out, "with a 2h-old recent_references entry the preamble should fire");
});

test("returns null when neither lastUserMsgAt nor recent_references is available", () => {
  const snap = makeSnapshot({ cart: [realMadrid], order_state: "ADDRESS_COLLECTION" });
  const out = buildResumePreamble(snap, null, NOW);
  assert.equal(out, null);
});

test("preamble lists multiple cart items when more than one line is present", () => {
  const snap = makeSnapshot({
    cart: [realMadrid, argentina],
    order_state: "ADDRESS_COLLECTION",
  });
  const out = buildResumePreamble(snap, TWELVE_HOURS_AGO, NOW);
  assert.ok(out);
  assert.ok(out!.includes("Real Madrid Home Jersey"));
  assert.ok(out!.includes("Argentina Away Jersey"));
});

test("ADDRESS_COLLECTION + 12h gap (the task's verification scenario) produces an address-resume cue, not a fresh greeting", () => {
  // Mirrors the integration scenario from tasks.md §9.2:
  //   "seeds a snapshot with order_state=ADDRESS_COLLECTION and a 12h-old timestamp,
  //    sends an inbound, and confirms the next reply is an address question
  //    (not a fresh greeting)."
  // Once this preamble is appended to history, the loop's deterministic FSM
  // (already restored to ADDRESS_COLLECTION via loadSnapshot inside the graph)
  // bounds the router into the address-collection branch on the next iteration.
  const snap = makeSnapshot({
    cart: [realMadrid],
    order_state: "ADDRESS_COLLECTION",
    profile: { name: "Mahir", phone: "017xxxxxxx" },
    missing_information: [{ slot: "address", attempts: 0 }],
    confirmed_information: { order: { payment_method: "cod" } },
  });
  const out = buildResumePreamble(snap, TWELVE_HOURS_AGO, NOW);
  assert.ok(out, "12h-old ADDRESS_COLLECTION snapshot must produce a resume preamble");
  // It must NOT read as a fresh greeting like "Welcome / Hello / Salam".
  assert.ok(
    !/^\s*(welcome|hello|hi|salam|assalamu)/i.test(out!),
    `preamble must not be a fresh greeting: ${out}`,
  );
  // It MUST surface the saved cart so the LLM sees what to resume.
  assert.ok(out!.includes("Real Madrid Home Jersey"));
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
