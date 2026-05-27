/**
 * Category schema loader (Multi-Tenant Commerce OS, task 2.2).
 *
 * Two responsibilities:
 *
 *   1. `loadBuiltInSchemas()` — synchronously read every JSON file under
 *      `./schemas/` once at boot, parse, validate the runtime shape, and
 *      memoize the result as an immutable `Map<slug, CategorySchema>`. The
 *      built-in id is synthesized as `<slug>-builtin` so consumers can refer
 *      to a schema by the same key whether it came from disk or Prisma.
 *
 *   2. `loadTenantSchemaFromDb(tenantId)` — read the tenant-cloned
 *      `CategorySchema` row from Prisma where `tenantId` matches. Returns
 *      `null` when the tenant has not customized the built-in. Higher layers
 *      (task 2.3) implement the full resolution chain (`categorySchemaId` ->
 *      built-in for `businessCategory` -> `jersey`).
 *
 * The loader does NOT call the cache. The cache layer (`schemaCache.ts`)
 * owns TTL/eviction and the LISTEN/NOTIFY round-trip lives in
 * `invalidation.ts`. This module is intentionally side-effect free apart
 * from the boot-time JSON read and the obvious Prisma call.
 *
 * Maps to: R2.1, R2.4, R3.1, R6.4.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import type { CategorySchema } from "./types.js";

/**
 * Absolute path of the built-in schemas directory. The package compiles to
 * CommonJS (NodeNext picks CJS in the absence of `"type": "module"` in
 * `package.json`), so `__dirname` is the most idiomatic anchor here. The
 * JSON files are NOT bundled into `dist/` — see the build note below — so
 * we resolve relative to the source `src/` tree at runtime.
 *
 * Resolution strategy:
 *  - Start from `__dirname`. In `dist/agent/categoryEngine/` this is the
 *    compiled folder; in `src/agent/categoryEngine/` (when running under
 *    `tsx`) this is the source folder.
 *  - In production, `tsc` does not copy `.json` assets, so when running
 *    from `dist/` we walk back to `src/agent/categoryEngine/schemas/`.
 *  - In `tsx`/test mode `__dirname` already points at the source folder,
 *    so the `schemas/` sibling is the right answer immediately.
 */
const SCHEMAS_DIR = (() => {
  const here = __dirname;
  const directSibling = pathResolve(here, "schemas");
  // When compiled, `here` looks like `<root>/dist/agent/categoryEngine`.
  // Map it back to `<root>/src/agent/categoryEngine/schemas`.
  const distMatch = here.match(/(.*)[\\/]dist[\\/]agent[\\/]categoryEngine$/);
  if (distMatch) {
    return pathResolve(distMatch[1] as string, "src/agent/categoryEngine/schemas");
  }
  return directSibling;
})();

/** Memoized result of `loadBuiltInSchemas`. `null` until the first call. */
let builtInCache: ReadonlyMap<string, CategorySchema> | null = null;

// ─── Built-in JSON schemas ────────────────────────────────────────────────

/**
 * Minimal runtime shape check. The validators in task 2.3 own per-key
 * validation; this function only ensures the JSON file is recognizably a
 * `CategorySchema` so a typo'd or empty file does not poison the in-memory
 * map. Anything that fails the check is logged and skipped.
 */
function isCategorySchemaShape(value: unknown): value is CategorySchema {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.slug === "string" &&
    typeof s.version === "number" &&
    Array.isArray(s.attributes) &&
    Array.isArray(s.variantAttributes) &&
    Array.isArray(s.orderAttributes) &&
    Array.isArray(s.filterAttributes) &&
    typeof s.terminology === "object" &&
    s.terminology !== null &&
    Array.isArray(s.dashboardModules) &&
    typeof s.workflowRules === "object" &&
    s.workflowRules !== null &&
    Array.isArray(s.promptFragments) &&
    typeof s.isBuiltIn === "boolean"
  );
}

/**
 * Built-in JSON files do not carry an `id` (they ship as data, not rows);
 * synthesize one of the form `<slug>-builtin` so callers can use a single
 * lookup key across disk and Prisma sources.
 */
function assignBuiltInId(schema: CategorySchema): CategorySchema {
  if (typeof schema.id === "string" && schema.id.length > 0) return schema;
  return { ...schema, id: `${schema.slug}-builtin` };
}

/**
 * Load every built-in `CategorySchema` JSON file once at boot. The result is
 * memoized for the life of the process; subsequent calls are O(1). Returns
 * an immutable `Map` keyed by `slug` (e.g. `jersey`, `restaurant`,
 * `cosmetics`, `custom`).
 *
 * Files that fail to parse or fail the runtime shape check are logged and
 * skipped — a malformed `mobile_accessories.json` must never bring down the
 * agent for the other 13 categories.
 */
export function loadBuiltInSchemas(): ReadonlyMap<string, CategorySchema> {
  if (builtInCache !== null) return builtInCache;

  const map = new Map<string, CategorySchema>();
  let files: string[];
  try {
    files = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".json"));
  } catch (err) {
    logger.warn(
      { event: "category_schema_dir_read_failed", dir: SCHEMAS_DIR, err: serializeError(err) },
      "category schemas directory could not be read",
    );
    builtInCache = map;
    return builtInCache;
  }

  for (const file of files) {
    const path = join(SCHEMAS_DIR, file);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isCategorySchemaShape(parsed)) {
        logger.warn(
          { event: "category_schema_invalid_shape", file },
          "category schema JSON ignored: shape mismatch",
        );
        continue;
      }
      const schema = assignBuiltInId(parsed);
      map.set(schema.slug, schema);
    } catch (err) {
      logger.warn(
        { event: "category_schema_parse_failed", file, err: serializeError(err) },
        "category schema JSON failed to parse",
      );
    }
  }

  builtInCache = map;
  return builtInCache;
}

/**
 * Convenience: look up a single built-in by `slug`. Returns `null` if the
 * slug is not recognized.
 */
export function getBuiltInSchema(slug: string): CategorySchema | null {
  if (!slug) return null;
  return loadBuiltInSchemas().get(slug) ?? null;
}

/**
 * Discard the in-process built-in cache so the next call rereads from disk.
 * Used by test suites that mutate the schemas directory; production callers
 * never need this because the built-ins ship as immutable JSON.
 *
 * @internal
 */
export function __resetBuiltInSchemasForTests(): void {
  builtInCache = null;
}

// ─── Tenant-cloned schemas (Prisma) ───────────────────────────────────────

/**
 * Subset of the Prisma `CategorySchema` row we read. Declared locally rather
 * than importing the generated type so the loader keeps compiling even if
 * `prisma generate` hasn't run yet (common during the in-place refactor).
 */
interface CategorySchemaRow {
  id: string;
  slug: string;
  version: number;
  attributes: unknown;
  variantAttributes: unknown;
  orderAttributes: unknown;
  filterAttributes: unknown;
  terminology: unknown;
  dashboardModules: unknown;
  workflowRules: unknown;
  promptFragments: unknown;
  isBuiltIn: boolean;
  tenantId: string | null;
}

/**
 * Cast a Prisma row to the runtime `CategorySchema` shape. JSON columns are
 * stored as `unknown`; we coerce with the documented defaults so a missing
 * key never produces `undefined.map(...)` downstream. Per-key validation is
 * the validators' job.
 */
function rowToSchema(row: CategorySchemaRow): CategorySchema {
  return {
    id: row.id,
    slug: row.slug,
    version: row.version,
    attributes: (row.attributes as CategorySchema["attributes"]) ?? [],
    variantAttributes:
      (row.variantAttributes as CategorySchema["variantAttributes"]) ?? [],
    orderAttributes:
      (row.orderAttributes as CategorySchema["orderAttributes"]) ?? [],
    filterAttributes:
      (row.filterAttributes as CategorySchema["filterAttributes"]) ?? [],
    terminology: (row.terminology as CategorySchema["terminology"]) ?? {},
    dashboardModules:
      (row.dashboardModules as CategorySchema["dashboardModules"]) ?? [],
    workflowRules: (row.workflowRules as CategorySchema["workflowRules"]) ?? {},
    promptFragments:
      (row.promptFragments as CategorySchema["promptFragments"]) ?? [],
    isBuiltIn: row.isBuiltIn,
    tenantId: row.tenantId,
  };
}

/**
 * Read the tenant-cloned `CategorySchema` row from Prisma. Returns `null` if
 * no row exists for the tenant — the resolver in task 2.3 falls back to the
 * built-in for `tenant.businessCategory`, then to `jersey`.
 *
 * When multiple rows exist for the same tenant (legacy migrations, manual
 * cloning), the most recently updated one wins. The schema id is unique on
 * its own, so callers that already know the id should use
 * `loadSchemaById(id)` instead.
 */
export async function loadTenantSchemaFromDb(
  tenantId: string,
): Promise<CategorySchema | null> {
  if (!tenantId) return null;
  try {
    const row = await prisma.categorySchema.findFirst({
      where: { tenantId },
      orderBy: { updatedAt: "desc" },
    });
    if (row === null) return null;
    return rowToSchema(row as unknown as CategorySchemaRow);
  } catch (err) {
    logger.warn(
      { event: "category_schema_db_read_failed", tenantId, err: serializeError(err) },
      "tenant category schema read failed",
    );
    return null;
  }
}

/**
 * Look up a schema by its stable `id`. For built-in ids of the form
 * `<slug>-builtin` the lookup is satisfied entirely from disk to avoid an
 * unnecessary DB hit. Otherwise the row is fetched by `id`.
 */
export async function loadSchemaById(
  id: string,
): Promise<CategorySchema | null> {
  if (!id) return null;
  if (id.endsWith("-builtin")) {
    const slug = id.slice(0, -"-builtin".length);
    return getBuiltInSchema(slug);
  }
  try {
    const row = await prisma.categorySchema.findUnique({ where: { id } });
    if (row === null) return null;
    return rowToSchema(row as unknown as CategorySchemaRow);
  } catch (err) {
    logger.warn(
      { event: "category_schema_db_read_failed", id, err: serializeError(err) },
      "category schema lookup by id failed",
    );
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function serializeError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
