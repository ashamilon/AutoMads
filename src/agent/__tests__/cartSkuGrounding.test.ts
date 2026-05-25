/**
 * Anti-hallucination guard tests for `add_to_cart` (task 3.4 — Reqs 6.4, 10.1, 10.5).
 *
 * Same `tsx`-runnable harness used by the rest of `src/agent/__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/cartSkuGrounding.test.ts
 *
 * The guard refuses BEFORE the Prisma lookup when the supplied sku is not present in
 * `snapshot.shownSkus` and not present in `snapshot.lastShown[*].sku`. We assert two
 * properties on the refusal:
 *
 *  1. The handler returns `{ ok: false, error: "sku_not_grounded" }` with the
 *     documented observation prefix (so `persistTurnTrace` lands `errorCode =
 *     "sku_not_grounded"` on the AgentTrace row).
 *  2. The cart in the snapshot is unchanged — `saveSnapshot` is never invoked, so a
 *     hallucinated sku cannot leak into `pendingDraftJson`.
 *
 * Because the guard short-circuits before any database call, this test does not need
 * a live Prisma client or a fixture — Prisma is never reached on the refusal path.
 * The positive grounded-path is covered by `cart.multi.test.ts` and the runner-level
 * smoke tests, so we don't repeat it here; this file's job is to pin the refusal.
 */

import assert from "node:assert/strict";
import { cartTools } from "../tools/cart.js";
import type { AgentSnapshot, AgentTurnInput, ToolHandlerCtx } from "../types.js";

type TestCase = { name: string; run: () => Promise<void> };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

const addToCart = cartTools.find((t) => t.name === "add_to_cart");
assert.ok(addToCart, "add_to_cart tool must be registered in cartTools");

function makeInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    tenantId: "tenant-1",
    tenantSlug: "tenant-1-slug",
    psid: "psid-1",
    conversationId: "conv-1",
    userText: "ektA jersey nibO",
    imageUrls: [],
    pageAccessToken: "PAGE-TOKEN",
    within24h: true,
    ...overrides,
  };
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

/**
 * Build a tool ctx whose `saveSnapshot` records every call so the test can assert
 * "cart unchanged" by checking that `saveSnapshot` was never invoked. We do NOT touch
 * Prisma in this ctx — the grounding refusal short-circuits before any Prisma call,
 * so no stubs are needed.
 */
function makeCtx(input: AgentTurnInput, snapshot: AgentSnapshot): {
  ctx: ToolHandlerCtx;
  saved: AgentSnapshot[];
  getSnapshot: () => AgentSnapshot;
} {
  let working = snapshot;
  const saved: AgentSnapshot[] = [];
  const ctx: ToolHandlerCtx = {
    input,
    get snapshot() {
      return working;
    },
    saveSnapshot: async (next) => {
      saved.push(next);
      working = next;
    },
  };
  return { ctx, saved, getSnapshot: () => working };
}

test(
  "add_to_cart {sku: MADE-UP-9999} with empty shownSkus/lastShown returns sku_not_grounded and does NOT mutate the cart",
  async () => {
    const input = makeInput();
    // Empty grounding context — no search_catalog has run, no products have been shown.
    const snapshot = makeSnapshot({ shownSkus: [], lastShown: [] });
    const { ctx, saved, getSnapshot } = makeCtx(input, snapshot);

    const result = await addToCart!.handler(
      { sku: "MADE-UP-9999", quantity: 1 },
      ctx,
    );

    assert.equal(result.ok, false, "guard MUST refuse a sku that was never shown");
    if (result.ok) return;

    assert.equal(result.error, "sku_not_grounded");
    // The observation is what surfaces back to the router on the next iteration AND
    // (via `errorCode = observation.split(":")[0]`) what lands in AgentTrace.
    assert.match(result.observation, /^sku_not_grounded:/);
    assert.match(result.observation, /MADE-UP-9999/);
    assert.match(result.observation, /search_catalog|resolve_product_name/);

    // saveSnapshot was never called — the snapshot's cart is untouched.
    assert.equal(saved.length, 0, "saveSnapshot MUST NOT be invoked on refusal");
    assert.deepEqual(getSnapshot().cart, [], "cart MUST remain empty after refusal");
  },
);

test(
  "add_to_cart with a sku present in shownSkus passes the grounding guard (and only fails later when Prisma can't resolve it)",
  async () => {
    const input = makeInput();
    // `RM-HOME-24` was previously surfaced via search_catalog this conversation.
    const snapshot = makeSnapshot({ shownSkus: ["RM-HOME-24"], lastShown: [] });
    const { ctx, saved } = makeCtx(input, snapshot);

    // We deliberately do NOT stub Prisma here. The guard passes (good), then the
    // Prisma lookup will throw because there's no real DB / fixture. We only care
    // that the refusal we get back is NOT the grounding refusal — so the guard
    // correctly admitted this sku.
    let result: Awaited<ReturnType<typeof addToCart.handler>> | null = null;
    try {
      result = await addToCart!.handler({ sku: "RM-HOME-24", quantity: 1 }, ctx);
    } catch {
      // Prisma threw because no DB is wired up in this test process. That's fine:
      // the throw means the guard let us through and we reached the Prisma call.
      // saveSnapshot was still never reached, which is the property we care about.
    }

    if (result && !result.ok) {
      // If Prisma returned cleanly (e.g. rejected by .catch elsewhere), the only
      // refusal we accept here is the downstream "sku_not_found" / "sku_inactive"
      // — anything else means the guard mis-fired.
      assert.notEqual(
        result.error,
        "sku_not_grounded",
        "shownSkus-grounded sku must NOT be refused by the anti-hallucination guard",
      );
    }
    assert.equal(saved.length, 0, "Prisma failure path must not have written a snapshot");
  },
);

test("add_to_cart with a sku present only in lastShown passes the grounding guard", async () => {
  const input = makeInput();
  const snapshot = makeSnapshot({
    shownSkus: [],
    lastShown: [{ sku: "ARG-AWAY-22", label: "Argentina Away" }],
  });
  const { ctx, saved } = makeCtx(input, snapshot);

  let result: Awaited<ReturnType<typeof addToCart.handler>> | null = null;
  try {
    result = await addToCart!.handler({ sku: "ARG-AWAY-22", quantity: 1 }, ctx);
  } catch {
    // Prisma not wired — see notes above.
  }
  if (result && !result.ok) {
    assert.notEqual(
      result.error,
      "sku_not_grounded",
      "lastShown-grounded sku must NOT be refused by the anti-hallucination guard",
    );
  }
  assert.equal(saved.length, 0);
});

async function runAll(): Promise<void> {
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
}

void runAll();
