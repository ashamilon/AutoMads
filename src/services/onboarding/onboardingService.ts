/**
 * Onboarding service (Multi-Tenant Commerce OS, task 11.1).
 *
 * Owns the resumable wizard state on `tenant.onboardingState` and the
 * single-transaction `finalize` that wires up `tenant.businessCategory`,
 * `tenant.categorySchemaId`, the trial `Subscription`, and the
 * `tenant.onboardingCompletedAt` stamp.
 *
 * Surface contract (R1.1..R1.7, R10.3):
 *
 *   getState(tenantId)
 *     Read `tenant.onboardingState` JSON. When the row is missing or the
 *     JSON is malformed (corrupted column), return a fresh
 *     `{ lastCompletedStep: null, payload: {} }` shape so the wizard always
 *     has a usable starting point — defensive parsing per task spec.
 *
 *   recordStep(tenantId, step, payload)
 *     Shallow-merge the partial `payload` into the existing payload, set
 *     `lastCompletedStep = step`, write back to `tenant.onboardingState`.
 *     Re-recording the same step with the same payload is a no-op (R1.7).
 *
 *   finalize(tenantId, finalPayload)
 *     Atomically (single `prisma.$transaction`):
 *       1. Set `tenant.businessCategory`, `tenant.businessSubcategory`,
 *          `tenant.dashboardTemplate` (= businessCategory).
 *       2. Resolve `categorySchemaId`:
 *          - predefined: link to the built-in CategorySchema row where
 *            `slug == businessCategory && isBuiltIn && tenantId == null`.
 *          - custom: clone the closest built-in (by
 *            `customCategoryTemplateSlug`) into a new CategorySchema row
 *            with `tenantId` set; apply `schemaOverrides` if provided;
 *            cloned slug = `customCategoryName.toLowerCase().replace(/\s+/g, '_')`.
 *       3. Update `tenant.categorySchemaId`.
 *       4. Call `subscriptionService.startTrial(tenantId, planSlug, ...)`
 *          inside the same transaction (the service accepts a tx client).
 *       5. Set `tenant.onboardingCompletedAt = new Date()`.
 *       6. Clear `tenant.onboardingState = null` (SQL NULL).
 *
 *     Idempotent: if `tenant.onboardingCompletedAt` is already set, returns
 *     the existing `{ tenantId, categorySchemaId, subscriptionId }` without
 *     creating a second subscription or schema row.
 *
 * Error codes (thrown as `Error(<code>)`):
 *   - TENANT_NOT_FOUND   — tenant row missing
 *   - SCHEMA_NOT_FOUND   — built-in slug (or custom template slug) does not
 *                          resolve to a `CategorySchema` row in Prisma
 *   - PLAN_NOT_FOUND     — `planSlug` does not match a `Plan` row
 *
 * No prisma migrations are introduced. The fields used here all exist on
 * the schema delta from task 1.1.
 *
 * Maps to: R1.1, R1.2, R1.3, R1.4, R1.5, R1.6, R1.7, R10.3.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import * as categoryEngine from "../../agent/categoryEngine/index.js";
import * as subscriptionService from "../subscription/subscriptionService.js";

// ─── Public types ─────────────────────────────────────────────────────────

export type OnboardingStep =
  | "welcome"
  | "audience"
  | "category_select"
  | "custom_category"
  | "schema_preferences"
  | "finalize";

export interface OnboardingPayload {
  /** 'jersey' | 'restaurant' | 'custom' | ... */
  businessCategory?: string;
  businessSubcategory?: string;
  /** When category=='custom', the closest built-in to clone. */
  customCategoryTemplateSlug?: string;
  customCategoryName?: string;
  /** Tenant edits to the default schema (applied during finalize). */
  schemaOverrides?: {
    attributes?: unknown[];
    orderAttributes?: unknown[];
  };
  /** Chosen plan, default 'starter'. */
  planSlug?: string;
  /**
   * Audience profile captured in the new audience step. Mirrors the runtime
   * shape stored on `tenant.settings.audienceProfile` so finalize can write
   * it through verbatim.
   */
  audienceProfile?: {
    targetAudience?: string[];
    defaultAddress?: string;
    allowedAddresses?: string[];
  };
}

export interface OnboardingState {
  lastCompletedStep: OnboardingStep | null;
  payload: OnboardingPayload;
}

export interface OnboardingFinalizeResult {
  ok: true;
  tenantId: string;
  categorySchemaId: string;
  subscriptionId: string;
}

// ─── Constants ────────────────────────────────────────────────────────────

const VALID_STEPS: ReadonlySet<OnboardingStep> = new Set([
  "welcome",
  "audience",
  "category_select",
  "custom_category",
  "schema_preferences",
  "finalize",
]);

const CUSTOM_CATEGORY = "custom";
const DEFAULT_PLAN_SLUG = "starter";

// ─── State helpers (defensive parsing) ────────────────────────────────────

function emptyState(): OnboardingState {
  return { lastCompletedStep: null, payload: {} };
}

/**
 * Coerce an arbitrary JSON value (as returned by Prisma) into the canonical
 * `OnboardingState` shape. Anything we can't recognize collapses to the
 * empty state so the wizard can keep moving — corrupted JSON is treated as
 * "no progress yet" per task spec.
 */
function parseState(value: unknown): OnboardingState {
  if (value === null || value === undefined) return emptyState();
  if (typeof value !== "object" || Array.isArray(value)) return emptyState();

  const obj = value as Record<string, unknown>;
  const rawStep = obj.lastCompletedStep;
  const lastCompletedStep =
    typeof rawStep === "string" && VALID_STEPS.has(rawStep as OnboardingStep)
      ? (rawStep as OnboardingStep)
      : null;

  const rawPayload = obj.payload;
  const payload: OnboardingPayload =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as OnboardingPayload)
      : {};

  return { lastCompletedStep, payload };
}

// ─── getState ─────────────────────────────────────────────────────────────

/**
 * Read the wizard state for a tenant. Always returns a usable shape; never
 * throws on missing tenants or malformed JSON (returns the empty state so
 * the front-end can route to the welcome step).
 */
export async function getState(tenantId: string): Promise<OnboardingState> {
  if (!tenantId) return emptyState();

  const row = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { onboardingState: true },
  });
  if (!row) return emptyState();

  return parseState(row.onboardingState);
}

// ─── recordStep ───────────────────────────────────────────────────────────

/**
 * Persist progress through a single wizard step. The `payload` argument is
 * shallow-merged on top of any prior payload; passing the same step twice
 * with the same payload is safe (idempotent write of the same JSON).
 *
 * Throws `Error('TENANT_NOT_FOUND')` when the tenant row is missing.
 */
export async function recordStep(
  tenantId: string,
  step: OnboardingStep,
  payload: Partial<OnboardingPayload>,
): Promise<OnboardingState> {
  if (!tenantId) throw new Error("TENANT_NOT_FOUND");

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, onboardingState: true },
  });
  if (!tenant) throw new Error("TENANT_NOT_FOUND");

  const prior = parseState(tenant.onboardingState);
  const nextState: OnboardingState = {
    lastCompletedStep: step,
    payload: { ...prior.payload, ...(payload ?? {}) },
  };

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      onboardingState: nextState as unknown as Prisma.InputJsonValue,
    },
  });

  return nextState;
}

// ─── finalize ─────────────────────────────────────────────────────────────

/**
 * Slug helper for cloned custom categories. Lower-cases and replaces
 * runs of whitespace with underscores so a name like `"Pet Spa Salon"`
 * becomes the slug `pet_spa_salon`.
 */
function customSlugFromName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

/**
 * Lift an `unknown[]` schema override into a Prisma `InputJsonValue` cast.
 * Validation of attribute shape is the Category Engine's job (task 2.3);
 * here we only care that the value is a JSON-storable array.
 */
function asJsonArray(value: unknown[] | undefined): Prisma.InputJsonValue | null {
  if (!Array.isArray(value)) return null;
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * Run the finalize transaction. Idempotent on `tenant.onboardingCompletedAt`:
 * a second call against an already-finalized tenant returns the existing
 * `{ tenantId, categorySchemaId, subscriptionId }` without writing any row.
 *
 * Validation rules:
 *   - `finalPayload.businessCategory` is required.
 *   - When `businessCategory === 'custom'`, `customCategoryName` is
 *     required; `customCategoryTemplateSlug` is required to resolve the
 *     starter template to clone.
 *
 * Errors:
 *   - TENANT_NOT_FOUND   — no tenant row for `tenantId`
 *   - SCHEMA_NOT_FOUND   — built-in/template slug doesn't resolve to a row
 *   - PLAN_NOT_FOUND     — `planSlug` doesn't match a `Plan` row
 */
export async function finalize(
  tenantId: string,
  finalPayload: OnboardingPayload,
): Promise<OnboardingFinalizeResult> {
  if (!tenantId) throw new Error("TENANT_NOT_FOUND");

  const businessCategory = finalPayload.businessCategory;
  if (!businessCategory || typeof businessCategory !== "string") {
    throw new Error("BUSINESS_CATEGORY_REQUIRED");
  }
  const businessSubcategory = finalPayload.businessSubcategory ?? null;
  const planSlug = finalPayload.planSlug ?? DEFAULT_PLAN_SLUG;

  if (businessCategory === CUSTOM_CATEGORY) {
    if (!finalPayload.customCategoryName) {
      throw new Error("CUSTOM_CATEGORY_NAME_REQUIRED");
    }
    if (!finalPayload.customCategoryTemplateSlug) {
      throw new Error("CUSTOM_CATEGORY_TEMPLATE_REQUIRED");
    }
  }

  // Pre-flight: validate plan exists. Doing it outside the transaction
  // avoids paying for the txn round-trip on a misconfigured payload.
  const plan = await prisma.plan.findUnique({ where: { slug: planSlug } });
  if (!plan) throw new Error("PLAN_NOT_FOUND");

  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        onboardingCompletedAt: true,
        categorySchemaId: true,
      },
    });
    if (!tenant) throw new Error("TENANT_NOT_FOUND");

    // Idempotency: already finalized → return existing wiring.
    if (tenant.onboardingCompletedAt && tenant.categorySchemaId) {
      const sub = await tx.subscription.findUnique({
        where: { tenantId },
        select: { id: true },
      });
      if (sub) {
        return {
          tenantId,
          categorySchemaId: tenant.categorySchemaId,
          subscriptionId: sub.id,
          createdSchemaId: null as string | null,
        };
      }
      // Edge case: completedAt set but no subscription row (e.g. partial
      // historic seed). Re-create the subscription via startTrial below.
    }

    // 1) Resolve / create the CategorySchema row.
    let categorySchemaId: string;
    let createdSchemaId: string | null = null;

    if (businessCategory !== CUSTOM_CATEGORY) {
      const builtIn = await tx.categorySchema.findFirst({
        where: {
          slug: businessCategory,
          isBuiltIn: true,
          tenantId: null,
        },
        select: { id: true },
      });
      if (!builtIn) throw new Error("SCHEMA_NOT_FOUND");
      categorySchemaId = builtIn.id;
    } else {
      const templateSlug = finalPayload.customCategoryTemplateSlug as string;
      const template = await tx.categorySchema.findFirst({
        where: {
          slug: templateSlug,
          isBuiltIn: true,
          tenantId: null,
        },
      });
      if (!template) throw new Error("SCHEMA_NOT_FOUND");

      const newSlug = customSlugFromName(
        finalPayload.customCategoryName as string,
      );

      const overrideAttrs = asJsonArray(finalPayload.schemaOverrides?.attributes);
      const overrideOrderAttrs = asJsonArray(
        finalPayload.schemaOverrides?.orderAttributes,
      );

      const cloned = await tx.categorySchema.create({
        data: {
          slug: newSlug,
          version: 1,
          attributes:
            overrideAttrs ??
            (template.attributes as unknown as Prisma.InputJsonValue),
          variantAttributes:
            template.variantAttributes as unknown as Prisma.InputJsonValue,
          orderAttributes:
            overrideOrderAttrs ??
            (template.orderAttributes as unknown as Prisma.InputJsonValue),
          filterAttributes:
            template.filterAttributes as unknown as Prisma.InputJsonValue,
          terminology:
            template.terminology as unknown as Prisma.InputJsonValue,
          dashboardModules:
            template.dashboardModules as unknown as Prisma.InputJsonValue,
          workflowRules:
            template.workflowRules as unknown as Prisma.InputJsonValue,
          promptFragments:
            template.promptFragments as unknown as Prisma.InputJsonValue,
          isBuiltIn: false,
          tenantId,
        },
        select: { id: true },
      });
      categorySchemaId = cloned.id;
      createdSchemaId = cloned.id;
    }

    // 2) Update tenant with category fields + categorySchemaId. Audience
    //    profile (if captured in the new audience step) is written into
    //    `tenant.settings.audienceProfile` non-destructively so we don't
    //    clobber any other settings keys the operator has already set.
    //
    //    Onboarding ALSO flips `settings.agent.enabled = true` so the
    //    agent loop actually runs for the freshly-onboarded tenant. Without
    //    this, `isAgentEnabledForTenant()` returns false and the chat
    //    sandbox / Messenger inbound fall through to the legacy switchboard
    //    that has no replies to give.
    const audienceProfilePayload = finalPayload.audienceProfile;
    const tenantSettingsRow = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const prev =
      tenantSettingsRow?.settings &&
      typeof tenantSettingsRow.settings === "object" &&
      !Array.isArray(tenantSettingsRow.settings)
        ? (tenantSettingsRow.settings as Record<string, unknown>)
        : {};
    const prevAgent =
      prev.agent && typeof prev.agent === "object" && !Array.isArray(prev.agent)
        ? (prev.agent as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = {
      ...prev,
      agent: { ...prevAgent, enabled: true },
    };
    if (audienceProfilePayload) {
      merged.audienceProfile = audienceProfilePayload;
    }
    const nextSettings: Prisma.InputJsonValue =
      merged as unknown as Prisma.InputJsonValue;

    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        businessCategory,
        businessSubcategory,
        dashboardTemplate: businessCategory,
        categorySchemaId,
        settings: nextSettings,
      },
    });

    // 3) Start the trial subscription inside the same transaction.
    const subscription = await subscriptionService.startTrial(
      tenantId,
      planSlug,
      `tenant:${tenantId}`,
      tx,
    );

    // 4) Stamp completedAt + clear onboardingState.
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        onboardingCompletedAt: new Date(),
        onboardingState: Prisma.DbNull,
      },
    });

    return {
      tenantId,
      categorySchemaId,
      subscriptionId: subscription.id,
      createdSchemaId,
    };
  });

  // Outside the transaction: punch the per-tenant Category Engine cache so
  // the next AI turn sees the freshly-linked schema without waiting for the
  // 30 s TTL or the LISTEN/NOTIFY round-trip. Best-effort — failures are
  // logged but don't roll back the (already-committed) transaction.
  try {
    await categoryEngine.invalidateSchemaCache(tenantId);
  } catch (err) {
    logger.warn(
      {
        event: "onboarding_invalidate_schema_cache_failed",
        tenantId,
        err: serializeError(err),
      },
      "onboarding schema cache invalidation failed",
    );
  }

  logger.info(
    {
      event: "onboarding_finalized",
      tenantId,
      businessCategory,
      categorySchemaId: result.categorySchemaId,
      subscriptionId: result.subscriptionId,
      planSlug,
      createdSchemaId: result.createdSchemaId,
    },
    "onboarding finalized",
  );

  return {
    ok: true,
    tenantId: result.tenantId,
    categorySchemaId: result.categorySchemaId,
    subscriptionId: result.subscriptionId,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function serializeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
