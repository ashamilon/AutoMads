/**
 * Photo Caption Agent — second agentic mode for the Content Calendar.
 *
 * The first agent (`contentAgentService.runContentAgent`) walks the tenant
 * **catalog** and drafts product-aware captions ("Brazil WC26 — 1490 BDT"
 * style). This one is the opposite: the tenant has a Cloudinary folder
 * full of lifestyle / promotional / random brand photos with no catalog
 * row attached, and they want a steady stream of short, hype-style posts
 * ("Bomb 🔥", "Poysa ushul", "Trending now") going out automatically.
 *
 * Decisions (per user spec, kept here for future maintenance):
 *   1. Cadence is `tenant.settings.photoCaptionAgent.postsPerDay`.
 *   2. Photo selection: random from the folder, no repeat until every
 *      photo has been used at least once. We track this with a row on
 *      `ScheduledPost` (matched by `productSkus = ["photo:" + public_id]`).
 *   3. Captions: short, 1–5 hype phrases, drawing from `captionHints[]`
 *      that the tenant types into the dashboard. The LLM can mix Banglish
 *      / English / Bangla as needed.
 *   4. Auto-publish — drafts go straight to `status="scheduled"`, no
 *      approval gate.
 *   5. Cloudinary access uses the tenant's saved Cloudinary creds (under
 *      `tenant.settings.cloudinary`) or, as fallback, the platform-level
 *      env credentials.
 */

import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { ollamaChat } from "../llm/ollamaChat.js";
import { listAllCloudinaryImages } from "./cloudinaryCatalogImageSync.js";
import { resolveCloudinaryListArgs } from "../utils/resolveCloudinaryTenantOrEnv.js";
import { computePostingSlots } from "./contentAgentService.js";

// ─── Settings shape ──────────────────────────────────────────────────────────

export type PhotoCaptionAgentSettings = {
  /** Master kill-switch. */
  enabled?: boolean;
  /** Cloudinary folder prefix, e.g. `lifestyle/wc26/`. Trailing slash is
   *  optional — we normalise. Empty = use the catalog prefix env fallback. */
  cloudinaryFolder?: string;
  /** Words / short phrases the tenant wants the caption to draw from. The
   *  LLM is told to use 1-5 of these (verbatim or paraphrased) per post.
   *  Examples: "bomb", "poysa ushul", "fresh stock", "limited drop". */
  captionHints?: string[];
  /** Posts per day cap (default 1). Honour 0 = disabled. */
  postsPerDay?: number;
  /** Posting window in tenant local time. Falls back to the contentAgent
   *  window if unset. */
  postingHourStart?: number;
  postingHourEnd?: number;
  /** Default platform target. */
  defaultPlatform?: string;
  /** Caption language preference; defaults to mixed Banglish per spec. */
  language?: "banglish" | "bangla" | "english" | "mixed";
};

const DEFAULT: Required<Omit<PhotoCaptionAgentSettings, "captionHints">> & {
  captionHints: string[];
} = {
  enabled: false,
  cloudinaryFolder: "",
  captionHints: [],
  postsPerDay: 1,
  postingHourStart: 11,
  postingHourEnd: 19,
  defaultPlatform: "facebook",
  language: "mixed",
};

export function parsePhotoCaptionAgentSettings(raw: unknown): typeof DEFAULT {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT };
  const r = raw as Record<string, unknown>;
  const enabled = r.enabled === true;
  const cloudinaryFolder =
    typeof r.cloudinaryFolder === "string" ? r.cloudinaryFolder.trim() : DEFAULT.cloudinaryFolder;
  const captionHints = Array.isArray(r.captionHints)
    ? (r.captionHints as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 30)
    : [];
  const postsPerDay = Number.isFinite(Number(r.postsPerDay))
    ? Math.max(0, Math.min(20, Number(r.postsPerDay)))
    : DEFAULT.postsPerDay;
  const postingHourStart = Number.isFinite(Number(r.postingHourStart))
    ? Math.max(0, Math.min(23, Math.floor(Number(r.postingHourStart))))
    : DEFAULT.postingHourStart;
  const postingHourEnd = Number.isFinite(Number(r.postingHourEnd))
    ? Math.max(0, Math.min(23, Math.floor(Number(r.postingHourEnd))))
    : DEFAULT.postingHourEnd;
  const defaultPlatform =
    typeof r.defaultPlatform === "string" ? r.defaultPlatform : DEFAULT.defaultPlatform;
  const language: PhotoCaptionAgentSettings["language"] =
    r.language === "banglish" || r.language === "bangla" || r.language === "english" || r.language === "mixed"
      ? r.language
      : DEFAULT.language;
  return {
    enabled,
    cloudinaryFolder,
    captionHints,
    postsPerDay,
    postingHourStart,
    postingHourEnd,
    defaultPlatform,
    language,
  };
}

// ─── Caption generator ───────────────────────────────────────────────────────

/**
 * Ask the LLM for one short, punchy caption that mixes 1-5 of the tenant's
 * hint phrases naturally. Falls back to a simple concatenation when the LLM
 * is unreachable so the agent never blocks on a single bad call.
 */
/**
 * Phrases we MUST strip / never emit on a photo post. The photo agent's
 * captions are pure praise — no "order this", no "DM us", no commercial
 * CTAs. The product-catalog agent has a separate flow for that.
 *
 * Patterns are checked case-insensitively against the LLM output. If any
 * match, we drop that phrase and trim — same goes for the deterministic
 * fallback so a misbehaving model can never re-introduce them.
 */
const BANNED_CTA_PATTERNS: RegExp[] = [
  /\bDM\s*(kore?|kora?|kor)?\s*order\b.*$/im,
  /\bDM\s*(kore?|kora?|kor)?\s*korun\b.*$/im,
  /\bDM\s*(us|now|me|please)?\s*to\s*order\b.*$/im,
  /\binbox\s*(koro|korun|kore?n?|now)?\b.*$/im,
  /\border\s*(now|korun|kore?n?|kora?)\b.*$/im,
  /\bnibo\s*ki\b.*$/im,
  /\bavailable\s*now\b.*$/im,
  /\bstock\s*(limited|cholche|ase|nai)\b.*$/im,
  /📩|📨|🛒|🛍/g,
];

function stripCtas(input: string): string {
  let out = input;
  for (const rx of BANNED_CTA_PATTERNS) {
    out = out.replace(rx, "");
  }
  // Collapse leftover dangling punctuation / multiple newlines.
  return out.replace(/[\s\u200b]+$/g, "").replace(/\n{2,}/g, "\n").trim();
}

/**
 * Pick `k` random elements from `arr` without replacement. Crypto-grade
 * randomness isn't needed; we just want true variation across runs so the
 * tenant's feed doesn't have 8 identical captions in a row.
 */
function sampleWithoutReplacement<T>(arr: T[], k: number): T[] {
  const pool = arr.slice();
  const out: T[] = [];
  const target = Math.min(k, pool.length);
  for (let i = 0; i < target; i += 1) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}

async function generateHypeCaption(args: {
  hints: string[];
  language: PhotoCaptionAgentSettings["language"];
}): Promise<string> {
  if (args.hints.length === 0) {
    return "🔥 Bomb";
  }

  // Pick a *small* random sample (1-2 hints) — these are STYLE EXAMPLES we
  // show the model, not phrases the model must use verbatim. The model is
  // told to invent something new in the same vibe.
  const k = 1 + Math.floor(Math.random() * 2); // 1 or 2
  const styleSamples = sampleWithoutReplacement(args.hints, k);

  const langInstruction =
    args.language === "english"
      ? "Use natural English."
      : args.language === "bangla"
        ? "Write in Bangla script."
        : args.language === "banglish"
          ? "Use Banglish (Bangla in Roman/English letters)."
          : "Mix Banglish and English freely — whatever sounds natural.";

  const sys = [
    "You write 2-4 word HYPE captions for a Bangladeshi shop's product photo posts.",
    "The user provides a few example phrases that show the BRAND'S VIBE / TONE.",
    "DO NOT copy or paste the example phrases. Use them only to learn the style.",
    "INVENT a fresh, original 2-4 word caption that captures the same energy.",
    "Style cues: punchy, casual, like a friend reacting in a Whatsapp group.",
    "RULES:",
    "  - Output 2 to 4 words only. NEVER more than 5 words total.",
    "  - NEVER repeat any example phrase verbatim.",
    "  - NEVER use these words anywhere: DM, inbox, order, korun, kore, kora, available, stock, nibo, niye, niben, price, BDT, taka, ৳.",
    "  - At most ONE emoji. Use whatever fits the vibe (🔥 ⚡ 😍 🤯 👀 🥵 ✨ etc).",
    "  - No hashtags. No quotes. No labels. No CTA.",
    langInstruction,
    "Return ONLY the caption — nothing else.",
  ].join(" ");

  const usr = [
    "Style examples (these show the brand's voice — DON'T reuse them, just match the energy):",
    ...styleSamples.map((p) => `  • ${p}`),
    "",
    "Now invent a NEW 2-4 word caption in the same vibe.",
    "It must be DIFFERENT from every example above.",
  ].join("\n");

  try {
    const res = await ollamaChat(
      {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: usr },
        ],
        // Very high temperature — we WANT the model to invent something new
        // every call, not pattern-match into the safest option.
        options: { temperature: 1.1, num_predict: 30 },
      },
      { timeoutMs: 30_000 },
    );
    if (res.status !== 200) {
      throw new Error(`ollama_status_${res.status}`);
    }
    const raw = String(res.data?.message?.content ?? "").trim();
    let cleaned = raw
      .replace(/^[\s"'`*]+|[\s"'`*]+$/g, "")
      .replace(/^Caption:\s*/i, "")
      .replace(/^Output:\s*/i, "")
      .trim();
    cleaned = stripCtas(cleaned);

    // Reject the result if it's an exact copy of any hint phrase. When this
    // happens, the LLM hasn't done its job — fall through to fallback.
    const lc = cleaned.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const isCopy = args.hints.some((h) => {
      const hLc = h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      return hLc.length > 0 && (lc === hLc || lc.startsWith(hLc + " ") || lc.endsWith(" " + hLc));
    });
    if (isCopy) throw new Error("verbatim_copy");

    // Hard word-count cap: 5 words max.
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length > 5) cleaned = words.slice(0, 5).join(" ");
    if (cleaned.length >= 3) return cleaned;
    throw new Error("empty_caption");
  } catch (e) {
    logger.warn(
      { e: String(e) },
      "photoCaptionAgent: LLM caption gen failed; using paraphrased fallback",
    );
    // Fallback ONLY runs if both cloud and local models failed. Generate a
    // tiny synthetic caption that's not a verbatim hint. Strategy: emoji +
    // generic praise word, no shop CTAs.
    const PRAISE_WORDS = [
      "Fire 🔥",
      "Heatwave ⚡",
      "🤯",
      "Insane",
      "Crazy good",
      "Eyes wide",
      "Dekhle taak",
      "Touch koro",
      "Legit 🔥",
      "Premium vibe",
      "👀👀",
      "Onek hard",
      "Stunning",
      "Eye-catcher",
    ];
    return PRAISE_WORDS[Math.floor(Math.random() * PRAISE_WORDS.length)]!;
  }
}

// ─── Cloudinary folder iteration + dedup ─────────────────────────────────────

type CloudinaryAsset = Awaited<ReturnType<typeof listAllCloudinaryImages>>[number];

function photoSkuTag(publicId: string): string {
  // Prefix lets us search ScheduledPost rows for "already posted this image"
  // without colliding with real catalog SKUs.
  return `photo:${publicId}`;
}

/**
 * Pick a random Cloudinary asset from the folder that has NOT been used by
 * this agent yet. Resets the cycle once every photo has been posted at
 * least once.
 */
async function pickUnusedPhoto(args: {
  tenantId: string;
  assets: CloudinaryAsset[];
}): Promise<CloudinaryAsset | null> {
  if (args.assets.length === 0) return null;

  // Collect every public_id this agent has already posted (no time horizon —
  // we want full-folder rotation regardless of how long ago the post was).
  const previous = await prisma.scheduledPost.findMany({
    where: {
      tenantId: args.tenantId,
      postType: "agent_photo_caption",
    },
    select: { productSkus: true },
  });
  const usedIds = new Set<string>();
  for (const p of previous) {
    const skus = Array.isArray(p.productSkus) ? (p.productSkus as unknown[]) : [];
    for (const s of skus) {
      if (typeof s === "string" && s.startsWith("photo:")) {
        usedIds.add(s.slice("photo:".length));
      }
    }
  }

  const unused = args.assets.filter((a) => !usedIds.has(a.publicId));
  // If every photo has been posted at least once, reset the cycle by
  // ignoring the dedup set (we still pick randomly, just from the full
  // folder again).
  const pool = unused.length > 0 ? unused : args.assets;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

// ─── Result types ────────────────────────────────────────────────────────────

export type PhotoCaptionAgentRunResult = {
  ok: boolean;
  skipped: string | null;
  drafted: Array<{ postId: string; publicId: string; caption: string }>;
  reasoning: string[];
};

// ─── Per-tenant run ──────────────────────────────────────────────────────────

/**
 * One pass of the photo-caption agent for a tenant. Idempotent + safe to
 * call multiple times per day — the daily quota check (postsPerDay) bounds
 * how many drafts get created.
 */
export async function runPhotoCaptionAgent(tenantId: string): Promise<PhotoCaptionAgentRunResult> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    return { ok: false, skipped: "tenant_not_found", drafted: [], reasoning: [] };
  }
  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  const cfg = parsePhotoCaptionAgentSettings(settings.photoCaptionAgent);
  const reasoning: string[] = [];
  reasoning.push(
    `enabled=${cfg.enabled} folder="${cfg.cloudinaryFolder}" hints=${cfg.captionHints.length} postsPerDay=${cfg.postsPerDay}`,
  );

  if (!cfg.enabled || cfg.postsPerDay === 0) {
    return { ok: true, skipped: "agent_off", drafted: [], reasoning };
  }
  if (cfg.captionHints.length === 0) {
    return { ok: true, skipped: "no_caption_hints", drafted: [], reasoning };
  }

  // Daily budget — count drafts this agent already created today.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayCount = await prisma.scheduledPost.count({
    where: {
      tenantId,
      createdAt: { gte: dayStart },
      postType: "agent_photo_caption",
    },
  });
  reasoning.push(`today_count=${todayCount}/${cfg.postsPerDay}`);
  const remaining = Math.max(0, cfg.postsPerDay - todayCount);
  if (remaining === 0) {
    return { ok: true, skipped: "daily_quota_reached", drafted: [], reasoning };
  }

  // Resolve Cloudinary credentials. Per-tenant first, env fallback second.
  const resolved = resolveCloudinaryListArgs(tenant.settings, cfg.cloudinaryFolder);
  if (!resolved) {
    return {
      ok: false,
      skipped: "cloudinary_not_configured",
      drafted: [],
      reasoning: [
        ...reasoning,
        "Tenant has no saved Cloudinary creds and the platform env fallback is empty.",
      ],
    };
  }
  const { cloudName, apiKey, apiSecret, prefix } = resolved;
  reasoning.push(`cloudinary_prefix="${prefix ?? ""}" cloud=${cloudName}`);

  let assets: CloudinaryAsset[] = [];
  try {
    assets = await listAllCloudinaryImages({ cloudName, apiKey, apiSecret, prefix });
  } catch (e) {
    logger.warn({ e: String(e), tenantId }, "photoCaptionAgent: cloudinary list failed");
    return {
      ok: false,
      skipped: "cloudinary_list_failed",
      drafted: [],
      reasoning: [...reasoning, `error: ${String(e)}`],
    };
  }
  reasoning.push(`folder_assets=${assets.length}`);
  if (assets.length === 0) {
    return { ok: true, skipped: "folder_empty", drafted: [], reasoning };
  }

  // Compute up to `remaining` posting slots for today.
  const slots: Date[] = computePostingSlots({
    count: remaining,
    hourStart: cfg.postingHourStart,
    hourEnd: cfg.postingHourEnd,
  });

  const drafted: PhotoCaptionAgentRunResult["drafted"] = [];

  for (let i = 0; i < remaining; i += 1) {
    const photo = await pickUnusedPhoto({ tenantId, assets });
    if (!photo) break;

    let caption: string;
    try {
      caption = await generateHypeCaption({
        hints: cfg.captionHints,
        language: cfg.language,
      });
    } catch (e) {
      logger.warn({ e: String(e), tenantId }, "photoCaptionAgent: caption gen failed");
      continue;
    }

    const scheduledAt = slots[i] ?? new Date(Date.now() + (i + 1) * 30 * 60 * 1000);

    try {
      const post = await prisma.scheduledPost.create({
        data: {
          tenantId,
          platform: cfg.defaultPlatform,
          postType: "agent_photo_caption",
          caption,
          imageUrls: [photo.secureUrl],
          // Reuse productSkus as the dedup key. Prefix prevents collision
          // with real SKU identifiers.
          productSkus: [photoSkuTag(photo.publicId)],
          scheduledAt,
          status: "scheduled",
        },
      });
      drafted.push({ postId: post.id, publicId: photo.publicId, caption });
      reasoning.push(`drafted ${photo.publicId} → ${post.id}`);
    } catch (e) {
      logger.warn({ e: String(e), tenantId, publicId: photo.publicId }, "photoCaptionAgent: insert failed");
    }
  }

  logger.info(
    { tenantId, drafted: drafted.length, reasoning },
    "photoCaptionAgent: run complete",
  );

  return { ok: true, skipped: null, drafted, reasoning };
}

// ─── Cron entry point ────────────────────────────────────────────────────────

/**
 * Drain every tenant whose photoCaptionAgent.enabled is true. Wired into the
 * existing post-scheduler tick so it runs hourly alongside the catalog
 * content agent.
 */
export async function runPhotoCaptionAgentForAllTenants(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, settings: true },
  });
  for (const t of tenants) {
    const settings = (t.settings ?? {}) as Record<string, unknown>;
    const cfg = parsePhotoCaptionAgentSettings(settings.photoCaptionAgent);
    if (!cfg.enabled || cfg.postsPerDay === 0) continue;
    try {
      await runPhotoCaptionAgent(t.id);
    } catch (e) {
      logger.error({ e: String(e), tenantId: t.id }, "photoCaptionAgent: tenant run failed");
    }
  }
}
