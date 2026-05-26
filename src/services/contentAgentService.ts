/**
 * Autonomous content agent (Reqs 3, 4, 9, 11, 13, 14).
 *
 * Runs per-tenant on a cadence configured in `tenant.settings.contentAgent`.
 * Picks products from `ProductMapping` that haven't been featured in the last
 * N posts, drafts captions in the tenant's brand voice + a rotating style,
 * and queues them as `pending_approval` (default) or `scheduled` (if the
 * tenant set autonomy = full).
 *
 * Storage: zero schema migrations. The agent's config lives on
 * `tenant.settings.contentAgent` (loose JSON), recent-feature memory is
 * derived from `ScheduledPost.productSkus` rows, and run history is logged
 * via the structured logger.
 *
 * Tier 2 polish — this is INTENTIONALLY a deterministic strategist, not a
 * full reasoning loop. The "agentic" feel comes from:
 *   - never repeating a recently-featured product (memory derived from posts)
 *   - rotating caption styles so the feed doesn't feel monotonous
 *   - rotating post types (showcase/collection/story)
 *   - honoring autonomy mode (off / draft / auto)
 *   - honoring posting hours, frequency cap, preferred/excluded products
 */

import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { generateCaption, type BrandVoice } from "./socialPostService.js";

// ─── Settings shape (lives on tenant.settings.contentAgent JSON) ─────────────

export type ContentAgentMode = "off" | "draft" | "auto";

export type ContentAgentSettings = {
  /**
   * - `off`: agent never runs.
   * - `draft`: agent generates posts as `pending_approval` so the client
   *   approves them in the calendar UI before they go out (Mode 2 from spec).
   * - `auto`: agent creates posts as `scheduled` so the post-scheduler tick
   *   publishes them at scheduledAt (Mode 1 from spec).
   */
  mode?: ContentAgentMode;
  /** Posts per day cap (default 1). 0 disables. */
  postsPerDay?: number;
  /** Lookback window — products featured within this many days are skipped. */
  rotationWindowDays?: number;
  /** Posting hour window in tenant local time (0-23). Default 10-20. */
  postingHourStart?: number;
  postingHourEnd?: number;
  /** Platform target for new posts (default "facebook"). */
  defaultPlatform?: string;
  /** Allow-list / deny-list of clientSkus. Empty preferred[] = consider all. */
  preferredSkus?: string[];
  excludedSkus?: string[];
  /** Caption style preference; "rotate" cycles through the catalog. */
  captionStyle?: string;
  /**
   * Internal cursor used to round-robin through styles when
   * `captionStyle === "rotate"`. The agent bumps this on every successful
   * draft so consecutive drafts hit different styles.
   */
  styleCursor?: number;
};

const DEFAULT_SETTINGS: Required<Omit<ContentAgentSettings, "preferredSkus" | "excludedSkus">> & {
  preferredSkus: string[];
  excludedSkus: string[];
} = {
  mode: "off",
  postsPerDay: 1,
  rotationWindowDays: 7,
  postingHourStart: 10,
  postingHourEnd: 20,
  defaultPlatform: "facebook",
  preferredSkus: [],
  excludedSkus: [],
  captionStyle: "rotate",
  styleCursor: 0,
};

const ROTATION_STYLES: ReadonlyArray<string> = [
  "default",
  "trendy",
  "sales",
  "storytelling",
  "minimal",
  "promotional",
  "luxury",
  "sports",
];

const ROTATION_POST_TYPES: ReadonlyArray<string> = [
  "product_showcase",
  "product_showcase",
  "collection",
  "story",
];

// ─── Settings parse / persist ───────────────────────────────────────────────

export function parseContentAgentSettings(raw: unknown): typeof DEFAULT_SETTINGS {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const mode: ContentAgentMode =
    r.mode === "draft" || r.mode === "auto" || r.mode === "off" ? r.mode : DEFAULT_SETTINGS.mode;
  const postsPerDay = Number.isFinite(Number(r.postsPerDay)) ? Math.max(0, Math.min(10, Number(r.postsPerDay))) : DEFAULT_SETTINGS.postsPerDay;
  const rotationWindowDays = Number.isFinite(Number(r.rotationWindowDays))
    ? Math.max(0, Math.min(60, Number(r.rotationWindowDays)))
    : DEFAULT_SETTINGS.rotationWindowDays;
  const postingHourStart = Number.isFinite(Number(r.postingHourStart))
    ? Math.max(0, Math.min(23, Math.floor(Number(r.postingHourStart))))
    : DEFAULT_SETTINGS.postingHourStart;
  const postingHourEnd = Number.isFinite(Number(r.postingHourEnd))
    ? Math.max(0, Math.min(23, Math.floor(Number(r.postingHourEnd))))
    : DEFAULT_SETTINGS.postingHourEnd;
  return {
    mode,
    postsPerDay,
    rotationWindowDays,
    postingHourStart,
    postingHourEnd,
    defaultPlatform: typeof r.defaultPlatform === "string" ? r.defaultPlatform : DEFAULT_SETTINGS.defaultPlatform,
    preferredSkus: Array.isArray(r.preferredSkus)
      ? (r.preferredSkus as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    excludedSkus: Array.isArray(r.excludedSkus)
      ? (r.excludedSkus as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    captionStyle: typeof r.captionStyle === "string" ? r.captionStyle : DEFAULT_SETTINGS.captionStyle,
    styleCursor: Number.isFinite(Number(r.styleCursor)) ? Math.max(0, Math.floor(Number(r.styleCursor))) : 0,
  };
}

async function persistAgentCursor(tenantId: string, nextCursor: number): Promise<void> {
  // Read-modify-write the contentAgent block on tenant.settings. Best-effort —
  // a failure here just means the next run picks the same style as last time,
  // which is harmless.
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return;
    const settings = (tenant.settings ?? {}) as Record<string, unknown>;
    const ca = (settings.contentAgent ?? {}) as Record<string, unknown>;
    const merged = { ...settings, contentAgent: { ...ca, styleCursor: nextCursor } };
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: merged as object },
    });
  } catch (e) {
    logger.warn({ e: String(e), tenantId }, "contentAgent: persist styleCursor failed");
  }
}

// ─── Brand voice + product helpers ──────────────────────────────────────────

function readBrandVoice(settings: Record<string, unknown>): BrandVoice {
  const bv = (settings["brandVoice"] ?? {}) as Record<string, unknown>;
  const out: BrandVoice = {};
  if (typeof bv.tone === "string") out.tone = bv.tone;
  if (Array.isArray(bv.vocabulary)) out.vocabulary = (bv.vocabulary as unknown[]).filter((x): x is string => typeof x === "string");
  if (Array.isArray(bv.bannedWords)) out.bannedWords = (bv.bannedWords as unknown[]).filter((x): x is string => typeof x === "string");
  if (bv.emojiPreference === "minimal" || bv.emojiPreference === "balanced" || bv.emojiPreference === "expressive" || bv.emojiPreference === "none") {
    out.emojiPreference = bv.emojiPreference;
  }
  if (bv.hashtagStyle === "none" || bv.hashtagStyle === "few" || bv.hashtagStyle === "many") {
    out.hashtagStyle = bv.hashtagStyle;
  }
  if (bv.language === "banglish" || bv.language === "bangla" || bv.language === "english") {
    out.language = bv.language;
  }
  return out;
}

function readProductImages(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const m = meta as Record<string, unknown>;
  const out: string[] = [];
  if (typeof m.image_url === "string" && m.image_url.startsWith("http")) out.push(m.image_url);
  for (const arr of [m.image_urls, m.images, m.photos]) {
    if (Array.isArray(arr)) {
      for (const u of arr) {
        if (typeof u === "string" && u.startsWith("http")) out.push(u);
      }
    }
  }
  return [...new Set(out)];
}

function readProductTags(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const t = (meta as Record<string, unknown>).tags;
  if (!Array.isArray(t)) return [];
  return (t as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 8);
}

// ─── Result types ────────────────────────────────────────────────────────────

export type ContentAgentRunResult = {
  ok: boolean;
  /** Why no posts were drafted; null on success. */
  skipped: string | null;
  /** Posts created this run. */
  drafted: Array<{ postId: string; status: string; clientSku: string; style: string }>;
  /** Diagnostics for the operator. */
  reasoning: string[];
};

// ─── Per-tenant run ──────────────────────────────────────────────────────────

/**
 * Drive ONE pass of the agent for the given tenant. Idempotent: callable from
 * a cron tick or the manual "Run agent now" button. Caps drafts at the
 * remaining `postsPerDay` budget so calling it twice in a day doesn't flood
 * the calendar.
 */
export async function runContentAgent(tenantId: string): Promise<ContentAgentRunResult> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    return { ok: false, skipped: "tenant_not_found", drafted: [], reasoning: [] };
  }
  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  const cfg = parseContentAgentSettings(settings.contentAgent);
  const reasoning: string[] = [];
  reasoning.push(`mode=${cfg.mode} postsPerDay=${cfg.postsPerDay} window=${cfg.rotationWindowDays}d`);

  if (cfg.mode === "off" || cfg.postsPerDay === 0) {
    return { ok: true, skipped: "agent_off", drafted: [], reasoning };
  }

  // Daily budget: count how many posts the agent already created today and
  // bail if we've hit the cap. We tag agent-created rows by checking the
  // post's `failureReason` for our marker — simpler than adding a column.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayCount = await prisma.scheduledPost.count({
    where: {
      tenantId,
      createdAt: { gte: dayStart },
      // Agent-created posts have postType prefix "agent_"
      postType: { startsWith: "agent_" },
    },
  });
  reasoning.push(`today_count=${todayCount}/${cfg.postsPerDay}`);
  const remaining = Math.max(0, cfg.postsPerDay - todayCount);
  if (remaining === 0) {
    return { ok: true, skipped: "daily_quota_reached", drafted: [], reasoning };
  }

  // Pull catalog. Empty catalog → nothing to feature.
  const mappings = await prisma.productMapping.findMany({
    where: { tenantId },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
  if (mappings.length === 0) {
    return { ok: true, skipped: "empty_catalog", drafted: [], reasoning };
  }
  reasoning.push(`catalog=${mappings.length}`);

  // Filter by allow / deny lists.
  const excluded = new Set(cfg.excludedSkus);
  const preferred = new Set(cfg.preferredSkus);
  let candidates = mappings.filter((m) => !excluded.has(m.clientSku));
  if (preferred.size > 0) {
    const preferredHits = candidates.filter((m) => preferred.has(m.clientSku));
    if (preferredHits.length > 0) {
      candidates = preferredHits;
      reasoning.push(`preferred_filter=${preferredHits.length}`);
    } else {
      reasoning.push("preferred_set_but_no_matches; falling back to full catalog");
    }
  }

  // Drop any product without at least one usable image — Facebook posting
  // works without images but Instagram requires one, and a feed without
  // visuals performs poorly.
  candidates = candidates.filter((m) => readProductImages(m.metadata).length > 0);
  if (candidates.length === 0) {
    return { ok: true, skipped: "no_imageable_products", drafted: [], reasoning };
  }

  // Recency filter: skip products featured in the rotation window.
  const windowMs = cfg.rotationWindowDays * 24 * 60 * 60 * 1000;
  const windowStart = new Date(Date.now() - windowMs);
  const recentPosts = await prisma.scheduledPost.findMany({
    where: { tenantId, createdAt: { gte: windowStart } },
    select: { productSkus: true },
  });
  const recentlyFeatured = new Set<string>();
  for (const rp of recentPosts) {
    const skus = Array.isArray(rp.productSkus) ? (rp.productSkus as unknown[]) : [];
    for (const s of skus) {
      if (typeof s === "string") recentlyFeatured.add(s);
    }
  }
  reasoning.push(`recently_featured=${recentlyFeatured.size}`);
  let fresh = candidates.filter((m) => !recentlyFeatured.has(m.clientSku));
  if (fresh.length === 0) {
    // Everything was featured recently — fall back to the whole candidate set
    // so the agent still posts SOMETHING, but the operator should widen the
    // rotation window.
    reasoning.push("all_candidates_featured_recently; falling back to full set");
    fresh = candidates;
  }

  const brandVoice = readBrandVoice(settings);

  // Schedule slot inside the tenant's posting window. Use the next available
  // slot starting at the window start, spaced 30min apart so multiple drafts
  // don't all land at the same time.
  const slots: Date[] = computePostingSlots({
    count: remaining,
    hourStart: cfg.postingHourStart,
    hourEnd: cfg.postingHourEnd,
  });
  reasoning.push(`slots=${slots.map((s) => s.toISOString()).join(",")}`);

  const drafted: ContentAgentRunResult["drafted"] = [];
  let cursor = cfg.styleCursor;

  for (let i = 0; i < remaining && i < fresh.length; i += 1) {
    const product = fresh[i]!;
    const meta = product.metadata as unknown;
    const productLabel = (product.facebookLabel ?? product.clientSku).trim();
    // Prices are intentionally NOT passed to the caption generator — captions
    // must stay price-free on the public feed (Req: agentic captions, no price).
    const tags = readProductTags(meta);
    const images = readProductImages(meta).slice(0, 4);

    // Pick caption style. "rotate" cycles ROTATION_STYLES; any other value is
    // used verbatim.
    const style = cfg.captionStyle === "rotate" ? ROTATION_STYLES[cursor % ROTATION_STYLES.length]! : cfg.captionStyle;
    const postType = ROTATION_POST_TYPES[cursor % ROTATION_POST_TYPES.length]!;
    cursor += 1;

    let caption: string;
    try {
      caption = await generateCaption({
        productNames: [productLabel],
        prices: [],
        tags,
        postType,
        style,
        brandVoice,
      });
    } catch (e) {
      logger.warn({ e: String(e), tenantId, sku: product.clientSku }, "contentAgent: caption gen failed; falling back");
      // Fallback never includes price — captions must stay price-free on the
      // public feed.
      caption = `🔥 ${productLabel} — DM kore order korun 📩`;
    }

    const scheduledAt = slots[i] ?? new Date(Date.now() + 30 * 60 * 1000);
    const status = cfg.mode === "auto" ? "scheduled" : "pending_approval";

    const post = await prisma.scheduledPost.create({
      data: {
        tenantId,
        platform: cfg.defaultPlatform,
        // `agent_` prefix lets the daily-quota counter find these without a
        // schema column.
        postType: `agent_${postType}`,
        caption,
        imageUrls: images,
        productSkus: [product.clientSku],
        scheduledAt,
        status,
      },
    });
    drafted.push({ postId: post.id, status, clientSku: product.clientSku, style });
    reasoning.push(`drafted ${product.clientSku} style=${style} status=${status}`);
  }

  await persistAgentCursor(tenantId, cursor);
  logger.info(
    { tenantId, mode: cfg.mode, drafted: drafted.length, reasoning },
    "contentAgent: run complete",
  );

  return { ok: true, skipped: null, drafted, reasoning };
}

// ─── Posting slot computation ────────────────────────────────────────────────

/**
 * Compute up to `count` evenly-spaced posting timestamps inside today's
 * posting window. If "now" is past the window, all slots roll to tomorrow.
 *
 * Pure / unit-testable: depends only on the supplied count + window, not on
 * tenant state.
 */
export function computePostingSlots(args: {
  count: number;
  hourStart: number;
  hourEnd: number;
  now?: Date;
}): Date[] {
  const now = args.now ?? new Date();
  const start = new Date(now);
  start.setHours(args.hourStart, 0, 0, 0);
  const end = new Date(now);
  end.setHours(args.hourEnd, 0, 0, 0);

  // If we're already past the window's end, push everything to tomorrow.
  if (now.getTime() > end.getTime()) {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 1);
  }

  // First slot is the LATER of "now + 5min" or window start.
  const earliest = new Date(Math.max(now.getTime() + 5 * 60 * 1000, start.getTime()));
  const windowMs = end.getTime() - earliest.getTime();
  if (args.count <= 0 || windowMs <= 0) return [];

  // Even spacing inside the remaining window.
  const stepMs = args.count > 1 ? Math.max(15 * 60 * 1000, windowMs / args.count) : windowMs;
  const out: Date[] = [];
  for (let i = 0; i < args.count; i += 1) {
    const t = new Date(earliest.getTime() + i * stepMs);
    if (t.getTime() <= end.getTime()) out.push(t);
  }
  return out;
}

// ─── Cron entry point ────────────────────────────────────────────────────────

/**
 * Drain every tenant whose contentAgent.mode is not "off" once per call.
 * Wired into the existing `postSchedulerService` tick so it runs hourly. Safe
 * to call multiple times — `runContentAgent` enforces the daily quota.
 */
export async function runContentAgentForAllTenants(): Promise<void> {
  // Cheap filter: scan all tenants, then bail per-tenant when the mode is
  // off. The tenant table is small for now (single-digit count) so a full
  // scan is fine.
  const tenants = await prisma.tenant.findMany({
    select: { id: true, settings: true },
  });
  for (const t of tenants) {
    const settings = (t.settings ?? {}) as Record<string, unknown>;
    const cfg = parseContentAgentSettings(settings.contentAgent);
    if (cfg.mode === "off" || cfg.postsPerDay === 0) continue;
    try {
      await runContentAgent(t.id);
    } catch (e) {
      logger.error({ e: String(e), tenantId: t.id }, "contentAgent: tenant run failed");
    }
  }
}
