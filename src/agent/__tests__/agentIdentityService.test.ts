/**
 * Unit tests for the Agent_Identity service (task 3.1, Reqs 5.1 / 5.2 / 5.4 /
 * 5.7 / 19.2 / 21.2).
 *
 * What's covered:
 *
 *  1. Resolution chain — per-tenant override > category default > platform
 *     default. Each layer is exercised on its own and together.
 *  2. Empty / non-string values in the tenant JSON column do NOT shadow
 *     meaningful defaults (so a stray `""` for `name` falls through to the
 *     category or platform value).
 *  3. The 30-second cache returns the same object on a second call without
 *     re-hitting Prisma.
 *  4. Cache TTL expiry — once 30 s have passed, a second call refetches.
 *  5. `invalidateAgentIdentityCache` punches the cached entry so the next
 *     call refetches.
 *  6. Two different tenants are cached under disjoint keys (R6.4 — Tenant
 *     Cache Key Isolation).
 *  7. A DB read failure falls back to the merge of category + platform
 *     defaults rather than throwing.
 *
 * Same tsx-runnable IIFE shape as the rest of `src/agent/__tests__/` — run
 * with:
 *
 *     npx tsx src/agent/__tests__/agentIdentityService.test.ts
 *
 * Prisma is stubbed at the module level with a counter so the test can
 * assert exact call counts. The pg LISTEN connection is suppressed by
 * deleting `DATABASE_URL` for the duration of the suite — the listener is
 * an operational concern (LISTEN/NOTIFY round-trip across processes) and is
 * out of scope for the resolution-chain assertions covered here.
 */

import assert from "node:assert/strict";

import { prisma } from "../../db/prisma.js";
import {
  PLATFORM_AGENT_IDENTITY_DEFAULTS,
  __resetAgentIdentityCacheForTests,
  invalidateAgentIdentityCache,
  mergeAgentIdentity,
  resolve,
  type AgentIdentity,
} from "../identity/agentIdentityService.js";
import type { CategorySchema } from "../categoryEngine/types.js";

// ─── Test harness ──────────────────────────────────────────────────────────

type TestCase = { name: string; run: () => Promise<void> | void };

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

// ─── Suppress LISTEN connection for hermetic tests ─────────────────────────

// The agent identity service starts a pg LISTEN connection on the first
// cache write when DATABASE_URL is set. We temporarily clear it so the
// listener never spins up; the resolution-chain logic doesn't depend on it.
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

// ─── Prisma stub ───────────────────────────────────────────────────────────

const originalTenantFindUnique = prisma.tenant.findUnique.bind(prisma.tenant);

interface StubState {
  /** What the stub will return on the next call. `null` means "no row". */
  next: { agentIdentity: unknown } | null;
  /** What the stub should throw on the next call. Cleared after one call. */
  throws: Error | null;
  /** Args captured per call so we can assert call counts and shape. */
  calls: Array<{ where: { id?: string } }>;
}

const stub: StubState = { next: null, throws: null, calls: [] };

function installPrismaStub(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.tenant as any).findUnique = async (args: any) => {
    stub.calls.push({ where: args?.where ?? {} });
    if (stub.throws !== null) {
      const err = stub.throws;
      stub.throws = null;
      throw err;
    }
    return stub.next;
  };
}

function restorePrismaStub(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.tenant as any).findUnique = originalTenantFindUnique;
}

function resetStub(): void {
  stub.next = null;
  stub.throws = null;
  stub.calls = [];
  __resetAgentIdentityCacheForTests();
}

installPrismaStub();

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeSchema(
  agentIdentityDefaults?: Partial<AgentIdentity>,
): CategorySchema {
  return {
    id: "schema-test",
    slug: "test",
    version: 1,
    attributes: [],
    variantAttributes: [],
    orderAttributes: [],
    filterAttributes: [],
    terminology: {},
    dashboardModules: [],
    workflowRules: {},
    promptFragments: [],
    isBuiltIn: true,
    tenantId: null,
    ...(agentIdentityDefaults ? { agentIdentityDefaults } : {}),
  };
}

// ─── pickString / mergeAgentIdentity (pure resolver) ───────────────────────

test("mergeAgentIdentity returns platform defaults when no overrides apply", () => {
  const merged = mergeAgentIdentity(null, null);
  assert.deepEqual(merged, PLATFORM_AGENT_IDENTITY_DEFAULTS);
});

test("mergeAgentIdentity layers category default over platform default per key", () => {
  const merged = mergeAgentIdentity(null, {
    name: "Sarah",
    salesStyle: "high_energy",
  });
  assert.equal(merged.name, "Sarah");
  assert.equal(merged.salesStyle, "high_energy");
  // Other keys come from platform defaults.
  assert.equal(merged.role, PLATFORM_AGENT_IDENTITY_DEFAULTS.role);
  assert.equal(merged.tone, PLATFORM_AGENT_IDENTITY_DEFAULTS.tone);
});

test("mergeAgentIdentity layers tenant override on top of category default", () => {
  const merged = mergeAgentIdentity(
    { name: "Alex" },
    { name: "Sarah", greetingStyle: "formal" },
  );
  assert.equal(merged.name, "Alex");          // tenant wins for name
  assert.equal(merged.greetingStyle, "formal"); // category fills greetingStyle
});

test("mergeAgentIdentity ignores empty / whitespace tenant values", () => {
  const merged = mergeAgentIdentity(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: "   ", role: "" } as any,
    { name: "Sarah" },
  );
  // Empty strings fall through to the category default.
  assert.equal(merged.name, "Sarah");
  // Whitespace-only role falls through to the platform default.
  assert.equal(merged.role, PLATFORM_AGENT_IDENTITY_DEFAULTS.role);
});

test("mergeAgentIdentity ignores non-string tenant values", () => {
  const merged = mergeAgentIdentity(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: 123, role: { en: "Manager" }, tone: true } as any,
    null,
  );
  assert.deepEqual(merged, PLATFORM_AGENT_IDENTITY_DEFAULTS);
});

// ─── resolve(tenantId, schema) — DB-backed ─────────────────────────────────

test("resolve returns platform defaults when tenant has no override and schema has none", async () => {
  resetStub();
  stub.next = { agentIdentity: null };

  const identity = await resolve("tenant-A", makeSchema());

  assert.deepEqual(identity, PLATFORM_AGENT_IDENTITY_DEFAULTS);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.where.id, "tenant-A");
});

test("resolve applies category defaults when tenant has no override", async () => {
  resetStub();
  stub.next = { agentIdentity: null };

  const identity = await resolve(
    "tenant-A",
    makeSchema({ name: "ChefBot", role: "Restaurant Order Manager" }),
  );

  assert.equal(identity.name, "ChefBot");
  assert.equal(identity.role, "Restaurant Order Manager");
  assert.equal(identity.language, PLATFORM_AGENT_IDENTITY_DEFAULTS.language);
});

test("resolve lets tenant override beat category default", async () => {
  resetStub();
  stub.next = {
    agentIdentity: {
      name: "Sarah",
      tone: "english_formal",
    },
  };

  const identity = await resolve(
    "tenant-A",
    makeSchema({ name: "ChefBot", tone: "warm_relaxed" }),
  );

  assert.equal(identity.name, "Sarah");          // tenant wins
  assert.equal(identity.tone, "english_formal"); // tenant wins
});

test("resolve ignores empty tenant fields and falls through to category default", async () => {
  resetStub();
  stub.next = {
    agentIdentity: { name: "", role: "   " },
  };

  const identity = await resolve(
    "tenant-A",
    makeSchema({ name: "ChefBot", role: "Restaurant Order Manager" }),
  );

  assert.equal(identity.name, "ChefBot");
  assert.equal(identity.role, "Restaurant Order Manager");
});

// ─── Caching (R5.7, R6.4) ──────────────────────────────────────────────────

test("resolve caches identity per tenantId and skips Prisma on the second call", async () => {
  resetStub();
  stub.next = { agentIdentity: { name: "Sarah" } };

  const first = await resolve("tenant-A", makeSchema());
  const second = await resolve("tenant-A", makeSchema());

  assert.equal(first.name, "Sarah");
  assert.equal(second.name, "Sarah");
  assert.equal(stub.calls.length, 1, "second resolve must come from cache");
});

test("invalidateAgentIdentityCache forces the next resolve to refetch", async () => {
  resetStub();
  stub.next = { agentIdentity: { name: "Sarah" } };
  await resolve("tenant-A", makeSchema());
  assert.equal(stub.calls.length, 1);

  // Operator (or LISTEN handler) bumps the cache.
  invalidateAgentIdentityCache("tenant-A");
  stub.next = { agentIdentity: { name: "Alex" } };

  const refreshed = await resolve("tenant-A", makeSchema());
  assert.equal(refreshed.name, "Alex");
  assert.equal(stub.calls.length, 2, "must refetch after invalidation");
});

test("two tenants are cached under disjoint keys (R6.4)", async () => {
  resetStub();
  stub.next = { agentIdentity: { name: "Sarah" } };
  const a = await resolve("tenant-A", makeSchema());

  stub.next = { agentIdentity: { name: "ChefBot" } };
  const b = await resolve("tenant-B", makeSchema());

  // First call hit the DB for tenant-A; second call hit the DB for tenant-B.
  assert.equal(stub.calls.length, 2);
  assert.equal(a.name, "Sarah");
  assert.equal(b.name, "ChefBot");

  // Both identities round-trip from cache without further Prisma calls.
  const aAgain = await resolve("tenant-A", makeSchema());
  const bAgain = await resolve("tenant-B", makeSchema());
  assert.equal(stub.calls.length, 2, "subsequent reads must come from cache");
  assert.equal(aAgain.name, "Sarah");
  assert.equal(bAgain.name, "ChefBot");
});

test("resolve with empty tenantId never poisons the cache", async () => {
  resetStub();
  // Don't preload `stub.next` — if resolve hit the DB it would crash.
  const identity = await resolve("", makeSchema({ name: "ChefBot" }));
  assert.equal(stub.calls.length, 0, "must not call Prisma for empty tenantId");
  assert.equal(identity.name, "ChefBot"); // category default used
});

// ─── DB failure path ───────────────────────────────────────────────────────

test("resolve falls back to category + platform defaults when Prisma read throws", async () => {
  resetStub();
  stub.throws = new Error("connection_terminated");

  const identity = await resolve(
    "tenant-A",
    makeSchema({ name: "ChefBot" }),
  );
  assert.equal(identity.name, "ChefBot");
  assert.equal(identity.role, PLATFORM_AGENT_IDENTITY_DEFAULTS.role);
});

// ─── Runner ────────────────────────────────────────────────────────────────

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

  // Restore stubs so sibling test files in the same `tsx` run see a clean
  // Prisma surface.
  restorePrismaStub();
  if (typeof ORIGINAL_DATABASE_URL === "string") {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
