"use client";

/**
 * Audience step (Multi-Tenant Commerce OS, customer audience extension).
 *
 * Two questions:
 *
 *   1. **Target audience** — multi-select. Drives recommendation bias and
 *      seeds the AI's default address style. Multi-select because shops
 *      often serve overlapping demographics ("women + girls", "men + boys").
 *      `Unisex` and `All ages` are escape hatches for shops that don't
 *      differentiate.
 *
 *   2. **Default address** — radio. The fallback the agent uses when the
 *      customer's first message has no Vaiya/Apu/Sir cue. `auto` lets the
 *      engine derive from target audience (women → Apu, men → Vaiya).
 *
 * Both feed into `tenant.settings.audienceProfile` on finalize. The agent
 * loop's per-conversation address detector runs independently and locks
 * a conversation to whatever the customer actually uses, so this step is
 * the *fallback* config — not a hard constraint.
 */

import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { useState } from "react";

import type { OnboardingPayload } from "../types";

const AUDIENCE_OPTIONS: ReadonlyArray<{ value: string; label: string; description: string }> = [
  { value: "men", label: "Men", description: "Adult male customers" },
  { value: "women", label: "Women", description: "Adult female customers" },
  { value: "boys", label: "Boys", description: "Younger male customers" },
  { value: "girls", label: "Girls", description: "Younger female customers" },
  { value: "kids", label: "Kids", description: "Children of all genders" },
  { value: "unisex", label: "Unisex", description: "Products that suit everyone" },
  { value: "all", label: "All ages", description: "Mixed audience, no targeting" },
];

const ADDRESS_OPTIONS: ReadonlyArray<{ value: string; label: string; sample: string }> = [
  { value: "auto", label: "Auto (recommended)", sample: "Agent picks based on the customer's own cues" },
  { value: "bhaiya", label: "Vaiya / Bhaiya", sample: "Vaiya, ei product ta dekhe nin." },
  { value: "apu", label: "Apu / Apa", sample: "Apu, ei collection ta dekhben please." },
  { value: "sir", label: "Sir", sample: "Sir, kindly take a look." },
  { value: "madam", label: "Madam", sample: "Madam, this would suit you well." },
  { value: "bondhu", label: "Bondhu", sample: "Bondhu, ei ta apnar jonno perfect." },
];

export function AudienceStep({
  value,
  onBack,
  onNext,
}: {
  value: OnboardingPayload;
  onBack: () => void;
  onNext: (slice: Partial<OnboardingPayload>) => Promise<void> | void;
}) {
  const [targetAudience, setTargetAudience] = useState<string[]>(
    Array.isArray(value.audienceProfile?.targetAudience)
      ? (value.audienceProfile?.targetAudience as string[])
      : [],
  );
  const [defaultAddress, setDefaultAddress] = useState<string>(
    typeof value.audienceProfile?.defaultAddress === "string"
      ? (value.audienceProfile?.defaultAddress as string)
      : "auto",
  );
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggleAudience(v: string) {
    setTargetAudience((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  }

  async function handleSubmit() {
    setErr(null);
    if (targetAudience.length === 0) {
      setErr("Pick at least one audience.");
      return;
    }
    setPending(true);
    try {
      await onNext({
        audienceProfile: {
          targetAudience,
          defaultAddress,
        },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold text-white">Who do you sell to?</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Helps the AI bias product recommendations and pick the right way to address customers.
          Pick all that apply — your AI will still adjust per customer based on how they write.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Target audience
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {AUDIENCE_OPTIONS.map((opt) => {
            const active = targetAudience.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleAudience(opt.value)}
                className={`flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                  active
                    ? "border-accent/60 bg-accent/10"
                    : "border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
                }`}
              >
                <div>
                  <p className={`text-sm font-semibold ${active ? "text-white" : "text-slate-200"}`}>
                    {opt.label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">{opt.description}</p>
                </div>
                {active && (
                  <span className="text-[10px] font-bold uppercase tracking-wide text-accent-bright">
                    Selected
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          How should the agent address customers by default?
        </p>
        <p className="text-[11px] text-slate-500">
          The agent always switches to whatever the customer themselves uses (vaiya / apu / sir / madam).
          This is the fallback when the customer's message has no clear cue.
        </p>
        <div className="space-y-1.5">
          {ADDRESS_OPTIONS.map((opt) => {
            const active = defaultAddress === opt.value;
            return (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition ${
                  active
                    ? "border-accent/60 bg-accent/10"
                    : "border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
                }`}
              >
                <input
                  type="radio"
                  name="defaultAddress"
                  value={opt.value}
                  checked={active}
                  onChange={() => setDefaultAddress(opt.value)}
                  className="mt-1 h-4 w-4 cursor-pointer accent-indigo-400"
                />
                <div>
                  <p className={`text-sm font-semibold ${active ? "text-white" : "text-slate-200"}`}>
                    {opt.label}
                  </p>
                  <p className="mt-0.5 text-[11px] italic text-slate-500">{opt.sample}</p>
                </div>
              </label>
            );
          })}
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
        <Button
          onClick={handleSubmit}
          disabled={pending || targetAudience.length === 0}
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
