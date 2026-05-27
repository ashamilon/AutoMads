/**
 * Public surface of the Dynamic Form Builder.
 *
 * Consumers (Next admin pages, dashboard module renderers) import from
 * `@/components/forms` rather than reaching into individual files so the
 * implementation can evolve without breaking call sites.
 */

export { DynamicForm } from "./DynamicForm";
export type { DynamicFormProps } from "./DynamicForm";

export { DynamicField } from "./DynamicField";
export type { DynamicFieldProps } from "./DynamicField";

export type {
  AttributeField,
  AttributeFieldType,
  ValidationCode,
  ValidationError,
} from "./types";

export { validateValues } from "./validate";
