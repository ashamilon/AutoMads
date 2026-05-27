"use client";

/**
 * Finalize step (Multi-Tenant Commerce OS, task 11.2 part B, R1.6).
 *
 * Confirmation screen. Renders a summary of every answer the operator
 * gave so far and exposes the "Finish setup" button which calls
 * `POST /api/v1/onboarding/finalize` (via the parent's `onSubmit`). On
 * success the parent refreshes the tenant context (so
 * `onboardingCompletedAt` becomes non-null and the middleware lets the
 * portal load) and redirects to `/portal`.
 *
 * Error handling: the server returns structured `{ error: <code> }` JSON.
 * We translate the most common codes into a friendly hint without
 * revealing internal status names.
 */

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { ArrowLeft, CheckCircle2, Loader2, Rocket } from "lucide-react";
import { useState } from "react";

import { CATEGORIES, PLAN_OPTIONS, type BuiltInSchemaPreview, type OnboardingPayload } from "../types";

export function FinalizeStep({
  schemas,
  payload,
  tenantName,
  onBack,
  onSubmit,
}: {
  schemas: BuiltInSchemaPreview[];
  payload: OnboardingPayload;
  tenantName: string;
  onBack: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const categoryLabel = labelForCategory(payload, schemas);
  const planLabel = labelForPlan(payload.planSlug ?? "starter");
  const enabledAttrCount = (payload.schemaOverrides?.attributes ?? []).filter(
    (a) => a.enabled,
  ).length;
  const enabledOrderCount = (payload.schemaOverrides?.orderAttributes ?? []).filter(
    (a) => a.enabled,
  ).length;

  async function handleFinalize() {
    setErr(null);
    setPending(true);
    try {
      await onSubmit();
    } catch (e) {
      setErr(translateFinalizeError(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
          <CheckCircle2 className="h-3.5 w-3.5" /> Almost there
        </div>
        <h1 className="font-display text-xl font-bold text-white">
          Confirm your setup
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          We&apos;ll save these and start your 14-day trial. You can change every
          one of these later from Settings.
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-2">
        <SummaryRow label="Workspace" value={tenantName} />
        <SummaryRow label="Category" value={categoryLabel} />
        {payload.businessSubcategory && (
          <SummaryRow label="Subcategory" value={payload.businessSubcategory} />
        )}
        {payload.businessCategory === "custom" && payload.customCategoryName && (
          <SummaryRow
            label="Custom name"
            value={payload.customCategoryName}
          />
        )}
        {payload.businessCategory === "custom" && payload.customCategoryTemplateSlug && (
          <SummaryRow
            label="Template"
            value={
              schemas.find((s) => s.slug === payload.customCategoryTemplateSlug)
                ?.displayName ?? payload.customCategoryTemplateSlug
            }
          />
        )}
        <SummaryRow
          label="Product fields"
          value={`${enabledAttrCount} enabled`}
        />
        <SummaryRow
          label="Order fields"
          value={`${enabledOrderCount} enabled`}
        />
        <SummaryRow label="Plan" value={`${planLabel} · 14-day trial`} />
      </dl>

      {err && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {err}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack} disabled={pending}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={handleFinalize} disabled={pending} className="min-w-[12rem] py-2.5">
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Setting up…
            </>
          ) : (
            <>
              <Rocket className="h-4 w-4" /> Finish setup
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2.5">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="truncate text-right text-sm font-medium text-slate-200">
        {value}
      </dd>
    </div>
  );
}

function labelForCategory(
  payload: OnboardingPayload,
  schemas: BuiltInSchemaPreview[],
): string {
  const slug = payload.businessCategory;
  if (!slug) return "—";
  if (slug === "custom") {
    return payload.customCategoryName?.trim()
      ? `${payload.customCategoryName} (custom)`
      : "Custom";
  }
  const fromSchemas = schemas.find((s) => s.slug === slug)?.displayName;
  if (fromSchemas) return fromSchemas;
  const fromList = CATEGORIES.find((c) => c.slug === slug)?.displayName;
  return fromList ?? slug;
}

function labelForPlan(slug: string): string {
  return PLAN_OPTIONS.find((p) => p.slug === slug)?.displayName ?? slug;
}

/**
 * Map server-thrown error codes to operator-friendly hints. The server
 * surfaces `{ error: <CODE> }` for both 400 and 404; we squash both into
 * a single message because the operator can't tell the difference.
 */
function translateFinalizeError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { error?: string };
      switch (body.error) {
        case "BUSINESS_CATEGORY_REQUIRED":
          return "Pick a business category before finishing.";
        case "CUSTOM_CATEGORY_NAME_REQUIRED":
          return "Custom category needs a name.";
        case "CUSTOM_CATEGORY_TEMPLATE_REQUIRED":
          return "Pick the closest built-in template for your custom category.";
        case "TENANT_NOT_FOUND":
          return "Workspace record is missing — sign out and back in.";
        case "SCHEMA_NOT_FOUND":
          return "The selected category schema is unavailable. Try a different category.";
        case "PLAN_NOT_FOUND":
          return "Selected plan is unavailable. Pick another plan.";
        default:
          return body.error ?? err.message;
      }
    } catch {
      // Fall through to generic message
    }
  }
  return err instanceof Error ? err.message : "Something went wrong";
}
