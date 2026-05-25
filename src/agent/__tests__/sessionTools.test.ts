/**
 * Unit tests for `save_session_state` and `retrieve_session_state` (task 7.3).
 *
 * Same `tsx`-runnable pattern as the other agent tests (no external runner). Run via:
 *
 *     npx tsx src/agent/__tests__/sessionTools.test.ts
 *
 * The two tools form the explicit memory-persistence path required by Req 13.6 — they
 * MUST round-trip the AgentSnapshot through `MessengerConversation.pendingDraftJson` so
 * the LLM can `save_session_state` then `retrieve_session_state` and see what was
 * persisted.
 *
 * We stub `prisma.messengerConversation.findUnique` and `.update` with a tiny in-memory
 * map so the test stays hermetic and doesn't need a live database. Stubs are restored
 * after the suite so the global Prisma client isn't polluted for sibling tests.
 */

import assert from "node:assert/strict";
import { prisma } from "../../db/prisma.js";
import { sessionTools } from "../tools/session.js";
import type { AgentSnapshot, AgentTurnInput, ToolHandlerCtx } from "../types.js";

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
    userText: "save my cart",
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
    ...overrides,
  };
}

/**
 * Build a tool ctx whose `saveSnapshot` mirrors the loop's behaviour: it persists via the
 * real `state.saveSnapshot` (so we exercise the full persistence path through Prisma) AND
 * updates the working in-memory copy that the next read can see.
 */
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
      const { saveSnapshot } = await import("../state.js");
      await saveSnapshot(input.conversationId, next);
    },
  };
  return { ctx, getWorking: () => working };
}

const saveTool = sessionTools.find((t) => t.name === "save_session_state");
const retrieveTool = sessionTools.find((t) => t.name === "retrieve_session_state");
assert.ok(saveTool, "save_session_state must be registered in sessionTools");
assert.ok(retrieveTool, "retrieve_session_state must be registered in sessionTools");

// In-memory persistence backing the prisma stubs. Keyed by conversationId.
const fakeStore = new Map<string, unknown>();

const originalFindUnique = prisma.messengerConversation.findUnique.bind(
  prisma.messengerConversation,
);
const originalUpdate = prisma.messengerConversation.update.bind(prisma.messengerConversation);

function installPrismaStubs(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).findUnique = async (args: any) => {
    const id = args?.where?.id as string | undefined;
    if (!id) return null;
    if (!fakeStore.has(id)) return null;
    return { id, pendingDraftJson: fakeStore.get(id) };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).update = async (args: any) => {
    const id = args?.where?.id as string;
    const data = args?.data?.pendingDraftJson;
    fakeStore.set(id, data);
    return { id, pendingDraftJson: data };
  };
}
function restorePrismaStubs(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).findUnique = originalFindUnique;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).update = originalUpdate;
  fakeStore.clear();
}

test("save_session_state refuses when conversationId is empty", async () => {
  installPrismaStubs();
  try {
    const input = makeInput({ conversationId: "" });
    const { ctx } = makeCtx(input, emptySnapshot());
    const result = await saveTool!.handler({}, ctx);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "missing_conversation_id");
      assert.match(result.observation, /no conversationId/);
    }
  } finally {
    restorePrismaStubs();
  }
});

test("retrieve_session_state refuses when conversationId is empty", async () => {
  installPrismaStubs();
  try {
    const input = makeInput({ conversationId: "" });
    const { ctx } = makeCtx(input, emptySnapshot());
    const result = await retrieveTool!.handler({}, ctx);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "missing_conversation_id");
      assert.match(result.observation, /no conversationId/);
    }
  } finally {
    restorePrismaStubs();
  }
});

test("save_session_state with empty patch flushes snapshot verbatim and reports 'session saved'", async () => {
  installPrismaStubs();
  try {
    const input = makeInput();
    const snap: AgentSnapshot = {
      ...emptySnapshot(),
      cart: [
        {
          sku: "RM-HOME-24",
          product: "Real Madrid Home Jersey",
          quantity: 2,
          line_id: "line-1",
          size: "L",
          unitPriceBdt: 1450,
        },
      ],
      profile: { name: "Mahir", phone: "01711111111", address: "Dhaka" },
      order_state: "ORDER_REVIEW",
    };
    const before = Date.now();
    const { ctx } = makeCtx(input, snap);
    const result = await saveTool!.handler({}, ctx);
    const after = Date.now();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.observation, "session saved");
      assert.equal(result.terminal ?? false, false);
      const data = result.data as { conversationId: string; savedAt: string; patched_keys: string[] };
      assert.equal(data.conversationId, "conv-1");
      assert.deepEqual(data.patched_keys, []);
      const ts = Date.parse(data.savedAt);
      assert.ok(Number.isFinite(ts));
      // savedAt should fall in the [before, after] window (allow 5s slack for clock skew).
      assert.ok(ts >= before - 5_000 && ts <= after + 5_000, `savedAt outside window: ${data.savedAt}`);
    }
    // Persistence side-effect: the fake store now holds the snapshot.
    assert.ok(fakeStore.has("conv-1"));
  } finally {
    restorePrismaStubs();
  }
});

test("save_session_state merges a partial patch into ctx.snapshot, preserving untouched fields", async () => {
  installPrismaStubs();
  try {
    const input = makeInput({ conversationId: "conv-patch" });
    const baseSnap: AgentSnapshot = {
      ...emptySnapshot(),
      cart: [
        {
          sku: "ARG-HOME-24",
          product: "Argentina Home Jersey",
          quantity: 1,
          line_id: "line-A",
          size: "M",
          unitPriceBdt: 1599,
        },
      ],
      profile: { name: "Liton", phone: "01788888888", address: "Khulna" },
      order_state: "CART_BUILDING",
      conversation_summary: "Existing summary.",
      confidence_level: 0.91,
    };
    const { ctx, getWorking } = makeCtx(input, baseSnap);

    // Patch only `active_goal` and `order_state` — everything else must survive untouched.
    const result = await saveTool!.handler(
      {
        active_goal: "buy_jersey",
        order_state: "ORDER_REVIEW",
      },
      ctx,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.observation, /^session saved \(patched: active_goal, order_state\)$/);
      const data = result.data as { patched_keys: string[] };
      assert.deepEqual(data.patched_keys.sort(), ["active_goal", "order_state"]);
    }

    const merged = getWorking();
    assert.equal(merged.active_goal, "buy_jersey");
    assert.equal(merged.order_state, "ORDER_REVIEW");
    // Untouched fields preserved verbatim.
    assert.equal(merged.cart.length, 1);
    assert.equal(merged.cart[0]!.sku, "ARG-HOME-24");
    assert.equal(merged.profile.name, "Liton");
    assert.equal(merged.profile.phone, "01788888888");
    assert.equal(merged.profile.address, "Khulna");
    assert.equal(merged.conversation_summary, "Existing summary.");
    assert.equal(merged.confidence_level, 0.91);
  } finally {
    restorePrismaStubs();
  }
});

test("save_session_state rejects unknown patch keys via strict zod schema", async () => {
  installPrismaStubs();
  try {
    const input = makeInput({ conversationId: "conv-strict" });
    const { ctx } = makeCtx(input, emptySnapshot());
    let threw = false;
    try {
      await saveTool!.handler({ totally_unknown_key: 42 }, ctx);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
    }
    assert.equal(threw, true, "save_session_state should reject unknown keys");
  } finally {
    restorePrismaStubs();
  }
});

test("save followed by load round-trips cart / profile / order_state through pendingDraftJson", async () => {
  installPrismaStubs();
  try {
    const input = makeInput({ conversationId: "conv-roundtrip" });
    const snap: AgentSnapshot = {
      ...emptySnapshot(),
      cart: [
        {
          sku: "ARG-HOME-24",
          product: "Argentina Home Jersey",
          quantity: 1,
          line_id: "line-A",
          size: "M",
          unitPriceBdt: 1599,
        },
        {
          sku: "BD-AWAY-22",
          product: "Bangladesh Away Jersey",
          quantity: 3,
          line_id: "line-B",
          size: "XL",
          unitPriceBdt: 1200,
        },
      ],
      profile: { name: "Liton", phone: "01788888888", address: "Khulna, BD" },
      order_state: "ORDER_REVIEW",
      missing_information: [{ slot: "delivery_window", attempts: 0 }],
      confirmed_information: { order: { payment_method: "cod" } },
      shownSkus: ["ARG-HOME-24", "BD-AWAY-22"],
      conversation_summary: "Customer ordering 2 jerseys.",
      confidence_level: 0.92,
    };

    const { ctx } = makeCtx(input, snap);
    const saveResult = await saveTool!.handler({}, ctx);
    assert.equal(saveResult.ok, true);

    // Now retrieve via the tool — its `data` payload MUST be a Snapshot whose
    // cart, profile, and order_state match what we just saved.
    const retrieveResult = await retrieveTool!.handler({}, ctx);
    assert.equal(retrieveResult.ok, true);
    if (retrieveResult.ok) {
      assert.equal(retrieveResult.terminal ?? false, false);
      const persisted = retrieveResult.data as AgentSnapshot;

      // Cart equality (order, sku, quantity, size, price, line_id all preserved).
      assert.equal(persisted.cart.length, 2);
      assert.equal(persisted.cart[0]!.sku, "ARG-HOME-24");
      assert.equal(persisted.cart[0]!.quantity, 1);
      assert.equal(persisted.cart[0]!.size, "M");
      assert.equal(persisted.cart[0]!.line_id, "line-A");
      assert.equal(persisted.cart[0]!.unitPriceBdt, 1599);
      assert.equal(persisted.cart[1]!.sku, "BD-AWAY-22");
      assert.equal(persisted.cart[1]!.quantity, 3);
      assert.equal(persisted.cart[1]!.size, "XL");
      assert.equal(persisted.cart[1]!.line_id, "line-B");

      // Profile equality.
      assert.equal(persisted.profile.name, "Liton");
      assert.equal(persisted.profile.phone, "01788888888");
      assert.equal(persisted.profile.address, "Khulna, BD");

      // FSM state preserved.
      assert.equal(persisted.order_state, "ORDER_REVIEW");

      // The compact observation should summarise the persisted state.
      const summary = JSON.parse(retrieveResult.observation) as {
        order_state: string;
        cart_lines: number;
        missing_information: number;
        profile: string;
        returned_keys: string[];
      };
      assert.equal(summary.order_state, "ORDER_REVIEW");
      assert.equal(summary.cart_lines, 2);
      assert.equal(summary.missing_information, 1);
      assert.match(summary.profile, /^3\/3$/);
      assert.ok(summary.returned_keys.includes("cart"));
      assert.ok(summary.returned_keys.includes("profile"));
      assert.ok(summary.returned_keys.includes("order_state"));
    }
  } finally {
    restorePrismaStubs();
  }
});

test("retrieve_session_state with `keys` filter returns only the requested fields", async () => {
  installPrismaStubs();
  try {
    const input = makeInput({ conversationId: "conv-keys" });
    const snap: AgentSnapshot = {
      ...emptySnapshot(),
      cart: [
        {
          sku: "RM-HOME-24",
          product: "Real Madrid Home Jersey",
          quantity: 1,
          line_id: "line-X",
          size: "S",
          unitPriceBdt: 1450,
        },
      ],
      profile: { name: "Karim", phone: "01700000000", address: "Sylhet" },
      missing_information: [{ slot: "size", attempts: 1, line_id: "line-X" }],
      order_state: "MISSING_INFO_COLLECTION",
    };
    const { ctx } = makeCtx(input, snap);
    await saveTool!.handler({}, ctx);

    const result = await retrieveTool!.handler(
      { keys: ["cart", "missing_information", "totally_unknown_field"] },
      ctx,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      const payload = result.data as Partial<AgentSnapshot>;
      const payloadKeys = Object.keys(payload).sort();
      // "totally_unknown_field" is silently dropped; only known top-level fields project.
      assert.deepEqual(payloadKeys, ["cart", "missing_information"]);
      assert.equal(payload.cart!.length, 1);
      assert.equal(payload.cart![0]!.sku, "RM-HOME-24");
      assert.equal(payload.missing_information!.length, 1);
      assert.equal(payload.missing_information![0]!.slot, "size");
      // Fields not requested must NOT appear on the payload.
      assert.equal((payload as Record<string, unknown>)["profile"], undefined);
      assert.equal((payload as Record<string, unknown>)["order_state"], undefined);

      const summary = JSON.parse(result.observation) as { returned_keys: string[] };
      assert.deepEqual(summary.returned_keys.sort(), ["cart", "missing_information"]);
    }
  } finally {
    restorePrismaStubs();
  }
});

test("retrieve_session_state on an unknown conversation returns the empty-snapshot defaults", async () => {
  installPrismaStubs();
  try {
    const input = makeInput({ conversationId: "conv-never-saved" });
    const { ctx } = makeCtx(input, emptySnapshot());
    const result = await retrieveTool!.handler({}, ctx);
    assert.equal(result.ok, true);
    if (result.ok) {
      const persisted = result.data as AgentSnapshot;
      assert.equal(persisted.cart.length, 0);
      assert.deepEqual(persisted.profile, {});
      assert.equal(persisted.order_state, "BROWSING");
      const summary = JSON.parse(result.observation) as {
        order_state: string;
        cart_lines: number;
        missing_information: number;
        profile: string;
      };
      assert.equal(summary.cart_lines, 0);
      assert.equal(summary.order_state, "BROWSING");
      assert.match(summary.profile, /missing=name,phone,address/);
    }
  } finally {
    restorePrismaStubs();
  }
});

test("retrieve_session_state does NOT mutate the in-flight ctx.snapshot", async () => {
  installPrismaStubs();
  try {
    const input = makeInput({ conversationId: "conv-no-mutate" });
    // Pre-seed the store with one snapshot, then call the tool with a DIFFERENT in-memory ctx.snapshot
    // to confirm the tool returns the persisted view as `data` without overwriting the working copy.
    fakeStore.set("conv-no-mutate", {
      cartItems: [],
      customerProfile: {},
      agent: { order_state: "CART_BUILDING" },
    });
    const inMemory: AgentSnapshot = {
      ...emptySnapshot(),
      order_state: "BROWSING",
      cart: [],
    };
    const { ctx, getWorking } = makeCtx(input, inMemory);
    const result = await retrieveTool!.handler({}, ctx);
    assert.equal(result.ok, true);
    if (result.ok) {
      const persisted = result.data as AgentSnapshot;
      assert.equal(persisted.order_state, "CART_BUILDING");
    }
    // Working copy still says BROWSING — the tool didn't bypass it.
    assert.equal(getWorking().order_state, "BROWSING");
  } finally {
    restorePrismaStubs();
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
