/**
 * Client-side validation for Dynamic Form Builder submissions (R9.3).
 *
 * The authoritative validator runs on the backend
 * (`categoryEngine.validateProductAttributes` /
 * `validateOrderAttributes`). The client mirror exists only to short-circuit
 * obviously-bad submissions before a network round-trip and to render
 * inline error messages. Backend validation is still required and remains
 * the source of truth.
 *
 * Rules implemented:
 *  - `required=true` fields must be non-empty (empty string, null, undefined,
 *    or empty array all count as missing).
 *  - `number` and `currency` values must parse as finite numbers and honor
 *    `min` / `max` when declared.
 *  - `enum` values must be one of `enumValues`.
 *  - `multi_enum` values must be an array whose entries are all in
 *    `enumValues`.
 *  - Other types are pass-through (string, boolean, date, image_ref) — the
 *    backend validator does the deep type check.
 */

import type { AttributeField, ValidationError } from "./types";

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function validateField(field: AttributeField, value: unknown): ValidationError | null {
  if (isMissing(value)) {
    if (field.required) {
      return { key: field.key, code: "missing_required" };
    }
    // Optional and empty — skip the rest of the checks.
    return null;
  }

  switch (field.type) {
    case "number":
    case "currency": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) {
        return { key: field.key, code: "type_mismatch", detail: "Expected a number" };
      }
      if (typeof field.min === "number" && n < field.min) {
        return {
          key: field.key,
          code: "min_violation",
          detail: `Must be at least ${field.min}`,
        };
      }
      if (typeof field.max === "number" && n > field.max) {
        return {
          key: field.key,
          code: "max_violation",
          detail: `Must be at most ${field.max}`,
        };
      }
      return null;
    }
    case "enum": {
      const allowed = field.enumValues ?? [];
      if (typeof value !== "string" || !allowed.includes(value)) {
        return { key: field.key, code: "enum_violation" };
      }
      return null;
    }
    case "multi_enum": {
      const allowed = field.enumValues ?? [];
      if (!Array.isArray(value)) {
        return { key: field.key, code: "type_mismatch", detail: "Expected an array" };
      }
      for (const entry of value) {
        if (typeof entry !== "string" || !allowed.includes(entry)) {
          return { key: field.key, code: "enum_violation" };
        }
      }
      return null;
    }
    case "boolean":
      if (typeof value !== "boolean") {
        return { key: field.key, code: "type_mismatch", detail: "Expected a boolean" };
      }
      return null;
    case "string":
    case "date":
    case "image_ref":
      if (typeof value !== "string") {
        return { key: field.key, code: "type_mismatch", detail: "Expected a string" };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Validate the full set of values against the provided field declarations.
 * Returns one error per failing field; an empty array means the form is
 * ready to submit.
 */
export function validateValues(
  fields: AttributeField[],
  values: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const field of fields) {
    const err = validateField(field, values[field.key]);
    if (err) errors.push(err);
  }
  return errors;
}
