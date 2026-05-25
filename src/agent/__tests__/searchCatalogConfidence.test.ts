/**
 * Tests for the per-row `confidence_score` exposed by `search_catalog` (task 6.1).
 *
 * Same `tsx`-runnable harness as `state.fsm.test.ts` (no external runner). Run via:
 *
 *     npx tsx src/agent/__tests__/searchCatalogConfidence.test.ts
 *
 * Validates Requirements §11.1 and §4.4: every entry in the returned `data`
 * payload carries a `confidence_score` in `[0, 1]`, the top row scores 1.0, and
 * a clearly weaker alternative scores strictly lower in the open interval (0, 1).
 *
 * The test calls the `search_catalog` handler directly with a stubbed Prisma row
 * set so it does not require a live database. We monkey-patch
 * `prisma.productMapping.findMany` for the duration of the test.
 */

import assert from "node:assert/strict";
import { prisma } from "../../db/prisma.js";
import { catalogTools } from "../tools/catalog.js";
import { normaliseScore } from "../tools/resolve.js";
import type { AgentSnapshot, AgentTurnInput } from "../types.js";

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

function makeSnapshot(): AgentSnapshot {
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
  };
}

function makeInput(): AgentTurnInput {
  return {
    tenantId: "tenant_test",
    tenantSlug: "test",
    psid: "psid_test",
    conversationId: "conv_test",
    userText: "argentina terrace kit",
    imageUrls: [],
    pageAccessToken: "tok",
    within24h: true,
  };
}

const searchCatalog = catalogTools.find((t) => t.name === "search_catalog");
assert.ok(searchCatalog, "search_catalog tool must be registered");

// Catalog fixture: top row owns BOTH "argentina" and "terrace" in the label;
// runner-up only owns "argentina" — clearly weaker.
const FIXTURE_ROWS = [
  {
    clientSku: "ARG-TERRACE-24",
    facebookLabel: "Argentina Terrace Kit 2024",
    metadata: {
      name: "Argentina Terrace Kit 2024",
      price: 1499,
      stock: 10,
      availableSizes: ["S", "M", "L"],
      isActive: true,
      tags: "argentina terrace retro",
    },
  },
  {
    clientSku: "ARG-HOME-24",
    facebookLabel: "Argentina Home Jersey 2024",
    metadata: {
      name: "Argentina Home Jersey 2024",
      price: 1399,
      stock: 5,
      availableSizes: ["S", "M", "L"],
      isActive: true,
      tags: "argentina jersey",
    },
  },
  {
    clientSku: "BRA-HOME-24",
    facebookLabel: "Brazil Home Jersey 2024",
    metadata: {
      name: "Brazil Home Jersey 2024",
      price: 1399,
      stock: 5,
      availableSizes: ["S", "M", "L"],
      isActive: true,
      tags: "brazil jersey",
    },
  },
];

function withStubbedPrisma<T>(fn: () => Promise<T>): Promise<T> {
  const original = prisma.productMapping.findMany;
  // Cast to a permissive shape — we only need the query to return our fixture.
  (prisma.productMapping as unknown as { findMany: (...args: unknown[]) => unknown }).findMany =
    async () => FIXTURE_ROWS;
  return fn().finally(() => {
    (prisma.productMapping as unknown as { findMany: typeof original }).findMany = original;
  });
}

type Card = {
  sku: string;
  label: string;
  priceBdt: number | null;
  stock: number | null;
  sizes: string[];
  isActive: boolean;
  confidence_score: number;
};

async function runSearch(query: string): Promise<Card[]> {
  let saved: AgentSnapshot | null = null;
  const ctx = {
    input: { ...makeInput(), userText: query },
    snapshot: makeSnapshot(),
    saveSnapshot: async (next: AgentSnapshot) => {
      saved = next;
    },
  };
  const result = await searchCatalog!.handler({ query, limit: 5 }, ctx);
  assert.equal(result.ok, true, "search_catalog should succeed against the fixture");
  if (!result.ok) throw new Error("unreachable");
  void saved;
  return result.data as Card[];
}

// --- normaliseScore unit ---

test("normaliseScore: top → 1.0, half → 0.5, zero → 0, clamps above 1", () => {
  assert.equal(normaliseScore(10, 10), 1);
  assert.equal(normaliseScore(10, 5), 0.5);
  assert.equal(normaliseScore(10, 0), 0);
  assert.equal(normaliseScore(10, -3), 0);
  assert.equal(normaliseScore(0, 0), 0);
  assert.equal(normaliseScore(10, 99), 1);
});

// --- search_catalog confidence_score wiring ---

test("search_catalog tags every returned card with a confidence_score in [0, 1]", async () => {
  const cards = await withStubbedPrisma(() => runSearch("argentina terrace kit"));
  assert.ok(cards.length >= 2, `expected >= 2 ranked cards, got ${cards.length}`);
  for (const c of cards) {
    assert.equal(typeof c.confidence_score, "number", `confidence_score missing on ${c.sku}`);
    assert.ok(
      c.confidence_score >= 0 && c.confidence_score <= 1,
      `confidence_score out of [0,1] on ${c.sku}: ${c.confidence_score}`,
    );
  }
});

test("search_catalog: top result has confidence_score === 1.0", async () => {
  const cards = await withStubbedPrisma(() => runSearch("argentina terrace kit"));
  assert.equal(cards[0]!.sku, "ARG-TERRACE-24", "fixture sanity: top row should be the terrace kit");
  assert.equal(
    cards[0]!.confidence_score,
    1,
    `top row must have confidence_score === 1.0, got ${cards[0]!.confidence_score}`,
  );
});

test("search_catalog: a clearly weaker alternative is strictly lower in (0, 1)", async () => {
  const cards = await withStubbedPrisma(() => runSearch("argentina terrace kit"));
  // We need a runner-up that shares some signal with the query (so it's still ranked)
  // but is clearly weaker (so its score is < top). The `argentina home jersey` row fits.
  const runnerUp = cards.find((c) => c.sku === "ARG-HOME-24");
  assert.ok(runnerUp, "fixture sanity: argentina home should be in the ranked set");
  assert.ok(
    runnerUp.confidence_score > 0,
    `runner-up must have confidence_score > 0 (was ${runnerUp.confidence_score})`,
  );
  assert.ok(
    runnerUp.confidence_score < 1,
    `runner-up must have confidence_score < 1 (was ${runnerUp.confidence_score})`,
  );
  assert.ok(
    runnerUp.confidence_score < cards[0]!.confidence_score,
    `runner-up score (${runnerUp.confidence_score}) must be strictly less than top (${cards[0]!.confidence_score})`,
  );
});

// --- runner ---

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
