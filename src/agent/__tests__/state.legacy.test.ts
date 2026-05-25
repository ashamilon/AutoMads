/**
 * Legacy-fixture tests for `parseSnapshot` (the pure helper that backs `loadSnapshot`).
 *
 * No external test runner is wired into this repo (see package.json — there is no `test` script
 * and no vitest/jest dep). This file is a self-contained `tsx`-runnable script that uses Node's
 * built-in `node:assert/strict` and exits non-zero if any assertion fails. Run via:
 *
 *     npx tsx src/agent/__tests__/state.legacy.test.ts
 *
 * The tests focus on the contract called out by Requirement 1.4 (and task 1.1's verification
 * step): a `pendingDraftJson` blob that predates the new structured-state fields MUST still
 * parse cleanly, with the documented defaults applied to every new field.
 */

import assert from "node:assert/strict";
import { parseSnapshot } from "../state.js";

type TestCase = { name: string; run: () => void };

const tests: TestCase[] = [];
function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

test("legacy blob with no `agent` key returns documented defaults for every new field", () => {
  // Simulates a snapshot written by the pre-refactor code: only cart + profile, no agent block.
  const legacy = {
    cartItems: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home Jersey",
        quantity: 1,
        size: "M",
        unitPriceBdt: 1450,
      },
    ],
    customerProfile: { name: "Mahir", phone: "017xxxxxxx" },
    updatedAt: "2024-09-01T12:00:00.000Z",
  };

  const snap = parseSnapshot(legacy);

  // Existing fields preserved.
  assert.equal(snap.cart.length, 1);
  assert.equal(snap.cart[0]!.sku, "RM-HOME-24");
  assert.equal(snap.profile.name, "Mahir");
  assert.deepEqual(snap.shownSkus, []);
  assert.deepEqual(snap.lastShown, []);

  // New fields: documented defaults.
  assert.equal(snap.active_goal, null);
  assert.equal(snap.order_state, "BROWSING");
  assert.deepEqual(snap.missing_information, []);
  assert.deepEqual(snap.confirmed_information, {});
  assert.deepEqual(snap.customer_preferences, {});
  assert.equal(snap.conversation_summary, "");
  assert.equal(snap.confidence_level, 1.0);
  assert.equal(snap.followup_needed, false);
  assert.deepEqual(snap.recent_references, []);
});

test("blob with partial `agent` block (only shownSkus/lastShown) defaults the rest", () => {
  // Mid-migration shape: agent.shownSkus/lastShown were added before the new structured fields.
  const partial = {
    cartItems: [],
    customerProfile: {},
    agent: {
      shownSkus: ["RM-HOME-24", "ARG-AWAY-22"],
      lastShown: [{ sku: "RM-HOME-24", label: "Real Madrid Home" }],
    },
  };

  const snap = parseSnapshot(partial);

  assert.deepEqual(snap.shownSkus, ["RM-HOME-24", "ARG-AWAY-22"]);
  assert.equal(snap.lastShown?.length, 1);
  assert.equal(snap.active_goal, null);
  assert.equal(snap.order_state, "BROWSING");
  assert.equal(snap.confidence_level, 1.0);
  assert.equal(snap.followup_needed, false);
  assert.deepEqual(snap.missing_information, []);
});

test("null / undefined / non-object input returns a fully-default snapshot", () => {
  for (const input of [null, undefined, "not-an-object", 42, []]) {
    const snap = parseSnapshot(input);
    assert.deepEqual(snap.cart, []);
    assert.deepEqual(snap.profile, {});
    assert.deepEqual(snap.shownSkus, []);
    assert.equal(snap.active_goal, null);
    assert.equal(snap.order_state, "BROWSING");
    assert.deepEqual(snap.missing_information, []);
    assert.deepEqual(snap.confirmed_information, {});
    assert.deepEqual(snap.customer_preferences, {});
    assert.equal(snap.conversation_summary, "");
    assert.equal(snap.confidence_level, 1.0);
    assert.equal(snap.followup_needed, false);
    assert.deepEqual(snap.recent_references, []);
  }
});

test("invalid order_state strings fall back to BROWSING", () => {
  const snap = parseSnapshot({ agent: { order_state: "NOT_A_REAL_STATE" } });
  assert.equal(snap.order_state, "BROWSING");
});

test("valid order_state strings round-trip through the reader", () => {
  for (const state of [
    "BROWSING",
    "PRODUCT_SELECTION",
    "CART_BUILDING",
    "MISSING_INFO_COLLECTION",
    "ADDRESS_COLLECTION",
    "PAYMENT_SELECTION",
    "ORDER_REVIEW",
    "FINAL_CONFIRMATION",
    "ORDER_COMPLETE",
  ]) {
    const snap = parseSnapshot({ agent: { order_state: state } });
    assert.equal(snap.order_state, state);
  }
});

test("confidence_level is clamped to [0, 1] and defaults to 1.0 for non-numeric input", () => {
  assert.equal(parseSnapshot({ agent: { confidence_level: -0.4 } }).confidence_level, 0);
  assert.equal(parseSnapshot({ agent: { confidence_level: 1.7 } }).confidence_level, 1);
  assert.equal(parseSnapshot({ agent: { confidence_level: 0.42 } }).confidence_level, 0.42);
  assert.equal(parseSnapshot({ agent: { confidence_level: "high" } }).confidence_level, 1.0);
  assert.equal(parseSnapshot({ agent: {} }).confidence_level, 1.0);
});

test("missing_information drops malformed rows but keeps well-formed ones", () => {
  const snap = parseSnapshot({
    agent: {
      missing_information: [
        { line_id: "L1", slot: "size", attempts: 1 },
        { slot: "address", attempts: 0 }, // order-level, no line_id
        { slot: "" }, // dropped: empty slot name
        "garbage", // dropped: not an object
        { slot: "phone", attempts: -1 }, // attempts coerced to 0
      ],
    },
  });
  assert.equal(snap.missing_information.length, 3);
  assert.deepEqual(snap.missing_information[0], { line_id: "L1", slot: "size", attempts: 1 });
  assert.deepEqual(snap.missing_information[1], { slot: "address", attempts: 0 });
  assert.deepEqual(snap.missing_information[2], { slot: "phone", attempts: 0 });
});

test("recent_references trims to the 5 most-recent entries", () => {
  const refs = Array.from({ length: 8 }, (_, i) => ({
    phrase: `phrase-${i}`,
    target_kind: "line",
    target_id: `L${i}`,
    ts: `2024-09-0${i + 1}T00:00:00.000Z`,
  }));
  const snap = parseSnapshot({ agent: { recent_references: refs } });
  assert.equal(snap.recent_references.length, 5);
  // Last 5 of the original 8 are kept (newest-last semantics).
  assert.equal(snap.recent_references[0]!.phrase, "phrase-3");
  assert.equal(snap.recent_references[4]!.phrase, "phrase-7");
});

test("recent_references rejects rows with unknown target_kind", () => {
  const snap = parseSnapshot({
    agent: {
      recent_references: [
        { phrase: "ok", target_kind: "line", target_id: "L1", ts: "2024-01-01T00:00:00.000Z" },
        { phrase: "bad", target_kind: "tenant", target_id: "T1", ts: "2024-01-02T00:00:00.000Z" },
      ],
    },
  });
  assert.equal(snap.recent_references.length, 1);
  assert.equal(snap.recent_references[0]!.phrase, "ok");
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
