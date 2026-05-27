/**
 * Client-side mirror of the Category Engine's `AttributeField` shape.
 *
 * The authoritative type lives at `src/agent/categoryEngine/types.ts` in the
 * Node backend. The Next.js client uses its own `tsconfig` (under `client/`)
 * with bundler module resolution and does not compile sources outside
 * `client/`, so we re-declare a thin, structurally compatible mirror here
 * rather than reach across the project boundary. Keeping the shapes aligned
 * is enforced by review — both files document this duplication.
 *
 * Consumers (DynamicForm, DynamicField, dashboard module renderers) read
 * arrays of `AttributeField` from `categorySchema.attributes`,
 * `variantAttributes`, `orderAttributes`, or `filterAttributes` returned by
 * the backend and render them through the form builder. Nothing here
 * persists state or caches the schema — see R9.6, schema changes take
 * effect on the next page load.
 */

/** Field types supported by the dynamic form builder (R9.2). */
export type AttributeFieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "multi_enum"
  | "date"
  | "currency"
  | "image_ref";

/**
 * Declarative description of a single form field on a category schema. The
 * tuple `(key, type, required, enumValues?, min?, max?)` drives both
 * rendering and client-side validation.
 */
export interface AttributeField {
  /** Stable machine key (e.g. `chest`, `spice_level`, `shoe_size`). */
  key: string;
  /** Human-readable label rendered next to the input. */
  label: string;
  /** Field type used for rendering and validation. */
  type: AttributeFieldType;
  /** When `true`, the form requires a non-empty value before submit (R9.3). */
  required: boolean;
  /**
   * When `true`, the field's value (translated through
   * `categorySchema.terminology` server-side) is exposed in customer-facing
   * AI replies. The form renders a "Customer-visible" badge so the operator
   * is aware (R9.4).
   */
  customerVisible: boolean;
  /** Allowed values for `enum` / `multi_enum` fields. */
  enumValues?: string[];
  /** Minimum value for `number` / `currency` fields. */
  min?: number;
  /** Maximum value for `number` / `currency` fields. */
  max?: number;
  /** Display unit (e.g. `cm`, `BDT`, `min`, `months`). */
  unit?: string;
}

/** Stable error codes raised by client-side validation. */
export type ValidationCode =
  | "missing_required"
  | "type_mismatch"
  | "enum_violation"
  | "min_violation"
  | "max_violation";

/** Per-field validation error surfaced to the form. */
export interface ValidationError {
  key: string;
  code: ValidationCode;
  detail?: string;
}
