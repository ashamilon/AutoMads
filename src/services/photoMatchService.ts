/**
 * Photo-to-catalog matching pipeline.
 *
 * The agent's image-handling flow used to do one thing: send the customer
 * photo + the FIRST image of each top candidate to the LLM and ask it to
 * pick. Two real-world problems with that:
 *
 *   1. **Multi-photo products are ignored.** A merchant typically uploads
 *      4–6 photos per SKU (front, back, side, fabric close-up, model
 *      shot). If the customer sends a back-side photo and the catalog's
 *      first image is a front shot, the LLM never sees the matching angle
 *      and the auto-pick fails.
 *   2. **Exact / near-exact reuse is wasted on the LLM.** When a customer
 *      forwards one of OUR own marketing images (very common — they
 *      screenshot our Cloudinary URL or repost our Facebook photo), we
 *      should recognise that deterministically and skip the LLM entirely.
 *
 * This module fixes both. Resolution order:
 *
 *   1. **URL exact match** — if the customer image URL is byte-equal to
 *      a catalog photo URL OR shares the same Cloudinary `public_id`,
 *      return that SKU with `confidence: "exact"`.
 *   2. **Perceptual hash near-duplicate** — compute an 8×8 average-hash
 *      (aHash, 64-bit fingerprint) for the customer image and for every
 *      photo on every top candidate, find the smallest Hamming distance.
 *      ≤8 bits → "near_exact" auto-pick. ≤16 bits → "similar" — passed
 *      as the "best angle" hint to the LLM.
 *   3. **LLM visual comparison** — fall back to the existing Ollama
 *      vision call, but feed it the PER-SKU photo with the smallest hash
 *      distance instead of always the first photo.
 *
 * Steps 1 and 2 are pure local computation (no LLM round-trip), so the
 * happy path returns in ~250 ms. Step 3 only runs when the local passes
 * are inconclusive.
 */

import axios from "axios";
import sharp from "sharp";
import type { ProductMapping } from "@prisma/client";
import { logger } from "../utils/logger.js";
import { extractCatalogAssets } from "./catalogReplyService.js";

/** Fingerprint = 64-bit aHash represented as a 16-char hex string. */
export type ImageFingerprint = string;

export type PhotoMatchOutcome =
  | {
      kind: "exact_url" | "exact_cloudinary" | "near_exact_hash";
      sku: string;
      row: ProductMapping;
      hammingDistance: number;
      bestUrl: string;
    }
  | {
      kind: "ranked";
      /**
       * Candidates re-ordered by smallest hash distance to the customer photo.
       * Caller can pass these to the LLM with the per-candidate `bestUrl`
       * already set to the closest-angle photo.
       */
      ranked: Array<{
        row: ProductMapping;
        bestUrl: string;
        bestImageBase64: string;
        hammingDistance: number;
      }>;
    }
  | {
      kind: "no_candidates";
    };

const MAX_CANDIDATES = 6;
const MAX_PHOTOS_PER_CANDIDATE = 4;
/** Hamming distance ≤ this → treat as the same image. */
const NEAR_EXACT_THRESHOLD = 8;
/** Hamming distance ≤ this → "similar enough to feed to the LLM". */
const SIMILAR_THRESHOLD = 16;

// ─────────────────────────────────────────────────────────────────────
// URL helpers
// ─────────────────────────────────────────────────────────────────────

/** Strip Cloudinary transformation segments + version so we compare on `public_id`. */
function cloudinaryPublicId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/cloudinary\.com$/i.test(u.hostname.replace(/^.*?\./, ""))) return null;
    // Path looks like:
    //   /<cloud>/image/upload/<transforms>/<v123>/<public_id>.<ext>
    // We want the bit AFTER `upload/<transforms>/v<digits>/` (or just
    // `upload/`) and BEFORE the extension.
    const match = u.pathname.match(/\/image\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?$/i);
    if (!match) return null;
    return match[1] || null;
  } catch {
    return null;
  }
}

/** Best-effort URL canonicalisation for byte-equal matching: strip query + hash. */
function canonicaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Perceptual hash (aHash 8×8)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the average-hash fingerprint for an image buffer.
 *
 * Algorithm:
 *   1. Resize to 8×8 grayscale (64 pixels).
 *   2. Compute the mean grayscale value across all 64 pixels.
 *   3. For each pixel, emit `1` if pixel > mean, `0` otherwise.
 *   4. Concatenate the 64 bits → 16-char hex string.
 *
 * Fast (~30 ms per image including resize) and resilient to compression,
 * mild colour shifts, and minor rescaling. Defeated by aggressive crops
 * or rotations — fine for our purpose because we want to recognise
 * *direct reuse* of the merchant's own photos, not classify novel shots.
 */
export async function computeFingerprint(buffer: Buffer): Promise<ImageFingerprint | null> {
  try {
    const raw = await sharp(buffer)
      .resize(8, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();
    if (raw.length !== 64) return null;
    let total = 0;
    for (let i = 0; i < 64; i++) total += raw[i] ?? 0;
    const mean = total / 64;
    let hex = "";
    let nibble = 0;
    let nibbleBits = 0;
    for (let i = 0; i < 64; i++) {
      nibble = (nibble << 1) | ((raw[i] ?? 0) > mean ? 1 : 0);
      nibbleBits += 1;
      if (nibbleBits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        nibbleBits = 0;
      }
    }
    return hex;
  } catch (e) {
    logger.warn({ e: String(e) }, "computeFingerprint failed");
    return null;
  }
}

/** Hamming distance between two 16-char hex fingerprints (max 64 bits). */
export function hammingDistance(a: ImageFingerprint, b: ImageFingerprint): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  let d = 0;
  for (let i = 0; i < 16; i++) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    // popcount of a 4-bit nibble
    let v = x;
    while (v) {
      d += v & 1;
      v >>>= 1;
    }
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────
// Image fetch
// ─────────────────────────────────────────────────────────────────────

async function fetchUrlAsBuffer(url: string, maxBytes = 4 * 1024 * 1024): Promise<Buffer | null> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 15_000,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: () => true,
    });
    if (res.status >= 400) return null;
    const buf = Buffer.from(res.data);
    if (buf.length < 256) return null;
    return buf;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────────────

/**
 * Run the multi-stage match against the top text/visual candidates.
 *
 * @param customerImage  bytes (data buffer) of the customer's photo
 * @param customerImageUrl original URL the customer sent (used for the URL
 *                         exact-match shortcut). Pass `null` if you only
 *                         have the bytes (e.g. a base64 attachment).
 * @param candidates     candidate `ProductMapping` rows ranked by upstream
 *                       text/jersey-vision matching. We'll fingerprint up
 *                       to 4 photos for each of the top 6.
 */
export async function matchCustomerPhotoAgainstCatalog(args: {
  customerImage: Buffer;
  customerImageUrl: string | null;
  candidates: ProductMapping[];
}): Promise<PhotoMatchOutcome> {
  const top = args.candidates.slice(0, MAX_CANDIDATES);
  if (top.length === 0) return { kind: "no_candidates" };

  // ── Stage 1 — URL exact / Cloudinary public_id match ───────────────
  if (args.customerImageUrl) {
    const customerCanonical = canonicaliseUrl(args.customerImageUrl);
    const customerCloudId = cloudinaryPublicId(args.customerImageUrl);
    for (const m of top) {
      const urls = extractCatalogAssets(m).imageUrls;
      for (const url of urls) {
        if (canonicaliseUrl(url) === customerCanonical) {
          return {
            kind: "exact_url",
            sku: m.clientSku,
            row: m,
            hammingDistance: 0,
            bestUrl: url,
          };
        }
        if (customerCloudId) {
          const candCloudId = cloudinaryPublicId(url);
          if (candCloudId && candCloudId === customerCloudId) {
            return {
              kind: "exact_cloudinary",
              sku: m.clientSku,
              row: m,
              hammingDistance: 0,
              bestUrl: url,
            };
          }
        }
      }
    }
  }

  // ── Stage 2 — perceptual hash compare ─────────────────────────────
  const customerFingerprint = await computeFingerprint(args.customerImage);
  if (!customerFingerprint) {
    // Fingerprinting failed (corrupt image / sharp error). Bail to ranked
    // with no hash data so the caller still has the candidate list.
    return { kind: "ranked", ranked: [] };
  }

  type CandidateScore = {
    row: ProductMapping;
    bestUrl: string;
    bestBuffer: Buffer;
    bestDistance: number;
  };
  const scored: CandidateScore[] = [];

  // Fan out the per-candidate photo fetches in parallel for latency. Each
  // candidate fetches up to MAX_PHOTOS_PER_CANDIDATE photos sequentially
  // (to bound per-candidate concurrency), but candidates run together.
  await Promise.all(
    top.map(async (m) => {
      const urls = extractCatalogAssets(m).imageUrls.slice(0, MAX_PHOTOS_PER_CANDIDATE);
      let bestUrl = "";
      let bestBuffer: Buffer | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const url of urls) {
        const buf = await fetchUrlAsBuffer(url);
        if (!buf) continue;
        const fp = await computeFingerprint(buf);
        if (!fp) continue;
        const d = hammingDistance(customerFingerprint, fp);
        if (d < bestDistance) {
          bestDistance = d;
          bestUrl = url;
          bestBuffer = buf;
        }
      }
      if (bestBuffer && bestUrl) {
        scored.push({ row: m, bestUrl, bestBuffer, bestDistance });
      }
    }),
  );

  if (scored.length === 0) {
    return { kind: "ranked", ranked: [] };
  }

  scored.sort((a, b) => a.bestDistance - b.bestDistance);
  const top1 = scored[0]!;

  // ── Stage 2a — near-exact auto-pick ───────────────────────────────
  if (top1.bestDistance <= NEAR_EXACT_THRESHOLD) {
    logger.info(
      { sku: top1.row.clientSku, distance: top1.bestDistance, url: top1.bestUrl },
      "photoMatch: near-exact hash match — auto-selecting",
    );
    return {
      kind: "near_exact_hash",
      sku: top1.row.clientSku,
      row: top1.row,
      hammingDistance: top1.bestDistance,
      bestUrl: top1.bestUrl,
    };
  }

  // ── Stage 3 — return ranked candidates for LLM fallback ───────────
  // Filter to the rows within SIMILAR_THRESHOLD if any exist; otherwise
  // keep the top-3 by distance so the LLM still gets something to work
  // with.
  const similar = scored.filter((s) => s.bestDistance <= SIMILAR_THRESHOLD);
  const final = similar.length > 0 ? similar : scored.slice(0, 3);
  return {
    kind: "ranked",
    ranked: final.map((s) => ({
      row: s.row,
      bestUrl: s.bestUrl,
      bestImageBase64: s.bestBuffer.toString("base64"),
      hammingDistance: s.bestDistance,
    })),
  };
}
