/**
 * Unit tests for `validate_order` and its precondition role for `confirm_order`
 * (task 7.2 — Req 6.6).
 *
 * Same `tsx`-runnable harness as the rest of `src/agent/__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/validateOrder.test.ts
 *
 * What's covered:
 *
 *  1. `validate_order` re-reads every cart line from `prisma.productMapping`, returns
 *     `{ ok: false, failures }` for a cart that contains an inactive sku, and writes
 *     the result onto the snapshot under `confirmed_information.__validation`.
 *  2. `confirm_order` reads that persisted result on the next turn and refuses to run
 *     with `error = "validation_failed"` and the validation reason surfaced.
 *  3. Reverse path: a clean cart passes validation and the persisted result is `ok=true`.
 *  4. Failure-code coverage for the spec's enumerated codes:
 *     `sku_not_found`, `sku_inactive`, `insufficient_stock`, `price_drift`,
 *     `addon_not_allowed`, `addon_price_drift`.
 *
 * We stub `prisma.productMapping.findUnique`, `prisma.tenant.findUnique`, and
 * `prisma.messengerConversation.findUnique` / `.update` with tiny in-memory shims so
 * the test stays hermetic. Stubs are restored after each case so siblings stay clean.
 */

import assert from "node:assert/strict";
import { prisma } from "../../db/prisma.js";
import { confirmTools } from "../tools/confirm.js";
import {
  readLatestValidation,
  runValidation,
  validateOrderTools,
} from "../tools/validate.js";
import type { AgentCartItem, AgentSnapshot, AgentTurnInput, ToolHandlerCtx } from "../types.js";

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

const validateTool = validateOrderTools.find((t) => t.name === "validate_order");
const confirmTool = confirmTools.find((t) => t.name === "confirm_order");
assert.ok(validateTool, "validate_order tool must be registered in validateOrderTools");
assert.ok(confirmTool, "confirm_order tool must be registered in confirmTools");

function emptySnapshot(): AgentSnapshot {
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

function makeInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    tenantId: "tenant-1",
    tenantSlug: "demo",
    psid: "psid-1",
    conversationId: "conv-1",
    userText: "order confirm",
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
    ...overrides,
  };
}

function makeCtx(input: AgentTurnInput, initial: AgentSnapshot): {
  ctx: ToolHandlerCtx;
  getWorking: () => AgentSnapshot;
} {
  let working = initial;
  const ctx: ToolHandlerCtx = {
    input,
    get snapshot() {
      return working;
    },
    saveSnapshot: async (next) => {
      working = next;
    },
  };
  return { ctx, getWorking: () => working };
}

// ─────────────────────────── Prisma stubs ───────────────────────────
//
// We stub the three Prisma surfaces the tools touch on the validation path:
//   - productMapping.findUnique  → catalog row lookup (active flag, price, stock, add-ons)
//   - tenant.findUnique          → tenant settings (only consulted for add-on resolution)
//   - messengerConversation.*    → confirm_order's snapshot side-channel write
//
// Each test installs a fresh stub set and restores at the end.

type ProductRow = {
  tenantId: string;
  clientSku: string;
  metadata: unknown;
  facebookLabel?: string | null;
} | null;

const originalProductFindUnique = prisma.productMapping.findUnique.bind(prisma.productMapping);
const originalTenantFindUnique = prisma.tenant.findUnique.bind(prisma.tenant);
const originalConvFindUnique = prisma.messengerConversation.findUnique.bind(
  prisma.messengerConversation,
);
const originalConvUpdate = prisma.messengerConversation.update.bind(prisma.messengerConversation);

function installPrismaStubs(args: {
  productRow: (sku: string) => ProductRow;
  tenantSettings?: unknown;
}): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.productMapping as any).findUnique = async (input: any) => {
    const sku = input?.where?.tenantId_clientSku?.clientSku as string;
    return args.productRow(sku);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.tenant as any).findUnique = async () => ({ id: "tenant-1", settings: args.tenantSettings ?? null });
  // confirm_order pokes pendingDraftJson during cart bookkeeping; we don't care about the
  // payload here, we only need the calls not to throw.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).findUnique = async () => null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).update = async () => ({});
}

function restorePrismaStubs(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.productMapping as any).findUnique = originalProductFindUnique;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.tenant as any).findUnique = originalTenantFindUnique;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).findUnique = originalConvFindUnique;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).update = originalConvUpdate;
}

function jersey(line: Partial<AgentCartItem> & { sku: string; line_id: string }): AgentCartItem {
  return {
    product: "Argentina Home Jersey",
    quantity: 1,
    size: "L",
    unitPriceBdt: 1500,
    ...line,
  };
}

// ─────────────────────────── tests ───────────────────────────

test("validate_order on a clean cart returns ok=true and persists the result on the snapshot", async () => {
  installPrismaStubs({
    productRow: (sku) => {
      if (sku !== "ARG-HOME-24") return null;
      return {
        tenantId: "tenant-1",
        clientSku: "ARG-HOME-24",
        metadata: { isActive: true, price: 1500, stock: 10, sizeStocks: { L: 5, M: 3 } },
      };
    },
  });
  try {
    const input = makeInput();
    const snapshot: AgentSnapshot = {
      ...emptySnapshot(),
      cart: [jersey({ sku: "ARG-HOME-24", line_id: "line-A", size: "L", quantity: 2 })],
    };
    const { ctx, getWorking } = makeCtx(input, snapshot);

    const result = await validateTool!.handler({}, ctx);
    assert.equal(result.ok, true, "clean cart must validate");
    if (result.ok) {
      assert.match(result.observation, /Cart validation passed/);
      const data = result.data as { ok: boolean; failures: unknown[]; totals: { line_count: number } };
      assert.equal(data.ok, true);
      assert.deepEqual(data.failures, []);
      assert.equal(data.totals.line_count, 1);
    }

    // Persisted on the snapshot under confirmed_information.__validation.
    const persisted = readLatestValidation(getWorking());
    assert.ok(persisted, "validation result must round-trip through the snapshot");
    assert.equal(persisted!.ok, true);
  } finally {
    restorePrismaStubs();
  }
});

test("validate_order flags an inactive sku as `sku_inactive`", async () => {
  installPrismaStubs({
    productRow: () => ({
      tenantId: "tenant-1",
      clientSku: "INACTIVE-SKU",
      metadata: { isActive: false, price: 1500, stock: 5 },
    }),
  });
  try {
    const cart: AgentCartItem[] = [
      jersey({ sku: "INACTIVE-SKU", line_id: "line-X", quantity: 1 }),
    ];
    const result = await runValidation("tenant-1", cart);
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]!.code, "sku_inactive");
    assert.equal(result.failures[0]!.line_id, "line-X");
    assert.match(result.failures[0]!.detail, /inactive/);
  } finally {
    restorePrismaStubs();
  }
});

test("validate_order flags a missing sku as `sku_not_found`", async () => {
  installPrismaStubs({ productRow: () => null });
  try {
    const cart: AgentCartItem[] = [jersey({ sku: "GHOST-SKU", line_id: "line-G" })];
    const result = await runValidation("tenant-1", cart);
    assert.equal(result.ok, false);
    assert.equal(result.failures[0]!.code, "sku_not_found");
    assert.equal(result.failures[0]!.line_id, "line-G");
  } finally {
    restorePrismaStubs();
  }
});

test("validate_order flags `insufficient_stock` using per-size stock when available", async () => {
  installPrismaStubs({
    productRow: () => ({
      tenantId: "tenant-1",
      clientSku: "RM-HOME-24",
      // Aggregate stock=10 but L=1 → asking for qty=3 in L should fail using per-size data.
      metadata: { isActive: true, price: 1450, stock: 10, sizeStocks: { L: 1, M: 5 } },
    }),
  });
  try {
    const cart: AgentCartItem[] = [
      jersey({ sku: "RM-HOME-24", line_id: "line-S", size: "L", quantity: 3, unitPriceBdt: 1450 }),
    ];
    const result = await runValidation("tenant-1", cart);
    assert.equal(result.ok, false);
    assert.equal(result.failures[0]!.code, "insufficient_stock");
    assert.match(result.failures[0]!.detail, /stock=1/);
    assert.match(result.failures[0]!.detail, /need=3/);
  } finally {
    restorePrismaStubs();
  }
});

test("validate_order flags `price_drift` when cart unit price ≠ live catalog price", async () => {
  installPrismaStubs({
    productRow: () => ({
      tenantId: "tenant-1",
      clientSku: "BD-HOME-24",
      metadata: { isActive: true, price: 1700, stock: 10 },
    }),
  });
  try {
    const cart: AgentCartItem[] = [
      jersey({ sku: "BD-HOME-24", line_id: "line-P", unitPriceBdt: 1500, quantity: 1 }),
    ];
    const result = await runValidation("tenant-1", cart);
    assert.equal(result.ok, false);
    const codes = result.failures.map((f) => f.code);
    assert.ok(codes.includes("price_drift"), `expected price_drift in failures: ${codes.join(", ")}`);
    const drift = result.failures.find((f) => f.code === "price_drift")!;
    assert.match(drift.detail, /cart=1500/);
    assert.match(drift.detail, /live=1700/);
  } finally {
    restorePrismaStubs();
  }
});

test("validate_order flags `addon_not_allowed` when an attached add-on is no longer in the resolved list", async () => {
  installPrismaStubs({
    productRow: () => ({
      tenantId: "tenant-1",
      clientSku: "ARG-HOME-24",
      // Per-product opt-in: only "namenum" is allowed for this sku.
      metadata: {
        isActive: true,
        price: 1500,
        stock: 10,
        addOnIds: ["namenum"],
      },
    }),
    tenantSettings: {
      addOns: [
        { id: "namenum", label: "Name + Number", priceBdt: 200, enabled: true },
        { id: "patches", label: "Patches", priceBdt: 100, enabled: true },
      ],
    },
  });
  try {
    // The cart still carries "patches" from a prior turn before the tenant restricted it.
    const cart: AgentCartItem[] = [
      {
        sku: "ARG-HOME-24",
        product: "Argentina Home Jersey",
        line_id: "line-AO",
        quantity: 1,
        size: "L",
        unitPriceBdt: 1500,
        addOns: [{ id: "patches", label: "Patches", priceBdt: 100 }],
      },
    ];
    const result = await runValidation("tenant-1", cart);
    assert.equal(result.ok, false);
    const failure = result.failures.find((f) => f.code === "addon_not_allowed");
    assert.ok(failure, "expected addon_not_allowed in failures");
    assert.match(failure!.detail, /patches/);
  } finally {
    restorePrismaStubs();
  }
});

test("validate_order flags `addon_price_drift` when the live add-on price differs from the cart's", async () => {
  installPrismaStubs({
    productRow: () => ({
      tenantId: "tenant-1",
      clientSku: "ARG-HOME-24",
      metadata: { isActive: true, price: 1500, stock: 10, addOnIds: ["namenum"] },
    }),
    tenantSettings: {
      addOns: [
        // Tenant nudged the price from 200 → 250 after the cart was built.
        { id: "namenum", label: "Name + Number", priceBdt: 250, enabled: true },
      ],
    },
  });
  try {
    const cart: AgentCartItem[] = [
      {
        sku: "ARG-HOME-24",
        product: "Argentina Home Jersey",
        line_id: "line-D",
        quantity: 1,
        size: "L",
        unitPriceBdt: 1500,
        addOns: [{ id: "namenum", label: "Name + Number", priceBdt: 200, value: "Limon 10" }],
      },
    ];
    const result = await runValidation("tenant-1", cart);
    assert.equal(result.ok, false);
    const drift = result.failures.find((f) => f.code === "addon_price_drift");
    assert.ok(drift, "expected addon_price_drift in failures");
    assert.match(drift!.detail, /cart=200/);
    assert.match(drift!.detail, /live=250/);
  } finally {
    restorePrismaStubs();
  }
});

test(
  "end-to-end: inactive SKU → validate_order fails → confirm_order refuses with validation reason surfaced",
  async () => {
    installPrismaStubs({
      productRow: (sku) => {
        if (sku !== "INACTIVE-1") return null;
        return {
          tenantId: "tenant-1",
          clientSku: "INACTIVE-1",
          metadata: { isActive: false, price: 1500, stock: 5 },
        };
      },
    });
    try {
      const input = makeInput();
      const snapshot: AgentSnapshot = {
        ...emptySnapshot(),
        cart: [jersey({ sku: "INACTIVE-1", line_id: "line-INACT" })],
        // Profile is fully populated so the only blocker is the validation result.
        profile: { name: "Liton", phone: "01711111111", address: "Khulna" },
        order_state: "FINAL_CONFIRMATION",
      };
      const { ctx, getWorking } = makeCtx(input, snapshot);

      // Step 1: run validate_order — it MUST fail and stash the result on the snapshot.
      const validateResult = await validateTool!.handler({}, ctx);
      assert.equal(validateResult.ok, false, "inactive sku must fail validation");
      if (!validateResult.ok) {
        assert.equal(validateResult.error, "validation_failed");
        assert.match(validateResult.observation, /sku_inactive/);
      }
      const persisted = readLatestValidation(getWorking());
      assert.ok(persisted, "validation result must be persisted onto the snapshot");
      assert.equal(persisted!.ok, false);
      assert.equal(persisted!.failures[0]!.code, "sku_inactive");

      // Step 2: confirm_order MUST refuse on the next call, citing the validation reason.
      const confirmResult = await confirmTool!.handler({}, ctx);
      assert.equal(confirmResult.ok, false, "confirm_order must refuse when validation failed");
      if (!confirmResult.ok) {
        assert.equal(confirmResult.error, "validation_failed");
        assert.match(confirmResult.observation, /sku_inactive/);
        // The line_id (truncated to 8 chars) is surfaced so the customer-facing reply
        // can address the right line.
        assert.match(confirmResult.observation, /line=line-INA/);
      }
    } finally {
      restorePrismaStubs();
    }
  },
);

test(
  "confirm_order without a prior validate_order runs validation synchronously and refuses on inactive sku",
  async () => {
    // This pins the auto-validate-on-demand contract: even if the LLM never calls
    // validate_order, confirm_order's own gate runs the validation itself before
    // creating an order. Same setup as the e2e test, but skipping the explicit
    // validate_order call.
    installPrismaStubs({
      productRow: () => ({
        tenantId: "tenant-1",
        clientSku: "INACTIVE-2",
        metadata: { isActive: false, price: 1500, stock: 5 },
      }),
    });
    try {
      const input = makeInput();
      const snapshot: AgentSnapshot = {
        ...emptySnapshot(),
        cart: [jersey({ sku: "INACTIVE-2", line_id: "line-AUTO" })],
        profile: { name: "Liton", phone: "01711111111", address: "Khulna" },
        order_state: "FINAL_CONFIRMATION",
      };
      const { ctx, getWorking } = makeCtx(input, snapshot);

      const result = await confirmTool!.handler({}, ctx);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, "validation_failed");
        assert.match(result.observation, /sku_inactive/);
      }
      // Side-effect: confirm_order's auto-validate persisted the result.
      const persisted = readLatestValidation(getWorking());
      assert.ok(persisted, "auto-validate must persist its result onto the snapshot");
      assert.equal(persisted!.ok, false);
    } finally {
      restorePrismaStubs();
    }
  },
);

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
