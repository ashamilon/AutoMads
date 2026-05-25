/**
 * Unit tests for the structured-cart projection (task 2.3 — Reqs 2.1, 2.3, 2.5, 2.6).
 *
 * Same `tsx`-runnable harness used by the rest of `src/agent/__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/structuredCart.test.ts
 *
 * The contract under test:
 *
 *   1. `recomputeStructuredCart(snapshot)` stamps `line_total` on every cart line as
 *      `(unitPriceBdt + sum(addOns.priceBdt)) * quantity`, and returns a new snapshot
 *      whose `structured_cart.subtotal` equals `sum(items[].line_total)` (Req 2.3).
 *   2. The order-level slots — `delivery_info`, `payment_method`, `order_status` —
 *      are populated from the existing snapshot fields (`profile`, FSM,
 *      `confirmed_information.order`); when nothing is recorded they default to `null`
 *      so consumers can distinguish "missing" from "zero" (Req 2.1).
 *   3. `parseSnapshot` round-trips `line_total` and the structured projection through
 *      `pendingDraftJson` (Req 2.6).
 *   4. `show_cart` reads from the structured projection rather than recomputing — an
 *      empty cart returns "Cart: (empty)", and a populated cart's observation reflects
 *      the persisted `subtotal` (Req 2.5).
 *
 * No external test runner is wired into this repo; the file uses `node:assert/strict`
 * and exits non-zero on the first failure.
 */

import assert from "node:assert/strict";
import { computeLineTotal, parseSnapshot, recomputeStructuredCart } from "../state.js";
import { cartTools } from "../tools/cart.js";
import type {
  AgentCartItem,
  AgentSnapshot,
  AgentTurnInput,
  ToolHandlerCtx,
} from "../types.js";

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

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
    userText: "show me my cart",
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
    ...overrides,
  };
}

function makeCtx(input: AgentTurnInput, snapshot: AgentSnapshot): ToolHandlerCtx {
  let working = snapshot;
  return {
    input,
    get snapshot() {
      return working;
    },
    saveSnapshot: async (next) => {
      working = next;
    },
  };
}

// --- computeLineTotal ---

test("computeLineTotal multiplies (unitPrice + sum(addOns)) by quantity", () => {
  const line: AgentCartItem = {
    sku: "RM-HOME-24",
    product: "Real Madrid Home",
    quantity: 2,
    line_id: "L1",
    unitPriceBdt: 1450,
    addOns: [
      { id: "name-number", label: "Name + Number", priceBdt: 200 },
      { id: "patch", label: "Champions Patch", priceBdt: 0 }, // FREE
    ],
  };
  assert.equal(computeLineTotal(line), (1450 + 200 + 0) * 2);
});

test("computeLineTotal treats missing unitPrice / addOns as zero (no NaN)", () => {
  const halfBuilt: AgentCartItem = {
    sku: "X",
    product: "X",
    quantity: 1,
    line_id: "L2",
    // unitPriceBdt deliberately undefined
  };
  assert.equal(computeLineTotal(halfBuilt), 0);
});

// --- recomputeStructuredCart: subtotal + per-line totals ---

test("two-line cart yields the expected subtotal and per-line line_total", () => {
  const snap = emptySnapshot();
  snap.cart = [
    {
      sku: "RM-HOME-24",
      product: "Real Madrid Home Jersey",
      quantity: 2,
      line_id: "L-RM",
      size: "L",
      unitPriceBdt: 1450,
    },
    {
      sku: "ARG-AWAY-22",
      product: "Argentina Away Jersey",
      quantity: 1,
      line_id: "L-ARG",
      size: "M",
      unitPriceBdt: 1600,
      addOns: [{ id: "name-number", label: "Name + Number", priceBdt: 200 }],
    },
  ];

  const next = recomputeStructuredCart(snap);

  // Per-line totals are stamped onto BOTH the loose array and the structured items.
  assert.equal(next.cart[0]!.line_total, 1450 * 2);
  assert.equal(next.cart[1]!.line_total, (1600 + 200) * 1);
  assert.ok(next.structured_cart, "structured_cart must be populated");
  assert.equal(next.structured_cart!.items[0]!.line_total, 1450 * 2);
  assert.equal(next.structured_cart!.items[1]!.line_total, 1800);

  // Subtotal is the sum of line_totals.
  const expectedSubtotal = 1450 * 2 + 1800;
  assert.equal(next.structured_cart!.subtotal, expectedSubtotal);
});

test("empty cart yields subtotal=0 and items=[]", () => {
  const next = recomputeStructuredCart(emptySnapshot());
  assert.ok(next.structured_cart);
  assert.equal(next.structured_cart!.subtotal, 0);
  assert.deepEqual(next.structured_cart!.items, []);
});

// --- order-level slots: payment_method / delivery_info / order_status ---

test("payment_method on confirmed_information.order surfaces on the structured cart", () => {
  const snap: AgentSnapshot = {
    ...emptySnapshot(),
    cart: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home",
        quantity: 1,
        line_id: "L1",
        unitPriceBdt: 1450,
      },
    ],
    confirmed_information: { order: { payment_method: "cod" } },
    order_state: "PAYMENT_SELECTION",
  };
  const next = recomputeStructuredCart(snap);
  assert.equal(next.structured_cart!.payment_method, "cod");
  assert.equal(next.structured_cart!.order_status, "draft");
});

test("empty payment_method string is treated as null (not yet collected)", () => {
  const snap: AgentSnapshot = {
    ...emptySnapshot(),
    cart: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home",
        quantity: 1,
        line_id: "L1",
        unitPriceBdt: 1450,
      },
    ],
    confirmed_information: { order: { payment_method: "   " } },
    order_state: "PAYMENT_SELECTION",
  };
  const next = recomputeStructuredCart(snap);
  assert.equal(next.structured_cart!.payment_method, null);
});

test("delivery_info pulls address from profile when no order-level value is set", () => {
  const snap: AgentSnapshot = {
    ...emptySnapshot(),
    cart: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home",
        quantity: 1,
        line_id: "L1",
        unitPriceBdt: 1450,
      },
    ],
    profile: { name: "Mahir", phone: "017xxx", address: "Dhaka, BD" },
    order_state: "ADDRESS_COLLECTION",
  };
  const next = recomputeStructuredCart(snap);
  assert.ok(next.structured_cart!.delivery_info, "delivery_info must be populated");
  assert.equal(next.structured_cart!.delivery_info!.address, "Dhaka, BD");
  // No tenant default delivery charge is read here — recomputeStructuredCart only reads
  // values explicitly captured on the snapshot. `null` means "not yet computed".
  assert.equal(next.structured_cart!.delivery_info!.delivery_charge_bdt, null);
});

test("delivery_info is null when neither address nor charge are recorded", () => {
  const snap: AgentSnapshot = {
    ...emptySnapshot(),
    cart: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home",
        quantity: 1,
        line_id: "L1",
        unitPriceBdt: 1450,
      },
    ],
  };
  const next = recomputeStructuredCart(snap);
  assert.equal(next.structured_cart!.delivery_info, null);
});

test("order_status is null for fresh BROWSING snapshots", () => {
  const next = recomputeStructuredCart(emptySnapshot());
  assert.equal(next.structured_cart!.order_status, null);
});

test("order_status follows the FSM through review/confirmed/completed", () => {
  const cases: Array<[AgentSnapshot["order_state"], "draft" | "review" | "confirmed" | "completed" | null]> = [
    ["BROWSING", null],
    ["PRODUCT_SELECTION", "draft"],
    ["CART_BUILDING", "draft"],
    ["MISSING_INFO_COLLECTION", "draft"],
    ["ADDRESS_COLLECTION", "draft"],
    ["PAYMENT_SELECTION", "draft"],
    ["ORDER_REVIEW", "review"],
    ["FINAL_CONFIRMATION", "confirmed"],
    ["ORDER_COMPLETE", "completed"],
  ];
  for (const [state, expected] of cases) {
    const next = recomputeStructuredCart({ ...emptySnapshot(), order_state: state });
    assert.equal(
      next.structured_cart!.order_status,
      expected,
      `order_state=${state} should map to order_status=${expected}`,
    );
  }
});

// --- round-trip through pendingDraftJson ---

test("parseSnapshot round-trips line_total and structured_cart through pendingDraftJson", () => {
  const blob = {
    cartItems: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home Jersey",
        quantity: 2,
        size: "L",
        unitPriceBdt: 1450,
        line_id: "L-RM",
        line_total: 2900,
      },
      {
        sku: "ARG-AWAY-22",
        product: "Argentina Away Jersey",
        quantity: 1,
        size: "M",
        unitPriceBdt: 1600,
        line_id: "L-ARG",
        line_total: 1800,
        addOns: [{ id: "name-number", label: "Name + Number", priceBdt: 200 }],
      },
    ],
    customerProfile: {},
    agent: {
      order_state: "ORDER_REVIEW",
      structured_cart: {
        subtotal: 4700,
        delivery_info: { address: "Dhaka", delivery_charge_bdt: 60 },
        payment_method: "cod",
        order_status: "review",
      },
    },
  };

  const snap = parseSnapshot(blob);
  assert.equal(snap.cart[0]!.line_total, 2900);
  assert.equal(snap.cart[1]!.line_total, 1800);
  assert.ok(snap.structured_cart);
  assert.equal(snap.structured_cart!.subtotal, 4700);
  assert.equal(snap.structured_cart!.payment_method, "cod");
  assert.equal(snap.structured_cart!.order_status, "review");
  assert.equal(snap.structured_cart!.delivery_info!.address, "Dhaka");
  assert.equal(snap.structured_cart!.delivery_info!.delivery_charge_bdt, 60);
});

test("legacy blob without structured_cart still loads cleanly with cart populated", () => {
  // Ensures loadSnapshot's defensive readers are honoured (Req 1.4).
  const blob = {
    cartItems: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home Jersey",
        quantity: 1,
        size: "L",
        unitPriceBdt: 1450,
      },
    ],
    customerProfile: {},
  };
  const snap = parseSnapshot(blob);
  assert.equal(snap.cart.length, 1);
  // structured_cart is undefined when absent from the blob — readers fall back to
  // recomputing on the fly.
  assert.equal(snap.structured_cart, undefined);
});

// --- show_cart reads from the structured projection ---

test("show_cart returns 'Cart: (empty)' for an empty cart", async () => {
  const showCart = cartTools.find((t) => t.name === "show_cart");
  assert.ok(showCart, "show_cart must be registered");
  const ctx = makeCtx(makeInput(), emptySnapshot());
  const result = await showCart!.handler({}, ctx);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.observation, /Cart:\s*\(empty\)/);
  }
});

test("show_cart's data payload reflects the persisted subtotal", async () => {
  const showCart = cartTools.find((t) => t.name === "show_cart");
  assert.ok(showCart, "show_cart must be registered");

  const snap = recomputeStructuredCart({
    ...emptySnapshot(),
    cart: [
      {
        sku: "RM-HOME-24",
        product: "Real Madrid Home Jersey",
        quantity: 2,
        line_id: "L-RM",
        size: "L",
        unitPriceBdt: 1450,
      },
      {
        sku: "ARG-AWAY-22",
        product: "Argentina Away Jersey",
        quantity: 1,
        line_id: "L-ARG",
        size: "M",
        unitPriceBdt: 1600,
        addOns: [{ id: "name-number", label: "Name + Number", priceBdt: 200 }],
      },
    ],
  });

  // Stub Prisma + advance resolver indirectly by stubbing `prisma.tenant.findUnique`.
  // show_cart only needs the tenant settings to compute the advance preview; we make
  // the lookup return null so it falls back to defaults — the structured-cart subtotal
  // we care about does NOT depend on that path.
  const { prisma } = await import("../../db/prisma.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = (prisma as any).tenant.findUnique;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma as any).tenant.findUnique = async () => null;
  try {
    const ctx = makeCtx(makeInput(), snap);
    const result = await showCart!.handler({}, ctx);
    assert.equal(result.ok, true);
    if (result.ok && result.data && typeof result.data === "object") {
      const data = result.data as Record<string, unknown>;
      const expectedSubtotal = 1450 * 2 + (1600 + 200) * 1;
      assert.equal(
        data["subtotal"],
        expectedSubtotal,
        "show_cart must surface the persisted subtotal from structured_cart",
      );
      assert.equal(data["items"], 2);
    }
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).tenant.findUnique = original;
  }
});

// --- recomputeStructuredCart is pure (does not mutate the input) ---

test("recomputeStructuredCart does not mutate the input snapshot or its arrays", () => {
  const snap = emptySnapshot();
  snap.cart = [
    {
      sku: "RM-HOME-24",
      product: "Real Madrid Home",
      quantity: 1,
      line_id: "L1",
      unitPriceBdt: 1450,
    },
  ];
  const beforeCart = snap.cart;
  const beforeFirst = snap.cart[0];
  const next = recomputeStructuredCart(snap);
  // Original cart and item references must be untouched (no mutation).
  assert.equal(snap.cart, beforeCart);
  assert.equal(snap.cart[0], beforeFirst);
  assert.equal(snap.cart[0]!.line_total, undefined, "input line must not have line_total mutated in place");
  // The result has fresh objects with line_total stamped.
  assert.notEqual(next.cart, snap.cart);
  assert.equal(next.cart[0]!.line_total, 1450);
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
