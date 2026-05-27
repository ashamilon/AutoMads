/**
 * Onboarding HTTP surface (Multi-Tenant Commerce OS, task 11.2 part A).
 *
 * Thin Express layer over `onboardingService` (task 11.1) plus a read-only
 * endpoint that surfaces the built-in `CategorySchema` rows so the wizard
 * can populate its category-picker preview cards. Auth is the existing
 * tenant-session/api-key middleware (`requireTenantApiKey`); the tenant id
 * is read from `req.tenant.id` so callers cannot spoof the parameter.
 *
 * Routes (mounted under `/api/v1/onboarding`):
 *
 *   GET  /state               → onboardingService.getState
 *   POST /step                → onboardingService.recordStep (validates `step`)
 *   POST /finalize            → onboardingService.finalize (translates errors)
 *   GET  /built-in-schemas    → list of `{slug, displayName, attributes,
 *                               orderAttributes, dashboardModules}` for
 *                               every CategorySchema row where
 *                               `isBuiltIn=true && tenantId IS NULL`,
 *                               sorted by `slug`.
 *
 * Error mapping for `POST /finalize`:
 *   - TENANT_NOT_FOUND, SCHEMA_NOT_FOUND          → 404 `{ error }`
 *   - PLAN_NOT_FOUND                              → 404 `{ error }`
 *   - BUSINESS_CATEGORY_REQUIRED                  → 400 `{ error }`
 *   - CUSTOM_CATEGORY_NAME_REQUIRED               → 400 `{ error }`
 *   - CUSTOM_CATEGORY_TEMPLATE_REQUIRED           → 400 `{ error }`
 *
 * Maps to: R1.1, R1.2, R1.3, R1.4, R1.5, R1.6, R1.7.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { prisma } from "../db/prisma.js";
import { requireTenantApiKey } from "../middlewares/tenantApiAuth.js";
import { logger } from "../utils/logger.js";
import * as onboardingService from "../services/onboarding/onboardingService.js";
import type {
  OnboardingPayload,
  OnboardingStep,
} from "../services/onboarding/onboardingService.js";

export const onboardingRoutes = Router();

// All onboarding endpoints require a valid tenant session / api key; the
// tenant id is read from `req.tenant.id` so the wizard cannot be driven on
// behalf of a different tenant.
onboardingRoutes.use(requireTenantApiKey);

// ─── Schemas ──────────────────────────────────────────────────────────────

const ONBOARDING_STEPS = [
  "welcome",
  "audience",
  "category_select",
  "custom_category",
  "schema_preferences",
  "finalize",
] as const satisfies readonly OnboardingStep[];

const stepEnum = z.enum(ONBOARDING_STEPS);

/**
 * `payload` is intentionally a free-form object — `recordStep` shallow-merges
 * it into the existing payload and the validators in finalize() catch the
 * required combinations. Limit the depth/size with z.record to keep the
 * Express body parser bounded.
 */
const stepBody = z.object({
  step: stepEnum,
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

const finalizeBody = z.object({
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

// Errors thrown by the service that must surface as 400 (client-side input
// problems) vs 404 (server-side missing-row problems).
const CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "BUSINESS_CATEGORY_REQUIRED",
  "CUSTOM_CATEGORY_NAME_REQUIRED",
  "CUSTOM_CATEGORY_TEMPLATE_REQUIRED",
]);
const NOT_FOUND_ERROR_CODES: ReadonlySet<string> = new Set([
  "TENANT_NOT_FOUND",
  "SCHEMA_NOT_FOUND",
  "PLAN_NOT_FOUND",
]);

// ─── Routes ───────────────────────────────────────────────────────────────

/**
 * GET /state
 *
 * Always returns a usable shape — the service collapses missing/corrupted
 * `tenant.onboardingState` to `{ lastCompletedStep: null, payload: {} }`.
 */
onboardingRoutes.get("/state", async (req: Request, res: Response) => {
  const tenantId = req.tenant!.id;
  const state = await onboardingService.getState(tenantId);
  res.json(state);
});

/**
 * POST /step
 *
 * Body: `{ step: OnboardingStep, payload?: Partial<OnboardingPayload> }`.
 * Validates that `step` is one of the recognized values; the service
 * shallow-merges `payload` into the existing JSON.
 */
onboardingRoutes.post("/step", async (req: Request, res: Response) => {
  const tenantId = req.tenant!.id;
  const parsed = stepBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_step_body", issues: parsed.error.issues });
    return;
  }
  try {
    const next = await onboardingService.recordStep(
      tenantId,
      parsed.data.step,
      parsed.data.payload as Partial<OnboardingPayload>,
    );
    res.json(next);
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown_error";
    if (NOT_FOUND_ERROR_CODES.has(code)) {
      res.status(404).json({ error: code });
      return;
    }
    logger.error(
      { event: "onboarding_step_failed", tenantId, err: serializeError(err) },
      "onboarding step recording failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /finalize
 *
 * Body: `{ payload?: OnboardingPayload }`. Translates the service's thrown
 * error codes into structured 400/404 responses; success returns the full
 * `{ ok, tenantId, categorySchemaId, subscriptionId }` envelope from the
 * service so the wizard can confirm the wiring before redirecting.
 */
onboardingRoutes.post("/finalize", async (req: Request, res: Response) => {
  const tenantId = req.tenant!.id;
  const parsed = finalizeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_finalize_body", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await onboardingService.finalize(
      tenantId,
      parsed.data.payload as OnboardingPayload,
    );
    res.json(result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown_error";
    if (CLIENT_ERROR_CODES.has(code)) {
      res.status(400).json({ error: code });
      return;
    }
    if (NOT_FOUND_ERROR_CODES.has(code)) {
      res.status(404).json({ error: code });
      return;
    }
    logger.error(
      { event: "onboarding_finalize_failed", tenantId, err: serializeError(err) },
      "onboarding finalize failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * GET /built-in-schemas
 *
 * Lists the built-in `CategorySchema` rows the wizard offers in its
 * category-picker step. Returns only the fields the wizard needs to render
 * the preview card (slug, display name, attributes count, etc.); we
 * intentionally omit `terminology`, `workflowRules`, and `promptFragments`
 * because they're large and not consumed by the wizard.
 *
 * The `displayName` is derived from `slug` with underscores replaced and
 * each word title-cased — there's no per-row display name column on the
 * CategorySchema model, so this gives a reasonable default for the picker.
 */
onboardingRoutes.get("/built-in-schemas", async (_req: Request, res: Response) => {
  const rows = await prisma.categorySchema.findMany({
    where: { isBuiltIn: true, tenantId: null },
    orderBy: { slug: "asc" },
    select: {
      slug: true,
      attributes: true,
      orderAttributes: true,
      dashboardModules: true,
    },
  });

  const schemas = rows.map((r) => ({
    slug: r.slug,
    displayName: slugToDisplayName(r.slug),
    attributes: r.attributes ?? [],
    orderAttributes: r.orderAttributes ?? [],
    dashboardModules: r.dashboardModules ?? [],
  }));

  res.json({ schemas });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function slugToDisplayName(slug: string): string {
  return slug
    .split(/[_\s]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

function serializeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
