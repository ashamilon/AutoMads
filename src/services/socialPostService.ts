import axios from "axios";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

// ─── Caption styles (Req 5) ─────────────────────────────────────────────────

/**
 * Per-style steering hints injected into the LLM prompt. Keep each block under
 * ~3 lines so the prompt stays compact when concatenated with brand voice.
 *
 * Styles map roughly to the architect-mode prompt's required modes (formal,
 * informal, luxury, minimal, sales-focused, trendy/viral, sports-hype,
 * promotional, storytelling). The picker is the `style` arg on
 * `generateCaption`; UI shows them as a dropdown.
 */
const STYLE_HINTS: Record<string, string> = {
  default:
    "Friendly, energetic small-shop voice. Mix Banglish with light English where natural.",
  formal:
    "Polite, brand-ambassador tone. Full sentences. No slang, no emoji-heavy bursts.",
  informal:
    "Casual chatty Banglish, like messaging a friend. Contractions and emoji are fine.",
  luxury:
    "Refined and minimal. Premium-feel adjectives. One emoji max. Avoid SHOUTY caps.",
  minimal:
    "Tight and punchy. Under 80 chars. One sentence + one CTA. No emoji, or one max.",
  sales:
    "Hard-sell. Lead with the offer (price/discount). Strong urgency CTA at the end.",
  trendy:
    "Viral / trendy hook. Match what's popular this season. Light humor. Two emoji max.",
  sports:
    "High-energy fan voice for football/cricket gear. Hype the team. Power emojis welcome.",
  promotional:
    "Announces a deal or campaign. Mention the saving or perk in the first 6 words.",
  storytelling:
    "Tiny story (1-2 short sentences). Customer wears it / takes it somewhere meaningful.",
};

function styleHint(style?: string): string {
  if (!style) return STYLE_HINTS.default;
  return STYLE_HINTS[style] ?? STYLE_HINTS.default;
}

// ─── Brand voice (Req 6) ─────────────────────────────────────────────────────

/**
 * Lightweight brand voice the caption generator can pick up off `tenant.settings`.
 * Lives loose on the JSON column so we don't need a schema migration today; the
 * UI can store any subset and the generator reads defensively.
 */
export type BrandVoice = {
  tone?: string;
  vocabulary?: string[];
  bannedWords?: string[];
  emojiPreference?: "minimal" | "balanced" | "expressive" | "none";
  hashtagStyle?: "none" | "few" | "many";
  language?: "banglish" | "bangla" | "english";
};

function readBrandVoice(settings: unknown): BrandVoice {
  if (!settings || typeof settings !== "object") return {};
  const s = settings as Record<string, unknown>;
  const bv = (s["brandVoice"] ?? {}) as Record<string, unknown>;
  return {
    tone: typeof bv.tone === "string" ? bv.tone : undefined,
    vocabulary: Array.isArray(bv.vocabulary) ? (bv.vocabulary as string[]).filter((x) => typeof x === "string") : undefined,
    bannedWords: Array.isArray(bv.bannedWords) ? (bv.bannedWords as string[]).filter((x) => typeof x === "string") : undefined,
    emojiPreference:
      bv.emojiPreference === "minimal" ||
      bv.emojiPreference === "balanced" ||
      bv.emojiPreference === "expressive" ||
      bv.emojiPreference === "none"
        ? bv.emojiPreference
        : undefined,
    hashtagStyle:
      bv.hashtagStyle === "none" || bv.hashtagStyle === "few" || bv.hashtagStyle === "many"
        ? bv.hashtagStyle
        : undefined,
    language:
      bv.language === "banglish" || bv.language === "bangla" || bv.language === "english"
        ? bv.language
        : undefined,
  };
}

// ─── Facebook Publishing ─────────────────────────────────────────────────────

export async function publishToFacebook(opts: {
  pageId: string;
  pageAccessToken: string;
  caption: string;
  imageUrls: string[];
}): Promise<{ postId: string }> {
  const { pageId, pageAccessToken, caption, imageUrls } = opts;

  if (imageUrls.length === 0) {
    const res = await axios.post(`${GRAPH_API_BASE}/${pageId}/feed`, {
      message: caption,
      access_token: pageAccessToken,
    });
    return { postId: res.data.id };
  }

  if (imageUrls.length === 1) {
    const res = await axios.post(`${GRAPH_API_BASE}/${pageId}/photos`, {
      url: imageUrls[0],
      caption,
      access_token: pageAccessToken,
    });
    return { postId: res.data.post_id ?? res.data.id };
  }

  // Multi-image: upload each as unpublished, then attach via attached_media
  // (Graph API takes them as separate JSON-stringified bracket keys).
  const mediaIds: string[] = [];
  for (const url of imageUrls.slice(0, 10)) {
    const res = await axios.post(`${GRAPH_API_BASE}/${pageId}/photos`, {
      url,
      published: false,
      access_token: pageAccessToken,
    });
    mediaIds.push(res.data.id);
  }

  const feedBody: Record<string, unknown> = {
    message: caption,
    access_token: pageAccessToken,
  };
  mediaIds.forEach((id, i) => {
    feedBody[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
  });

  const res = await axios.post(`${GRAPH_API_BASE}/${pageId}/feed`, feedBody);
  return { postId: res.data.id };
}

// ─── Instagram Publishing ────────────────────────────────────────────────────

export async function publishToInstagram(opts: {
  igUserId: string;
  pageAccessToken: string;
  caption: string;
  imageUrls: string[];
}): Promise<{ mediaId: string }> {
  const { igUserId, pageAccessToken, caption, imageUrls } = opts;

  if (imageUrls.length === 0) {
    throw new Error("Instagram requires at least one image");
  }

  if (imageUrls.length === 1) {
    // Single image post
    const containerRes = await axios.post(`${GRAPH_API_BASE}/${igUserId}/media`, {
      image_url: imageUrls[0],
      caption,
      access_token: pageAccessToken,
    });
    const containerId = containerRes.data.id;

    await waitForIgContainer(igUserId, containerId, pageAccessToken);

    const publishRes = await axios.post(`${GRAPH_API_BASE}/${igUserId}/media_publish`, {
      creation_id: containerId,
      access_token: pageAccessToken,
    });
    return { mediaId: publishRes.data.id };
  }

  // Carousel (multi-image)
  const childIds: string[] = [];
  for (const url of imageUrls.slice(0, 10)) {
    const res = await axios.post(`${GRAPH_API_BASE}/${igUserId}/media`, {
      image_url: url,
      is_carousel_item: true,
      access_token: pageAccessToken,
    });
    childIds.push(res.data.id);
  }

  // Wait for all children
  for (const cid of childIds) {
    await waitForIgContainer(igUserId, cid, pageAccessToken);
  }

  // Create carousel container
  const carouselRes = await axios.post(`${GRAPH_API_BASE}/${igUserId}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption,
    access_token: pageAccessToken,
  });
  const carouselId = carouselRes.data.id;

  await waitForIgContainer(igUserId, carouselId, pageAccessToken);

  const publishRes = await axios.post(`${GRAPH_API_BASE}/${igUserId}/media_publish`, {
    creation_id: carouselId,
    access_token: pageAccessToken,
  });
  return { mediaId: publishRes.data.id };
}

async function waitForIgContainer(
  igUserId: string,
  containerId: string,
  token: string,
  maxWait = 30_000,
): Promise<void> {
  void igUserId;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await axios.get(`${GRAPH_API_BASE}/${containerId}`, {
      params: { fields: "status_code", access_token: token },
    });
    if (res.data.status_code === "FINISHED") return;
    if (res.data.status_code === "ERROR") {
      throw new Error(`Instagram container ${containerId} failed`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Instagram container ${containerId} timed out`);
}

// ─── AI Caption Generation ───────────────────────────────────────────────────

/**
 * Generate a social-post caption via Ollama chat (same path the Messenger
 * agent uses). Honors brand voice from tenant settings and the caller-picked
 * `style` (formal/luxury/sales/sports/etc.). Falls back to a deterministic
 * template only when Ollama returns junk or errors.
 *
 * Price policy (Req: never leak prices in captions): prices are NEVER injected
 * into the prompt or fallback template, AND a defensive post-filter strips
 * any leftover BDT/Tk amounts the model invents on its own. Prices belong on
 * the website / DM conversation, not on social posts.
 */
export async function generateCaption(opts: {
  productNames: string[];
  prices: number[];
  tags?: string[];
  postType: string;
  language?: string;
  /** Caption style key — see STYLE_HINTS keys above. */
  style?: string;
  /** Brand voice overrides from tenant settings. */
  brandVoice?: BrandVoice;
}): Promise<string> {
  const { productNames, tags, postType, style } = opts;
  const brand = opts.brandVoice ?? {};
  const language = opts.language ?? brand.language ?? "banglish";

  // Prices intentionally NOT injected into the prompt — captions must never
  // expose pricing on the public feed.
  const productList = productNames.map((name) => `- ${name}`).join("\n");

  // Build per-style + brand voice steering. The chat surface gets a system
  // message with voice rules, then a user message with the products and ask.
  const langLabel =
    language === "bangla" ? "Bangla" : language === "english" ? "English" : "Banglish (Bangla in English script)";

  const emojiRule =
    brand.emojiPreference === "none"
      ? "No emojis at all."
      : brand.emojiPreference === "minimal"
        ? "At most ONE emoji."
        : brand.emojiPreference === "expressive"
          ? "2-4 emojis are fine when they fit."
          : "1-2 relevant emojis.";

  const hashtagRule =
    brand.hashtagStyle === "none" || !brand.hashtagStyle
      ? "Do NOT include hashtags."
      : brand.hashtagStyle === "few"
        ? "Add 2-3 relevant hashtags at the end."
        : "Add 5-8 relevant hashtags at the end.";

  const bannedRule =
    brand.bannedWords && brand.bannedWords.length > 0
      ? `Banned words (NEVER use): ${brand.bannedWords.join(", ")}.`
      : "";

  const vocabRule =
    brand.vocabulary && brand.vocabulary.length > 0
      ? `Preferred phrasing the brand uses: ${brand.vocabulary.join(", ")}.`
      : "";

  const systemPrompt = [
    `You are a social media caption writer for a Bangladeshi commerce shop.`,
    `Output ONLY the caption text — no JSON, no markdown, no quotes, no labels.`,
    `Keep it under 220 characters.`,
    `Language: ${langLabel}.`,
    `Style: ${styleHint(style)}`,
    brand.tone ? `Brand tone: ${brand.tone}` : "",
    emojiRule,
    hashtagRule,
    `Always include a clear call-to-action (e.g. "Order now", "DM korun", "Stock limited").`,
    `Sound natural and human, never corporate.`,
    // HARD RULE — never expose pricing on the public feed. The model should
    // direct customers to DM for the price instead.
    `NEVER mention any price, cost, BDT, Taka, ৳, Tk, or any number followed by a currency hint. ` +
      `If the customer wants the price, the CTA should ask them to DM / inbox / message.`,
    bannedRule,
    vocabRule,
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = [
    `Post type: ${postType}`,
    `Products:\n${productList}`,
    tags && tags.length > 0 ? `Keywords: ${tags.join(", ")}` : "",
    "Write the caption now (NO PRICES):",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await axios.post(
      `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
      {
        model: config.ollamaModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        options: { temperature: 0.85, num_predict: 220 },
      },
      { timeout: 30_000 },
    );

    const text = String(res.data?.message?.content ?? "")
      .trim()
      .replace(/^[\s"`]+|[\s"`]+$/g, "")
      .replace(/^Caption:\s*/i, "");
    if (text.length > 10) return stripPriceMentions(text);
  } catch (e) {
    logger.warn({ e: String(e) }, "Caption generation failed, using template");
  }

  // Deterministic fallback template — never used unless Ollama is down.
  // Also no prices here, by design.
  if (productNames.length === 1) {
    return `🔥 ${productNames[0]} — DM kore order korun 📩`;
  }
  return `🔥 New collection drop! ${productNames.slice(0, 3).join(", ")} — DM kore order korun 📩`;
}

/**
 * Defensive post-filter: strip any price mentions the LLM invented despite
 * the system prompt rule. Catches the common shapes:
 *   - "1500 BDT", "1,500 Tk", "৳1500"
 *   - "BDT 1500", "Tk. 1500"
 *   - "Price: 1500", "Daam: 1500"
 *
 * Trims the resulting double-spaces / orphan punctuation. Pure / unit-testable.
 */
export function stripPriceMentions(text: string): string {
  let out = text;
  // Number followed by a currency hint.
  out = out.replace(/[\d,]+(?:\.\d+)?\s*(?:BDT|Tk\.?|Taka|৳|টাকা)\b/gi, "");
  // Currency hint followed by a number.
  out = out.replace(/(?:BDT|Tk\.?|Taka|৳|টাকা)\s*[\d,]+(?:\.\d+)?/gi, "");
  // "Price:" / "Daam:" / "Mullo:" prefixed numbers.
  out = out.replace(/\b(?:price|daam|dam|mullo|mully|cost)[:\s]+[\d,]+(?:\.\d+)?/gi, "");
  // Tidy: collapse multiple spaces, fix orphan punctuation that the strip leaves behind.
  out = out
    .replace(/\(\s*\)/g, "")
    .replace(/[—–-]\s*[—–-]/g, "—")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([,;])\s*([,;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out;
}

// ─── Publish Orchestrator ────────────────────────────────────────────────────

/**
 * Per-platform publish attempt with one retry on transient failures (network,
 * Graph API rate limits, IG container timeouts). Returns the post id on
 * success or throws the LAST error.
 */
async function publishWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    const err = e as { code?: string; response?: { status?: number; data?: unknown } };
    const transient =
      err?.code === "ECONNRESET" ||
      err?.code === "ETIMEDOUT" ||
      err?.code === "ECONNABORTED" ||
      (typeof err?.response?.status === "number" && err.response.status >= 500) ||
      // Graph API rate limit error code is 4 / 17 / 32 inside data.error.code
      (typeof (err?.response?.data as { error?: { code?: number } })?.error?.code === "number" &&
        [4, 17, 32].includes((err.response!.data as { error: { code: number } }).error.code));
    if (!transient) throw e;
    logger.warn({ label, e: String(e) }, "publish transient failure — retrying once");
    await new Promise((r) => setTimeout(r, 1500));
    return await fn();
  }
}

export async function publishScheduledPost(postId: string): Promise<void> {
  const post = await prisma.scheduledPost.findUnique({
    where: { id: postId },
    include: { tenant: true },
  });
  if (!post) throw new Error("Post not found");
  if (post.status === "published" && post.fbPostId) return;

  const tenant = post.tenant;
  const pageAccessToken = tenant.facebookPageAccessToken;
  const pageId = tenant.facebookPageId;
  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  const igConfig = settings["instagram"] as { igUserId?: string; enabled?: boolean } | undefined;
  const tiktokConfig = settings["tiktok"] as { enabled?: boolean; accessToken?: string } | undefined;
  const imageUrls = (Array.isArray(post.imageUrls) ? post.imageUrls : []) as string[];

  let fbPostId: string | null = null;
  let igMediaId: string | null = null;
  const errors: string[] = [];

  // Decide which targets this post should hit. "all" used to also force
  // TikTok which silently failed and poisoned the success of FB+IG. Now we
  // skip TikTok completely unless the tenant explicitly asks for it AND has
  // it configured — and treat its unavailability as informational, not a
  // failure.
  const plat = post.platform;
  const targets = {
    facebook: plat === "facebook" || plat === "both" || plat === "all",
    instagram: plat === "instagram" || plat === "both" || plat === "all",
    tiktok: plat === "tiktok",
  };

  // Publish to Facebook
  if (targets.facebook) {
    if (!pageAccessToken || !pageId) {
      errors.push("FB: Page ID or Page Access Token not configured");
    } else {
      try {
        const result = await publishWithRetry("facebook", () =>
          publishToFacebook({ pageId, pageAccessToken, caption: post.caption, imageUrls }),
        );
        fbPostId = result.postId;
        logger.info({ postId, fbPostId, pageId }, "Facebook post published");
      } catch (e: unknown) {
        const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
        const msg = err?.response?.data?.error?.message ?? err?.message ?? String(e);
        errors.push(`FB: ${msg}`);
        logger.error({ e: msg, postId, pageId }, "Facebook publish failed");
      }
    }
  }

  // Publish to Instagram
  if (targets.instagram) {
    if (!pageAccessToken) {
      errors.push("IG: Page Access Token not configured");
    } else if (!igConfig?.enabled || !igConfig.igUserId) {
      errors.push("IG: Instagram not connected — add IG User ID in Settings → Social Accounts");
    } else {
      try {
        const result = await publishWithRetry("instagram", () =>
          publishToInstagram({
            igUserId: igConfig.igUserId!,
            pageAccessToken,
            caption: post.caption,
            imageUrls,
          }),
        );
        igMediaId = result.mediaId;
        logger.info({ postId, igMediaId }, "Instagram post published");
      } catch (e: unknown) {
        const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
        const msg = err?.response?.data?.error?.message ?? err?.message ?? String(e);
        errors.push(`IG: ${msg}`);
        logger.error({ e: msg, postId }, "Instagram publish failed");
      }
    }
  }

  // TikTok — only when explicitly chosen as the target. Auto-publishing via
  // the Content Posting API requires an additional integration; for now we
  // mark the post as failed with a clear message instead of silently failing.
  if (targets.tiktok) {
    if (!tiktokConfig?.enabled || !tiktokConfig.accessToken) {
      errors.push("TikTok: not connected — configure Settings → Social Accounts → TikTok");
    } else {
      errors.push(
        "TikTok: auto-post not implemented yet (Content Posting API integration pending). " +
          "For now publish manually from the TikTok app.",
      );
    }
  }

  // A post is "published" if at least one explicitly-targeted platform
  // succeeded AND no targeted platform failed. The previous logic flipped to
  // "failed" whenever ANY error existed even if the user-chosen platform
  // succeeded — so a post going to "all" with TikTok unconfigured was always
  // marked failed. New rule: count successes vs. the platforms the user
  // actually asked for.
  const targetCount = Number(targets.facebook) + Number(targets.instagram) + Number(targets.tiktok);
  const successCount = (fbPostId ? 1 : 0) + (igMediaId ? 1 : 0);
  const published = targetCount > 0 && successCount === targetCount && errors.length === 0;
  // Partial success (e.g. FB ok, IG failed) → keep it as "failed" so the
  // operator sees the failureReason; the success ids are still recorded so
  // we don't double-publish to the platform that worked.
  const isFailed = !published;

  await prisma.scheduledPost.update({
    where: { id: postId },
    data: {
      status: published ? "published" : isFailed ? "failed" : "scheduled",
      publishedAt: published ? new Date() : undefined,
      fbPostId,
      igMediaId,
      failureReason: errors.length > 0 ? errors.join("; ") : null,
    },
  });

  if (published) {
    logger.info({ postId, fbPostId, igMediaId }, "Scheduled post published");
  } else if (errors.length > 0) {
    logger.warn({ postId, errors }, "Scheduled post publish failed");
  }
}
