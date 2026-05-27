/**
 * Reasoning_Context builder (Multi-Tenant Commerce OS, task 3.2).
 *
 * The builder runs ONCE per agent turn, before `observe_input` in the
 * StateGraph, and returns a frozen `ReasoningContext` that every later stage
 * (intent classifier, prompt builder, tools, reply filter) reads instead of
 * issuing its own tenant/category/identity/plan/subscription lookups.
 *
 * Resolution chain (mirrors design.md, "Reasoning_Context Builder"):
 *
 *   1. `prisma.tenant.findUnique({ id: tenantId })`. Missing row →
 *      {@link MissingTenantScopeError} (R6.1, R6.3).
 *   2. `categoryEngine.loadCategorySchema(tenantId)` — already handles the
 *      `categorySchemaId → built-in(businessCategory) → jersey` fallback chain
 *      and emits the `category_schema_fallback` warn when it falls all the
 *      way through (R2.3, R2.6).
 *   3. `agentIdentityService.resolve(tenantId, categorySchema)` — merges
 *      per-tenant overrides over category defaults over platform defaults
 *      (R5.4, R5.7).
 *   4. `planLimitService.resolve(tenantId)` — already returns platform
 *      defaults when the tenant has no `Subscription` row yet (the
 *      onboarding wizard is still racing the first turn). We catch any
 *      unexpected throw and fall back to platform defaults so a transient DB
 *      hiccup never short-circuits a turn (R15.6, R16.1).
 *   5. `subscriptionService.getStatus(tenantId)` — `null` means the trial
 *      hasn't been bootstrapped yet, in which case we synthesise
 *      `{ status: 'trial', isOperational: true }` so the very first inbound
 *      message during onboarding doesn't get refused (design.md, "Free trial
 *      defaults"). For real rows, `isOperational` is true when:
 *        - `status ∈ {trial, active}`, OR
 *        - `status === 'overdue'` AND `now < gracePeriodEndsAt` (R10.5,
 *          R12.4).
 *   6. Validate that `tenantId`, `businessCategory`, `categorySchema` are all
 *      non-null. Otherwise throw
 *      {@link ReasoningContextIncompleteError} (R7.6).
 *   7. Return `Object.freeze(context)` so callers cannot mutate it after the
 *      fact (defensive — every tool reads through `ctx`, never mutates).
 *
 * `brandVoice` is sourced from `tenant.settings.brandVoice` (existing JSON
 * column, not part of `agentIdentity`) and parsed defensively so any
 * malformed shape silently falls back to `{}` rather than crashing the turn.
 *
 * `workflowRules` mirrors `categorySchema.workflowRules`. Surfacing it as a
 * top-level property keeps tool handlers terse (`ctx.workflowRules` instead
 * of `ctx.categorySchema.workflowRules`) and matches the design.md
 * `ReasoningContext` interface verbatim.
 *
 * Pure with respect to its inputs: every fetch is read-only and the returned
 * object is frozen.
 *
 * Maps to: R5.6, R6.6, R7.1, R7.6, R12.4, R18.1, R18.2.
 */

import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import * as categoryEngine from "../categoryEngine/index.js";
import type {
  CategorySchema,
  WorkflowRules,
} from "../categoryEngine/types.js";
import * as agentIdentityService from "../identity/agentIdentityService.js";
import type { AgentIdentity } from "../identity/agentIdentityService.js";
import {
  parseAudienceProfile,
  resolveAddressStyle,
} from "../audience/resolve.js";
import type {
  AudienceProfile,
  ResolvedAudience,
} from "../audience/types.js";
import * as planLimitService from "../../services/plan/planLimitService.js";
import {
  PLATFORM_DEFAULT_PLAN_LIMITS,
  type ResolvedPlanLimits,
} from "../../services/plan/planLimitService.js";
import * as subscriptionService from "../../services/subscription/subscriptionService.js";
import type { SubscriptionStatus } from "../../services/subscription/subscriptionStateMachine.js";
import type { BrandVoice } from "../../services/socialPostService.js";
import {
  MissingTenantScopeError,
  ReasoningContextIncompleteError,
} from "./reasoningContextErrors.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * The frozen, fully populated context handed to every node in the agent
 * loop. Mirrors the `ReasoningContext` interface in design.md verbatim so
 * the type and the implementation never drift.
 */
export interface ReasoningContext {
  readonly tenantId: string;
  readonly businessCategory: string;
  readonly categorySchema: CategorySchema;
  readonly agentIdentity: AgentIdentity;
  readonly brandVoice: BrandVoice;
  readonly planLimits: ResolvedPlanLimits;
  readonly workflowRules: WorkflowRules;
  readonly subscription: {
    readonly status: SubscriptionStatus;
    readonly isOperational: boolean;
  };
  /**
   * Audience profile + resolved address style for the current customer.
   *
   * `profile` is the tenant-level config from `tenant.settings.audienceProfile`
   * (set during onboarding). `null` for tenants who haven't configured one
   * yet — the resolver still produces a sensible default in `address`.
   *
   * `address` is the per-conversation resolved style. The resolver fuses
   * conversation override → customer cue → tenant default → category default
   * → platform default and surfaces the chosen style plus an audit `source`.
   * Always populated; the agent uses `address.style` directly without
   * re-running the resolution.
   */
  readonly audience: {
    readonly profile: AudienceProfile | null;
    readonly address: ResolvedAudience;
  };
}

/**
 * Statuses for which the agent is allowed to do outbound work without
 * checking the grace-period clock. `overdue` is operational only while
 * `now < gracePeriodEndsAt` and is therefore handled separately below.
 */
const ALWAYS_OPERATIONAL_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  "trial",
  "active",
]);

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Defensive parse of `tenant.settings.brandVoice`. The column is loose JSON
 * the dashboard wrote without a Prisma migration (R23.4 — `prisma db push`
 * only). Anything other than a plain object is treated as "not set" so a
 * stray `null`/`true`/array never crashes the turn — we simply fall back to
 * `{}` and the prompt builder uses platform-default copy.
 */
function readBrandVoiceFromSettings(settings: unknown): BrandVoice {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return {};
  }
  const root = settings as Record<string, unknown>;
  const raw = root["brandVoice"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const bv = raw as Record<string, unknown>;
  const out: BrandVoice = {};
  if (typeof bv.tone === "string") out.tone = bv.tone;
  if (Array.isArray(bv.vocabulary)) {
    out.vocabulary = (bv.vocabulary as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
  }
  if (Array.isArray(bv.bannedWords)) {
    out.bannedWords = (bv.bannedWords as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
  }
  if (
    bv.emojiPreference === "minimal" ||
    bv.emojiPreference === "balanced" ||
    bv.emojiPreference === "expressive" ||
    bv.emojiPreference === "none"
  ) {
    out.emojiPreference = bv.emojiPreference;
  }
  if (
    bv.hashtagStyle === "none" ||
    bv.hashtagStyle === "few" ||
    bv.hashtagStyle === "many"
  ) {
    out.hashtagStyle = bv.hashtagStyle;
  }
  if (
    bv.language === "banglish" ||
    bv.language === "bangla" ||
    bv.language === "english"
  ) {
    out.language = bv.language;
  }
  return out;
}

/**
 * `Subscription.status` is a free-form string at the Prisma layer (the column
 * accepts any string so the state machine can evolve without a migration).
 * Narrow it back to the {@link SubscriptionStatus} union here so downstream
 * callers don't have to repeat the cast. Unknown statuses fall back to
 * `'cancelled'` (the conservative choice — `isOperational` will be false).
 */
function asSubscriptionStatus(raw: string | null | undefined): SubscriptionStatus {
  switch (raw) {
    case "trial":
    case "active":
    case "overdue":
    case "suspended":
    case "cancelled":
      return raw;
    default:
      return "cancelled";
  }
}

/**
 * Compute `isOperational` per design.md / R12.4:
 *   - trial / active        → operational
 *   - overdue + within grace → operational
 *   - everything else        → NOT operational
 *
 * Outbound surfaces (Messenger reply, content publish, follow-up send) read
 * this flag to decide whether to short-circuit the turn (design.md,
 * "Subscription Suspension Paths").
 */
function computeIsOperational(
  status: SubscriptionStatus,
  gracePeriodEndsAt: Date | null,
  now: Date,
): boolean {
  if (ALWAYS_OPERATIONAL_STATUSES.has(status)) return true;
  if (status === "overdue") {
    if (gracePeriodEndsAt === null) return false;
    return now.getTime() < gracePeriodEndsAt.getTime();
  }
  return false;
}

/**
 * Resolve plan limits with a soft fallback. `planLimitService.resolve`
 * already returns `PLATFORM_DEFAULT_PLAN_LIMITS` when the subscription row is
 * absent, but we still wrap in try/catch so a transient DB error during
 * resolve doesn't take down the whole turn — we'd rather emit a reply
 * gated by `isOperational` than throw and let the loop fall through to the
 * generic error handler.
 */
async function resolvePlanLimitsSafe(
  tenantId: string,
): Promise<ResolvedPlanLimits> {
  try {
    return await planLimitService.resolve(tenantId);
  } catch (err) {
    logger.warn(
      {
        event: "reasoning_context_plan_limit_resolve_failed",
        tenantId,
        err: serializeError(err),
      },
      "plan limit resolve failed inside Reasoning_Context builder; falling back to platform defaults",
    );
    return { ...PLATFORM_DEFAULT_PLAN_LIMITS };
  }
}

/**
 * Defaults applied when the tenant has no `Subscription` row yet (the
 * onboarding wizard's `startTrial` write hasn't landed by the time the very
 * first inbound message arrives). The agent treats this as a soft trial so
 * the first turn during onboarding doesn't get refused; the billing
 * scheduler will reconcile the actual subscription state on the next tick.
 */
const FREE_TRIAL_DEFAULT_SUBSCRIPTION: ReasoningContext["subscription"] =
  Object.freeze({
    status: "trial",
    isOperational: true,
  });

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Build the `ReasoningContext` for a tenant. See file docstring for the full
 * resolution chain and error contract.
 *
 * `conversationId` is accepted but not currently used by the builder —
 * future work (per-conversation memory windows, plan-limit accounting at
 * conversation grain) will read it. Keeping it on the signature now means
 * task 3.3's call sites don't change when those features land.
 */
export async function buildReasoningContext(args: {
  tenantId: string;
  conversationId?: string;
}): Promise<ReasoningContext> {
  const tenantId = (args?.tenantId ?? "").trim();
  if (!tenantId) {
    throw new MissingTenantScopeError(null);
  }

  // 1) Load the tenant row. Missing row → MissingTenantScopeError. Reading a
  //    narrow projection so we don't fan out into related rows here; tools
  //    fetch their own slices when they need them.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      businessCategory: true,
      settings: true,
    },
  });
  if (tenant === null) {
    throw new MissingTenantScopeError(tenantId);
  }

  // 2) Resolve the active CategorySchema. The engine handles the
  //    `categorySchemaId → built-in(businessCategory) → jersey` fallback
  //    chain + the `category_schema_fallback` warn internally.
  const categorySchema = await categoryEngine.loadCategorySchema(tenantId);

  // 3) Resolve AgentIdentity against that schema (per-tenant override →
  //    category default → platform default).
  const agentIdentity = await agentIdentityService.resolve(
    tenantId,
    categorySchema,
  );

  // 4) Resolve plan limits + feature flags. Soft fallback to platform
  //    defaults on transient DB failure.
  const planLimits = await resolvePlanLimitsSafe(tenantId);

  // 5) Subscription status. `null` → free-trial default so the first turn
  //    during onboarding still flows; populated rows feed the
  //    `isOperational` calculation.
  let subscription: ReasoningContext["subscription"];
  try {
    const subRow = await subscriptionService.getStatus(tenantId);
    if (subRow === null) {
      subscription = FREE_TRIAL_DEFAULT_SUBSCRIPTION;
    } else {
      const status = asSubscriptionStatus(subRow.status);
      subscription = {
        status,
        isOperational: computeIsOperational(
          status,
          subRow.gracePeriodEndsAt ?? null,
          new Date(),
        ),
      };
    }
  } catch (err) {
    // A subscription read failure is recoverable — log and treat as the
    // free-trial default so the agent doesn't refuse outbound work for a
    // transient DB hiccup. The billing scheduler is the authoritative gate
    // for suspension; if we're genuinely suspended, the next tick will
    // catch the next turn.
    logger.warn(
      {
        event: "reasoning_context_subscription_read_failed",
        tenantId,
        err: serializeError(err),
      },
      "subscription read failed inside Reasoning_Context builder; falling back to free-trial default",
    );
    subscription = FREE_TRIAL_DEFAULT_SUBSCRIPTION;
  }

  // 6) Validate the three required Reasoning_Context keys are populated.
  //    `tenantId` is non-null by construction here (we already threw above
  //    on empty), but we keep it in the missing-keys check so the error
  //    contract stays exhaustive and matches the design's R7.6 wording.
  const missingKeys: Array<
    "tenantId" | "businessCategory" | "categorySchema"
  > = [];
  if (!tenant.id) missingKeys.push("tenantId");
  if (!tenant.businessCategory) missingKeys.push("businessCategory");
  if (!categorySchema) missingKeys.push("categorySchema");
  if (missingKeys.length > 0) {
    logger.warn(
      {
        event: "reasoning_context_incomplete",
        tenantId,
        missingKeys,
      },
      "Reasoning_Context is incomplete; aborting turn before observe_input",
    );
    throw new ReasoningContextIncompleteError(tenantId, missingKeys);
  }

  // 7) Compose + freeze. `businessCategory` is asserted non-null by the
  //    missing-keys gate above; the cast keeps strict-mode happy.
  const businessCategory = tenant.businessCategory as string;
  const brandVoice = readBrandVoiceFromSettings(tenant.settings);

  // 7a) Audience resolution — combines tenant config, conversation override,
  //     and the customer's latest cue into a single resolved address style
  //     so the prompt builder and reply filter both read the same answer.
  //
  //     The conversation override and the latest customer message both
  //     require the conversationId, so we only fetch those when present.
  //     For test fixtures (no conversationId) the resolver falls through
  //     to the tenant default → category default → platform default chain.
  const tenantProfile = parseAudienceProfile(tenant.settings);
  let conversationOverride: ResolvedAudience["style"] | null = null;
  let latestCustomerMessage: string | null = null;
  if (args.conversationId) {
    try {
      const convo = await prisma.messengerConversation.findUnique({
        where: { id: args.conversationId },
        select: { pendingDraftJson: true },
      });
      const draft = convo?.pendingDraftJson;
      if (draft && typeof draft === "object" && !Array.isArray(draft)) {
        const prefs = (draft as Record<string, unknown>)["preferences"];
        if (prefs && typeof prefs === "object" && !Array.isArray(prefs)) {
          const raw = (prefs as Record<string, unknown>)["addressStyle"];
          if (
            raw === "bhaiya" ||
            raw === "apu" ||
            raw === "sir" ||
            raw === "madam" ||
            raw === "bondhu"
          ) {
            conversationOverride = raw;
          }
        }
      }
      // Latest inbound text — drives the customer-cue layer of the resolver.
      const latest = await prisma.messengerMessage.findFirst({
        where: { conversationId: args.conversationId, role: "user" },
        orderBy: { createdAt: "desc" },
        select: { text: true },
      });
      latestCustomerMessage = latest?.text ?? null;
    } catch (err) {
      logger.warn(
        {
          event: "reasoning_context_audience_lookup_failed",
          tenantId,
          conversationId: args.conversationId,
          err: serializeError(err),
        },
        "audience lookup failed inside Reasoning_Context builder; falling back to defaults",
      );
    }
  }
  const resolvedAddress = resolveAddressStyle({
    tenantProfile,
    conversationOverride,
    latestCustomerMessage,
  });

  const context: ReasoningContext = {
    tenantId,
    businessCategory,
    categorySchema,
    agentIdentity,
    brandVoice,
    planLimits,
    workflowRules: categorySchema.workflowRules,
    subscription,
    audience: {
      profile: tenantProfile,
      address: resolvedAddress,
    },
  };
  return Object.freeze(context);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function serializeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
