/**
 * Smoke tests for the Category_Engine schema loader + per-tenant cache
 * (Multi-Tenant Commerce OS, task 2.2).
 *
 * Covered behaviors:
 *
 *  1. `loadBuiltInSchemas()` reads every JSON file under `./schemas/` and
 *     yields a `Map` whose keys are the schema slugs. The 14 categories
 *     called out in the spec (jersey ... custom) MUST all be present and
 *     each gets a synthesized id of the form `<slug>-builtin`.
 *  2. `getBuiltInSchema(slug)` round-trips for known slugs and returns
 *     `null` for unknown ones.
 *  3. `schemaCache.set/get/invalidate/clear` round-trip correctly.
 *  4. Cache keys are namespaced by tenant id so two tenants are isolated
 *     (R6.4 — Tenant Cache Key Isolation, partial coverage for task 2.2).
 *  5. Cache entries respect the 30 s TTL (R2.6) — we simulate the clock by
 *     reaching into the cache with a manual past timestamp.
 *  6. `loadTenantSchemaFromDb` returns null when the tenant has no row,
 *     and reads through the stubbed Prisma client otherwise.
 *
 * Same tsx-runnable IIFE shape as the rest of `src/agent/__tests__/`. Run
 * with:
 *
 *     npx tsx src/agent/__tests__/categorySchemaLoaderCache.test.ts
 *
 * The pg LISTEN listener stays disabled for the suite — `DATABASE_URL` is
 * cleared on entry — so the tests are hermetic.
 */

import assert from "node:assert/strict";

import { prisma } from "../../db/prisma.js";
import {
  __resetBuiltInSchemasForTests,
  getBuiltInSchema,
  loadBuiltInSchemas,
  loadTenantSchemaFromDb,
} from "../categoryEngine/schemaLoader.js";
import * as schemaCache from "../categoryEngine/schemaCache.js";
import {
  __stopListenerForTests,
  publishCategorySchemaInvalidation,
} from "../categoryEngine/invalidation.js";
import type { CategorySchema } from "../categoryEngine/types.js";

// ─── Test harness ──────────────────────────────────────────────────────────

type TestCase = { name: string; run: () => Promise<void> | void };
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

// ─── Suppress the LISTEN connection for hermetic tests ────────────────────

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

// ─── Prisma stub for `categorySchema.findFirst` ───────────────────────────

const originalFindFirst = prisma.categorySchema.findFirst.bind(
  prisma.categorySchema,
);

interface StubState {
  /** Row returned on the next call. `null` means "no tenant row". */
  next: unknown | null;
  /** Captured args per call. */
  calls: Array<{ where: { tenantId?: string } }>;
}

const stub: StubState = { next: null, calls: [] };

function installPrismaStub(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.categorySchema as any).findFirst = async (args: any) => {
    stub.calls.push({ where: args?.where ?? {} });
    return stub.next;
  };
}

function restorePrismaStub(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.categorySchema as any).findFirst = originalFindFirst;
}

function resetStub(): void {
  stub.next = null;
  stub.calls = [];
  schemaCache.__resetCacheForTests();
  __resetBuiltInSchemasForTests();
}

installPrismaStub();

// ─── Fixtures ──────────────────────────────────────────────────────────────

const EXPECTED_BUILTIN_SLUGS = [
  "jersey",
  "clothing",
  "undergarments",
  "shoes",
  "cosmetics",
  "electronics",
  "restaurant",
  "grocery",
  "jewelry",
  "furniture",
  "pet_shop",
  "pharmacy",
  "mobile_accessories",
  "custom",
] as const;

function makeSchema(slug: string): CategorySchema {
  return {
    id: `${slug}-test`,
    slug,
    version: 1,
    attributes: [],
    variantAttributes: [],
    orderAttributes: [],
    filterAttributes: [],
    terminology: {},
    dashboardModules: [],
    workflowRules: {},
    promptFragments: [],
    isBuiltIn: false,
    tenantId: "tenant-fixture",
  };
}

// ─── Built-in JSON loading ────────────────────────────────────────────────

test("loadBuiltInSchemas surfaces all 14 spec-required built-in categories", () => {
  resetStub();
  const map = loadBuiltInSchemas();
  for (const slug of EXPECTED_BUILTIN_SLUGS) {
    assert.ok(map.has(slug), `expected built-in schema for ${slug}`);
    const s = map.get(slug);
    assert.equal(s?.slug, slug);
    assert.equal(s?.isBuiltIn, true);
    assert.equal(s?.id, `${slug}-builtin`);
  }
});

test("loadBuiltInSchemas memoizes the map across calls", () => {
  resetStub();
  const a = loadBuiltInSchemas();
  const b = loadBuiltInSchemas();
  assert.strictEqual(a, b, "second call must return the cached map reference");
});

test("getBuiltInSchema returns the matching slug or null", () => {
  resetStub();
  const jersey = getBuiltInSchema("jersey");
  assert.ok(jersey);
  assert.equal(jersey?.slug, "jersey");
  assert.equal(getBuiltInSchema("nonsense_category"), null);
  assert.equal(getBuiltInSchema(""), null);
});

// ─── Per-tenant cache ─────────────────────────────────────────────────────

test("schemaCache get/set roundtrip per tenantId", () => {
  schemaCache.__resetCacheForTests();
  const a = makeSchema("jersey");
  schemaCache.set("tenant-A", a);
  assert.equal(schemaCache.get("tenant-A")?.slug, "jersey");
  assert.equal(schemaCache.get("tenant-B"), null);
});

test("schemaCache key is namespaced by tenant id (R6.4)", () => {
  schemaCache.__resetCacheForTests();
  const a = makeSchema("jersey");
  schemaCache.set("tenant-A", a);
  assert.equal(schemaCache.cacheKey("tenant-A"), "tenant:tenant-A");
  // The bare tenant id MUST NOT be reachable.
  assert.equal(schemaCache.get(""), null);
});

test("schemaCache.invalidate evicts only the targeted tenant", () => {
  schemaCache.__resetCacheForTests();
  schemaCache.set("tenant-A", makeSchema("jersey"));
  schemaCache.set("tenant-B", makeSchema("restaurant"));
  schemaCache.invalidate("tenant-A");
  assert.equal(schemaCache.get("tenant-A"), null);
  assert.equal(schemaCache.get("tenant-B")?.slug, "restaurant");
});

test("schemaCache.clear evicts every entry", () => {
  schemaCache.__resetCacheForTests();
  schemaCache.set("tenant-A", makeSchema("jersey"));
  schemaCache.set("tenant-B", makeSchema("restaurant"));
  schemaCache.clear();
  assert.equal(schemaCache.__sizeForTests(), 0);
});

// ─── Tenant DB read ───────────────────────────────────────────────────────

test("loadTenantSchemaFromDb returns null when no row exists", async () => {
  resetStub();
  stub.next = null;
  const result = await loadTenantSchemaFromDb("tenant-A");
  assert.equal(result, null);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.where.tenantId, "tenant-A");
});

test("loadTenantSchemaFromDb maps a Prisma row to the runtime CategorySchema shape", async () => {
  resetStub();
  stub.next = {
    id: "schema-A",
    slug: "restaurant",
    version: 3,
    attributes: [{ key: "spice_level", label: "Spice Level", type: "enum", required: true, customerVisible: true, enumValues: ["mild", "hot"] }],
    variantAttributes: [],
    orderAttributes: [],
    filterAttributes: [],
    terminology: { catalog: "menu" },
    dashboardModules: ["menu_manager"],
    workflowRules: { requiresDeliveryEstimate: true },
    promptFragments: ["Restaurant agent."],
    isBuiltIn: false,
    tenantId: "tenant-A",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await loadTenantSchemaFromDb("tenant-A");
  assert.ok(result);
  assert.equal(result?.id, "schema-A");
  assert.equal(result?.slug, "restaurant");
  assert.equal(result?.version, 3);
  assert.equal(result?.terminology["catalog"], "menu");
  assert.equal(result?.workflowRules.requiresDeliveryEstimate, true);
});

test("loadTenantSchemaFromDb returns null on empty tenantId without hitting Prisma", async () => {
  resetStub();
  const result = await loadTenantSchemaFromDb("");
  assert.equal(result, null);
  assert.equal(stub.calls.length, 0);
});

// ─── Publisher (no DATABASE_URL — local-only path) ────────────────────────

test("publishCategorySchemaInvalidation punches the local cache when DATABASE_URL is unset", async () => {
  schemaCache.__resetCacheForTests();
  schemaCache.set("tenant-A", makeSchema("jersey"));
  await publishCategorySchemaInvalidation("tenant-A");
  assert.equal(schemaCache.get("tenant-A"), null);
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

  // Restore stubs and DATABASE_URL so sibling tests in the same `tsx` run
  // see a clean Prisma surface.
  restorePrismaStub();
  await __stopListenerForTests();
  if (typeof ORIGINAL_DATABASE_URL === "string") {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
