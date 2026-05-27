"use client";

/**
 * Custom-category step (Multi-Tenant Commerce OS, task 11.2 part B, R1.4).
 *
 * Active when the operator picked `custom` in the category-select step.
 * Captures:
 *   - free-text category name (required)
 *   - optional subcategory
 *   - the closest built-in template to clone (required, sourced from the
 *     wizard-loaded `BuiltInSchemaPreview[]` list)
 *
 * Submits `customCategoryName`, `businessSubcategory`, and
 * `customCategoryTemplateSlug` so the finalize step has everything the
 * onboarding service needs to clone the chosen built-in into a tenant-
 * scoped CategorySchema row.
 */

import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  BuiltInSchemaPreview,
  OnboardingPayload,
} from "../types";

export function CustomCategoryStep({
  schemas,
  value,
  onBack,
  onNext,
}: {
  schemas: BuiltInSchemaPreview[];
  value: OnboardingPayload;
  onBack: () => void;
  onNext: (slice: Partial<OnboardingPayload>) => Promise<void> | void;
}) {
  const [name, setName] = useState(value.customCategoryName ?? "");
  const [subcategory, setSubcategory] = useState(value.businessSubcategory ?? "");
  const [templateSlug, setTemplateSlug] = useState(
    value.customCategoryTemplateSlug ?? "",
  );
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Hide `custom` from the template options — we're cloning a built-in
  // here, and the custom JSON file has empty attribute lists.
  const templateOptions = useMemo(
    () => schemas.filter((s) => s.slug !== "custom"),
    [schemas],
  );

  async function handleSubmit() {
    setErr(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr("Category name is required.");
      return;
    }
    if (!templateSlug) {
      setErr("Pick the closest built-in template to clone.");
      return;
    }
    setPending(true);
    try {
      const slice: Partial<OnboardingPayload> = {
        customCategoryName: trimmedName,
        customCategoryTemplateSlug: templateSlug,
      };
      const trimmedSub = subcategory.trim();
      if (trimmedSub) {
        slice.businessSubcategory = trimmedSub;
      }
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
          Tell us about your business
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          We&apos;ll start with a built-in template and clone it for your tenant.
          You can rename, disable, or add fields in the next step.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Category name <span className="text-rose-400">*</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            type="text"
            placeholder="e.g. Pet Spa, Bookstore, Bike Workshop"
            maxLength={120}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
            required
          />
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Subcategory <span className="text-slate-600">(optional)</span>
          </label>
          <input
            value={subcategory}
            onChange={(e) => setSubcategory(e.target.value)}
            type="text"
            placeholder="e.g. Cat care, Programming books"
            maxLength={120}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Closest template <span className="text-rose-400">*</span>
          </label>
          <select
            value={templateSlug}
            onChange={(e) => setTemplateSlug(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-100 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
            required
          >
            <option value="" disabled>
              Pick a built-in to start from
            </option>
            {templateOptions.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.displayName}
              </option>
            ))}
          </select>
          {templateSlug && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              You&apos;ll be able to edit the cloned schema in the next step. The
              original built-in stays untouched for other tenants.
            </p>
          )}
        </div>
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
