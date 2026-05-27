/**
 * Category Engine type definitions.
 *
 * These types are the in-memory shape of a {@link CategorySchema} as loaded
 * from either a built-in JSON file under `./schemas/` or from the
 * `CategorySchema` Prisma table for tenant-cloned customizations.
 *
 * The shapes mirror the design document (Multi-Tenant Commerce OS, Category
 * Engine section). Consumers (agent loop, tools, prompt builder, reply filter,
 * dashboard module registry, dynamic form builder, order pipeline) read these
 * structures through {@link ../categoryEngine/index} rather than reaching into
 * the raw JSON or DB row.
 */

/**
 * Identifier for a dashboard module (e.g. `size_chart`, `menu_manager`,
 * `product_grid`). The dashboard registry on the client side owns the
 * authoritative enumeration of supported module IDs; the engine treats this
 * value as a free-form string so new modules can be introduced without
 * coordinating a backend release.
 */
export type DashboardModuleId = string;

/**
 * The set of attribute field types supported by the Category Engine. Mirrors
 * the design's `AttributeField.type` union and is consumed by both the
 * dynamic form builder and the validators in
 * `validateProductAttributes`/`validateOrderAttributes`.
 */
export type AttributeFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'multi_enum'
  | 'date'
  | 'currency'
  | 'image_ref';

/**
 * Declares a single attribute (product, variant, order, or filter) on a
 * {@link CategorySchema}. The combination of `key`, `type`, and the
 * type-specific options (`enumValues`, `min`, `max`, `unit`) drives both
 * validation and rendering.
 */
export interface AttributeField {
  /** Stable machine key (e.g. `chest`, `spice_level`, `shoe_size`). */
  key: string;
  /** Human-readable label used by the form builder. */
  label: string;
  /** Field type used for validation and rendering. */
  type: AttributeFieldType;
  /** When `true`, validators reject submissions missing this key. */
  required: boolean;
  /**
   * When `true`, the field's value (translated through
   * `categorySchema.terminology`) is included in customer-facing AI replies
   * and product detail panels. See R8.4.
   */
  customerVisible: boolean;
  /** Allowed values for `enum`/`multi_enum` types. */
  enumValues?: string[];
  /** Minimum value for `number`/`currency` types. */
  min?: number;
  /** Maximum value for `number`/`currency` types. */
  max?: number;
  /** Display unit (e.g. `cm`, `BDT`, `min`, `months`). */
  unit?: string;
}

/**
 * Category-specific reasoning hints surfaced on `Reasoning_Context`.
 * Tools and the prompt builder read these to specialize behavior
 * (e.g. recommend by team for jersey, require a delivery estimate for
 * restaurant orders, run a compatibility check for electronics).
 */
export interface WorkflowRules {
  /** Hints the intent classifier consults to bias category-specific intents. */
  intentHints?: string[];
  /** Strategy slug for the recommendation engine (e.g. `team_first`). */
  recommendationStrategy?: string;
  /** When `true`, order flows must surface a delivery time estimate. */
  requiresDeliveryEstimate?: boolean;
  /** When `true`, the agent must run a compatibility check before checkout. */
  compatibilityCheckRequired?: boolean;
  /** Open-ended bag for category-specific overrides not yet promoted. */
  customRules?: Record<string, unknown>;
}

/**
 * Validation error returned by `validateProductAttributes` and
 * `validateOrderAttributes`. The `code` enumeration is stable and consumed by
 * UI surfaces to render localized messages.
 */
export interface ValidationError {
  /** The attribute key that failed validation. */
  key: string;
  /** Stable machine code identifying the failure mode. */
  code: 'unknown_key' | 'missing_required' | 'type_mismatch' | 'enum_violation';
  /** Optional human-readable detail. */
  detail?: string;
}

/**
 * Minimal local mirror of `AgentIdentity` used by category schemas to
 * declare per-category defaults (e.g. cosmetics defaults to a softer tone).
 *
 * Kept local to avoid a circular import with the future
 * `../identity/agentIdentityService` module. The service-side definition is
 * the authoritative one; this interface only exists so JSON schemas can carry
 * partial overrides via {@link CategorySchema.agentIdentityDefaults}.
 */
export interface AgentIdentityShape {
  name: string;
  role: string;
  personality: string;
  tone: string;
  language: string;
  salesStyle: string;
  greetingStyle: string;
}

/**
 * The runtime shape of a category schema, identical between built-in JSON
 * files and the resolved Prisma row. The `id` is omitted on built-ins until
 * the schema loader assigns the synthetic id `<slug>-builtin`.
 */
export interface CategorySchema {
  /** Stable id. `<slug>-builtin` for built-ins, cuid() for tenant clones. */
  id: string;
  /** Category slug (e.g. `jersey`, `restaurant`, `custom`). */
  slug: string;
  /** Schema version, bumped on every tenant edit. */
  version: number;
  /** Product-level attributes (chest, fabric, model, ...). */
  attributes: AttributeField[];
  /** Variant-level attributes (size, color, ...). */
  variantAttributes: AttributeField[];
  /** Order-time attributes (delivery_notes, gift_wrap, prescription_image, ...). */
  orderAttributes: AttributeField[];
  /** Filter-time attributes used by dashboard search/filter widgets. */
  filterAttributes: AttributeField[];
  /**
   * Internal-term -> customer-facing-Banglish-term map (e.g.
   * `catalog -> 'product list'`, `cart -> 'order list'`). Applied by the
   * Reply Filter terminology pre-pass before any reply leaves the system.
   */
  terminology: Record<string, string>;
  /** Dashboard module IDs to render, in declared order. */
  dashboardModules: DashboardModuleId[];
  /** Category-specific reasoning hints. */
  workflowRules: WorkflowRules;
  /** Prompt fragments appended after the persona section, in declared order. */
  promptFragments: string[];
  /** `true` for the JSON-shipped built-ins; `false` for tenant clones. */
  isBuiltIn: boolean;
  /** `null` for built-ins; the tenant id for tenant-cloned customizations. */
  tenantId: string | null;
  /**
   * Optional per-category Agent_Identity defaults merged into the resolution
   * chain by `agentIdentityService.resolve` between platform defaults and
   * per-tenant overrides. See R5.4.
   */
  agentIdentityDefaults?: Partial<AgentIdentityShape>;
}
