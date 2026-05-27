"use client";

/**
 * DynamicForm renders a category-schema attribute array as a form.
 *
 * The same component is used for product forms (`categorySchema.attributes`),
 * variant forms (`variantAttributes`), order forms (`orderAttributes`), and
 * filter forms (`filterAttributes`) — see R9.1. The caller is responsible
 * for fetching the appropriate field array; this component does not load
 * the schema and does not cache it (R9.6 — schema changes take effect on
 * the next page load because the parent simply re-renders with new fields).
 *
 * Submission flow (R9.3):
 *  1. The user clicks the submit button.
 *  2. Client-side validation runs `validateValues(fields, values)`. Required
 *     fields must be non-empty, numeric `min`/`max` is honored, and enum
 *     values must be members of `enumValues`.
 *  3. If any errors are returned, they are rendered inline on the offending
 *     fields and `onSubmit` is NOT invoked.
 *  4. Otherwise `onSubmit(values)` fires. The backend remains the source of
 *     truth — it re-validates through `categoryEngine.validateProductAttributes`
 *     or `validateOrderAttributes` (R3.4, R8.2).
 *
 * The form is fully controlled — `values` and `onChange` come from the
 * parent. Errors are kept in component state because they are derived
 * purely from the most recent submission attempt against the current
 * fields and don't need to outlive the form.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DynamicField } from "./DynamicField";
import type { AttributeField, ValidationError } from "./types";
import { validateValues } from "./validate";

export interface DynamicFormProps {
  /** Attribute declarations from the active category schema. */
  fields: AttributeField[];
  /** Current form values, keyed by `field.key`. */
  values: Record<string, unknown>;
  /** Called whenever a field value changes. */
  onChange: (values: Record<string, unknown>) => void;
  /** Called with the values when client-side validation passes. */
  onSubmit: (values: Record<string, unknown>) => void;
  /** Submit button label. Defaults to "Save". */
  submitLabel?: string;
  /** Disables every control, including the submit button. */
  disabled?: boolean;
}

function formatError(err: ValidationError): string {
  if (err.detail) return err.detail;
  switch (err.code) {
    case "missing_required":
      return "This field is required";
    case "type_mismatch":
      return "Invalid value";
    case "enum_violation":
      return "Pick a value from the list";
    case "min_violation":
      return "Below minimum";
    case "max_violation":
      return "Above maximum";
    default:
      return "Invalid value";
  }
}

export function DynamicForm({
  fields,
  values,
  onChange,
  onSubmit,
  submitLabel = "Save",
  disabled = false,
}: DynamicFormProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  function setFieldValue(key: string, next: unknown) {
    onChange({ ...values, [key]: next });
    // Clear any stale error for the field the user is editing so they get
    // immediate feedback that the form noticed the change.
    if (errors[key]) {
      setErrors((prev) => {
        const { [key]: _removed, ...rest } = prev;
        void _removed;
        return rest;
      });
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    const validationErrors = validateValues(fields, values);
    if (validationErrors.length > 0) {
      const map: Record<string, string> = {};
      for (const err of validationErrors) {
        // First error per field wins.
        if (!map[err.key]) map[err.key] = formatError(err);
      }
      setErrors(map);
      return;
    }
    setErrors({});
    onSubmit(values);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {fields.length === 0 ? (
        <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm text-slate-400">
          No fields configured for this section.
        </p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {fields.map((field) => (
            <DynamicField
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={(next) => setFieldValue(field.key, next)}
              disabled={disabled}
              error={errors[field.key]}
            />
          ))}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={disabled || fields.length === 0}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
