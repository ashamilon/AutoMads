/**
 * Unit tests for `reconcileAbandonedCartFollowUp` (task 9.3 — Req 13.3).
 *
 * Same `tsx`-runnable harness used by the rest of `src/agent/__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/followUpFsm.test.ts
 *
 * Pins the FSM-driven schedule/cancel decision table:
 *
 *  • In-flight FSM (CART_BUILDING / MISSING_INFO_COLLECTION / ADDRESS_COLLECTION /
 *    PAYMENT_SELECTION) with a non-empty cart → schedule `abandoned_cart` 24h ahead
 *    (replacing any prior pending row of the same kind).
 *  • ORDER_COMPLETE → cancel any pending `abandoned_cart` row regardless of cart.
 *  • In-flight FSM but empty cart → cancel.
 *  • BROWSING / PRODUCT_SELECTION / ORDER_REVIEW / FINAL_CONFIRMATION → no-op (no
 *    schedule, no cancel).
 *
 * Prisma is stubbed at the module level with a tiny in-memory store so the test
 * stays hermetic and doesn't need a database. Stubs are restored after each suite
 * so sibling tests aren't polluted.
 */

import assert from "node:assert/strict";
import { prisma } from "../../db/prisma.js";
import {
  reconcileAbandonedCartFollowUp,
  cancelAbandonedCartFollowUps,
} from "../followUp.js";
import { ABANDONED_CART_TIMEOUT_MS, type OrderFSMState } from "../state.js";
import type { AgentSnapshot } from "../types.js";

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

// ---------- in-memory FollowUp store + Prisma stubs ----------

type FollowUpRow = {
  id: string;
  tenantId: string;
  psid: string;
  conversationId: string | null;
  kind: string;
  status: string;
  runAt: Date;
  attempts: number;
  payload: unknown;
};

const store: FollowUpRow[] = [];
let nextId = 1;

const originalCreate = prisma.followUp.create.bind(prisma.followUp);
const originalUpdateMany = prisma.followUp.updateMany.bind(prisma.followUp);
const originalFindMany = prisma.followUp.findMany.bind(prisma.followUp);

function installStubs(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.followUp as any).create = async (args: any): Promise<FollowUpRow> => {
    const row: FollowUpRow = {
      id: `f-${nextId++}`,
      tenantId: args?.data?.tenantId,
      psid: args?.data?.psid,
      conversationId: args?.data?.conversationId ?? null,
      kind: args?.data?.kind,
      status: args?.data?.status ?? "scheduled",
      runAt: args?.data?.runAt,
      attempts: 0,
      payload: args?.data?.payload ?? null,
    };
    store.push(row);
    return row;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.followUp as any).updateMany = async (args: any): Promise<{ count: number }> => {
    const where = args?.where ?? {};
    let count = 0;
    for (const row of store) {
      const matchTenant = where.tenantId == null || row.tenantId === where.tenantId;
      const matchPsid = where.psid == null || row.psid === where.psid;
      const matchKind = where.kind == null || row.kind === where.kind;
      const matchStatus = where.status == null || row.status === where.status;
      if (matchTenant && matchPsid && matchKind && matchStatus) {
        Object.assign(row, args?.data ?? {});
        count++;
      }
    }
    return { count };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.followUp as any).findMany = async (args: any): Promise<FollowUpRow[]> => {
    const where = args?.where ?? {};
    return store.filter((row) => {
      if (where.tenantId != null && row.tenantId !== where.tenantId) return false;
      if (where.psid != null && row.psid !== where.psid) return false;
      if (where.kind != null && row.kind !== where.kind) return false;
      if (where.status != null && row.status !== where.status) return false;
      return true;
    });
  };
}

function restoreStubs(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.followUp as any).create = originalCreate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.followUp as any).updateMany = originalUpdateMany;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.followUp as any).findMany = originalFindMany;
  store.length = 0;
  nextId = 1;
}

// ---------- snapshot fixtures ----------

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

const oneItem = {
  line_id: "L1",
  sku: "RM-HOME-24",
  product: "Real Madrid Home Jersey",
  quantity: 1,
  size: "L",
  unitPriceBdt: 1450,
};

const TENANT = "tenant-1";
const PSID = "psid-1";
const CONVO = "conv-1";

function pendingAbandonedRows(): FollowUpRow[] {
  return store.filter(
    (r) => r.tenantId === TENANT && r.psid === PSID && r.kind === "abandoned_cart" && r.status === "scheduled",
  );
}

// ---------- tests ----------

const IN_FLIGHT_STATES: OrderFSMState[] = [
  "CART_BUILDING",
  "MISSING_INFO_COLLECTION",
  "ADDRESS_COLLECTION",
  "PAYMENT_SELECTION",
];

for (const state of IN_FLIGHT_STATES) {
  test(`schedules abandoned_cart 24h ahead when FSM=${state} and cart non-empty`, async () => {
    installStubs();
    try {
      const before = Date.now();
      await reconcileAbandonedCartFollowUp({
        tenantId: TENANT,
        psid: PSID,
        conversationId: CONVO,
        snapshot: makeSnapshot({ cart: [oneItem], order_state: state }),
      });
      const after = Date.now();

      const pending = pendingAbandonedRows();
      assert.equal(pending.length, 1, `expected exactly one pending abandoned_cart row for ${state}`);
      const row = pending[0]!;
      assert.equal(row.kind, "abandoned_cart");
      assert.equal(row.status, "scheduled");
      assert.equal(row.conversationId, CONVO);

      // runAt should be approximately `now + ABANDONED_CART_TIMEOUT_MS` (24h).
      const runAtMs = row.runAt.getTime();
      assert.ok(
        runAtMs >= before + ABANDONED_CART_TIMEOUT_MS - 5_000 &&
          runAtMs <= after + ABANDONED_CART_TIMEOUT_MS + 5_000,
        `runAt outside expected window for ${state}: ${row.runAt.toISOString()}`,
      );

      // Payload should record FSM state + cartSize so the worker can render a useful nudge.
      const payload = row.payload as { fsm: string; cartSize: number };
      assert.equal(payload.fsm, state);
      assert.equal(payload.cartSize, 1);
    } finally {
      restoreStubs();
    }
  });
}

test("replaces a prior pending abandoned_cart row when called again on an in-flight FSM", async () => {
  installStubs();
  try {
    // First reconcile in CART_BUILDING.
    await reconcileAbandonedCartFollowUp({
      tenantId: TENANT,
      psid: PSID,
      conversationId: CONVO,
      snapshot: makeSnapshot({ cart: [oneItem], order_state: "CART_BUILDING" }),
    });
    assert.equal(pendingAbandonedRows().length, 1, "first reconcile must schedule one row");

    // Second reconcile on a later FSM state should cancel the first row (replace=true)
    // and create exactly one new pending row.
    await reconcileAbandonedCartFollowUp({
      tenantId: TENANT,
      psid: PSID,
      conversationId: CONVO,
      snapshot: makeSnapshot({
        cart: [oneItem],
        order_state: "ADDRESS_COLLECTION",
        profile: { name: "Mahir", phone: "017xxxxxxx" },
      }),
    });
    const pending = pendingAbandonedRows();
    assert.equal(pending.length, 1, "second reconcile must end up with exactly one pending row");
    const row = pending[0]!;
    const payload = row.payload as { fsm: string };
    assert.equal(payload.fsm, "ADDRESS_COLLECTION", "the surviving row must be the latest reconcile");

    // The original row should now be cancelled, not still scheduled.
    const allAbandonedForPsid = store.filter(
      (r) => r.tenantId === TENANT && r.psid === PSID && r.kind === "abandoned_cart",
    );
    const cancelled = allAbandonedForPsid.filter((r) => r.status === "cancelled");
    assert.equal(cancelled.length, 1, "the prior scheduled row must be flipped to cancelled");
  } finally {
    restoreStubs();
  }
});

test("cancels pending abandoned_cart row when FSM advances to ORDER_COMPLETE", async () => {
  installStubs();
  try {
    // Pre-seed a scheduled abandoned_cart row.
    await reconcileAbandonedCartFollowUp({
      tenantId: TENANT,
      psid: PSID,
      conversationId: CONVO,
      snapshot: makeSnapshot({ cart: [oneItem], order_state: "PAYMENT_SELECTION" }),
    });
    assert.equal(pendingAbandonedRows().length, 1);

    // Now finish the order — cart is cleared at ORDER_COMPLETE per Req 7.6, but the
    // reconciler must cancel the abandoned_cart row regardless of cart contents.
    await reconcileAbandonedCartFollowUp({
      tenantId: TENANT,
      psid: PSID,
      conversationId: CONVO,
      snapshot: makeSnapshot({ cart: [], order_state: "ORDER_COMPLETE" }),
    });

    assert.equal(pendingAbandonedRows().length, 0, "no abandoned_cart rows should remain pending");
    const cancelled = store.filter(
      (r) =>
        r.tenantId === TENANT &&
        r.psid === PSID &&
        r.kind === "abandoned_cart" &&
        r.status === "cancelled",
    );
    assert.equal(cancelled.length, 1, "exactly one row should have been cancelled");
  } finally {
    restoreStubs();
  }
});

test("cancels pending abandoned_cart row when in-flight FSM has empty cart", async () => {
  installStubs();
  try {
    await reconcileAbandonedCartFollowUp({
      tenantId: TENANT,
      psid: PSID,
      conversationId: CONVO,
      snapshot: makeSnapshot({ cart: [oneItem], order_state: "CART_BUILDING" }),
    });
    assert.equal(pendingAbandonedRows().length, 1);

    // Customer cleared the cart but FSM hasn't reset yet.
    await reconcileAbandonedCartFollowUp({
      tenantId: TENANT,
      psid: PSID,
      conversationId: CONVO,
      snapshot: makeSnapshot({ cart: [], order_state: "CART_BUILDING" }),
    });
    assert.equal(pendingAbandonedRows().length, 0);
  } finally {
    restoreStubs();
  }
});

test("no-op (no schedule, no cancel) when FSM is BROWSING / PRODUCT_SELECTION / ORDER_REVIEW / FINAL_CONFIRMATION", async () => {
  const noopStates: OrderFSMState[] = [
    "BROWSING",
    "PRODUCT_SELECTION",
    "ORDER_REVIEW",
    "FINAL_CONFIRMATION",
  ];
  for (const state of noopStates) {
    installStubs();
    try {
      // Pre-seed a pending row.
      await reconcileAbandonedCartFollowUp({
        tenantId: TENANT,
        psid: PSID,
        conversationId: CONVO,
        snapshot: makeSnapshot({ cart: [oneItem], order_state: "CART_BUILDING" }),
      });
      assert.equal(pendingAbandonedRows().length, 1, `pre-seed failed for ${state}`);

      const before = store.length;
      await reconcileAbandonedCartFollowUp({
        tenantId: TENANT,
        psid: PSID,
        conversationId: CONVO,
        snapshot: makeSnapshot({ cart: [oneItem], order_state: state }),
      });
      const after = store.length;

      // No new row was created and the prior row is still pending.
      assert.equal(after, before, `no new rows should be created at ${state}`);
      assert.equal(pendingAbandonedRows().length, 1, `prior pending row should survive at ${state}`);
    } finally {
      restoreStubs();
    }
  }
});

test("does not cancel non-abandoned-cart follow-ups (e.g. payment_reminder is preserved)", async () => {
  installStubs();
  try {
    // Seed a payment_reminder row directly via the stub so we can verify it survives.
    await prisma.followUp.create({
      data: {
        tenantId: TENANT,
        psid: PSID,
        conversationId: CONVO,
        kind: "payment_reminder",
        status: "scheduled",
        runAt: new Date(Date.now() + 60 * 60 * 1000),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: { orderId: "order-9" } as any,
      },
    });

    // ORDER_COMPLETE should cancel ONLY abandoned_cart, not payment_reminder.
    await reconcileAbandonedCartFollowUp({
      tenantId: TENANT,
      psid: PSID,
      conversationId: CONVO,
      snapshot: makeSnapshot({ cart: [], order_state: "ORDER_COMPLETE" }),
    });

    const paymentRows = store.filter((r) => r.kind === "payment_reminder");
    assert.equal(paymentRows.length, 1);
    assert.equal(paymentRows[0]!.status, "scheduled", "payment_reminder must remain scheduled");
  } finally {
    restoreStubs();
  }
});

test("cancelAbandonedCartFollowUps targets only the abandoned_cart kind", async () => {
  installStubs();
  try {
    // Seed two scheduled rows of different kinds.
    await prisma.followUp.create({
      data: {
        tenantId: TENANT,
        psid: PSID,
        kind: "abandoned_cart",
        status: "scheduled",
        runAt: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: null as any,
      },
    });
    await prisma.followUp.create({
      data: {
        tenantId: TENANT,
        psid: PSID,
        kind: "delivery_review",
        status: "scheduled",
        runAt: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: null as any,
      },
    });

    await cancelAbandonedCartFollowUps(TENANT, PSID);

    const stillPending = store.filter((r) => r.status === "scheduled");
    assert.equal(stillPending.length, 1);
    assert.equal(stillPending[0]!.kind, "delivery_review");
  } finally {
    restoreStubs();
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
