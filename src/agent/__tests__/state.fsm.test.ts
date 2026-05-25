/**
 * Tests for the OrderFSM machinery exported from `state.ts`: `ALLOWED_TRANSITIONS`,
 * `canTransition`, and `nextSuggestedState`.
 *
 * Same `tsx`-runnable pattern as state.legacy.test.ts (no external runner). Run via:
 *
 *     npx tsx src/agent/__tests__/state.fsm.test.ts
 *
 * Validates the contract called out by Requirements §7.1–§7.4: legal-edge enforcement,
 * deterministic preconditions, and the next-suggested-state walk used by the loop to
 * override skip-ahead actions.
 */

import assert from "node:assert/strict";
import { ALLOWED_TRANSITIONS, canTransition, nextSuggestedState } from "../state.js";
import {
  ABANDONED_CART_TIMEOUT_MS,
  CONFIDENCE_THRESHOLDS,
  MAX_SLOT_ATTEMPTS,
} from "../state.js";
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
  line_id: "L1",
  sku: "RM-HOME-24",
  product: "Real Madrid Home Jersey",
  quantity: 1,
  size: "M",
  unitPriceBdt: 1450,
};

const fullProfile = { name: "Mahir", phone: "017xxxxxxx", address: "Dhaka, BD" };

// --- canTransition: structural edges ---

test("BROWSING → PRODUCT_SELECTION is allowed on an empty snapshot", () => {
  const result = canTransition("BROWSING", "PRODUCT_SELECTION", makeSnapshot());
  assert.deepEqual(result, { ok: true });
});

test("BROWSING → FINAL_CONFIRMATION is rejected as transition_not_allowed (skip violation)", () => {
  const result = canTransition("BROWSING", "FINAL_CONFIRMATION", makeSnapshot());
  assert.deepEqual(result, { ok: false, reason: "transition_not_allowed" });
});

test("PAYMENT_SELECTION → FINAL_CONFIRMATION is allowed when FINAL_CONFIRMATION preconditions are met (confirm_order is the review-and-finalise step)", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    order_state: "PAYMENT_SELECTION",
    missing_information: [],
  });
  const result = canTransition("PAYMENT_SELECTION", "FINAL_CONFIRMATION", snap);
  assert.deepEqual(result, { ok: true });
});

test("PAYMENT_SELECTION → FINAL_CONFIRMATION is rejected when profile is incomplete (precondition, not structural)", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: { name: "Mahir", phone: "017xxxxxxx" }, // address missing
    order_state: "PAYMENT_SELECTION",
    missing_information: [],
  });
  const result = canTransition("PAYMENT_SELECTION", "FINAL_CONFIRMATION", snap);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "FINAL_CONFIRMATION_precondition_profile_incomplete");
  }
});

// --- canTransition: preconditions ---

test("CART_BUILDING → MISSING_INFO_COLLECTION is allowed when cart has items and a per-line slot is missing", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    order_state: "CART_BUILDING",
    missing_information: [{ slot: "size", line_id: "L1", attempts: 0 }],
  });
  const result = canTransition("CART_BUILDING", "MISSING_INFO_COLLECTION", snap);
  assert.deepEqual(result, { ok: true });
});

test("MISSING_INFO_COLLECTION → ADDRESS_COLLECTION is rejected when per-line slots remain", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    order_state: "MISSING_INFO_COLLECTION",
    missing_information: [{ slot: "size", line_id: "L1", attempts: 0 }],
  });
  const result = canTransition("MISSING_INFO_COLLECTION", "ADDRESS_COLLECTION", snap);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /per_line/);
    assert.equal(result.reason, "ADDRESS_COLLECTION_precondition_per_line_slots_remaining");
  }
});

test("MISSING_INFO_COLLECTION → ADDRESS_COLLECTION is allowed once per-line slots are cleared", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    order_state: "MISSING_INFO_COLLECTION",
    missing_information: [{ slot: "address", attempts: 0 }], // order-level only
  });
  const result = canTransition("MISSING_INFO_COLLECTION", "ADDRESS_COLLECTION", snap);
  assert.deepEqual(result, { ok: true });
});

test("ADDRESS_COLLECTION → PAYMENT_SELECTION requires a complete profile", () => {
  const incomplete = makeSnapshot({
    cart: [oneItem],
    order_state: "ADDRESS_COLLECTION",
    profile: { name: "Mahir", phone: "017" }, // address missing
  });
  const r1 = canTransition("ADDRESS_COLLECTION", "PAYMENT_SELECTION", incomplete);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "PAYMENT_SELECTION_precondition_profile_incomplete");

  const complete = makeSnapshot({
    cart: [oneItem],
    order_state: "ADDRESS_COLLECTION",
    profile: fullProfile,
  });
  assert.deepEqual(canTransition("ADDRESS_COLLECTION", "PAYMENT_SELECTION", complete), {
    ok: true,
  });
});

test("ORDER_REVIEW → FINAL_CONFIRMATION is rejected if missing_information is non-empty", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    order_state: "ORDER_REVIEW",
    missing_information: [{ slot: "delivery_window", attempts: 0 }],
  });
  const result = canTransition("ORDER_REVIEW", "FINAL_CONFIRMATION", snap);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "FINAL_CONFIRMATION_precondition_missing_info");
});

test("ORDER_REVIEW → FINAL_CONFIRMATION is allowed once profile is complete, cart is non-empty, and no missing info", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    profile: fullProfile,
    order_state: "ORDER_REVIEW",
    missing_information: [],
  });
  assert.deepEqual(canTransition("ORDER_REVIEW", "FINAL_CONFIRMATION", snap), { ok: true });
});

test("CART_BUILDING from BROWSING requires at least one cart line", () => {
  // First go through PRODUCT_SELECTION to reach CART_BUILDING legally.
  const empty = makeSnapshot({ order_state: "PRODUCT_SELECTION" });
  const r1 = canTransition("PRODUCT_SELECTION", "CART_BUILDING", empty);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "CART_BUILDING_precondition_empty_cart");

  const withItem = makeSnapshot({ cart: [oneItem], order_state: "PRODUCT_SELECTION" });
  assert.deepEqual(canTransition("PRODUCT_SELECTION", "CART_BUILDING", withItem), { ok: true });
});

test("ALLOWED_TRANSITIONS covers all 9 states with self-edges where the FSM stays put", () => {
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
  for (const s of states) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[s]), `missing entry for ${s}`);
  }
  // Self-edges everywhere except ORDER_COMPLETE (which only routes back to BROWSING per Req 7.6).
  for (const s of states) {
    if (s === "ORDER_COMPLETE") {
      assert.deepEqual(ALLOWED_TRANSITIONS[s], ["BROWSING"]);
    } else {
      assert.ok(
        ALLOWED_TRANSITIONS[s].includes(s),
        `${s} should have a self-edge for multi-turn slot collection`,
      );
    }
  }
});

// --- nextSuggestedState ---

test("nextSuggestedState returns BROWSING for an empty cart", () => {
  assert.equal(nextSuggestedState(makeSnapshot()), "BROWSING");
});

test("nextSuggestedState returns MISSING_INFO_COLLECTION when a per-line slot is missing", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    missing_information: [{ slot: "size", line_id: "L1", attempts: 0 }],
  });
  assert.equal(nextSuggestedState(snap), "MISSING_INFO_COLLECTION");
});

test("nextSuggestedState returns ADDRESS_COLLECTION when cart is non-empty, no per-line slots, profile incomplete", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    missing_information: [],
    profile: {},
  });
  assert.equal(nextSuggestedState(snap), "ADDRESS_COLLECTION");
});

test("nextSuggestedState returns PAYMENT_SELECTION when profile is complete but no payment_method confirmed", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    missing_information: [],
    profile: fullProfile,
    confirmed_information: {},
  });
  assert.equal(nextSuggestedState(snap), "PAYMENT_SELECTION");
});

test("nextSuggestedState advances ORDER_REVIEW → FINAL_CONFIRMATION when nothing is missing", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    missing_information: [],
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "ORDER_REVIEW",
  });
  assert.equal(nextSuggestedState(snap), "FINAL_CONFIRMATION");
});

test("nextSuggestedState returns ORDER_REVIEW when cart, profile, and payment are ready but state is earlier", () => {
  const snap = makeSnapshot({
    cart: [oneItem],
    missing_information: [],
    profile: fullProfile,
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "PAYMENT_SELECTION",
  });
  assert.equal(nextSuggestedState(snap), "ORDER_REVIEW");
});

// --- Runtime constants (task 1.3) ---

test("CONFIDENCE_THRESHOLDS pins the high/medium/low band boundaries (Req 11.3)", () => {
  assert.equal(CONFIDENCE_THRESHOLDS.high, 0.8);
  assert.equal(CONFIDENCE_THRESHOLDS.medium, 0.55);
  assert.equal(CONFIDENCE_THRESHOLDS.low, 0.3);
});

test("MAX_SLOT_ATTEMPTS caps Anti-Loop Guard retries at 2 per slot (Reqs 8.5, 12.6)", () => {
  assert.equal(MAX_SLOT_ATTEMPTS, 2);
});

test("ABANDONED_CART_TIMEOUT_MS equals 24 hours in milliseconds (Req 13.3)", () => {
  assert.equal(ABANDONED_CART_TIMEOUT_MS, 86_400_000);
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
