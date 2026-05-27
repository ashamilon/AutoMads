"use client";

/**
 * Category-selection step (Multi-Tenant Commerce OS, task 11.2 part B, R1.3).
 *
 * Lists the 14 categories from the requirements (`jersey, clothing,
 * undergarments, shoes, cosmetics, electronics, restaurant, grocery,
 * jewelry, furniture, pet_shop, pharmacy, mobile_accessories, custom`) and
 * pulls a one-line description per category from the built-in
 * CategorySchema preview returned by `/api/v1/onboarding/built-in-schemas`.
 *
 * The description is derived from the schema's product attributes so the
 * picker actually surfaces what makes each category distinct without us
 * hand-writing 14 marketing strings — e.g. cosmetics shows
 * "Shade · Skin type · Ingredients · Volume".
 */

import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { CATEGORIES, type BuiltInSchemaPreview } from "../types";

export function CategoryStep({
  schemas,
  value,
  onBack,
  onNext,
}: {
  schemas: BuiltInSchemaPreview[];
  value: string | null;
  onBack: () => void;
  onNext: (slug: string) => Promise<void> | void;
}) {
  const [selected, setSelected] = useState<string | null>(value);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Quick lookup so each card can pull its own preview without re-scanning
  // the schemas array per render.
  const schemaBySlug = useMemo(() => {
    const map = new Map<string, BuiltInSchemaPreview>();
    for (const s of schemas) map.set(s.slug, s);
    return map;
  }, [schemas]);

  async function handleContinue() {
    if (!selected) {
      setErr("Pick a category to continue.");
      return;
    }
    setErr(null);
    setPending(true);
    try {
      await onNext(selected);
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
          What do you sell?
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          We&apos;ll preconfigure the AI agent and dashboard for your industry. Pick{" "}
          <span className="text-slate-200">Custom</span> at the bottom if your
          business doesn&apos;t fit any preset.
        </p>
      </div>

      <div className="grid max-h-[26rem] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
        {CATEGORIES.map((cat) => {
          const schema = schemaBySlug.get(cat.slug);
          const description = describeCategory(cat.slug, schema);
          const active = selected === cat.slug;
          return (
            <button
              key={cat.slug}
              type="button"
              onClick={() => setSelected(cat.slug)}
              className={`group flex flex-col items-start rounded-xl border px-3 py-3 text-left transition ${
                active
                  ? "border-accent/60 bg-accent/10"
                  : "border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <p
                  className={`text-sm font-semibold ${
                    active ? "text-white" : "text-slate-200"
                  }`}
                >
                  {cat.displayName}
                </p>
                {active && (
                  <span className="text-[10px] font-bold uppercase tracking-wide text-accent-bright">
                    Selected
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                {description}
              </p>
            </button>
          );
        })}
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
        <Button
          onClick={handleContinue}
          disabled={pending || !selected}
          className="min-w-[10rem] py-2.5"
        >
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

/**
 * Build a one-line preview of what a category implies — using the actual
 * schema attributes when available so the description never drifts from
 * what the AI agent will actually ask about.
 *
 * `custom` doesn't have a schema, so we hard-code an explanation pointing
 * the operator at the next step.
 */
function describeCategory(
  slug: string,
  schema: BuiltInSchemaPreview | undefined,
): string {
  if (slug === "custom") {
    return "Build your own from a similar template (next step lets you pick the closest match).";
  }
  if (!schema || schema.attributes.length === 0) {
    return "No preview available yet.";
  }
  const labels = schema.attributes.slice(0, 4).map((a) => a.label);
  const more = schema.attributes.length - labels.length;
  const rest = more > 0 ? ` · +${more} more` : "";
  return labels.join(" · ") + rest;
}
