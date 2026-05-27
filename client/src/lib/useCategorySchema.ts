"use client";

/**
 * Tenant-scoped Category Engine schema reader.
 *
 * Calls `GET /api/v1/me/category-schema` once per tenant session via the
 * existing stale-while-revalidate cache. The portal pages (catalog, settings,
 * orders) read this hook to drive category-aware UI: which product fields to
 * show, which size chart presets are sensible, which dashboard modules to
 * render, etc.
 *
 * The schema mirrors the server-side `CategorySchema` shape from
 * `src/agent/categoryEngine/types.ts`. Keep this client copy minimal — only
 * the fields the dashboard actually uses are typed. Adding a new field is a
 * matter of extending this interface and the consumer; no server change.
 *
 * Maps to: R2.1, R3.1, R3.2, R8.1, R8.2, R9.1, R9.6.
 */

import { useApiCache } from "./api-cache";

export type AttributeType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "multi_enum"
  | "date"
  | "currency"
  | "image_ref";

export interface AttributeField {
  key: string;
  label: string;
  type: AttributeType;
  required: boolean;
  customerVisible: boolean;
  enumValues?: string[];
  min?: number;
  max?: number;
  unit?: string;
}

export interface CategorySchema {
  id: string;
  slug: string;
  version: number;
  attributes: AttributeField[];
  variantAttributes: AttributeField[];
  orderAttributes: AttributeField[];
  filterAttributes: AttributeField[];
  terminology: Record<string, string>;
  dashboardModules: string[];
  workflowRules?: Record<string, unknown>;
  promptFragments?: string[];
  isBuiltIn: boolean;
  tenantId: string | null;
}

interface CategorySchemaResponse {
  schema: CategorySchema;
}

/**
 * Hook returning the active CategorySchema for the authenticated tenant.
 *
 * Returns `null` until the first fetch resolves, then the schema. The hook
 * surfaces `isStale` and `refresh` from `useApiCache` so callers can
 * trigger a manual refresh after onboarding flips the schema (e.g. when the
 * Tenant_Admin renames category fields in Settings → triggers an admin
 * `assignSchemaToTenant` → next page load picks up the new shape).
 */
export function useCategorySchema(): {
  schema: CategorySchema | null;
  isStale: boolean;
  refresh: () => void;
} {
  const { data, isStale, refresh } = useApiCache<CategorySchemaResponse>(
    "/api/v1/me/category-schema",
    { ttlMs: 30_000 }, // R2.6 — schema cache invalidates within 30s
  );
  return {
    schema: data?.schema ?? null,
    isStale,
    refresh,
  };
}

/**
 * Pull a single attribute field out of a schema by key. Returns `undefined`
 * when the field is not declared (e.g. the tenant cloned the built-in and
 * dropped the field). Callers that depend on a specific field should
 * gracefully degrade — usually by hiding a row or substituting a generic
 * input — rather than crashing.
 */
export function findAttributeField(
  fields: AttributeField[] | undefined,
  key: string,
): AttributeField | undefined {
  if (!fields) return undefined;
  return fields.find((f) => f.key === key);
}

/**
 * Read enum values for a given variant attribute key (e.g. `size`,
 * `shoe_size`, `portion_size`). Returns an empty array when the field is
 * missing or not an enum so callers can pre-render a fallback dropdown.
 */
export function getVariantEnumValues(
  schema: CategorySchema | null,
  key: string,
): string[] {
  const field = findAttributeField(schema?.variantAttributes, key);
  if (!field || !Array.isArray(field.enumValues)) return [];
  return field.enumValues;
}
