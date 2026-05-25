/**
 * Unit tests for the `/admin/snapshot/:conversationId` developer endpoint (task 11.1).
 *
 * `supertest` is not in the dev dependencies, so instead of mounting Express we drive
 * `handleSnapshotRequest` directly with mocked `req`/`res` shims. This is the lighter
 * path the task description allows ("If supertest is not in package.json, skip the
 * integration test and just write a unit test of the handler function").
 *
 * Coverage:
 *   - happy path: snapshot is loaded, recent_traces.length === 10 (clipped from 12),
 *     last_verified_tools.length <= 5 with synthetic rows filtered out.
 *   - tenant scoping: a conversationId owned by a different tenant returns 404.
 *   - validation: an empty conversationId returns 400.
 *   - the `last_verified_tools` projection respects the documented filtering rules
 *     (only `ok === true`, no `(step)` / `(override)` / `(none)` rows).
 *
 * Stubs `prisma.messengerConversation.findFirst` and `prisma.agentTrace.findMany`
 * with in-memory recorders so the test never touches Postgres. The original methods
 * are restored after the suite via a `finally` block at the bottom of each test.
 *
 * Runnable via `npx tsx`:
 *
 *     npx tsx src/agent/__tests__/agentDebugEndpoint.test.ts
 */

import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { prisma } from "../../db/prisma.js";
import {
  handleSnapshotRequest,
  type RecentTraceRow,
  type SnapshotResponseBody,
  type VerifiedToolEntry,
} from "../../routes/agentDebugRoutes.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type TestCase = { name: string; run: () => Promise<void> | void };
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

// ---------------------------------------------------------------------------
// Prisma stubs
// ---------------------------------------------------------------------------

type ConversationRow = { id: string; tenantId: string; pendingDraftJson: unknown };
type TraceRow = {
  id: string;
  iter: number;
  tool: string;
  thought: string | null;
  args: unknown;
  ok: boolean;
  observation: string;
  errorCode: string | null;
  llmLatencyMs: number | null;
  toolLatencyMs: number | null;
  finalReason: string | null;
  turnId: string;
  createdAt: Date;
  tenantId: string;
  conversationId: string;
};

const fakeConversations = new Map<string, ConversationRow>();
let fakeTraces: TraceRow[] = [];

const realFindFirst = prisma.messengerConversation.findFirst.bind(
  prisma.messengerConversation,
);
const realFindUniqueConvo = prisma.messengerConversation.findUnique.bind(
  prisma.messengerConversation,
);
const realTraceFindMany = prisma.agentTrace.findMany.bind(prisma.agentTrace);

function installStubs(): void {
  // findFirst — used by the route to verify conversation ownership.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).findFirst = async (args: any) => {
    const id = args?.where?.id as string | undefined;
    const tenantId = args?.where?.tenantId as string | undefined;
    if (!id || !tenantId) return null;
    const row = fakeConversations.get(id);
    if (!row) return null;
    if (row.tenantId !== tenantId) return null;
    return { id: row.id };
  };
  // findUnique — used by `loadSnapshot` to read pendingDraftJson.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).findUnique = async (args: any) => {
    const id = args?.where?.id as string | undefined;
    if (!id) return null;
    const row = fakeConversations.get(id);
    if (!row) return null;
    return { pendingDraftJson: row.pendingDraftJson };
  };
  // agentTrace.findMany — return our seeded trace rows newest-first, capped at `take`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.agentTrace as any).findMany = async (args: any) => {
    const tenantId = args?.where?.tenantId as string | undefined;
    const conversationId = args?.where?.conversationId as string | undefined;
    const take = typeof args?.take === "number" ? args.take : fakeTraces.length;
    let rows = fakeTraces.filter(
      (r) =>
        (!tenantId || r.tenantId === tenantId) &&
        (!conversationId || r.conversationId === conversationId),
    );
    // Newest first.
    rows = rows.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows.slice(0, take);
  };
}

function restoreStubs(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).findFirst = realFindFirst;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.messengerConversation as any).findUnique = realFindUniqueConvo;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.agentTrace as any).findMany = realTraceFindMany;
  fakeConversations.clear();
  fakeTraces = [];
}

// ---------------------------------------------------------------------------
// Express req/res shims
// ---------------------------------------------------------------------------

type RecordedResponse = {
  statusCode: number;
  body: unknown;
};

function makeReq(args: {
  conversationId: string;
  tenantId?: string;
}): Request {
  const tenant = args.tenantId
    ? ({ id: args.tenantId } as Request["tenant"])
    : undefined;
  return {
    params: { conversationId: args.conversationId },
    tenant,
  } as unknown as Request;
}

function makeRes(): { res: Response; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      recorded.statusCode = code;
      return this;
    },
    json(body: unknown) {
      recorded.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, recorded };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-debug-1";
const OTHER_TENANT_ID = "tenant-debug-other";
const CONVERSATION_ID = "test-conv";

function seedConversation(): void {
  fakeConversations.set(CONVERSATION_ID, {
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    pendingDraftJson: {
      cartItems: [
        {
          sku: "RM-HOME-24",
          product: "Real Madrid Home Jersey",
          quantity: 2,
          line_id: "line-1",
          size: "L",
          unitPriceBdt: 1450,
          line_total: 2900,
        },
      ],
      customerProfile: { name: "Mahir", phone: "01700000000", address: "Dhaka" },
      agent: {
        order_state: "ORDER_REVIEW",
        confidence_level: 0.91,
        shownSkus: ["RM-HOME-24"],
        lastShown: [{ sku: "RM-HOME-24", label: "Real Madrid Home" }],
      },
    },
  });
}

function seedTraces(count: number): void {
  // Build `count` rows covering a mix of:
  //   - real tool calls (ok=true)        → eligible for last_verified_tools
  //   - failed tool calls (ok=false)     → excluded from last_verified_tools
  //   - synthetic step rows (tool="(step)")
  //   - override rows  (tool="(override)")
  // The mix is deterministic so the assertions below are stable.
  const base = Date.now();
  const rows: TraceRow[] = [];
  const TOOL_CYCLE = [
    { tool: "search_catalog", ok: true },
    { tool: "(step)", ok: true },
    { tool: "add_to_cart", ok: true },
    { tool: "(override)", ok: false },
    { tool: "check_inventory", ok: true },
    { tool: "search_catalog", ok: false }, // failure — must not appear in last_verified_tools
  ];
  for (let i = 0; i < count; i += 1) {
    const slot = TOOL_CYCLE[i % TOOL_CYCLE.length]!;
    rows.push({
      id: `trace-${i}`,
      iter: i,
      tool: slot.tool,
      thought: `thought ${i}`,
      args: { i, tool: slot.tool },
      ok: slot.ok,
      observation: `obs ${i}`,
      errorCode: slot.ok ? null : "stub_error",
      llmLatencyMs: 10,
      toolLatencyMs: 20,
      finalReason: null,
      turnId: `turn-${Math.floor(i / 3)}`,
      createdAt: new Date(base + i * 1000),
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
    });
  }
  fakeTraces = rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("happy path: returns snapshot, 10 recent_traces, and ≤5 last_verified_tools", async () => {
  installStubs();
  try {
    seedConversation();
    seedTraces(12);

    const req = makeReq({ conversationId: CONVERSATION_ID, tenantId: TENANT_ID });
    const { res, recorded } = makeRes();
    await handleSnapshotRequest(req, res);

    assert.equal(recorded.statusCode, 200, `unexpected status: ${recorded.statusCode}`);
    const body = recorded.body as SnapshotResponseBody;
    assert.equal(body.conversationId, CONVERSATION_ID);

    // Snapshot was loaded via loadSnapshot.
    assert.ok(body.snapshot, "snapshot must be present");
    assert.equal(body.snapshot.cart.length, 1);
    assert.equal(body.snapshot.cart[0]!.sku, "RM-HOME-24");
    assert.equal(body.snapshot.order_state, "ORDER_REVIEW");

    // recent_traces clipped to exactly 10 even though we seeded 12.
    assert.equal(
      body.recent_traces.length,
      10,
      `recent_traces.length was ${body.recent_traces.length}, expected 10`,
    );
    // Newest first.
    assert.equal(body.recent_traces[0]!.id, "trace-11");
    assert.equal(body.recent_traces[9]!.id, "trace-2");

    // last_verified_tools must be ≤5, must exclude (step)/(override) and ok=false rows.
    assert.ok(
      body.last_verified_tools.length <= 5,
      `last_verified_tools.length must be <=5, was ${body.last_verified_tools.length}`,
    );
    for (const t of body.last_verified_tools) {
      assert.notEqual(t.name, "(step)", "synthetic (step) row leaked into last_verified_tools");
      assert.notEqual(
        t.name,
        "(override)",
        "synthetic (override) row leaked into last_verified_tools",
      );
      assert.notEqual(t.name, "(none)");
    }
  } finally {
    restoreStubs();
  }
});

test("last_verified_tools excludes failed real-tool rows", async () => {
  installStubs();
  try {
    seedConversation();
    seedTraces(12);

    const req = makeReq({ conversationId: CONVERSATION_ID, tenantId: TENANT_ID });
    const { res, recorded } = makeRes();
    await handleSnapshotRequest(req, res);

    const body = recorded.body as SnapshotResponseBody;

    // The TOOL_CYCLE includes one entry { tool: "search_catalog", ok: false } at index 5
    // and (because we seeded 12 rows) again at index 11. Those rows MUST NOT appear in
    // last_verified_tools — only the successful real-tool rows do.
    const failedTraceObservations = body.recent_traces
      .filter((r): r is RecentTraceRow => !r.ok && r.tool === "search_catalog")
      .map((r) => r.observation);
    assert.ok(
      failedTraceObservations.length > 0,
      "test setup: at least one failed search_catalog row must be in recent_traces",
    );
    for (const failedObs of failedTraceObservations) {
      const leaked = body.last_verified_tools.find(
        (t: VerifiedToolEntry) => t.observation === failedObs,
      );
      assert.equal(leaked, undefined, `failed observation leaked into verified tools: ${failedObs}`);
    }
  } finally {
    restoreStubs();
  }
});

test("returns 404 when conversation belongs to a different tenant", async () => {
  installStubs();
  try {
    seedConversation();
    seedTraces(3);

    const req = makeReq({ conversationId: CONVERSATION_ID, tenantId: OTHER_TENANT_ID });
    const { res, recorded } = makeRes();
    await handleSnapshotRequest(req, res);

    assert.equal(recorded.statusCode, 404);
    const body = recorded.body as { error: string };
    assert.equal(body.error, "conversation_not_found");
  } finally {
    restoreStubs();
  }
});

test("returns 404 when conversation does not exist at all", async () => {
  installStubs();
  try {
    // Note: no seedConversation() call — fakeConversations is empty.
    const req = makeReq({ conversationId: "missing-conv", tenantId: TENANT_ID });
    const { res, recorded } = makeRes();
    await handleSnapshotRequest(req, res);

    assert.equal(recorded.statusCode, 404);
    const body = recorded.body as { error: string };
    assert.equal(body.error, "conversation_not_found");
  } finally {
    restoreStubs();
  }
});

test("returns 400 when conversationId path param is empty / whitespace", async () => {
  installStubs();
  try {
    const req = makeReq({ conversationId: "   ", tenantId: TENANT_ID });
    const { res, recorded } = makeRes();
    await handleSnapshotRequest(req, res);

    assert.equal(recorded.statusCode, 400);
    const body = recorded.body as { error: string };
    assert.equal(body.error, "missing_conversation_id");
  } finally {
    restoreStubs();
  }
});

test("returns 401 when no tenant context is attached (defensive guard)", async () => {
  installStubs();
  try {
    const req = makeReq({ conversationId: CONVERSATION_ID });
    const { res, recorded } = makeRes();
    await handleSnapshotRequest(req, res);

    assert.equal(recorded.statusCode, 401);
    const body = recorded.body as { error: string };
    assert.equal(body.error, "missing_tenant");
  } finally {
    restoreStubs();
  }
});

test("with fewer than 10 trace rows, recent_traces still returns all of them", async () => {
  installStubs();
  try {
    seedConversation();
    seedTraces(3);

    const req = makeReq({ conversationId: CONVERSATION_ID, tenantId: TENANT_ID });
    const { res, recorded } = makeRes();
    await handleSnapshotRequest(req, res);

    const body = recorded.body as SnapshotResponseBody;
    assert.equal(body.recent_traces.length, 3);
    // last_verified_tools: of the 3 seeded rows we have search_catalog (ok), (step), add_to_cart (ok).
    // → exactly 2 real successful tools.
    assert.equal(body.last_verified_tools.length, 2);
    const names = body.last_verified_tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["add_to_cart", "search_catalog"]);
  } finally {
    restoreStubs();
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

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
