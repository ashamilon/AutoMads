/**
 * Onboarding wizard shared types (Multi-Tenant Commerce OS, task 11.2).
 *
 * Mirrors the runtime contract from `src/services/onboarding/onboardingService.ts`.
 * The wizard never imports server code directly; this file is the
 * client-side source of truth for the JSON the wizard exchanges with the
 * API.
 */

/** Stable step ids — must stay in sync with `OnboardingStep` server-side. */
export type OnboardingStep =
  | "welcome"
  | "audience"
  | "category_select"
  | "custom_category"
  | "schema_preferences"
  | "finalize";

/**
 * Snapshot of the wizard's persisted JSON. Each step contributes a slice
 * of this; the server shallow-merges new slices into the existing payload
 * so a returning operator never loses prior answers.
 */
export interface OnboardingPayload {
  businessCategory?: string;
  businessSubcategory?: string;
  customCategoryTemplateSlug?: string;
  customCategoryName?: string;
  schemaOverrides?: {
    attributes?: SchemaAttributeOverride[];
    orderAttributes?: SchemaAttributeOverride[];
  };
  planSlug?: string;
  /**
   * Audience profile captured in the new audience step. Persists onto
   * `tenant.settings.audienceProfile` during finalize so the agent's
   * Reasoning_Context can read it on every turn.
   */
  audienceProfile?: {
    targetAudience?: string[];
    defaultAddress?: string;
    allowedAddresses?: string[];
  };
}

export interface OnboardingState {
  lastCompletedStep: OnboardingStep | null;
  payload: OnboardingPayload;
}

/**
 * Built-in schema preview returned by `GET /api/v1/onboarding/built-in-schemas`.
 * The wizard renders these as one-line descriptions in the category picker
 * and as the starting attribute list in the preferences step.
 */
export interface BuiltInSchemaPreview {
  slug: string;
  displayName: string;
  attributes: SchemaAttribute[];
  orderAttributes: SchemaAttribute[];
  dashboardModules: string[];
}

/**
 * Subset of `AttributeField` consumed by the wizard. The server ships the
 * full shape; we keep the types narrow because the wizard only renders
 * `key`, `label`, `type`, `required`, and the unit/enum hints needed to
 * describe the field. Anything else (validation, customer-visibility) is
 * applied server-side.
 */
export interface SchemaAttribute {
  key: string;
  label: string;
  type: string;
  required: boolean;
  unit?: string;
  enumValues?: string[];
  customerVisible?: boolean;
}

/**
 * The shape captured in `schemaOverrides`. Tenants can:
 *  - rename a built-in field by changing `label`
 *  - drop a built-in field by setting `enabled=false`
 *  - add a brand-new field (`origin: 'custom'`)
 *
 * `key` is preserved across renames so historical data tied to the same
 * key keeps validating. New custom fields default to `string` type — a
 * future task can expose a richer field-type picker.
 */
export interface SchemaAttributeOverride {
  key: string;
  label: string;
  type: string;
  required: boolean;
  unit?: string;
  enumValues?: string[];
  enabled: boolean;
  origin: "builtin" | "custom";
}

/** Every category the wizard offers in step 2 (R1.3). `custom` is last. */
export const CATEGORIES: ReadonlyArray<{ slug: string; displayName: string }> = [
  { slug: "jersey", displayName: "Jersey" },
  { slug: "clothing", displayName: "Clothing" },
  { slug: "undergarments", displayName: "Undergarments" },
  { slug: "shoes", displayName: "Shoes" },
  { slug: "cosmetics", displayName: "Cosmetics" },
  { slug: "electronics", displayName: "Electronics" },
  { slug: "restaurant", displayName: "Restaurant" },
  { slug: "grocery", displayName: "Grocery" },
  { slug: "jewelry", displayName: "Jewelry" },
  { slug: "furniture", displayName: "Furniture" },
  { slug: "pet_shop", displayName: "Pet shop" },
  { slug: "pharmacy", displayName: "Pharmacy" },
  { slug: "mobile_accessories", displayName: "Mobile accessories" },
  { slug: "custom", displayName: "Custom" },
];

/** Plan picker options on the preferences step. `starter` is the default. */
export const PLAN_OPTIONS: ReadonlyArray<{ slug: string; displayName: string; description: string }> = [
  {
    slug: "starter",
    displayName: "Starter",
    description: "14-day trial. Up to 2k messages, 50 products, 1 social account.",
  },
  {
    slug: "pro",
    displayName: "Pro",
    description: "20k messages, 500 products, 3 social accounts, AI posting.",
  },
  {
    slug: "agency",
    displayName: "Agency",
    description: "100k messages, 5000 products, 10 social accounts, automation rules.",
  },
];
