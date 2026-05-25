/**
 * Unit tests for `resolveReference` (task 4.1 — Deterministic Reference_Resolution).
 *
 * Same `tsx`-runnable shape as the other agent tests in this folder. Run via:
 *
 *     npx tsx src/agent/__tests__/referenceResolver.test.ts
 *
 * Validates Requirements §9.1–§9.5: the resolver fires the documented priority
 * branches deterministically and returns the documented confidence scores.
 */

import assert from "node:assert/strict";
import {
  extractOrdinalIndex,
  ORDINAL_BANGLISH_RE,
  ORDINAL_SUFFIX_RE,
  PRODUCT_CODE_RE,
  resolveReference,
} from "../referenceResolver.js";
import { parseSnapshot } from "../state.js";
import type { AgentRecentReference, AgentSnapshot } from "../types.js";

type TestCase = { name: string; run: () => void };
const tests: TestCase[] = [];
function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

function snapshotWith(args: {
  cart?: AgentSnapshot["cart"];
  lastShown?: AgentSnapshot["lastShown"];
}): AgentSnapshot {
  const seed = parseSnapshot({});
  return {
    ...seed,
    cart: args.cart ?? seed.cart,
    lastShown: args.lastShown ?? seed.lastShown,
  };
}

// --- Ordinal extraction ----------------------------------------------------

test("extractOrdinalIndex picks up Banglish word ordinals", () => {
  assert.equal(extractOrdinalIndex("prothom ta nibo")?.index, 1);
  assert.equal(extractOrdinalIndex("ditiyo ta dao")?.index, 2);
  assert.equal(extractOrdinalIndex("tritiyo ta lagbe")?.index, 3);
});

test("extractOrdinalIndex picks up English word ordinals", () => {
  assert.equal(extractOrdinalIndex("the first one please")?.index, 1);
  assert.equal(extractOrdinalIndex("second one")?.index, 2);
  assert.equal(extractOrdinalIndex("third item")?.index, 3);
});

test("extractOrdinalIndex picks up suffix ordinals (1st, 2nd, 3rd)", () => {
  assert.equal(extractOrdinalIndex("1st ta")?.index, 1);
  assert.equal(extractOrdinalIndex("2nd one")?.index, 2);
  assert.equal(extractOrdinalIndex("3rd one nibo")?.index, 3);
});

test("extractOrdinalIndex picks up Banglish 'N ta' / 'N number' / 'N item'", () => {
  assert.equal(extractOrdinalIndex("1 ta lagbe")?.index, 1);
  assert.equal(extractOrdinalIndex("2 number")?.index, 2);
  assert.equal(extractOrdinalIndex("3 item dao")?.index, 3);
});

test("extractOrdinalIndex falls back to a bare digit when no other indicator", () => {
  assert.equal(extractOrdinalIndex("2")?.index, 2);
});

test("extractOrdinalIndex does NOT confuse attribute values like 'size 42'", () => {
  // size 42 must NOT be read as the 42nd item.
  assert.equal(extractOrdinalIndex("make the boot size 42"), null);
});

test("extractOrdinalIndex returns null for messages with no ordinal", () => {
  assert.equal(extractOrdinalIndex("ami jersey nibo"), null);
});

test("ordinal regex helpers are exported and usable", () => {
  assert.ok(ORDINAL_SUFFIX_RE.test("3rd"));
  assert.ok(ORDINAL_BANGLISH_RE.test("3 ta"));
  PRODUCT_CODE_RE.lastIndex = 0;
  assert.ok(PRODUCT_CODE_RE.exec("WC26 ta"));
});

// --- Priority 1: lastShown ordinal -----------------------------------------

test("priority 1: lastShown ordinal returns kind=product with confidence 1.0", () => {
  const snap = snapshotWith({
    lastShown: [
      { sku: "RM-HOME", label: "Real Madrid Home Jersey" },
      { sku: "BARC-HOME", label: "Barcelona Home Jersey" },
      { sku: "ARG-HOME", label: "Argentina Home Jersey" },
    ],
  });
  const r = resolveReference(snap, "prothom ta nibo");
  assert.equal(r.kind, "product");
  if (r.kind !== "product") return;
  assert.equal(r.product_id, "RM-HOME");
  assert.equal(r.confidence_score, 1.0);
  assert.match(r.debug, /priority1/);
});

test("priority 1: '2' resolves to lastShown[1]", () => {
  const snap = snapshotWith({
    lastShown: [
      { sku: "A", label: "A label" },
      { sku: "B", label: "B label" },
    ],
  });
  const r = resolveReference(snap, "2");
  assert.equal(r.kind, "product");
  if (r.kind !== "product") return;
  assert.equal(r.product_id, "B");
});

test("priority 1: 'second ta' resolves to lastShown[1]", () => {
  const snap = snapshotWith({
    lastShown: [
      { sku: "A", label: "A label" },
      { sku: "B", label: "B label" },
    ],
  });
  const r = resolveReference(snap, "second ta");
  assert.equal(r.kind, "product");
  if (r.kind !== "product") return;
  assert.equal(r.product_id, "B");
});

// --- Priority 2: cart ordinal ----------------------------------------------

test("priority 2: cart ordinal when no lastShown is present", () => {
  const snap = snapshotWith({
    cart: [
      { sku: "A", product: "Jersey A", quantity: 1, line_id: "L-A" },
      { sku: "B", product: "Jersey B", quantity: 1, line_id: "L-B" },
    ],
  });
  const r = resolveReference(snap, "first item remove koro");
  assert.equal(r.kind, "line");
  if (r.kind !== "line") return;
  assert.equal(r.line_id, "L-A");
  assert.equal(r.confidence_score, 1.0);
  assert.match(r.debug, /priority2/);
});

test("priority 2: 'second one' resolves to cart[1] when lastShown is empty", () => {
  const snap = snapshotWith({
    cart: [
      { sku: "A", product: "Jersey A", quantity: 1, line_id: "L-A" },
      { sku: "B", product: "Jersey B", quantity: 1, line_id: "L-B" },
    ],
  });
  const r = resolveReference(snap, "second one");
  assert.equal(r.kind, "line");
  if (r.kind !== "line") return;
  assert.equal(r.line_id, "L-B");
});

test("priority 2: cart ordinal fires after lastShown ordinal misses (out-of-range)", () => {
  // lastShown only has 1 entry; "second ta" is out of range -> should fall to cart ordinal.
  const snap = snapshotWith({
    lastShown: [{ sku: "X", label: "X label" }],
    cart: [
      { sku: "A", product: "A", quantity: 1, line_id: "L-A" },
      { sku: "B", product: "B", quantity: 1, line_id: "L-B" },
    ],
  });
  const r = resolveReference(snap, "second ta");
  assert.equal(r.kind, "line");
  if (r.kind !== "line") return;
  assert.equal(r.line_id, "L-B");
});

// --- Priority 3: cart attribute match --------------------------------------

test("priority 3: 'make the boot size 42' resolves to the BOOT line, not the jersey", () => {
  const snap = snapshotWith({
    cart: [
      { sku: "JERSEY-A", product: "Real Madrid Jersey", quantity: 1, line_id: "L-JERSEY" },
      { sku: "BOOT-A", product: "Nike Football Boot", quantity: 1, line_id: "L-BOOT" },
    ],
  });
  const r = resolveReference(snap, "make the boot size 42");
  assert.equal(r.kind, "line");
  if (r.kind !== "line") return;
  assert.equal(r.line_id, "L-BOOT");
  assert.equal(r.confidence_score, 0.85);
  assert.match(r.debug, /priority3/);
});

test("priority 3: 'the red one' matches addOn value 'red'", () => {
  const snap = snapshotWith({
    cart: [
      {
        sku: "T-1",
        product: "Tshirt",
        quantity: 1,
        line_id: "L-1",
        addOns: [{ id: "color", label: "Color", priceBdt: 0, value: "blue" }],
      },
      {
        sku: "T-2",
        product: "Tshirt",
        quantity: 1,
        line_id: "L-2",
        addOns: [{ id: "color", label: "Color", priceBdt: 0, value: "red" }],
      },
    ],
  });
  const r = resolveReference(snap, "the red one");
  assert.equal(r.kind, "line");
  if (r.kind !== "line") return;
  assert.equal(r.line_id, "L-2");
  assert.equal(r.confidence_score, 0.85);
});

test("priority 3: ambiguous attribute match returns lower confidence so loop disambiguates", () => {
  // Two lines both contain "jersey" — ambiguous.
  const snap = snapshotWith({
    cart: [
      { sku: "A", product: "Real Madrid Jersey", quantity: 1, line_id: "L-A" },
      { sku: "B", product: "Barcelona Jersey", quantity: 1, line_id: "L-B" },
    ],
  });
  const r = resolveReference(snap, "the jersey size M");
  assert.equal(r.kind, "line");
  if (r.kind !== "line") return;
  assert.ok(r.confidence_score < 0.8, `expected ambiguous score < 0.8, got ${r.confidence_score}`);
});

// --- Priority 4: product code in lastShown labels --------------------------

test("priority 4: 'WC26 ta' matches lastShown label containing 'WC26'", () => {
  const snap = snapshotWith({
    lastShown: [
      { sku: "RM-HOME", label: "Real Madrid Home Jersey" },
      { sku: "WC-26-1", label: "Argentina WC26 Edition" },
    ],
  });
  const r = resolveReference(snap, "WC26 ta dao");
  assert.equal(r.kind, "product");
  if (r.kind !== "product") return;
  assert.equal(r.product_id, "WC-26-1");
  assert.equal(r.confidence_score, 1.0);
  assert.match(r.debug, /priority4/);
});

test("priority 4: 'WC-26' in label is matchable from 'WC26' in message (separator-tolerant)", () => {
  const snap = snapshotWith({
    lastShown: [{ sku: "P", label: "Product WC-26 Edition" }],
  });
  const r = resolveReference(snap, "WC26 ta nibo");
  assert.equal(r.kind, "product");
  if (r.kind !== "product") return;
  assert.equal(r.product_id, "P");
});

// --- Priority 5: fuzzy cart-name match -------------------------------------

test("priority 5: high-overlap cart fuzzy match returns kind=line", () => {
  // The customer types the full distinctive product phrase. With stopwords
  // filtered, "real madrid home jersey" -> ["real","madrid","home","jersey"]
  // matches the line tokens 1:1, score = 1.0.
  const snap = snapshotWith({
    cart: [
      { sku: "RM-HOME", product: "Real Madrid Home Jersey", quantity: 1, line_id: "L-RM" },
      { sku: "OTHER", product: "Tracksuit", quantity: 1, line_id: "L-OTHER" },
    ],
  });
  // Use a phrase that doesn't ALSO trigger priority 3 dominantly — but priority
  // 3 will still fire here on "real/madrid/home" tokens. Both branches resolve
  // to the same line, so the test is order-agnostic on the line_id assertion.
  const r = resolveReference(snap, "Real Madrid Home Jersey");
  assert.equal(r.kind, "line");
  if (r.kind !== "line") return;
  assert.equal(r.line_id, "L-RM");
});

test("priority 5: low-overlap fuzzy returns kind=none", () => {
  const snap = snapshotWith({
    cart: [
      { sku: "RM-HOME", product: "Real Madrid Home Jersey", quantity: 1, line_id: "L-RM" },
    ],
  });
  // Message has no overlap with the cart line's tokens. Should fall through
  // priority 3 (no match) and priority 5 (below 0.8 threshold).
  const r = resolveReference(snap, "porashona kemon cholche");
  assert.equal(r.kind, "none");
  assert.equal(r.confidence_score, 0);
});

// --- onResolve callback (purity contract) ----------------------------------

test("onResolve fires exactly once on a successful resolution", () => {
  const captured: AgentRecentReference[] = [];
  const snap = snapshotWith({
    lastShown: [{ sku: "X", label: "X label" }],
  });
  const r = resolveReference(snap, "prothom ta", {
    onResolve: (ref) => captured.push(ref),
  });
  assert.equal(r.kind, "product");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.target_kind, "product");
  assert.equal(captured[0]!.target_id, "X");
  assert.equal(captured[0]!.phrase, "prothom ta");
  assert.ok(typeof captured[0]!.ts === "string" && captured[0]!.ts.length > 0);
});

test("onResolve does NOT fire on kind=none results", () => {
  const captured: AgentRecentReference[] = [];
  const snap = snapshotWith({});
  const r = resolveReference(snap, "porashona kemon cholche", {
    onResolve: (ref) => captured.push(ref),
  });
  assert.equal(r.kind, "none");
  assert.equal(captured.length, 0);
});

test("the resolver does not mutate the input snapshot", () => {
  const snap = snapshotWith({
    cart: [{ sku: "A", product: "Jersey A", quantity: 1, line_id: "L-A" }],
    lastShown: [{ sku: "X", label: "X label" }],
  });
  const beforeCart = snap.cart;
  const beforeLastShown = snap.lastShown;
  const beforeRefs = snap.recent_references;
  resolveReference(snap, "prothom ta");
  assert.equal(snap.cart, beforeCart);
  assert.equal(snap.lastShown, beforeLastShown);
  assert.equal(snap.recent_references, beforeRefs);
});

// --- empty / blank inputs --------------------------------------------------

test("empty message returns kind=none with a debug string", () => {
  const r = resolveReference(snapshotWith({}), "");
  assert.equal(r.kind, "none");
  assert.equal(r.confidence_score, 0);
  assert.match(r.debug, /empty_message|blank_message/);
});

test("whitespace-only message returns kind=none", () => {
  const r = resolveReference(snapshotWith({}), "   ");
  assert.equal(r.kind, "none");
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
