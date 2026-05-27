"use client";

/**
 * Onboarding wizard entry router (Multi-Tenant Commerce OS, task 11.2 part B).
 *
 * Single-page wizard that switches between five steps based on local state.
 * On mount it calls `GET /api/v1/onboarding/state` to resume at the step
 * after `lastCompletedStep`; on completion it redirects to `/portal`.
 *
 * The five steps live as plain function components under
 * `./steps/*.tsx`; this file wires them together, owns the cross-step
 * payload, and renders the centred card layout + progress indicator.
 *
 * Auth: this page renders inside the same `RequireAuth` guarantees the
 * portal uses — we call `apiFetch` which throws if no credential is
 * stored, and rely on `client/src/middleware.ts` to keep unauthenticated
 * users from landing here without a session in the first place.
 *
 * Maps to: R1.1, R1.2, R1.3, R1.4, R1.5, R1.6, R1.7.
 */

import { Card } from "@/components/ui/card";
import { useTenant } from "@/context/tenant-context";
import { ApiError, apiFetch, getStoredCredential } from "@/lib/api";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import { motion } from "framer-motion";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AudienceStep } from "./steps/audience";
import { CategoryStep } from "./steps/category";
import { CustomCategoryStep } from "./steps/custom";
import { FinalizeStep } from "./steps/finalize";
import { PreferencesStep } from "./steps/preferences";
import { WelcomeStep } from "./steps/welcome";
import type {
  BuiltInSchemaPreview,
  OnboardingPayload,
  OnboardingState,
  OnboardingStep,
} from "./types";

/** Visible step ids in the order the user walks through them. */
type WizardScreen =
  | "welcome"
  | "audience"
  | "category_select"
  | "custom_category"
  | "schema_preferences"
  | "finalize";

/**
 * Map a server-persisted `lastCompletedStep` to the screen the wizard
 * should resume on. Anything we don't recognize (corrupted state, fresh
 * tenant) falls back to `welcome`.
 */
function resumeScreen(
  state: OnboardingState | null,
  payload: OnboardingPayload,
): WizardScreen {
  const last = state?.lastCompletedStep ?? null;
  switch (last) {
    case "welcome":
      return "audience";
    case "audience":
      return "category_select";
    case "category_select":
      // If the operator already chose `custom`, the next stop is the
      // custom-naming step; otherwise jump straight to preferences.
      return payload.businessCategory === "custom"
        ? "custom_category"
        : "schema_preferences";
    case "custom_category":
      return "schema_preferences";
    case "schema_preferences":
      return "finalize";
    case "finalize":
      return "finalize";
    default:
      return "welcome";
  }
}

/** Order of progress dots so we can highlight "where am I" visually. */
const PROGRESS_ORDER: WizardScreen[] = [
  "welcome",
  "audience",
  "category_select",
  "custom_category",
  "schema_preferences",
  "finalize",
];

const PROGRESS_LABELS: Record<WizardScreen, string> = {
  welcome: "Welcome",
  audience: "Audience",
  category_select: "Category",
  custom_category: "Custom",
  schema_preferences: "Preferences",
  finalize: "Finish",
};

export default function OnboardingPage() {
  const router = useRouter();
  const { tenant, loading: tenantLoading, refresh } = useTenant();
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();

  const [screen, setScreen] = useState<WizardScreen>("welcome");
  const [payload, setPayload] = useState<OnboardingPayload>({});
  const [schemas, setSchemas] = useState<BuiltInSchemaPreview[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  // ─── Boot: fetch state + built-in schemas in parallel ───────────────────
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (!getStoredCredential()) {
        // The middleware should have redirected to /login already; do the
        // same here defensively in case the user landed via an old tab.
        router.replace("/login");
        return;
      }
      setBooting(true);
      setBootError(null);
      try {
        // Refresh the tenant context first so the onboarding probe cookie
        // (`onboarding_completed`) is in sync with the server's
        // `onboardingCompletedAt`. If the tenant finished the wizard
        // earlier, bounce straight to the portal — this happens when the
        // operator hits `/onboarding` directly via an old bookmark.
        await refresh();
        const meRes = await apiFetch<{ onboardingCompletedAt: string | null }>(
          "/api/v1/me",
        );
        if (cancelled) return;
        if (meRes.onboardingCompletedAt) {
          router.replace("/portal");
          return;
        }

        const [state, schemasRes] = await Promise.all([
          apiFetch<OnboardingState>("/api/v1/onboarding/state"),
          apiFetch<{ schemas: BuiltInSchemaPreview[] }>(
            "/api/v1/onboarding/built-in-schemas",
          ),
        ]);
        if (cancelled) return;
        setSchemas(schemasRes.schemas);
        setPayload(state.payload ?? {});
        setScreen(resumeScreen(state, state.payload ?? {}));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          router.replace("/login");
          return;
        }
        setBootError(err instanceof Error ? err.message : "Failed to load onboarding state");
      } finally {
        if (!cancelled) setBooting(false);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [router, refresh]);

  // ─── Step persistence ───────────────────────────────────────────────────

  /**
   * Persist a wizard step to the server, merging `slice` into the local
   * payload so the next render sees the latest values immediately. The
   * server shallow-merges the same slice into `tenant.onboardingState`,
   * making the wizard fully resumable across browser refreshes.
   */
  const recordStep = useCallback(
    async (step: OnboardingStep, slice: Partial<OnboardingPayload>) => {
      // Optimistic local merge so the next screen sees the value right away
      // — the API call below catches up the server in the background.
      setPayload((prev) => mergePayload(prev, slice));
      await apiFetch<OnboardingState>("/api/v1/onboarding/step", {
        method: "POST",
        body: JSON.stringify({ step, payload: slice }),
      });
    },
    [],
  );

  /**
   * Walk forward through the wizard. The custom step is conditionally
   * skipped when the operator picked a predefined category in the
   * category-select step (R1.4 / R1.5 fork).
   */
  const goNext = useCallback(
    (current: WizardScreen, latestPayload: OnboardingPayload) => {
      switch (current) {
        case "welcome":
          setScreen("audience");
          return;
        case "audience":
          setScreen("category_select");
          return;
        case "category_select":
          setScreen(
            latestPayload.businessCategory === "custom"
              ? "custom_category"
              : "schema_preferences",
          );
          return;
        case "custom_category":
          setScreen("schema_preferences");
          return;
        case "schema_preferences":
          setScreen("finalize");
          return;
        case "finalize":
          // No further screens; the finalize step handles its own redirect.
          return;
      }
    },
    [],
  );

  const goBack = useCallback((current: WizardScreen) => {
    switch (current) {
      case "audience":
        setScreen("welcome");
        return;
      case "category_select":
        setScreen("audience");
        return;
      case "custom_category":
        setScreen("category_select");
        return;
      case "schema_preferences":
        setScreen(payload.businessCategory === "custom" ? "custom_category" : "category_select");
        return;
      case "finalize":
        setScreen("schema_preferences");
        return;
    }
  }, [payload.businessCategory]);

  /**
   * Final submit — calls `/finalize`, refreshes the tenant context (so
   * `onboardingCompletedAt` is populated and the middleware lets `/portal`
   * load), then redirects.
   */
  const finalizeAndRedirect = useCallback(async () => {
    await apiFetch<{ ok: true }>("/api/v1/onboarding/finalize", {
      method: "POST",
      body: JSON.stringify({ payload }),
    });
    await refresh();
    router.replace("/portal");
  }, [payload, refresh, router]);

  // ─── Visible-step filtering for the progress indicator ──────────────────
  const visibleSteps = useMemo<WizardScreen[]>(() => {
    // Hide the custom step from the progress dots when the operator chose
    // a predefined category — it's a no-op for them and would mis-imply a
    // longer journey than they're actually taking.
    if (payload.businessCategory && payload.businessCategory !== "custom") {
      return PROGRESS_ORDER.filter((s) => s !== "custom_category");
    }
    return PROGRESS_ORDER.slice();
  }, [payload.businessCategory]);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (tenantLoading || booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-mesh-dark">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-white/5 px-10 py-12">
          <Loader2 className="h-10 w-10 animate-spin text-accent-bright" />
          <p className="text-sm text-slate-400">Loading workspace…</p>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md rounded-2xl border border-rose-500/30 bg-rose-500/10 p-8 text-center text-rose-200">
          <p className="text-sm">{bootError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-mesh-dark" />
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 w-full max-w-2xl"
      >
        <div className="mb-6 flex items-center justify-center gap-3">
          <img
            src={brandLogoUrl}
            alt="Brand logo"
            className="h-12 w-12 rounded-xl object-contain brightness-0 invert"
          />
          <img
            src={brandNameUrl}
            alt="Brand name"
            className="h-7 w-auto max-w-[12rem] object-contain brightness-0 invert"
          />
        </div>

        <Card className="border-white/10 p-8">
          <ProgressIndicator current={screen} steps={visibleSteps} />
          <div className="mt-7">
            {screen === "welcome" && (
              <WelcomeStep
                tenantName={tenant?.name ?? "your workspace"}
                onNext={async () => {
                  await recordStep("welcome", {});
                  goNext("welcome", payload);
                }}
              />
            )}
            {screen === "audience" && (
              <AudienceStep
                value={payload}
                onBack={() => goBack("audience")}
                onNext={async (slice) => {
                  const next = mergePayload(payload, slice);
                  await recordStep("audience", slice);
                  goNext("audience", next);
                }}
              />
            )}
            {screen === "category_select" && (
              <CategoryStep
                schemas={schemas}
                value={payload.businessCategory ?? null}
                onBack={() => goBack("category_select")}
                onNext={async (slug) => {
                  const next = mergePayload(payload, { businessCategory: slug });
                  await recordStep("category_select", { businessCategory: slug });
                  goNext("category_select", next);
                }}
              />
            )}
            {screen === "custom_category" && (
              <CustomCategoryStep
                schemas={schemas}
                value={payload}
                onBack={() => goBack("custom_category")}
                onNext={async (slice) => {
                  const next = mergePayload(payload, slice);
                  await recordStep("custom_category", slice);
                  goNext("custom_category", next);
                }}
              />
            )}
            {screen === "schema_preferences" && (
              <PreferencesStep
                schemas={schemas}
                payload={payload}
                onBack={() => goBack("schema_preferences")}
                onNext={async (slice) => {
                  const next = mergePayload(payload, slice);
                  await recordStep("schema_preferences", slice);
                  goNext("schema_preferences", next);
                }}
              />
            )}
            {screen === "finalize" && (
              <FinalizeStep
                schemas={schemas}
                payload={payload}
                tenantName={tenant?.name ?? "your workspace"}
                onBack={() => goBack("finalize")}
                onSubmit={finalizeAndRedirect}
              />
            )}
          </div>
        </Card>

        <p className="mt-6 text-center text-[11px] text-slate-600">
          Resumable — close this tab anytime, your progress is saved.
        </p>
      </motion.div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Shallow merge a slice into the wizard payload, with a single special-case
 * for `schemaOverrides` so renames in the preferences step don't blow away
 * a sibling `orderAttributes` slice when the same step writes both.
 */
function mergePayload(
  prev: OnboardingPayload,
  slice: Partial<OnboardingPayload>,
): OnboardingPayload {
  const next: OnboardingPayload = { ...prev, ...slice };
  if (slice.schemaOverrides) {
    next.schemaOverrides = {
      ...(prev.schemaOverrides ?? {}),
      ...slice.schemaOverrides,
    };
  }
  return next;
}

function ProgressIndicator({
  current,
  steps,
}: {
  current: WizardScreen;
  steps: WizardScreen[];
}) {
  const currentIdx = steps.indexOf(current);
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={s} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                active
                  ? "border-accent/60 bg-accent/20 text-white"
                  : done
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                    : "border-white/10 bg-white/[0.03] text-slate-500"
              }`}
            >
              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <div className="hidden min-w-0 flex-1 sm:block">
              <p
                className={`truncate text-[11px] font-semibold uppercase tracking-wide ${
                  active
                    ? "text-white"
                    : done
                      ? "text-emerald-200"
                      : "text-slate-500"
                }`}
              >
                {PROGRESS_LABELS[s]}
              </p>
            </div>
            {i < steps.length - 1 && (
              <span
                className={`hidden h-px flex-1 sm:block ${
                  done ? "bg-emerald-500/40" : "bg-white/[0.06]"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
