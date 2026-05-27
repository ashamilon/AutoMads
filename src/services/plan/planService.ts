import { Prisma, type Plan } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";

/**
 * Plan service — exposes read access to subscription plans plus an idempotent
 * seeder for the four built-in plans (Starter / Pro / Agency / Enterprise).
 *
 * The `Plan.limits` and `Plan.featureFlags` columns are JSON so new flags or
 * limits can be added without schema changes (R15.1, R15.2, R16.1). A numeric
 * `-1` in `limits` means unlimited; consumers (planLimitService) honor that.
 *
 * Seeding is invoked from the bootstrap script (task 15.1) — this module
 * MUST NOT call `seedDefaultPlans()` itself at import time.
 */

export type PlanLimits = {
  maxMonthlyMessages: number;
  maxAiTokensMonthly: number;
  maxProducts: number;
  maxSocialAccounts: number;
  maxPostingPerDay: number;
};

export type PlanFeatureFlags = {
  "feature.aiPosting": boolean;
  "feature.contentCalendar": boolean;
  "feature.automationRules": boolean;
  "feature.multiSocialAccounts": boolean;
  "feature.advancedAnalytics": boolean;
  "feature.customCategorySchema": boolean;
};

type DefaultPlanSpec = {
  slug: string;
  displayName: string;
  billingCycle: "monthly";
  priceBdt: number;
  trialDays: number;
  limits: PlanLimits;
  featureFlags: PlanFeatureFlags;
};

const DEFAULT_PLANS: readonly DefaultPlanSpec[] = [
  {
    slug: "starter",
    displayName: "Starter",
    billingCycle: "monthly",
    priceBdt: 990,
    trialDays: 14,
    limits: {
      maxMonthlyMessages: 2000,
      maxAiTokensMonthly: 200_000,
      maxProducts: 50,
      maxSocialAccounts: 1,
      maxPostingPerDay: 0,
    },
    featureFlags: {
      "feature.aiPosting": false,
      "feature.contentCalendar": false,
      "feature.automationRules": false,
      "feature.multiSocialAccounts": false,
      "feature.advancedAnalytics": false,
      "feature.customCategorySchema": false,
    },
  },
  {
    slug: "pro",
    displayName: "Pro",
    billingCycle: "monthly",
    priceBdt: 2490,
    trialDays: 14,
    limits: {
      maxMonthlyMessages: 20_000,
      maxAiTokensMonthly: 2_000_000,
      maxProducts: 500,
      maxSocialAccounts: 3,
      maxPostingPerDay: 5,
    },
    featureFlags: {
      "feature.aiPosting": true,
      "feature.contentCalendar": true,
      "feature.automationRules": false,
      "feature.multiSocialAccounts": true,
      "feature.advancedAnalytics": false,
      "feature.customCategorySchema": true,
    },
  },
  {
    slug: "agency",
    displayName: "Agency",
    billingCycle: "monthly",
    priceBdt: 6990,
    trialDays: 14,
    limits: {
      maxMonthlyMessages: 100_000,
      maxAiTokensMonthly: 10_000_000,
      maxProducts: 5000,
      maxSocialAccounts: 10,
      maxPostingPerDay: 20,
    },
    featureFlags: {
      "feature.aiPosting": true,
      "feature.contentCalendar": true,
      "feature.automationRules": true,
      "feature.multiSocialAccounts": true,
      "feature.advancedAnalytics": true,
      "feature.customCategorySchema": true,
    },
  },
  {
    slug: "enterprise",
    displayName: "Enterprise",
    billingCycle: "monthly",
    priceBdt: 19_990,
    trialDays: 0,
    limits: {
      maxMonthlyMessages: -1,
      maxAiTokensMonthly: -1,
      maxProducts: -1,
      maxSocialAccounts: -1,
      maxPostingPerDay: -1,
    },
    featureFlags: {
      "feature.aiPosting": true,
      "feature.contentCalendar": true,
      "feature.automationRules": true,
      "feature.multiSocialAccounts": true,
      "feature.advancedAnalytics": true,
      "feature.customCategorySchema": true,
    },
  },
];

/**
 * List active plans, ordered by `priceBdt` ascending so the dashboard tier
 * picker shows them in the natural Starter -> Enterprise progression.
 */
export async function listPlans(): Promise<Plan[]> {
  return prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { priceBdt: "asc" },
  });
}

/**
 * Look up a single plan by its stable slug (e.g. `starter`, `pro`).
 * Returns `null` when no matching row exists; callers MUST handle that case
 * before assuming the plan is valid.
 */
export async function getPlanBySlug(slug: string): Promise<Plan | null> {
  return prisma.plan.findUnique({
    where: { slug },
  });
}

/**
 * Idempotent seed of the four default plans. Re-running this function MUST
 * NOT create duplicate rows; it always overwrites `displayName`, `priceBdt`,
 * `trialDays`, `limits`, `featureFlags`, and `isActive` so config drift in
 * staging/dev is corrected on every bootstrap. The `id` column stays stable
 * because we match on `slug` (the unique key) via `upsert`.
 */
export async function seedDefaultPlans(): Promise<void> {
  for (const spec of DEFAULT_PLANS) {
    const priceBdt = new Prisma.Decimal(spec.priceBdt);
    await prisma.plan.upsert({
      where: { slug: spec.slug },
      update: {
        displayName: spec.displayName,
        billingCycle: spec.billingCycle,
        priceBdt,
        trialDays: spec.trialDays,
        limits: spec.limits as unknown as Prisma.InputJsonValue,
        featureFlags: spec.featureFlags as unknown as Prisma.InputJsonValue,
        isActive: true,
      },
      create: {
        slug: spec.slug,
        displayName: spec.displayName,
        billingCycle: spec.billingCycle,
        priceBdt,
        trialDays: spec.trialDays,
        limits: spec.limits as unknown as Prisma.InputJsonValue,
        featureFlags: spec.featureFlags as unknown as Prisma.InputJsonValue,
        isActive: true,
      },
    });
  }

  logger.info(
    { event: "plan_seed_complete", count: DEFAULT_PLANS.length },
    "plan_seed_complete",
  );
}
