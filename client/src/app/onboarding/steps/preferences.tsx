"use client";

/**
 * Schema-preferences step (Multi-Tenant Commerce OS, task 11.2 part B, R1.5).
 *
 * Loads the chosen schema's default `attributes` and `orderAttributes` and
 * lets the operator:
 *   - toggle each field on/off
 *   - rename a field's display label
 *   - add custom fields (string only — richer field-type pickers come later)
 *
 * The result is stored on `payload.schemaOverrides` so the finalize step
 * can persist it through `POST /api/v1/onboarding/finalize`. The finalize
 * service applies these overrides only when the operator picked `custom`
 * (R1.4); for predefined categories the link to the built-in schema is
 * direct, but capturing the preferences keeps the wizard consistent and
 * gives us a place to expose tenant-specific schema clones in the future.
 *
 * Plan picker: defaults to `starter`. The plan options come from the
 * shared `PLAN_OPTIONS` const so the labels match the seeded plans.
 */

import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  PLAN_OPTIONS,
  type BuiltInSchemaPreview,
  type OnboardingPayload,
  type SchemaAttribute,
  type SchemaAttributeOverride,
} from "../types";

export function PreferencesStep({
  schemas,
  payload,
  onBack,
  onNext,
}: {
  schemas: BuiltInSchemaPreview[];
  payload: OnboardingPayload;
  onBack: () => void;
  onNext: (slice: Partial<OnboardingPayload>) => Promise<void> | void;
}) {
  // Resolve the chosen template:
  //   - predefined category → schema for that slug
  //   - custom              → schema for `customCategoryTemplateSlug`
  const templateSlug = useMemo(() => {
    if (payload.businessCategory && payload.businessCategory !== "custom") {
      return payload.businessCategory;
    }
    return payload.customCategoryTemplateSlug ?? null;
  }, [payload.businessCategory, payload.customCategoryTemplateSlug]);

  const sourceSchema = useMemo(() => {
    if (!templateSlug) return null;
    return schemas.find((s) => s.slug === templateSlug) ?? null;
  }, [schemas, templateSlug]);

  const [attributes, setAttributes] = useState<SchemaAttributeOverride[]>(() =>
    initOverrides(payload.schemaOverrides?.attributes, sourceSchema?.attributes),
  );
  const [orderAttributes, setOrderAttributes] = useState<SchemaAttributeOverride[]>(
    () =>
      initOverrides(
        payload.schemaOverrides?.orderAttributes,
        sourceSchema?.orderAttributes,
      ),
  );
  const [planSlug, setPlanSlug] = useState(payload.planSlug ?? "starter");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // If the user backtracks and changes the chosen template, re-seed the
  // override lists from the new template — but only when there were no
  // user edits yet (overrides empty in the wizard payload). This prevents
  // a returning operator from losing their renames just because they
  // re-opened this step.
  useEffect(() => {
    if (!sourceSchema) return;
    if (
      !payload.schemaOverrides?.attributes &&
      !payload.schemaOverrides?.orderAttributes
    ) {
      setAttributes(initOverrides(undefined, sourceSchema.attributes));
      setOrderAttributes(initOverrides(undefined, sourceSchema.orderAttributes));
    }
    // We deliberately only run on schema slug change, not on every
    // payload mutation — the wizard owns payload, this effect just reacts
    // to the template choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSchema?.slug]);

  function addCustomAttribute(target: "product" | "order") {
    const blank: SchemaAttributeOverride = {
      key: `custom_${Date.now().toString(36)}`,
      label: "New field",
      type: "string",
      required: false,
      enabled: true,
      origin: "custom",
    };
    if (target === "product") {
      setAttributes((prev) => [...prev, blank]);
    } else {
      setOrderAttributes((prev) => [...prev, blank]);
    }
  }

  async function handleSubmit() {
    setErr(null);
    setPending(true);
    try {
      // Drop any custom row whose label was wiped out — it's an obvious
      // user error rather than an intentional empty field.
      const filteredAttrs = attributes.filter(
        (a) => a.origin === "builtin" || a.label.trim().length > 0,
      );
      const filteredOrderAttrs = orderAttributes.filter(
        (a) => a.origin === "builtin" || a.label.trim().length > 0,
      );

      const slice: Partial<OnboardingPayload> = {
        planSlug,
        schemaOverrides: {
          attributes: filteredAttrs,
          orderAttributes: filteredOrderAttrs,
        },
      };
      await onNext(slice);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold text-white">
          Configure your fields
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          {sourceSchema ? (
            <>
              Starting from the{" "}
              <span className="text-slate-200">{sourceSchema.displayName}</span>{" "}
              template. Toggle fields off, rename them, or add your own.
            </>
          ) : (
            <>Pick a category before configuring fields.</>
          )}
        </p>
      </div>

      <FieldGroup
        title="Product fields"
        description="What you describe about each product."
        rows={attributes}
        onChange={setAttributes}
        onAdd={() => addCustomAttribute("product")}
      />

      <FieldGroup
        title="Order fields"
        description="What customers tell you when they order."
        rows={orderAttributes}
        onChange={setOrderAttributes}
        onAdd={() => addCustomAttribute("order")}
      />

      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
          Starting plan
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {PLAN_OPTIONS.map((p) => {
            const active = planSlug === p.slug;
            return (
              <button
                key={p.slug}
                type="button"
                onClick={() => setPlanSlug(p.slug)}
                className={`rounded-xl border px-3 py-3 text-left transition ${
                  active
                    ? "border-accent/60 bg-accent/10"
                    : "border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
                }`}
              >
                <p
                  className={`text-sm font-semibold ${
                    active ? "text-white" : "text-slate-200"
                  }`}
                >
                  {p.displayName}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  {p.description}
                </p>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-slate-600">
          You start on a 14-day trial. You can change plans later from Settings.
        </p>
      </div>

      {err && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {err}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack} disabled={pending}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={handleSubmit} disabled={pending} className="min-w-[10rem] py-2.5">
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Saving…
            </>
          ) : (
            <>
              Continue <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Build the editable override list for a step. If the operator already
 * customised the schema in a previous wizard run, we hydrate from that
 * snapshot; otherwise we mirror the source schema verbatim (`enabled=true`,
 * matching label + type + flags).
 */
function initOverrides(
  prior: SchemaAttributeOverride[] | undefined,
  source: SchemaAttribute[] | undefined,
): SchemaAttributeOverride[] {
  if (Array.isArray(prior) && prior.length > 0) {
    return prior.map((p) => ({ ...p }));
  }
  if (!source) return [];
  return source.map((a) => ({
    key: a.key,
    label: a.label,
    type: a.type,
    required: a.required,
    enabled: true,
    origin: "builtin",
    ...(a.unit ? { unit: a.unit } : {}),
    ...(a.enumValues ? { enumValues: [...a.enumValues] } : {}),
  }));
}

function FieldGroup({
  title,
  description,
  rows,
  onChange,
  onAdd,
}: {
  title: string;
  description: string;
  rows: SchemaAttributeOverride[];
  onChange: (next: SchemaAttributeOverride[]) => void;
  onAdd: () => void;
}) {
  function update(index: number, patch: Partial<SchemaAttributeOverride>) {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">{title}</p>
          <p className="text-[11px] text-slate-500">{description}</p>
        </div>
        <Button
          variant="secondary"
          onClick={onAdd}
          className="px-3 py-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" /> Add custom
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-white/[0.05] bg-black/30 px-3 py-4 text-center text-[11px] text-slate-500">
          No fields yet. Add a custom field to start.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, idx) => (
            <li
              key={`${row.key}-${idx}`}
              className={`grid grid-cols-[auto,1fr,auto,auto] items-center gap-2 rounded-lg border px-3 py-2 ${
                row.enabled
                  ? "border-white/[0.08] bg-black/30"
                  : "border-white/[0.04] bg-black/20 opacity-60"
              }`}
            >
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(e) => update(idx, { enabled: e.target.checked })}
                className="h-4 w-4 cursor-pointer accent-indigo-400"
                aria-label={`Enable ${row.label}`}
              />
              <input
                type="text"
                value={row.label}
                onChange={(e) => update(idx, { label: e.target.value })}
                placeholder="Field label"
                maxLength={80}
                className="rounded-md border border-white/[0.07] bg-black/40 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none"
              />
              <span className="text-[10px] font-mono uppercase tracking-wide text-slate-500">
                {row.type}
                {row.required ? " · required" : ""}
              </span>
              {row.origin === "custom" ? (
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  className="rounded-md p-1.5 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300"
                  aria-label="Remove custom field"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : (
                <span className="rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-600">
                  built-in
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
