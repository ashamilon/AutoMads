/**
 * Category_Engine public API (Multi-Tenant Commerce OS, task 2.3).
 *
 * Surface contract (R2.1, R2.2, R2.3, R2.5, R3.2, R3.3, R3.4, R8.2, R9.3):
 *
 *   loadCategorySchema(tenantId)
 *     Resolution chain (per design):
 *       1. `tenant.categorySchemaId` — when set, load by id (covers both
 *          built-ins via the synthetic `<slug>-builtin` id and tenant-cloned
 *          rows in Prisma).
 *       2. Built-in schema matching `tenant.businessCategory`.
 *       3. Final fallback to the `jersey` built-in. When this branch fires
 *          we emit a structured `category_schema_fallback` warn tagged with
 *          `tenantId` so operators can spot tenants stuck on the demo
 *          template (R3.2, R8.2).
 *
 *   validateProductAttributes(tenantId, attributes)
 *   validateOrderAttributes(tenantId, orderAttributes)
 *     Both reject unknown keys, missing required fields, and type
 *     mismatches. For `enum`/`multi_enum` they verify membership in
 *     `enumValues`; for `number`/`currency` they honor `min`/`max`. Return
 *     `{ ok: true }` or `{ ok: false, errors: [{ key, code, detail? }] }`.
 *
 *     Preserve mode (R3.4 + demo-tenant invariant): when
 *     `tenant.businessCategory === 'jersey'` the validators silently allow
 *     the historical attribute keys `chest, length, sleeve, version, team,
 *     season` regardless of whether they appear in the active schema or
 *     are flagged required. This keeps demo-tenant
 *     (`cmooz62gy0000v5gclycwq78p`) reads/writes flowing across schema
 *     edits during the rollout.
 *
 *   resolveTerminology(tenantId)
 *   listDashboardModules(tenantId)
 *   getWorkflowRules(tenantId)
 *     Thin accessors over the resolved schema, used by the Reply Filter
 *     terminology pre-pass (R2.5), the Dashboard Module Registry (R9.3),
 *     and the agent loop's category-aware reasoning hints (R8.2).
 *
 *   invalidateSchemaCache(tenantId)
 *     Punches the local in-process `schemaCache` and emits
 *     `pg_notify('category_schema_invalidate', tenantId)` via the publisher
 *     in `./invalidation.ts` so peer processes evict their copies. When
 *     `DATABASE_URL` is unset (tests) the publisher is a no-op and only
 *     the local cache is cleared.
 *
 * Caching policy (R2.6, R6.4): all schema lookups go through the existing
 * `schemaCache` (per-`tenantId`, 30 s TTL). Tenant attribute reads
 * (`businessCategory`, `categorySchemaId`) are memoized in a tiny sibling
 * map with the same TTL so the validators don't issue a Prisma read on
 * every product/order write — invalidated alongside the schema.
 */

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { publishCategorySchemaInvalidation } from "./invalidation.js";
import * as schemaCache from "./schemaCache.js";
import { getBuiltInSchema, loadSchemaById } from "./schemaLoader.js";
import type {
  AttributeField,
  CategorySchema,
  DashboardModuleId,
  ValidationError,
  WorkflowRules,
} from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────

/** Final fallback slug per R3.2 / R8.2. */
const FALLBACK_SLUG = "jersey";

/** `tenant.businessCategory` value that triggers preserve mode (R3.4). */
const PRESERVE_MODE_CATEGORY = "jersey";

/**
 * Historical jersey product attribute keys that preserve mode must accept
 * regardless of the active schema's `required` list. Mirrors the demo
 * tenant's pre-Commerce-OS columnar layout.
 */
const PRESERVE_MODE_KEYS: ReadonlySet<string> = new Set([
  "chest",
  "length",
  "sleeve",
  "version",
  "team",
  "season",
]);

/**
 * TTL for the tenant-attributes mini-cache. Aligned with `schemaCache` so a
 * single `invalidateSchemaCache(tenantId)` evicts both atomically.
 */
const TENANT_CONTEXT_TTL_MS = 30_000;

// ─── Result types ─────────────────────────────────────────────────────────

/**
 * Public validation result. Exporting the type so callers can narrow on
 * `result.ok` without importing the field-level error shape separately.
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

// ─── Tenant-attributes mini-cache ─────────────────────────────────────────

interface TenantContext {
  /** `tenant.businessCategory` (e.g. `jersey`, `restaurant`, `custom`). */
  businessCategory: string | null;
  /** `tenant.categorySchemaId`, when the tenant has been pinned to a row. */
  categorySchemaId: string | null;
}

interface TenantContextCacheEntry {
  ctx: TenantContext;
  fetchedAt: number;
}

const tenantContextCache = new Map<string, TenantContextCacheEntry>();

function getCachedTenantContext(tenantId: string): TenantContext | null {
  const entry = tenantContextCache.get(tenantId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TENANT_CONTEXT_TTL_MS) {
    tenantContextCache.delete(tenantId);
    return null;
  }
  return entry.ctx;
}

function setCachedTenantContext(tenantId: string, ctx: TenantContext): void {
  tenantContextCache.set(tenantId, { ctx, fetchedAt: Date.now() });
}

async function fetchTenantContext(tenantId: string): Promise<TenantContext> {
  const cached = getCachedTenantContext(tenantId);
  if (cached !== null) return cached;

  let row: TenantContext | null = null;
  try {
    const found = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { businessCategory: true, categorySchemaId: true },
    });
    if (found) {
      row = {
        businessCategory: found.businessCategory ?? null,
        categorySchemaId: found.categorySchemaId ?? null,
      };
    }
  } catch (err) {
    // Don't throw — the resolver falls back to jersey on read failure so
    // the agent never hard-fails on transient DB hiccups (R8.2).
    logger.warn(
      {
        event: "category_schema_tenant_read_failed",
        tenantId,
        err: serializeError(err),
      },
      "tenant lookup for category schema resolution failed",
    );
  }

  const ctx: TenantContext =
    row ?? { businessCategory: null, categorySchemaId: null };
  setCachedTenantContext(tenantId, ctx);
  return ctx;
}

// ─── loadCategorySchema ───────────────────────────────────────────────────

/**
 * Resolve the active `CategorySchema` for a tenant. Always returns a usable
 * schema — on any unrecoverable miss the function emits
 * `category_schema_fallback` and returns the `jersey` built-in (R3.2).
 *
 * Throws only if the `jersey` built-in itself is missing from disk, which
 * would indicate a packaging bug rather than a runtime condition any
 * caller can recover from.
 */
export async function loadCategorySchema(
  tenantId: string,
): Promise<CategorySchema> {
  if (!tenantId) {
    return resolveJerseyFallback("missing_tenant_id", tenantId);
  }

  const cached = schemaCache.get(tenantId);
  if (cached !== null) return cached;

  const ctx = await fetchTenantContext(tenantId);

  // 1. Pinned schema id (covers built-ins and tenant-cloned rows).
  if (ctx.categorySchemaId) {
    const byId = await loadSchemaById(ctx.categorySchemaId);
    if (byId !== null) {
      schemaCache.set(tenantId, byId);
      return byId;
    }
  }

  // 2. Built-in matching the tenant's businessCategory.
  if (ctx.businessCategory) {
    const builtIn = getBuiltInSchema(ctx.businessCategory);
    if (builtIn !== null) {
      schemaCache.set(tenantId, builtIn);
      return builtIn;
    }
  }

  // 3. Jersey fallback + structured warn.
  return resolveJerseyFallback("no_match", tenantId);
}

function resolveJerseyFallback(
  reason: "missing_tenant_id" | "no_match",
  tenantId: string,
): CategorySchema {
  const fallback = getBuiltInSchema(FALLBACK_SLUG);
  if (fallback === null) {
    // The jersey JSON ships with the package; this would be a build/asset
    // packaging bug and cannot be papered over at runtime.
    throw new Error("category_engine_missing_jersey_fallback");
  }
  logger.warn(
    { event: "category_schema_fallback", tenantId: tenantId || null, reason },
    "category schema fell back to jersey built-in",
  );
  if (tenantId) schemaCache.set(tenantId, fallback);
  return fallback;
}

// ─── Validators ───────────────────────────────────────────────────────────

/**
 * Validate a single value against an `AttributeField`'s declared type.
 * Returns `null` when the value is acceptable, or a single
 * {@link ValidationError} describing the failure.
 *
 * Notes:
 *  - The `ValidationError.code` enum (`unknown_key | missing_required |
 *    type_mismatch | enum_violation`) is fixed by `types.ts` and not
 *    extended here, so range violations on `number`/`currency` reuse
 *    `type_mismatch` with a descriptive `detail`.
 *  - `date` accepts either a `Date` instance or any string parseable by
 *    `new Date(...)`.
 *  - `image_ref` accepts any non-empty string (a URL or storage key).
 */
function validateValue(
  field: AttributeField,
  value: unknown,
): ValidationError | null {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") {
        return { key: field.key, code: "type_mismatch", detail: "expected string" };
      }
      return null;
    }
    case "number":
    case "currency": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { key: field.key, code: "type_mismatch", detail: "expected number" };
      }
      if (typeof field.min === "number" && value < field.min) {
        return {
          key: field.key,
          code: "type_mismatch",
          detail: `value ${value} below min ${field.min}`,
        };
      }
      if (typeof field.max === "number" && value > field.max) {
        return {
          key: field.key,
          code: "type_mismatch",
          detail: `value ${value} above max ${field.max}`,
        };
      }
      return null;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return { key: field.key, code: "type_mismatch", detail: "expected boolean" };
      }
      return null;
    }
    case "enum": {
      if (typeof value !== "string") {
        return { key: field.key, code: "type_mismatch", detail: "expected string for enum" };
      }
      if (Array.isArray(field.enumValues) && !field.enumValues.includes(value)) {
        return {
          key: field.key,
          code: "enum_violation",
          detail: `value '${value}' not in enumValues`,
        };
      }
      return null;
    }
    case "multi_enum": {
      if (!Array.isArray(value)) {
        return { key: field.key, code: "type_mismatch", detail: "expected array for multi_enum" };
      }
      if (!value.every((v) => typeof v === "string")) {
        return {
          key: field.key,
          code: "type_mismatch",
          detail: "expected array of strings for multi_enum",
        };
      }
      if (Array.isArray(field.enumValues)) {
        const allowed = new Set(field.enumValues);
        for (const v of value as string[]) {
          if (!allowed.has(v)) {
            return {
              key: field.key,
              code: "enum_violation",
              detail: `value '${v}' not in enumValues`,
            };
          }
        }
      }
      return null;
    }
    case "date": {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          return { key: field.key, code: "type_mismatch", detail: "invalid Date" };
        }
        return null;
      }
      if (typeof value !== "string") {
        return { key: field.key, code: "type_mismatch", detail: "expected ISO date string or Date" };
      }
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return { key: field.key, code: "type_mismatch", detail: "invalid date string" };
      }
      return null;
    }
    case "image_ref": {
      if (typeof value !== "string" || value.length === 0) {
        return { key: field.key, code: "type_mismatch", detail: "expected non-empty image_ref string" };
      }
      return null;
    }
    default: {
      // Unknown field type — treat as a soft acceptance rather than failing
      // shut so a future schema field type doesn't break validation in the
      // wild. Schema authoring is gated by typescript at the source.
      return null;
    }
  }
}

/**
 * Run validation across `fields` for the supplied `values` map. Pure — no
 * I/O, no schema resolution. The caller picks which slice of the schema
 * (product attributes vs order attributes) to validate.
 */
function runValidation(
  fields: AttributeField[],
  values: Record<string, unknown>,
  preserveMode: boolean,
): ValidationResult {
  const errors: ValidationError[] = [];
  const fieldByKey = new Map<string, AttributeField>();
  for (const f of fields) fieldByKey.set(f.key, f);

  // Unknown keys
  for (const key of Object.keys(values)) {
    if (fieldByKey.has(key)) continue;
    if (preserveMode && PRESERVE_MODE_KEYS.has(key)) continue;
    errors.push({ key, code: "unknown_key" });
  }

  // Required + per-value type checks
  for (const f of fields) {
    const present = Object.prototype.hasOwnProperty.call(values, f.key);
    const value = present ? values[f.key] : undefined;

    if (!present || value === undefined || value === null) {
      if (f.required) {
        if (preserveMode && PRESERVE_MODE_KEYS.has(f.key)) continue;
        errors.push({ key: f.key, code: "missing_required" });
      }
      continue;
    }

    const fieldError = validateValue(f, value);
    if (fieldError !== null) errors.push(fieldError);
  }

  if (errors.length === 0) return { ok: true };
  return { ok: false, errors };
}

/**
 * Validate a product's attribute payload against the active schema's
 * `attributes` list. See module docstring for the preserve-mode rule
 * (R3.4).
 */
export async function validateProductAttributes(
  tenantId: string,
  attributes: Record<string, unknown>,
): Promise<ValidationResult> {
  const schema = await loadCategorySchema(tenantId);
  const ctx = await fetchTenantContext(tenantId);
  const preserveMode = ctx.businessCategory === PRESERVE_MODE_CATEGORY;
  return runValidation(schema.attributes, attributes ?? {}, preserveMode);
}

/**
 * Validate an order's attribute payload against the active schema's
 * `orderAttributes` list. See module docstring for the preserve-mode rule
 * (R3.4).
 */
export async function validateOrderAttributes(
  tenantId: string,
  orderAttributes: Record<string, unknown>,
): Promise<ValidationResult> {
  const schema = await loadCategorySchema(tenantId);
  const ctx = await fetchTenantContext(tenantId);
  const preserveMode = ctx.businessCategory === PRESERVE_MODE_CATEGORY;
  return runValidation(
    schema.orderAttributes,
    orderAttributes ?? {},
    preserveMode,
  );
}

// ─── Accessors ────────────────────────────────────────────────────────────

/**
 * Resolve the internal-term -> customer-facing-Banglish-term map for a
 * tenant. Consumed by the Reply Filter terminology pre-pass (R2.5).
 */
export async function resolveTerminology(
  tenantId: string,
): Promise<Record<string, string>> {
  const schema = await loadCategorySchema(tenantId);
  return schema.terminology;
}

/**
 * Return the dashboard module IDs the tenant should render, in declared
 * order. Used by the Dashboard Module Registry (R9.3).
 */
export async function listDashboardModules(
  tenantId: string,
): Promise<DashboardModuleId[]> {
  const schema = await loadCategorySchema(tenantId);
  return schema.dashboardModules;
}

/**
 * Return the category-specific reasoning hints for a tenant. Read by the
 * agent loop, intent classifier, and recommendation engine (R8.2).
 */
export async function getWorkflowRules(
  tenantId: string,
): Promise<WorkflowRules> {
  const schema = await loadCategorySchema(tenantId);
  return schema.workflowRules;
}

// ─── Cache invalidation ───────────────────────────────────────────────────

/**
 * Invalidate every per-tenant cache layer the engine maintains. Calls into
 * `schemaCache` for the in-process eviction and emits the
 * `category_schema_invalidate` `pg_notify` so peer processes evict too.
 *
 * Idempotent — safe to call repeatedly. Returns a promise so admin/onboard
 * code paths can `await` propagation before responding to the operator.
 */
export async function invalidateSchemaCache(tenantId: string): Promise<void> {
  if (!tenantId) return;
  schemaCache.invalidate(tenantId);
  tenantContextCache.delete(tenantId);
  await publishCategorySchemaInvalidation(tenantId);
}

// ─── Internals (test hooks) ───────────────────────────────────────────────

/**
 * Drop the tenant-attributes mini-cache. Exposed for tsx-runnable test
 * suites that need to assert resolution after mutating Prisma between
 * scenarios.
 *
 * @internal
 */
export function __resetTenantContextCacheForTests(): void {
  tenantContextCache.clear();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function serializeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
