/**
 * Tests for `computeOrderCompleteness` exported from `state.ts`.
 *
 * Same `tsx`-runnable pattern as the other state tests (no external runner). Run via:
 *
 *     npx tsx src/agent/__tests__/orderCompleteness.test.ts
 *
 * Validates Requirements §11.1 (deterministic `Confidence_Score` in `[0, 1]`) and §11.5
 * (the score is `1.0` iff cart is non-empty, `missing_information` is empty, profile is
 * complete, payment method confirmed, and FSM is at `FINAL_CONFIRMATION` or
 * `ORDER_COMPLETE`).
 */

import assert from "node:assert/strict";
import { computeOrderCompleteness } from "../state.js";
import type { AgentCartItem, AgentSnapshot } from "../types.js";

type TestCase = { name: string; run: () => void };

const tests: TestCase[] = [];
function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

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

const oneItem: AgentCartItem = {
  sku: "RM-HOME-24",
  product: "Real Madrid Home Jersey",
  quantity: 1,
  line_id: "L1",
  size: "M",
  unitPriceBdt: 1450,
};

const fullProfile = { name: "Mahir", phone: "017xxxxxxx", address: "Dhaka, BD" };

// --- Empty cart short-circuit ---

test("empty cart yields exactly 0.0", () => {
  assert.equal(computeOrderCompleteness(makeSnapshot()), 0.0);
});

test("empty cart still scores 0.0 even if everything else looks complete", () => {
  const snap = makeSnapshot({
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "FINAL_CONFIRMATION",
  });
  assert.equal(computeOrderCompleteness(snap), 0.0);
});

// --- Filled-but-missing-slots cases must be < 1.0 ---

test("cart-only base case (no profile, no payment, BROWSING) scores 0.2", () => {
  const snap = makeSnapshot({ cart: [oneItem] });
  const score = computeOrderCompleteness(snap);
  assert.ok(score < 1.0, `expected < 1.0, got ${score}`);
  // Cart non-empty (+0.2) + missing_information empty (+0.2) = 0.4
  assert.ok(Math.abs(score - 0.4) < 1e-9, `expected 0.4, got ${score}`);
});

test("missing slots while profile complete + payment + ORDER_REVIEW scores < 1.0", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "ORDER_REVIEW",
    missing_information: [{ slot: "delivery_window", attempts: 0 }],
  });
  const score = computeOrderCompleteness(snap);
  assert.ok(score < 1.0, `expected < 1.0 with missing slots, got ${score}`);
  // 0.2 (cart) + 0.0 (slots present) + 0.2 (profile) + 0.1 (payment) + 0.1 (review) = 0.6
  assert.ok(Math.abs(score - 0.6) < 1e-9, `expected 0.6, got ${score}`);
});

test("incomplete profile at FINAL_CONFIRMATION still scores < 1.0", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: { name: "Mahir", phone: "017xxxxxxx" }, // address missing
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "FINAL_CONFIRMATION",
  });
  const score = computeOrderCompleteness(snap);
  assert.ok(score < 1.0, `expected < 1.0 without full profile, got ${score}`);
});

test("missing payment_method at FINAL_CONFIRMATION still scores < 1.0", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    confirmed_information: {}, // no payment confirmed
    order_state: "FINAL_CONFIRMATION",
  });
  const score = computeOrderCompleteness(snap);
  assert.ok(score < 1.0, `expected < 1.0 without payment_method, got ${score}`);
});

test("FSM only at PAYMENT_SELECTION never reaches 1.0 even if everything else is set", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "PAYMENT_SELECTION",
  });
  const score = computeOrderCompleteness(snap);
  assert.ok(score < 1.0, `expected < 1.0 below ORDER_REVIEW, got ${score}`);
});

// --- All conditions met → exactly 1.0 ---

test("all conditions met at FINAL_CONFIRMATION yields exactly 1.0", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "FINAL_CONFIRMATION",
    missing_information: [],
  });
  const score = computeOrderCompleteness(snap);
  assert.equal(score, 1.0, `expected exactly 1.0, got ${score}`);
});

test("all conditions met at ORDER_COMPLETE also yields 1.0", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "ORDER_COMPLETE",
    missing_information: [],
  });
  const score = computeOrderCompleteness(snap);
  assert.equal(score, 1.0, `expected exactly 1.0 at ORDER_COMPLETE, got ${score}`);
});

test("score is always within [0, 1]", () => {
  // Spot-check a representative grid of snapshots stays in range.
  const states = [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
    "MISSING_INFO_COLLECTION",
    "ADDRESS_COLLECTION",
    "PAYMENT_SELECTION",
    "ORDER_REVIEW",
    "FINAL_CONFIRMATION",
    "ORDER_COMPLETE",
  ] as const;
  const carts: AgentCartItem[][] = [[], [oneItem]];
  const profiles: AgentSnapshot["profile"][] = [{}, fullProfile];
  const cis: AgentSnapshot["confirmed_information"][] = [
    {},
    { order: { payment_method: "cod" } },
  ];
  for (const state of states) {
    for (const cart of carts) {
      for (const profile of profiles) {
        for (const ci of cis) {
          const snap = makeSnapshot({
            cart,
            profile,
            confirmed_information: ci,
            order_state: state,
          });
          const score = computeOrderCompleteness(snap);
          assert.ok(score >= 0 && score <= 1, `score out of range for ${state}: ${score}`);
        }
      }
    }
  }
});

// --- Payment method must be a non-empty string ---

test("empty-string payment_method does NOT count toward the score", () => {
  const withEmptyPm = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "" } },
    order_state: "FINAL_CONFIRMATION",
  });
  const withRealPm = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "FINAL_CONFIRMATION",
  });
  assert.ok(
    computeOrderCompleteness(withEmptyPm) < computeOrderCompleteness(withRealPm),
    "empty-string payment_method should score lower than a real one",
  );
  assert.notEqual(computeOrderCompleteness(withEmptyPm), 1.0);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
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
