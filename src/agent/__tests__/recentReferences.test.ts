/**
 * Unit tests for `appendRecentReference` (task 4.2 — Persist `recent_references` into the Snapshot).
 *
 * Same `tsx`-runnable shape as the other agent tests in this folder (no test runner is wired
 * into the repo). Run via:
 *
 *     npx tsx src/agent/__tests__/recentReferences.test.ts
 *
 * Validates Requirements §9.6: the agent persists the most recent five customer references
 * and their resolved targets. The test covers FIFO trimming and snapshot immutability.
 */

import assert from "node:assert/strict";
import { appendRecentReference, parseSnapshot } from "../state.js";
import type { AgentRecentReference, AgentSnapshot } from "../types.js";

type TestCase = { name: string; run: () => void };

const tests: TestCase[] = [];
function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

function ref(i: number): AgentRecentReference {
  return {
    phrase: `phrase-${i}`,
    target_kind: "line",
    target_id: `L${i}`,
    ts: `2024-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
  };
}

function freshSnapshot(): AgentSnapshot {
  return parseSnapshot({});
}

test("appending 7 refs leaves exactly the 5 most-recent entries in order", () => {
  let snap = freshSnapshot();
  for (let i = 0; i < 7; i += 1) {
    snap = appendRecentReference(snap, ref(i));
  }

  // Exactly 5 entries kept.
  assert.equal(snap.recent_references.length, 5);

  // Newest-last order: oldest two (indices 0 and 1) are dropped, refs 2..6 remain.
  assert.equal(snap.recent_references[0]!.phrase, "phrase-2");
  assert.equal(snap.recent_references[1]!.phrase, "phrase-3");
  assert.equal(snap.recent_references[2]!.phrase, "phrase-4");
  assert.equal(snap.recent_references[3]!.phrase, "phrase-5");
  assert.equal(snap.recent_references[4]!.phrase, "phrase-6");
});

test("the input snapshot is not mutated (immutability)", () => {
  const original = freshSnapshot();
  const originalRefsRef = original.recent_references;
  const originalLen = original.recent_references.length;

  const next = appendRecentReference(original, ref(0));

  // The input array reference is unchanged and still empty.
  assert.equal(original.recent_references, originalRefsRef);
  assert.equal(original.recent_references.length, originalLen);
  assert.equal(original.recent_references.length, 0);

  // The returned snapshot is a NEW object with a NEW array.
  assert.notEqual(next, original);
  assert.notEqual(next.recent_references, original.recent_references);
  assert.equal(next.recent_references.length, 1);
  assert.equal(next.recent_references[0]!.phrase, "phrase-0");
});

test("appending under the cap preserves all entries in insertion order", () => {
  let snap = freshSnapshot();
  for (let i = 0; i < 3; i += 1) {
    snap = appendRecentReference(snap, ref(i));
  }
  assert.equal(snap.recent_references.length, 3);
  assert.deepEqual(
    snap.recent_references.map((r) => r.phrase),
    ["phrase-0", "phrase-1", "phrase-2"],
  );
});

test("appending exactly 5 fills the buffer without trimming", () => {
  let snap = freshSnapshot();
  for (let i = 0; i < 5; i += 1) {
    snap = appendRecentReference(snap, ref(i));
  }
  assert.equal(snap.recent_references.length, 5);
  assert.equal(snap.recent_references[0]!.phrase, "phrase-0");
  assert.equal(snap.recent_references[4]!.phrase, "phrase-4");
});

test("the 6th append drops only the oldest entry (FIFO of 1)", () => {
  let snap = freshSnapshot();
  for (let i = 0; i < 5; i += 1) {
    snap = appendRecentReference(snap, ref(i));
  }
  snap = appendRecentReference(snap, ref(5));
  assert.equal(snap.recent_references.length, 5);
  // Oldest (phrase-0) gone, phrase-5 is the new tail.
  assert.equal(snap.recent_references[0]!.phrase, "phrase-1");
  assert.equal(snap.recent_references[4]!.phrase, "phrase-5");
});

test("non-recent_references fields on the snapshot are passed through unchanged", () => {
  const seed = parseSnapshot({
    cartItems: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home Jersey",
        quantity: 1,
        size: "M",
        unitPriceBdt: 1450,
        line_id: "line-rm-home-24",
      },
    ],
    customerProfile: { name: "Mahir", phone: "017xxxxxxx" },
    agent: { order_state: "CART_BUILDING", confidence_level: 0.9 },
  });

  const next = appendRecentReference(seed, ref(0));

  assert.equal(next.cart.length, 1);
  assert.equal(next.cart[0]!.sku, "RM-HOME-24");
  assert.equal(next.profile.name, "Mahir");
  assert.equal(next.order_state, "CART_BUILDING");
  assert.equal(next.confidence_level, 0.9);
  // And by reference: cart array isn't cloned (we only spread the top-level snapshot).
  assert.equal(next.cart, seed.cart);
});

test("supports product target_kind in addition to line", () => {
  let snap = freshSnapshot();
  snap = appendRecentReference(snap, {
    phrase: "WC26 ta",
    target_kind: "product",
    target_id: "WC26",
    ts: "2024-09-10T00:00:00.000Z",
  });
  assert.equal(snap.recent_references.length, 1);
  assert.equal(snap.recent_references[0]!.target_kind, "product");
  assert.equal(snap.recent_references[0]!.target_id, "WC26");
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
