"use client";

/**
 * DynamicField renders a single category-schema attribute as an input.
 *
 * Each `AttributeField.type` maps to a concrete control:
 *  - `string`  → text input
 *  - `number` / `currency` → number input (currency adds a unit suffix, default `BDT`)
 *  - `boolean` → checkbox
 *  - `enum`    → native select using `enumValues`
 *  - `multi_enum` → multi-select checkbox grid using `enumValues`
 *  - `date`    → date input
 *  - `image_ref` → URL input plus a thumbnail preview when the value parses
 *    as an `http(s)` URL. Cloudinary upload integration is out of scope at
 *    this layer (the URL is provided by an upstream uploader).
 *
 * The component is fully controlled — it never holds a copy of the value in
 * local state, which means schema changes propagate cleanly when the parent
 * re-renders with new `field`/`value` props (R9.6, no caching beyond a
 * single render).
 *
 * R9.3: when `field.required` is `true`, an asterisk indicator is rendered
 * next to the label. The actual required check happens in
 * `DynamicForm.handleSubmit` and again on the backend via
 * `validateProductAttributes` / `validateOrderAttributes`.
 *
 * R9.4: when `field.customerVisible` is `true`, a small "Customer-visible"
 * badge is rendered so the operator knows the field will be exposed in AI
 * replies (translated through `categorySchema.terminology` server-side).
 */

import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AttributeField } from "./types";

const inputCls =
  "w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm font-medium text-slate-100 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30";

export interface DynamicFieldProps {
  field: AttributeField;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Disables every control while the parent form is submitting. */
  disabled?: boolean;
  /** Inline validation error for this field, if any. */
  error?: string;
}

function isLikelyUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^https?:\/\//i.test(value.trim());
}

export function DynamicField({ field, value, onChange, disabled, error }: DynamicFieldProps) {
  const inputId = useId();
  const describedBy = error ? `${inputId}-error` : undefined;
  const numericUnit = field.unit ?? (field.type === "currency" ? "BDT" : "");

  function renderControl() {
    switch (field.type) {
      case "string":
        return (
          <input
            id={inputId}
            type="text"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            aria-required={field.required}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            className={inputCls}
          />
        );

      case "number":
      case "currency": {
        const numericValue =
          value === undefined || value === null || value === ""
            ? ""
            : typeof value === "number"
              ? value
              : Number(value);
        return (
          <div className="relative">
            <input
              id={inputId}
              type="number"
              value={Number.isNaN(numericValue) ? "" : numericValue}
              min={field.min}
              max={field.max}
              onChange={(e) =>
                onChange(e.target.value === "" ? undefined : Number(e.target.value))
              }
              disabled={disabled}
              aria-required={field.required}
              aria-invalid={Boolean(error)}
              aria-describedby={describedBy}
              className={cn(inputCls, numericUnit && "pr-16")}
            />
            {numericUnit && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                {numericUnit}
              </span>
            )}
          </div>
        );
      }

      case "boolean":
        return (
          <label
            htmlFor={inputId}
            className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-200"
          >
            <input
              id={inputId}
              type="checkbox"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
              disabled={disabled}
              aria-describedby={describedBy}
              className="h-4 w-4 rounded border border-white/15 bg-black/40 accent-indigo-500"
            />
            <span className="text-xs text-slate-400">Enabled</span>
          </label>
        );

      case "enum": {
        const enumValues = field.enumValues ?? [];
        return (
          <select
            id={inputId}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
            disabled={disabled}
            aria-required={field.required}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            className={inputCls}
          >
            <option value="">Select…</option>
            {enumValues.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        );
      }

      case "multi_enum": {
        const enumValues = field.enumValues ?? [];
        const selected = Array.isArray(value) ? (value as unknown[]) : [];
        return (
          <div
            id={inputId}
            role="group"
            aria-required={field.required}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            className="grid gap-2 rounded-xl border border-white/[0.08] bg-black/20 p-3 sm:grid-cols-2"
          >
            {enumValues.map((option) => {
              const checked = selected.includes(option);
              return (
                <label
                  key={option}
                  className="flex cursor-pointer items-center gap-2 text-sm text-slate-200"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selected.filter((v) => v !== option), option]
                        : selected.filter((v) => v !== option);
                      onChange(next);
                    }}
                    disabled={disabled}
                    className="h-4 w-4 rounded border border-white/15 bg-black/40 accent-indigo-500"
                  />
                  <span>{option}</span>
                </label>
              );
            })}
            {enumValues.length === 0 && (
              <p className="text-xs text-slate-500">No options defined for this field.</p>
            )}
          </div>
        );
      }

      case "date":
        return (
          <input
            id={inputId}
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            aria-required={field.required}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            className={inputCls}
          />
        );

      case "image_ref": {
        const stringValue = typeof value === "string" ? value : "";
        return (
          <div className="space-y-2">
            <input
              id={inputId}
              type="url"
              value={stringValue}
              onChange={(e) => onChange(e.target.value)}
              placeholder="https://…"
              disabled={disabled}
              aria-required={field.required}
              aria-invalid={Boolean(error)}
              aria-describedby={describedBy}
              className={inputCls}
            />
            {isLikelyUrl(stringValue) && (
              <div className="overflow-hidden rounded-lg border border-white/[0.08] bg-black/20 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={stringValue}
                  alt={`${field.label} preview`}
                  className="h-24 w-24 rounded-md object-cover"
                  onError={(e) => {
                    // Hide the broken-image icon if the URL doesn't resolve.
                    (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                  }}
                />
              </div>
            )}
          </div>
        );
      }

      default:
        return null;
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className="block text-xs font-semibold uppercase tracking-wide text-slate-400"
        >
          {field.label}
          {field.required && (
            <span aria-hidden="true" className="ml-1 text-rose-400">
              *
            </span>
          )}
          {field.required && <span className="sr-only"> (required)</span>}
        </label>
        {field.customerVisible && (
          <Badge tone="info" className="normal-case tracking-normal">
            Customer-visible
          </Badge>
        )}
      </div>
      {renderControl()}
      {error && (
        <p id={`${inputId}-error`} className="text-[11px] text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
