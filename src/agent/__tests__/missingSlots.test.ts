/**
 * Per-line missing-slot tracking tests (task 2.2 — Reqs 8.1, 8.2, 8.4, 8.6).
 *
 * Same `tsx`-runnable harness used by the rest of `src/agent/__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/missingSlots.test.ts
 *
 * The contract under test (verbatim from tasks.md §2.2):
 *
 *   "After `add_to_cart {sku, qty:1}` (no size), `missing_information` contains
 *    exactly one row with `slot=\"size\"` and the correct `line_id`; after a
 *    follow-up `modify_cart_item {line_id, size:\"L\"}` it disappears and
 *    `confirmed_information[line_id].size === \"L\"`."
 *
 * To exercise the cart tool handlers without a live database we stub
 * `prisma.productMapping.findUnique` to return a synthetic row whose metadata
 * carries a non-empty `sizeStocks` map — that is what `skuHasVariants`
 * (in `tools/missingSlots.ts`) keys off when deciding whether the `size` slot
 * is required.
 *
 * Auxiliary Prisma calls inside the cart tools (`bumpLeadScore`,
 * `messengerConversation.findUnique/update`) DO reach the database when one is
 * configured via DATABASE_URL — and `bumpLeadScore` calls
 * `ensureCustomerProfile.create` without a `.catch`. So we additionally stub the
 * `customerProfile` and `messengerConversation` accessors to inert no-ops while
 * the test runs, then restore them.
 */

import assert from "node:assert/strict";
import { prisma } from "../../db/prisma.js";
import { cartTools } from "../tools/cart.js";
import type {
  AgentSnapshot,
  AgentTurnInput,
  ToolHandlerCtx,
} from "../types.js";

type TestCase = { name: string; run: () => Promise<void> };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

const addToCart = cartTools.find((t) => t.name === "add_to_cart");
const modifyCartItem = cartTools.find((t) => t.name === "modify_cart_item");
const removeFromCart = cartTools.find((t) => t.name === "remove_from_cart");
assert.ok(addToCart, "add_to_cart must be registered in cartTools");
assert.ok(modifyCartItem, "modify_cart_item must be registered in cartTools");
assert.ok(removeFromCart, "remove_from_cart must be registered in cartTools");

function makeInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    tenantId: "tenant-1",
    tenantSlug: "demo",
    psid: "psid-1",
    conversationId: "conv-1",
    userText: "ektA jersey nibO",
    imageUrls: [],
    pageAccessToken: "PAGE-TOKEN",
    within24h: true,
    ...overrides,
  };
}

function emptySnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
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
 * Build a tool ctx whose `saveSnapshot` updates a working copy in place so a
 * downstream tool call (`modify_cart_item` after `add_to_cart`) sees the post-
 * mutation snapshot, just like the real loop does.
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

/**
 * Stub `prisma.productMapping.findUnique` to return a synthetic catalog row.
 * Returns the previous implementation so the test can restore it.
 *
 * The synthetic row's metadata carries a non-empty `sizeStocks` map, which is
 * what `skuHasVariants` (in tools/missingSlots.ts) looks for when deciding
 * whether the `size` slot should be tracked. That makes this exactly the
 * "SKU has variants" case the task spec calls out.
 */
function stubPrisma(): { restore: () => void } {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const p = prisma as any;
  // Snapshot the original methods we're about to override so we can restore them.
  const originals = {
    productMappingFindUnique: p.productMapping.findUnique,
    customerProfileFindUnique: p.customerProfile.findUnique,
    customerProfileCreate: p.customerProfile.create,
    customerProfileUpdate: p.customerProfile.update,
    messengerConvoFindUnique: p.messengerConversation.findUnique,
    messengerConvoUpdate: p.messengerConversation.update,
  };

  // productMapping.findUnique → return a synthetic catalog row whose metadata
  // carries a non-empty `sizeStocks` map (triggers `skuHasVariants`).
  p.productMapping.findUnique = async (args: any) => {
    const sku = args?.where?.tenantId_clientSku?.clientSku ?? "";
    return {
      tenantId: "tenant-1",
      clientSku: sku,
      facebookLabel: "Real Madrid Home Jersey",
      metadata: {
        name: "Real Madrid Home Jersey",
        price: 1450,
        sizeStocks: { S: 5, M: 3, L: 4, XL: 2 },
        isActive: true,
      },
    };
  };

  // customerProfile.* → inert stubs so `bumpLeadScore` is a no-op and never
  // throws on a missing DB record / FK constraint.
  p.customerProfile.findUnique = async () => ({
    id: "cp-stub",
    tenantId: "tenant-1",
    psid: "psid-1",
    leadScore: 10,
    tags: [],
    preferences: null,
    lastSeenAt: new Date(),
  });
  p.customerProfile.create = async () => ({
    id: "cp-stub",
    tenantId: "tenant-1",
    psid: "psid-1",
    leadScore: 10,
    tags: [],
    preferences: null,
    lastSeenAt: new Date(),
  });
  p.customerProfile.update = async () => ({
    id: "cp-stub",
    tenantId: "tenant-1",
    psid: "psid-1",
    leadScore: 15,
    tags: [],
    preferences: null,
    lastSeenAt: new Date(),
  });

  // messengerConversation.* → inert stubs so the `lastCatalogSku` bridge is a
  // no-op (it already swallows errors with try/catch but the noisy logging is
  // distracting and a missing record on update would still propagate).
  p.messengerConversation.findUnique = async () => ({ pendingDraftJson: null });
  p.messengerConversation.update = async () => ({});

  return {
    restore: () => {
      p.productMapping.findUnique = originals.productMappingFindUnique;
      p.customerProfile.findUnique = originals.customerProfileFindUnique;
      p.customerProfile.create = originals.customerProfileCreate;
      p.customerProfile.update = originals.customerProfileUpdate;
      p.messengerConversation.findUnique = originals.messengerConvoFindUnique;
      p.messengerConversation.update = originals.messengerConvoUpdate;
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

test(
  "add_to_cart {sku, qty:1} on a variant SKU with no size leaves exactly one missing-info row {line_id, slot:'size'}",
  async () => {
    const stub = stubPrisma();
    try {
      const input = makeInput();
      // Ground the sku via shownSkus so the anti-hallucination guard admits it.
      const snap = emptySnapshot({ shownSkus: ["RM-HOME-24"] });
      const { ctx, getSnapshot } = makeCtx(input, snap);

      const result = await addToCart!.handler(
        { sku: "RM-HOME-24", quantity: 1 },
        ctx,
      );
      assert.equal(result.ok, true, `add_to_cart should succeed: ${JSON.stringify(result)}`);

      const after = getSnapshot();
      assert.equal(after.cart.length, 1, "cart should have exactly one line");
      const line = after.cart[0]!;
      assert.equal(line.sku, "RM-HOME-24");
      assert.equal(line.size, undefined, "line must not carry a size yet");
      assert.ok(line.line_id, "line_id must be minted by add_to_cart");

      // The contract: exactly one missing-info row, keyed by this line_id, slot='size'.
      assert.equal(
        after.missing_information.length,
        1,
        `expected exactly one missing-info row, got ${JSON.stringify(after.missing_information)}`,
      );
      const row = after.missing_information[0]!;
      assert.equal(row.slot, "size");
      assert.equal(row.line_id, line.line_id);
      assert.equal(row.attempts, 0, "freshly-tracked slot starts at attempts=0");
    } finally {
      stub.restore();
    }
  },
);

test(
  "follow-up modify_cart_item {line_id, size:'L'} drops the missing-info row and sets confirmed_information[line_id].size='L'",
  async () => {
    const stub = stubPrisma();
    try {
      const input = makeInput();
      const snap = emptySnapshot({ shownSkus: ["RM-HOME-24"] });
      const { ctx, getSnapshot } = makeCtx(input, snap);

      // Step 1: add the line without a size.
      const add = await addToCart!.handler({ sku: "RM-HOME-24", quantity: 1 }, ctx);
      assert.equal(add.ok, true, "add_to_cart must succeed");
      const lineId = getSnapshot().cart[0]!.line_id;

      // Sanity: the size slot is missing right after add.
      assert.equal(getSnapshot().missing_information.length, 1);
      assert.equal(getSnapshot().missing_information[0]!.slot, "size");

      // Step 2: modify the line to set size = "L".
      const modify = await modifyCartItem!.handler({ line_id: lineId, size: "L" }, ctx);
      assert.equal(modify.ok, true, `modify_cart_item must succeed: ${JSON.stringify(modify)}`);

      const after = getSnapshot();

      // The size missing-info row for this line is gone.
      const lingering = after.missing_information.filter(
        (r) => r.line_id === lineId && r.slot === "size",
      );
      assert.equal(
        lingering.length,
        0,
        `size slot for line ${lineId} must move out of missing_information once filled`,
      );

      // And the captured value lands in confirmed_information keyed by line_id.
      const lineConfirmed = after.confirmed_information[lineId];
      assert.ok(
        lineConfirmed && typeof lineConfirmed === "object",
        `confirmed_information[${lineId}] must be populated`,
      );
      assert.equal(lineConfirmed!["size"], "L");

      // The cart line itself reflects the new size.
      assert.equal(after.cart[0]!.size, "L");
    } finally {
      stub.restore();
    }
  },
);

test(
  "size supplied directly to add_to_cart records confirmed_information[line_id].size at first sight (no missing row)",
  async () => {
    const stub = stubPrisma();
    try {
      const input = makeInput();
      const snap = emptySnapshot({ shownSkus: ["RM-HOME-24"] });
      const { ctx, getSnapshot } = makeCtx(input, snap);

      const add = await addToCart!.handler(
        { sku: "RM-HOME-24", quantity: 1, size: "M" },
        ctx,
      );
      assert.equal(add.ok, true, "add_to_cart with size must succeed");

      const after = getSnapshot();
      const lineId = after.cart[0]!.line_id;

      // No missing row for this line — size was filled at first sight.
      const sizeRows = after.missing_information.filter(
        (r) => r.line_id === lineId && r.slot === "size",
      );
      assert.equal(sizeRows.length, 0, "no size slot should be missing when supplied at add time");

      // confirmed_information records the captured value.
      assert.equal(after.confirmed_information[lineId]?.["size"], "M");
    } finally {
      stub.restore();
    }
  },
);

test(
  "remove_from_cart drops the line's missing-info rows and confirmed_information entry",
  async () => {
    const stub = stubPrisma();
    try {
      const input = makeInput();
      const snap = emptySnapshot({ shownSkus: ["RM-HOME-24"] });
      const { ctx, getSnapshot } = makeCtx(input, snap);

      // Add a line with no size — yields a missing row.
      const add = await addToCart!.handler({ sku: "RM-HOME-24", quantity: 1 }, ctx);
      assert.equal(add.ok, true);
      const lineId = getSnapshot().cart[0]!.line_id;
      assert.equal(getSnapshot().missing_information.length, 1);

      // Remove the line by line_id.
      const removed = await removeFromCart!.handler({ line_id: lineId }, ctx);
      assert.equal(removed.ok, true, "remove_from_cart must succeed");

      const after = getSnapshot();
      assert.equal(after.cart.length, 0, "cart should be empty after removal");
      const lingering = after.missing_information.filter((r) => r.line_id === lineId);
      assert.equal(lingering.length, 0, "removed line must not leave missing-info rows behind");
      assert.equal(
        lineId in after.confirmed_information,
        false,
        "removed line must not leave confirmed_information entry behind",
      );
    } finally {
      stub.restore();
    }
  },
);

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
