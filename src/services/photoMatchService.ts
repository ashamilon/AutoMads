/**
 * Photo-to-catalog matching pipeline.
 *
 * The agent's image-handling flow used to do one thing: send the customer
 * photo + the FIRST image of each top text-ranked candidate to the LLM
 * and ask it to pick. Two real-world problems with that:
 *
 *   1. **Multi-photo products are ignored.** A merchant typically uploads
 *      4–6 photos per SKU (front, back, side, fabric close-up). If the
 *      customer sends a back-side photo and the catalog's first image is
 *      a front shot, the LLM never sees the matching angle.
 *   2. **Top-6 by team text isn't enough.** When a customer sends a
 *      "Brazil" photo, jersey vision narrows to Brazil rows ranked by
 *      stock + active flags. If the actual SKU sits at #11 by that
 *      ranking (e.g. a special-edition that's lower-stock), it never
 *      enters the visual-compare pool.
 *   3. **Re-using our own marketing image** (Cloudinary URL forwarded by
 *      the customer) is wasted on the LLM — should be deterministic.
 *
 * This module fixes all three. Resolution order:
 *
 *   1. **URL exact match** — customer URL byte-equal to a catalog URL or
 *      sharing the same Cloudinary `public_id` → "exact" pick.
 *   2. **Perceptual hash near-duplicate, full-catalog scan** — compute
 *      an 8×8 average-hash for the customer image, scan EVERY photo on
 *      EVERY product in the catalog (cached fingerprints make this CPU-
 *      only after the first scan), find the smallest Hamming distance.
 *      ≤8 bits → "near_exact" auto-pick. ≤16 → "similar" — feeds the LLM.
 *   3. **LLM visual comparison** — fall back to Ollama with the per-
 *      candidate BEST-angle photo (the photo with the smallest hash
 *      distance), not just photo #1.
 *
 * The fingerprint cache lives in `productMapping.metadata.imageFingerprints`
 * (a `{ url → fingerprint }` map). First customer photo per fresh deploy
 * fetches + hashes every catalog image (~200 ms × N photos / parallel) and
 * persists the cache. Subsequent customer photos compute one fingerprint
 * for the customer image and compare against the cached map in microseconds
 * per product — even a 500-product catalog finishes the scan in <50 ms.
 */

import axios from "axios";
import sharp from "sharp";
import type { ProductMapping } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
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

/** Per-product photo fingerprint count cap. Avoids unbounded fetches on noisy catalogs. */
const MAX_PHOTOS_PER_PRODUCT = 8;
/** Hamming distance ≤ this → treat as the same image (auto-pick). */
const NEAR_EXACT_THRESHOLD = 8;
/** Hamming distance ≤ this → "similar enough to feed to the LLM". */
const SIMILAR_THRESHOLD = 16;
/** How many ranked products to forward to the LLM when no auto-pick fires. */
const LLM_FALLBACK_TOP_K = 4;

// ─────────────────────────────────────────────────────────────────────
// URL helpers
// ─────────────────────────────────────────────────────────────────────

/** Strip Cloudinary transformation segments + version so we compare on `public_id`. */
function cloudinaryPublicId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/cloudinary\.com$/i.test(u.hostname.replace(/^.*?\./, ""))) return null;
    // Path: /<cloud>/image/upload/<transforms>/<v123>/<public_id>.<ext>
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
 *   1. Resize to 8×8 grayscale (64 pixels)
 *   2. Mean grayscale across 64 px
 *   3. Bit `i` = 1 if pixel i > mean else 0
 *   4. 64 bits → 16-char hex
 *
 * Resilient to compression, mild colour shifts, minor rescaling. Defeated
 * by aggressive crops or rotations — fine for recognising direct reuse of
 * the merchant's own photos, not for classifying novel shots.
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
// Fingerprint cache (per-product, persisted on metadata)
// ─────────────────────────────────────────────────────────────────────

/**
 * Pull the cached `{ url → fingerprint }` map off a product's metadata.
 * Written by `ensureFingerprintsForProduct` and read on every photo
 * match. Empty / corrupt → empty object so callers can recompute.
 */
function readCachedFingerprints(meta: unknown): Record<string, string> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const slot = (meta as Record<string, unknown>)["imageFingerprints"];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(slot as Record<string, unknown>)) {
    if (typeof v === "string" && v.length === 16) out[k] = v;
  }
  return out;
}

/**
 * Compute fingerprints for any photo on `row` that isn't already cached,
 * then persist the merged map back onto `metadata.imageFingerprints`.
 *
 * This is the slow-path. For a fresh deploy with a 500-product catalog
 * it runs once at startup of the first photo match; afterwards every
 * customer photo is pure CPU work (one customer fingerprint + a Hamming
 * scan over the cached map).
 *
 * Concurrency-safe: we read the row inside the function to capture the
 * latest metadata, merge our updates with `Prisma.JsonValue`, and write
 * back. Two parallel callers ensuring different photos can race but the
 * merge is idempotent (URL → 16-char hex is deterministic).
 */
async function ensureFingerprintsForProduct(row: ProductMapping): Promise<{
  fingerprints: Record<string, string>;
  /** Buffers of any photo we just fetched, keyed by URL. Used so the caller
   * can later re-base64 the best-matching candidate without a second fetch. */
  freshBuffers: Map<string, Buffer>;
}> {
  const urls = extractCatalogAssets(row).imageUrls.slice(0, MAX_PHOTOS_PER_PRODUCT);
  const cached = readCachedFingerprints(row.metadata);
  const missing = urls.filter((u) => !(u in cached));
  const freshBuffers = new Map<string, Buffer>();
  if (missing.length === 0) return { fingerprints: cached, freshBuffers };

  // Fetch + hash missing photos in parallel.
  await Promise.all(
    missing.map(async (url) => {
      const buf = await fetchUrlAsBuffer(url);
      if (!buf) return;
      const fp = await computeFingerprint(buf);
      if (!fp) return;
      cached[url] = fp;
      freshBuffers.set(url, buf);
    }),
  );

  // Persist the merged cache. We re-read the row to avoid clobbering
  // concurrent writes to other parts of metadata.
  try {
    const fresh = await prisma.productMapping.findUnique({
      where: { id: row.id },
      select: { metadata: true },
    });
    const existingMeta =
      fresh?.metadata && typeof fresh.metadata === "object" && !Array.isArray(fresh.metadata)
        ? (fresh.metadata as Record<string, unknown>)
        : {};
    const existingFingerprints =
      existingMeta["imageFingerprints"] && typeof existingMeta["imageFingerprints"] === "object"
        ? (existingMeta["imageFingerprints"] as Record<string, unknown>)
        : {};
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(existingFingerprints)) {
      if (typeof v === "string" && v.length === 16) merged[k] = v;
    }
    Object.assign(merged, cached);
    const nextMeta = { ...existingMeta, imageFingerprints: merged };
    await prisma.productMapping.update({
      where: { id: row.id },
      data: { metadata: nextMeta as Prisma.InputJsonValue },
    });
  } catch (e) {
    // Cache write failure is non-fatal — the in-memory `cached` still has
    // the new entries for this turn. Next turn re-fetches the missing
    // ones, which is suboptimal but correct.
    logger.warn({ e: String(e), sku: row.clientSku }, "ensureFingerprintsForProduct cache write failed");
  }

  return { fingerprints: cached, freshBuffers };
}

// ─────────────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────────────

/**
 * Match a customer photo against every product in the tenant catalog.
 *
 * @param customerImage     decoded bytes of the customer's photo
 * @param customerImageUrl  original URL the customer sent (Messenger CDN
 *                          or data:URI). Used by the URL-equality and
 *                          Cloudinary public_id shortcuts. Pass `null`
 *                          when only bytes are available.
 * @param tenantId          REQUIRED. We always scope catalog reads by
 *                          tenant — never compare across tenants.
 * @param prefilterCandidates Optional list of pre-narrowed candidates
 *                          (e.g. team-filtered) used for the URL/Cloudinary
 *                          shortcut to keep it cheap. The hash scan still
 *                          runs against the full tenant catalog.
 */
export async function matchCustomerPhotoAgainstCatalog(args: {
  customerImage: Buffer;
  customerImageUrl: string | null;
  tenantId: string;
  prefilterCandidates?: ProductMapping[];
}): Promise<PhotoMatchOutcome> {
  // ── Stage 1 — URL exact / Cloudinary public_id match ───────────────
  // Cheap: walks at most all rows in `prefilterCandidates` (or the whole
  // catalog if none provided). Uses meta.images directly — no fetch.
  if (args.customerImageUrl) {
    const customerCanonical = canonicaliseUrl(args.customerImageUrl);
    const customerCloudId = cloudinaryPublicId(args.customerImageUrl);
    const stage1Pool: ProductMapping[] =
      args.prefilterCandidates && args.prefilterCandidates.length > 0
        ? args.prefilterCandidates
        : await prisma.productMapping.findMany({
            where: { tenantId: args.tenantId },
            // Cap at 1000 so a pathological catalog never balloons; tenants
            // with more than this can still match via Stage 2 / 3.
            take: 1000,
          });
    for (const m of stage1Pool) {
      const urls = extractCatalogAssets(m).imageUrls;
      for (const url of urls) {
        if (canonicaliseUrl(url) === customerCanonical) {
          logger.info(
            { event: "photo_match_url_exact", sku: m.clientSku, url },
            "photoMatch: URL exact match",
          );
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
            logger.info(
              { event: "photo_match_cloudinary_exact", sku: m.clientSku, publicId: candCloudId },
              "photoMatch: Cloudinary public_id match",
            );
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

  // ── Stage 2 — perceptual hash compare against the WHOLE tenant catalog
  const customerFingerprint = await computeFingerprint(args.customerImage);
  if (!customerFingerprint) {
    return { kind: "ranked", ranked: [] };
  }
  // Capture into a non-nullable const so the worker closure below typechecks
  // without needing per-iteration narrowing assertions.
  const customerFp: ImageFingerprint = customerFingerprint;

  // Pull every product mapping for the tenant. The cache means subsequent
  // matches don't re-fetch the photos — this is one DB query + a CPU scan.
  // Cap at 1000 to keep memory bounded; large tenants would shard this.
  const allRows = await prisma.productMapping.findMany({
    where: { tenantId: args.tenantId },
    take: 1000,
  });
  if (allRows.length === 0) return { kind: "no_candidates" };

  type CandidateScore = {
    row: ProductMapping;
    bestUrl: string;
    bestDistance: number;
    /** Buffer is only set when we fetched it during the cache fill OR
     * when we re-fetch later for the LLM fallback. Stage 2a does not
     * need the buffer (it just returns the SKU). */
    bestBuffer?: Buffer;
  };
  const scored: CandidateScore[] = [];

  // Concurrency-bounded sweep: 8 products at a time. Each product reads
  // its cached fingerprints (or computes them once if missing) and
  // returns the best per-product hash distance.
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < allRows.length) {
      const i = cursor++;
      const m = allRows[i]!;
      try {
        const { fingerprints, freshBuffers } = await ensureFingerprintsForProduct(m);
        const entries = Object.entries(fingerprints);
        if (entries.length === 0) return;
        let bestUrl = "";
        let bestDistance = Number.POSITIVE_INFINITY;
        let bestBuffer: Buffer | undefined;
        for (const [url, fp] of entries) {
          const d = hammingDistance(customerFp, fp);
          if (d < bestDistance) {
            bestDistance = d;
            bestUrl = url;
            bestBuffer = freshBuffers.get(url);
          }
        }
        if (bestUrl) {
          const entry: CandidateScore = { row: m, bestUrl, bestDistance };
          if (bestBuffer) entry.bestBuffer = bestBuffer;
          scored.push(entry);
        }
      } catch (e) {
        logger.warn({ e: String(e), sku: m.clientSku }, "photoMatch: per-product scan failed");
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (scored.length === 0) {
    return { kind: "ranked", ranked: [] };
  }

  scored.sort((a, b) => a.bestDistance - b.bestDistance);
  const top1 = scored[0]!;

  // ── Stage 2a — near-exact auto-pick ───────────────────────────────
  if (top1.bestDistance <= NEAR_EXACT_THRESHOLD) {
    logger.info(
      {
        event: "photo_match_near_exact",
        sku: top1.row.clientSku,
        distance: top1.bestDistance,
        url: top1.bestUrl,
        catalogScanned: allRows.length,
      },
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

  // ── Stage 3 — return top-K for LLM fallback ───────────────────────
  // Within SIMILAR_THRESHOLD if any exist, else top-K by distance so the
  // LLM still has something to compare. We re-fetch the buffer here only
  // for products we didn't grab during the cache fill, so this is a few
  // HTTP calls at most.
  const similar = scored.filter((s) => s.bestDistance <= SIMILAR_THRESHOLD);
  const final = (similar.length > 0 ? similar : scored).slice(0, LLM_FALLBACK_TOP_K);

  const ranked = await Promise.all(
    final.map(async (s) => {
      let buf = s.bestBuffer;
      if (!buf) {
        const fetched = await fetchUrlAsBuffer(s.bestUrl);
        if (fetched) buf = fetched;
      }
      if (!buf) return null;
      return {
        row: s.row,
        bestUrl: s.bestUrl,
        bestImageBase64: buf.toString("base64"),
        hammingDistance: s.bestDistance,
      };
    }),
  );
  const filtered = ranked.filter((r): r is NonNullable<typeof r> => r !== null);

  logger.info(
    {
      event: "photo_match_llm_fallback",
      catalogScanned: allRows.length,
      topK: filtered.length,
      bestDistance: top1.bestDistance,
      bestSku: top1.row.clientSku,
    },
    "photoMatch: no near-exact match — falling back to LLM with top-K best-angle photos",
  );

  return { kind: "ranked", ranked: filtered };
}
