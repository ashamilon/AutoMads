/**
 * Unit tests for `filterReply` (task 10.1).
 *
 * Same pattern as the other agent unit tests: a self-contained `tsx`-runnable script using
 * `node:assert/strict`. Run via:
 *
 *     npx tsx src/agent/__tests__/replyFilter.test.ts
 *
 * Coverage:
 *   • Pass 1 — banned-word substitution (delegates to `sanitizeCustomerReply`).
 *   • Pass 2 — anti-hallucination strips ungrounded price + size claims.
 *   • Pass 3 — confirmation-phrase block fires when no `create_order` step succeeded.
 *
 * These map to Reqs 10.1, 10.2, 10.3, 10.6, 14.2, 14.3, 14.6.
 */

import assert from "node:assert/strict";
import {
  filterReply,
  sanitizeCustomerReply,
  type FilterTraceStep,
  type VerifiedToolResult,
} from "../replyFilter.js";

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

// ─── Pass 1: banned-word substitution ────────────────────────────────────────

test("filterReply rewrites banned words and records overrides", () => {
  const result = filterReply("Apnar cart e 2 ta item ache, checkout korben?", [], []);
  assert.equal(result.text, "Apnar list e 2 ta item ache, order confirm korben?");
  assert.ok(
    result.overrides.some((o) => o.kind === "banned_word" && o.from.toLowerCase() === "cart"),
    "must record a banned_word override for 'cart'",
  );
  assert.ok(
    result.overrides.some((o) => o.kind === "banned_word" && /check/i.test(o.from)),
    "must record a banned_word override for 'checkout'",
  );
});

test("filterReply keeps sanitizeCustomerReply behaviour for direct callers", () => {
  // Existing callers (tools/reply.ts, runner.ts) still use sanitizeCustomerReply directly.
  // Make sure that path is unchanged.
  assert.equal(sanitizeCustomerReply("Apnar cart e checkout koren"), "Apnar list e order confirm koren");
});

// ─── Tone rewrites — soften robotic "dewa holo / kora holo" stems ───────────

test("sanitizeCustomerReply softens 'niche dewa holo' into warm active phrasing", () => {
  const out = sanitizeCustomerReply("Niche dewa holo apnar product list.");
  assert.match(out, /ei je dekhe nin/);
  assert.doesNotMatch(out, /dewa holo/i);
});

test("sanitizeCustomerReply softens 'pathano holo' into 'pathiye dilam'", () => {
  const out = sanitizeCustomerReply("Apnar address e parcel pathano holo.");
  assert.match(out, /pathiye dilam/);
  assert.doesNotMatch(out, /pathano holo/i);
});

test("sanitizeCustomerReply rewrites 'add kora holo' into 'add kore dilam'", () => {
  const out = sanitizeCustomerReply("Apnar list e item add kora holo.");
  assert.match(out, /add kore dilam/);
});

test("filterReply records tone_rewrite override rows for 'dewa holo' replacements", () => {
  const result = filterReply("Niche dewa holo apnar list.", [], []);
  assert.match(result.text, /ei je dekhe nin/);
  assert.ok(
    result.overrides.some((o) => o.kind === "tone_rewrite"),
    "must record at least one tone_rewrite override",
  );
});

// ─── Capability-confession rewrites ──────────────────────────────────────────

test("sanitizeCustomerReply rewrites 'uporer message dekhte parchi na' into a warm pivot", () => {
  const out = sanitizeCustomerReply(
    "Uporer message ami dekhte parchi na. Apnar order id ki?",
  );
  // The confession sentence is gone; the warm pivot is in.
  assert.doesNotMatch(out, /dekhte parchi na/i);
  assert.match(out, /Apni ektu bolen ki niye janche/);
  // The follow-up question survives.
  assert.match(out, /order id/);
});

test("sanitizeCustomerReply rewrites English 'I cannot see your previous messages' confession", () => {
  const out = sanitizeCustomerReply(
    "I cannot see your previous messages. Could you share more?",
  );
  assert.doesNotMatch(out, /cannot see/i);
  assert.match(out, /Apni ektu bolen ki niye janche/);
});

test("sanitizeCustomerReply rewrites 'ami remember korte parchi na' confession", () => {
  const out = sanitizeCustomerReply("Ami remember korte parchi na apnar age er order.");
  assert.doesNotMatch(out, /remember korte parchi na/i);
  assert.match(out, /Apni ektu bolen/);
});

test("sanitizeCustomerReply leaves clean replies untouched", () => {
  const original = "Apnar order list ready, confirm korben?";
  assert.equal(sanitizeCustomerReply(original), original);
});

test("filterReply records capability_confession override rows", () => {
  const result = filterReply(
    "Uporer message ami dekhte parchi na. Order id ta diben?",
    [],
    [],
  );
  assert.ok(
    result.overrides.some((o) => o.kind === "capability_confession"),
    "must record at least one capability_confession override",
  );
});

// ─── Pass 2: anti-hallucination ──────────────────────────────────────────────

test("filterReply strips ungrounded price tokens", () => {
  const tools: VerifiedToolResult[] = [
    { name: "search_catalog", observation: "RM jersey BDT 1500", data: { unitPriceBdt: 1500 } },
  ];
  const result = filterReply("RM jersey ta 9999 BDT, order korben?", tools, []);
  assert.match(result.text, /dam admin verify kore janabe/);
  assert.doesNotMatch(result.text, /9999/);
  assert.ok(
    result.overrides.some((o) => o.kind === "anti_hallucination" && o.attribute === "price"),
    "must record an anti_hallucination override for the bogus price",
  );
});

test("filterReply leaves grounded price tokens alone", () => {
  const tools: VerifiedToolResult[] = [
    { name: "search_catalog", observation: "RM jersey 1500 BDT", data: { unitPriceBdt: 1500 } },
  ];
  const result = filterReply("RM jersey ta 1500 BDT, order korben?", tools, []);
  assert.equal(result.text, "RM jersey ta 1500 BDT, order korben?");
  assert.equal(result.overrides.length, 0);
});

test("filterReply strips ungrounded size claims", () => {
  const tools: VerifiedToolResult[] = [
    { name: "check_inventory", observation: "L size 3 ache", data: { size: "L", stock: 3 } },
  ];
  // Reply claims XXL is in stock — not grounded by any tool result.
  const result = filterReply("XXL size ache apnar jonno", tools, []);
  assert.match(result.text, /size info admin theke confirm korbo/);
  assert.ok(
    result.overrides.some(
      (o) => o.kind === "anti_hallucination" && o.attribute === "size" && o.value === "XXL",
    ),
    "must record an anti_hallucination override for the XXL claim",
  );
});

test("filterReply leaves grounded size claims alone", () => {
  const tools: VerifiedToolResult[] = [
    { name: "check_inventory", observation: "L size 3 ache", data: { size: "L", stock: 3 } },
  ];
  const result = filterReply("L size ache apnar jonno", tools, []);
  assert.equal(result.text, "L size ache apnar jonno");
  assert.equal(result.overrides.length, 0);
});

test("filterReply is conservative: a bare 'L' outside size context is NOT flagged", () => {
  // Plain English text containing letter L should not trip the size guard.
  const result = filterReply("Apnar order list ready ache.", [], []);
  // No size override.
  assert.equal(
    result.overrides.filter((o) => o.kind === "anti_hallucination" && o.attribute === "size").length,
    0,
  );
});

// ─── Pass 3: confirmation block ──────────────────────────────────────────────

test("filterReply blocks 'order confirmed' when no create_order step ran", () => {
  const result = filterReply("Apnar order confirmed!", [], []);
  assert.equal(result.text, "Apnar order list ready, confirm korben?");
  assert.ok(
    result.overrides.some((o) => o.kind === "confirmation_block"),
    "must record a confirmation_block override",
  );
});

test("filterReply blocks 'payment received' when no create_order step ran", () => {
  const result = filterReply("Payment received, dhonnobad!", [], []);
  assert.equal(result.text, "Apnar order list ready, confirm korben?");
});

test("filterReply blocks Banglish 'order place hoye gechhe' when no create_order step ran", () => {
  const result = filterReply("Apnar order place hoye gechhe.", [], []);
  assert.equal(result.text, "Apnar order list ready, confirm korben?");
});

test("filterReply allows confirmation phrase when create_order succeeded", () => {
  const trace: FilterTraceStep[] = [
    { tool: "search_catalog", ok: true },
    { tool: "create_order", ok: true, data: { orderId: "ord_123" } },
  ];
  const result = filterReply("Apnar order confirmed! Dhonnobad.", [], trace);
  assert.equal(result.text, "Apnar order confirmed! Dhonnobad.");
  assert.equal(
    result.overrides.filter((o) => o.kind === "confirmation_block").length,
    0,
    "must NOT fire confirmation block when create_order ok",
  );
});

test("filterReply does NOT allow confirmation phrase when create_order failed", () => {
  const trace: FilterTraceStep[] = [{ tool: "create_order", ok: false }];
  const result = filterReply("Apnar order confirmed!", [], trace);
  assert.equal(result.text, "Apnar order list ready, confirm korben?");
});

// ─── Empty / no-op cases ─────────────────────────────────────────────────────

test("filterReply on empty text returns empty + no overrides", () => {
  const result = filterReply("", [], []);
  assert.equal(result.text, "");
  assert.equal(result.overrides.length, 0);
});

test("filterReply on clean text returns text unchanged + no overrides", () => {
  const result = filterReply("Apnar list ready, order confirm korben?", [], []);
  assert.equal(result.text, "Apnar list ready, order confirm korben?");
  assert.equal(result.overrides.length, 0);
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
