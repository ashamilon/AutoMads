/**
 * Unit tests for the canonical-name aliases registered by task 7.1 (Reqs 6.1–6.5).
 *
 * Same `tsx`-runnable harness as the rest of `src/agent/__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/toolAliases.test.ts
 *
 * Properties under test:
 *   1. `findTool(<alias>)` resolves to a `ToolDef` whose `handler` is the SAME function
 *      reference as `findTool(<canonical>)`. This is the "alias rather than rename"
 *      contract from the task spec — both names MUST hit the same code path so callers
 *      that say `update_cart` and callers that say `add_to_cart` get identical behaviour.
 *   2. Every name listed in Req 6.1 is resolvable through `findTool`.
 *   3. Alias entries carry `aliasOf: <canonical>` so renderers (`router.renderToolCatalog`)
 *      can filter them out of the LLM-facing tool catalog.
 */

import assert from "node:assert/strict";
import { findTool, TOOLS } from "../tools/registry.js";
import { renderToolCatalog } from "../router.js";

type TestCase = { name: string; run: () => void };
const tests: TestCase[] = [];
function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

// ─── alias identity ─────────────────────────────────────────────────────────

const ALIAS_PAIRS: Array<readonly [alias: string, canonical: string]> = [
  ["update_cart", "add_to_cart"],
  ["remove_cart_item", "remove_from_cart"],
  ["search_products", "search_catalog"],
  ["create_order", "confirm_order"],
];

for (const [alias, canonical] of ALIAS_PAIRS) {
  test(`findTool("${alias}") and findTool("${canonical}") resolve to the same handler reference`, () => {
    const aliasDef = findTool(alias);
    const canonicalDef = findTool(canonical);
    assert.ok(aliasDef, `${alias} must be registered in TOOLS`);
    assert.ok(canonicalDef, `${canonical} must be registered in TOOLS`);
    // Handler identity is the load-bearing invariant: both names hit the same closure,
    // so the "same code path" guarantee is verifiable at runtime.
    assert.equal(
      aliasDef!.handler,
      canonicalDef!.handler,
      `${alias}.handler must === ${canonical}.handler`,
    );
    // Schemas are shared by reference too — guards against a future refactor that
    // accidentally clones the schema and lets the two names drift.
    assert.equal(
      aliasDef!.paramsSchema,
      canonicalDef!.paramsSchema,
      `${alias}.paramsSchema must === ${canonical}.paramsSchema`,
    );
    // The alias entry is tagged so the prompt renderer can skip it.
    assert.equal(aliasDef!.aliasOf, canonical, `${alias}.aliasOf must equal "${canonical}"`);
    // The canonical entry is NOT tagged as an alias.
    assert.equal(
      canonicalDef!.aliasOf,
      undefined,
      `${canonical} is the canonical handler — aliasOf must be undefined`,
    );
  });
}

// ─── Req 6.1 name coverage ─────────────────────────────────────────────────

const REQ_61_NAMES = [
  "search_products",
  "resolve_product_name",
  "check_inventory",
  "update_cart",
  "remove_cart_item",
  "modify_cart_item",
  "save_session_state",
  "retrieve_session_state",
  "create_order",
  "validate_order",
] as const;

test("every tool name from Req 6.1 is resolvable via findTool", () => {
  const missing = REQ_61_NAMES.filter((n) => findTool(n) === null);
  assert.deepEqual(missing, [], `missing tool registrations: ${missing.join(", ")}`);
});

// ─── alias entries don't shadow primaries when iterating TOOLS ──────────────

test("aliases never share their `name` with a non-alias entry", () => {
  // Name uniqueness across the registry: every name should map to exactly one ToolDef.
  // (Without this, `findTool` would silently pick the first match and a future test
  // could land on a stale primary.)
  const seen = new Map<string, number>();
  for (const t of TOOLS) {
    seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  assert.deepEqual(dupes, [], `duplicate tool names in TOOLS: ${dupes.join(", ")}`);
});

test("alias entries preserve the canonical tool's terminal flag", () => {
  // create_order is an alias for confirm_order, which is terminal — the alias must
  // carry that flag so the loop ends the turn correctly when the LLM picks the alias name.
  const createOrder = findTool("create_order");
  const confirmOrder = findTool("confirm_order");
  assert.ok(createOrder && confirmOrder);
  assert.equal(
    createOrder!.terminal,
    confirmOrder!.terminal,
    "create_order.terminal must mirror confirm_order.terminal",
  );
  assert.equal(createOrder!.terminal, true);
});

// ─── catalog rendering excludes aliases ─────────────────────────────────────

test("renderToolCatalog(TOOLS) lists only canonical names, never alias names", () => {
  // The router prompt should only see canonical tool entries — listing both names
  // wastes prompt budget and gives the LLM two equally valid choices for the same
  // action. We verify by:
  //   1. ensuring every alias name is absent from the rendered catalog, AND
  //   2. ensuring every canonical name those aliases point at IS present.
  const rendered = renderToolCatalog(TOOLS);
  // Each tool entry is rendered as `- <name>: ...`, so we look for line starts to
  // avoid false hits when a tool's description prose mentions another tool name.
  const lineStartName = (n: string): RegExp => new RegExp(`^- ${n}:`, "m");

  for (const [alias, canonical] of ALIAS_PAIRS) {
    assert.ok(
      !lineStartName(alias).test(rendered),
      `renderToolCatalog must not emit an entry for alias "${alias}"`,
    );
    assert.ok(
      lineStartName(canonical).test(rendered),
      `renderToolCatalog must emit an entry for canonical "${canonical}"`,
    );
  }
});

// ─── runner ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`ok    ${t.name}`);
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${t.name}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
