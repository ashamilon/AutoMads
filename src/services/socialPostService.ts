import axios from "axios";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

// ─── Facebook Publishing ─────────────────────────────────────────────────────

export async function publishToFacebook(opts: {
  pageId: string;
  pageAccessToken: string;
  caption: string;
  imageUrls: string[];
}): Promise<{ postId: string }> {
  const { pageId, pageAccessToken, caption, imageUrls } = opts;

  if (imageUrls.length === 0) {
    const res = await axios.post(
      `${GRAPH_API_BASE}/${pageId}/feed`,
      { message: caption, access_token: pageAccessToken },
    );
    return { postId: res.data.id };
  }

  if (imageUrls.length === 1) {
    const res = await axios.post(
      `${GRAPH_API_BASE}/${pageId}/photos`,
      { url: imageUrls[0], caption, access_token: pageAccessToken },
    );
    return { postId: res.data.post_id ?? res.data.id };
  }

  // Multi-image: upload each as unpublished, then create a feed post with attached_media
  const mediaIds: string[] = [];
  for (const url of imageUrls.slice(0, 10)) {
    const res = await axios.post(
      `${GRAPH_API_BASE}/${pageId}/photos`,
      { url, published: false, access_token: pageAccessToken },
    );
    mediaIds.push(res.data.id);
  }

  const attachedMedia: Record<string, { media_fbid: string }> = {};
  mediaIds.forEach((id, i) => {
    attachedMedia[`attached_media[${i}]`] = { media_fbid: id };
  });

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
    const containerRes = await axios.post(
      `${GRAPH_API_BASE}/${igUserId}/media`,
      { image_url: imageUrls[0], caption, access_token: pageAccessToken },
    );
    const containerId = containerRes.data.id;

    await waitForIgContainer(igUserId, containerId, pageAccessToken);

    const publishRes = await axios.post(
      `${GRAPH_API_BASE}/${igUserId}/media_publish`,
      { creation_id: containerId, access_token: pageAccessToken },
    );
    return { mediaId: publishRes.data.id };
  }

  // Carousel (multi-image)
  const childIds: string[] = [];
  for (const url of imageUrls.slice(0, 10)) {
    const res = await axios.post(
      `${GRAPH_API_BASE}/${igUserId}/media`,
      { image_url: url, is_carousel_item: true, access_token: pageAccessToken },
    );
    childIds.push(res.data.id);
  }

  // Wait for all children
  for (const cid of childIds) {
    await waitForIgContainer(igUserId, cid, pageAccessToken);
  }

  // Create carousel container
  const carouselRes = await axios.post(
    `${GRAPH_API_BASE}/${igUserId}/media`,
    { media_type: "CAROUSEL", children: childIds.join(","), caption, access_token: pageAccessToken },
  );
  const carouselId = carouselRes.data.id;

  await waitForIgContainer(igUserId, carouselId, pageAccessToken);

  const publishRes = await axios.post(
    `${GRAPH_API_BASE}/${igUserId}/media_publish`,
    { creation_id: carouselId, access_token: pageAccessToken },
  );
  return { mediaId: publishRes.data.id };
}

async function waitForIgContainer(igUserId: string, containerId: string, token: string, maxWait = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await axios.get(
      `${GRAPH_API_BASE}/${containerId}`,
      { params: { fields: "status_code", access_token: token } },
    );
    if (res.data.status_code === "FINISHED") return;
    if (res.data.status_code === "ERROR") {
      throw new Error(`Instagram container ${containerId} failed`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Instagram container ${containerId} timed out`);
}

// ─── AI Caption Generation ───────────────────────────────────────────────────

export async function generateCaption(opts: {
  productNames: string[];
  prices: number[];
  tags?: string[];
  postType: string;
  language?: string;
}): Promise<string> {
  const { productNames, prices, tags, postType, language } = opts;
  const lang = language ?? "banglish";

  const productList = productNames
    .map((name, i) => `- ${name} (${prices[i] ?? "?"} BDT)`)
    .join("\n");

  const prompt = [
    `Write a short, engaging ${postType === "collection" ? "collection showcase" : "product showcase"} caption for a Facebook/Instagram post.`,
    `Language: ${lang === "bangla" ? "Bangla" : "Banglish (Bangla in English script)"}`,
    `Products:\n${productList}`,
    tags && tags.length > 0 ? `Tags/keywords: ${tags.join(", ")}` : "",
    "Rules:",
    "- Keep it under 200 characters",
    "- Use 1-2 relevant emojis",
    "- Include a call-to-action (e.g. 'Order now', 'DM to order')",
    "- Sound natural and enthusiastic, not corporate",
    "- Do NOT include hashtags",
    "- Output ONLY the caption text, nothing else",
  ].filter(Boolean).join("\n");

  try {
    const res = await axios.post(`${config.ollamaBaseUrl}/api/generate`, {
      model: config.ollamaModel,
      prompt,
      stream: false,
      options: { temperature: 0.8, num_predict: 150 },
    }, { timeout: 30_000 });

    const text = (res.data?.response ?? "").trim();
    if (text.length > 10) return text;
  } catch (e) {
    logger.warn({ e: String(e) }, "Caption generation failed, using template");
  }

  // Fallback template
  if (productNames.length === 1) {
    return `🔥 ${productNames[0]} — ${prices[0]} BDT e available! DM kore order korun 📩`;
  }
  return `🔥 New collection drop! ${productNames.slice(0, 3).join(", ")} — DM kore order korun 📩`;
}

// ─── Publish Orchestrator ────────────────────────────────────────────────────

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
  const imageUrls = (Array.isArray(post.imageUrls) ? post.imageUrls : []) as string[];

  let fbPostId: string | null = null;
  let igMediaId: string | null = null;
  const errors: string[] = [];

  const plat = post.platform;
  const shouldFb = plat === "facebook" || plat === "both" || plat === "all";
  const shouldIg = plat === "instagram" || plat === "both" || plat === "all";
  const shouldTiktok = plat === "tiktok" || plat === "all";

  // Publish to Facebook
  if (shouldFb) {
    if (!pageAccessToken || !pageId) {
      errors.push("FB: Page ID or Page Access Token not configured in tenant settings");
    } else {
      try {
        const result = await publishToFacebook({ pageId, pageAccessToken, caption: post.caption, imageUrls });
        fbPostId = result.postId;
        logger.info({ postId, fbPostId, pageId }, "Facebook post published");
      } catch (e: any) {
        const msg = e?.response?.data?.error?.message ?? String(e);
        errors.push(`FB: ${msg}`);
        logger.error({ e: msg, postId, pageId }, "Facebook publish failed");
      }
    }
  }

  // Publish to Instagram
  if (shouldIg) {
    if (!pageAccessToken) {
      errors.push("IG: Page Access Token not configured");
    } else if (!igConfig?.enabled || !igConfig.igUserId) {
      errors.push("IG: Instagram not connected — add IG User ID in Settings → Social Accounts");
    } else {
      try {
        const result = await publishToInstagram({
          igUserId: igConfig.igUserId,
          pageAccessToken,
          caption: post.caption,
          imageUrls,
        });
        igMediaId = result.mediaId;
        logger.info({ postId, igMediaId }, "Instagram post published");
      } catch (e: any) {
        const msg = e?.response?.data?.error?.message ?? String(e);
        errors.push(`IG: ${msg}`);
        logger.error({ e: msg, postId }, "Instagram publish failed");
      }
    }
  }

  // TikTok (placeholder — requires TikTok Content Posting API integration)
  if (shouldTiktok) {
    errors.push("TikTok: Auto-post not configured yet — connect via Settings or use Facebook/Instagram");
  }

  const anyTarget =
    shouldFb || shouldIg || shouldTiktok;
  const published = anyTarget && (fbPostId != null || igMediaId != null) && errors.length === 0;
  const failed = !published;

  await prisma.scheduledPost.update({
    where: { id: postId },
    data: {
      status: published ? "published" : failed ? "failed" : "scheduled",
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
