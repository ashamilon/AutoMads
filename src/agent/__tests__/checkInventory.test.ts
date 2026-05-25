/**
 * Unit tests for `check_inventory` (task 3.2).
 *
 * Same pattern as state.legacy.test.ts: a self-contained `tsx`-runnable script using
 * `node:assert/strict`. Run via:
 *
 *     npx tsx src/agent/__tests__/checkInventory.test.ts
 *
 * Focus: assert that variant-level (per-size) lookup precedes aggregate `stock` when both are
 * present (Req 10.4), and that the helper functions `coerceNumber` / `sizeStockFromMeta` —
 * which `add_to_cart` and `check_inventory` BOTH consume — read identical numbers (Req 6.1).
 *
 * We stub `prisma.productMapping.findUnique` at the module level so the test stays hermetic and
 * doesn't need a database. The tool reads only that one field, so the surface area is small.
 */

import assert from "node:assert/strict";
import { prisma } from "../../db/prisma.js";
import { coerceNumber, sizeStockFromMeta } from "../tools/inventoryHelpers.js";
import { inventoryTools } from "../tools/inventory.js";
import type { AgentSnapshot, AgentTurnInput, ToolHandlerCtx } from "../types.js";

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

function makeCtx(): ToolHandlerCtx {
  const input: AgentTurnInput = {
    tenantId: "tenant-1",
    tenantSlug: "demo",
    psid: "psid-1",
    conversationId: "conv-1",
    userText: "L size ache?",
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
  const snapshot: AgentSnapshot = {
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
    confidence_level: 1,
    followup_needed: false,
    recent_references: [],
  };
  return {
    input,
    snapshot,
    saveSnapshot: async () => {
      /* noop */
    },
  };
}

const checkInventory = inventoryTools.find((t) => t.name === "check_inventory");
assert.ok(checkInventory, "check_inventory tool must be registered in inventoryTools");

// Stub prisma.productMapping.findUnique. We restore the original after each test so the stub
// doesn't leak between cases.
const originalFindUnique = prisma.productMapping.findUnique.bind(prisma.productMapping);
type StubRow = { tenantId: string; clientSku: string; metadata: unknown; facebookLabel?: string | null } | null;
function stubFindUnique(rowFor: (sku: string) => StubRow): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.productMapping as any).findUnique = async (args: any) => {
    const sku = args?.where?.tenantId_clientSku?.clientSku as string;
    return rowFor(sku);
  };
}
function restoreFindUnique(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.productMapping as any).findUnique = originalFindUnique;
}

test("coerceNumber accepts numbers and numeric strings, rejects garbage", () => {
  assert.equal(coerceNumber(5), 5);
  assert.equal(coerceNumber("12"), 12);
  assert.equal(coerceNumber("1,200"), 1200);
  assert.equal(coerceNumber(""), undefined);
  assert.equal(coerceNumber("abc"), undefined);
  assert.equal(coerceNumber(undefined), undefined);
  assert.equal(coerceNumber(null), undefined);
  assert.equal(coerceNumber(NaN), undefined);
});

test("sizeStockFromMeta reads sizeStocks map (case-insensitive)", () => {
  const meta = { sizeStocks: { L: 3, M: 0, XL: "7" } };
  assert.equal(sizeStockFromMeta(meta, "L"), 3);
  assert.equal(sizeStockFromMeta(meta, "l"), 3);
  assert.equal(sizeStockFromMeta(meta, "M"), 0);
  assert.equal(sizeStockFromMeta(meta, "XL"), 7);
  assert.equal(sizeStockFromMeta(meta, "S"), undefined);
});

test("sizeStockFromMeta reads variants[] array shape", () => {
  const meta = {
    variants: [
      { size: "L", stock: 4 },
      { size: "M", stock: "2" },
    ],
  };
  assert.equal(sizeStockFromMeta(meta, "L"), 4);
  assert.equal(sizeStockFromMeta(meta, "M"), 2);
  assert.equal(sizeStockFromMeta(meta, "S"), undefined);
});

test("sizeStockFromMeta returns undefined when no per-size data exists", () => {
  assert.equal(sizeStockFromMeta({ stock: 10 }, "L"), undefined);
  assert.equal(sizeStockFromMeta({}, "L"), undefined);
});

test("check_inventory: variant-level lookup precedes aggregate stock when BOTH are present", async () => {
  // The catalog row says aggregate stock=10 but per-size L=2. The tool MUST report 2, not 10.
  stubFindUnique(() => ({
    tenantId: "tenant-1",
    clientSku: "ARG-HOME-24",
    metadata: { stock: 10, sizeStocks: { L: 2, M: 0 }, isActive: true },
  }));
  try {
    const ctx = makeCtx();
    const sized = await checkInventory!.handler({ sku: "ARG-HOME-24", size: "L" }, ctx);
    assert.equal(sized.ok, true);
    if (sized.ok) {
      const data = sized.data as {
        in_stock: boolean;
        stock: number | null;
        sku: string;
        size: string | null;
        is_active: boolean;
      };
      assert.equal(data.stock, 2, "must use per-size L=2, NOT aggregate 10");
      assert.equal(data.in_stock, true);
      assert.equal(data.size, "L");
      assert.equal(data.sku, "ARG-HOME-24");
      assert.equal(data.is_active, true);
    }

    // Same sku, size=M → per-size says 0 → in_stock=false even though aggregate=10.
    const zeroSize = await checkInventory!.handler({ sku: "ARG-HOME-24", size: "M" }, ctx);
    assert.equal(zeroSize.ok, true);
    if (zeroSize.ok) {
      const data = zeroSize.data as { in_stock: boolean; stock: number | null };
      assert.equal(data.stock, 0, "must use per-size M=0, NOT aggregate 10");
      assert.equal(data.in_stock, false);
    }

    // No size supplied → falls back to aggregate stock=10.
    const noSize = await checkInventory!.handler({ sku: "ARG-HOME-24" }, ctx);
    assert.equal(noSize.ok, true);
    if (noSize.ok) {
      const data = noSize.data as { in_stock: boolean; stock: number | null; size: string | null };
      assert.equal(data.stock, 10, "no size supplied → aggregate stock");
      assert.equal(data.in_stock, true);
      assert.equal(data.size, null);
    }
  } finally {
    restoreFindUnique();
  }
});

test("check_inventory: returns sku_not_found when productMapping has no matching row", async () => {
  stubFindUnique(() => null);
  try {
    const ctx = makeCtx();
    const result = await checkInventory!.handler({ sku: "DOES-NOT-EXIST" }, ctx);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "sku_not_found");
      assert.match(result.observation, /not in catalog/);
    }
  } finally {
    restoreFindUnique();
  }
});

test("check_inventory: respects isActive flag and never reports in_stock for inactive rows", async () => {
  stubFindUnique(() => ({
    tenantId: "tenant-1",
    clientSku: "RM-OLD",
    metadata: { stock: 5, isActive: false },
  }));
  try {
    const ctx = makeCtx();
    const result = await checkInventory!.handler({ sku: "RM-OLD" }, ctx);
    assert.equal(result.ok, true);
    if (result.ok) {
      const data = result.data as { in_stock: boolean; stock: number | null; is_active: boolean };
      assert.equal(data.is_active, false);
      assert.equal(data.stock, 5);
      assert.equal(data.in_stock, false, "inactive row → in_stock must be false even with stock>0");
    }
  } finally {
    restoreFindUnique();
  }
});

test("check_inventory: stock=null reported when catalog carries no stock data", async () => {
  stubFindUnique(() => ({
    tenantId: "tenant-1",
    clientSku: "BD-AWAY-22",
    metadata: { isActive: true },
  }));
  try {
    const ctx = makeCtx();
    const result = await checkInventory!.handler({ sku: "BD-AWAY-22", size: "L" }, ctx);
    assert.equal(result.ok, true);
    if (result.ok) {
      const data = result.data as { in_stock: boolean; stock: number | null };
      assert.equal(data.stock, null);
      assert.equal(data.in_stock, false, "unknown stock → in_stock=false (don't promise what we can't verify)");
    }
  } finally {
    restoreFindUnique();
  }
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
