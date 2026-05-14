/**
 * List Cloudinary image assets (Admin API) and match folder-style public_ids to
 * ProductMapping rows by **title words** (label + common metadata title fields): if at
 * least **two** normalized words overlap between the folder slug and the title,
 * it counts as a match. SKU is not used for this rule (avoid false negatives when
 * folder names follow product titles, not internal SKUs).
 */

import type { ProductMapping } from "@prisma/client";

export type CloudinaryListConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Only assets under this public_id prefix (e.g. "jerseys/" or "catalog/brazil/") */
  prefix?: string;
};

export type CloudinaryAsset = {
  publicId: string;
  secureUrl: string;
  /**
   * Dynamic folder mode (Cloudinary default since ~2024): Media Library folder is stored
   * here and often **not** reflected in `public_id` (which can look like `image_…_hash`).
   */
  assetFolder?: string;
  displayName?: string;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parentFolderPath(publicId: string): string {
  const i = publicId.lastIndexOf("/");
  if (i <= 0) return "";
  return publicId.slice(0, i);
}

const TITLE_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "of",
  "to",
  "in",
  "on",
  "with",
  "official",
  "version",
]);

function readMeta(row: ProductMapping): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function metaTitleFragments(meta: Record<string, unknown>): string {
  const keys = ["name", "product_name", "productname", "productName", "title", "product_title"];
  return keys.map((k) => String(meta[k] ?? "").trim()).filter(Boolean).join(" ");
}

/** Customer-facing title text only (no SKU). Includes CSV/common metadata keys. */
function productTitleText(row: ProductMapping): string {
  const meta = readMeta(row);
  const label = String(row.facebookLabel ?? "").trim();
  const fromMeta = metaTitleFragments(meta);
  return [label, fromMeta].filter(Boolean).join(" ").trim();
}

/** Cloudinary “root” folder names — skip to the previous segment when possible. */
const GENERIC_FOLDER_SLUGS = new Set([
  "home",
  "root",
  "assets",
  "media",
  "images",
  "image",
  "uploads",
  "upload",
  "catalog",
  "products",
  "samples",
]);

/**
 * Cloudinary Media Library folders become path segments in each file’s `public_id`
 * (the technical path string, e.g. `Home/Spain WC26 Away Kit/photo_1`).
 * We take the **rightmost non-generic** folder segment so `Home/Spain WC26 Away Kit/…`
 * resolves to `Spain WC26 Away Kit`, not `Home`.
 */
function deepestFolderLabelFromPublicId(publicId: string): string {
  const trimmed = publicId.trim();
  const parent = parentFolderPath(trimmed);
  const path = parent || trimmed;
  const segs = path.split("/").map((s) => s.trim()).filter(Boolean);
  if (segs.length > 0) {
    let idx = segs.length - 1;
    while (idx > 0 && GENERIC_FOLDER_SLUGS.has(slugify(segs[idx]!))) idx -= 1;
    return segs[idx]!;
  }
  const leaf = trimmed.split("/").pop() ?? trimmed;
  return leaf.replace(/\.[^./]+$/i, "");
}

/** Words from a human title: letters/digits, min length 2, light stopword trim. */
function wordTokensFromTitle(text: string): Set<string> {
  const t = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const out = new Set<string>();
  for (const w of t.split(/\s+/)) {
    if (w.length < 2) continue;
    if (TITLE_STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** Tokens from slugified folder path (hyphen-separated, e.g. brazil-wc26-home). */
function wordTokensFromFolderSlug(folderSlug: string): Set<string> {
  const out = new Set<string>();
  for (const part of folderSlug.split("-")) {
    const w = part.trim().toLowerCase();
    if (w.length < 2) continue;
    if (TITLE_STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

function sharedWordCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * Score for picking best product for a folder. Requires ≥2 shared title/folder words.
 * Returns 0 if the rule is not met.
 */
function titleFolderWordMatchScore(folderSlug: string, row: ProductMapping): number {
  const folderTok = wordTokensFromFolderSlug(folderSlug);
  const titleTok = wordTokensFromTitle(productTitleText(row));
  if (folderTok.size === 0 || titleTok.size === 0) return 0;
  const shared = sharedWordCount(folderTok, titleTok);
  if (shared < 2) return 0;
  const denom = Math.max(folderTok.size, titleTok.size, 1);
  return 0.35 + (0.65 * shared) / denom;
}

function folderSlugForGrouping(publicId: string): string {
  const label = deepestFolderLabelFromPublicId(publicId);
  return slugify(label);
}

/**
 * Score using every `/` segment of the public_id as a title candidate (Cloudinary’s
 * “public id” **is** the path — e.g. `Home/Spain WC26 Away Kit/1`). Catches layouts
 * where the product name sits in a middle segment, not only the grouped folder key.
 */
function bestTitleMatchScoreFromPublicIdSegments(publicId: string, row: ProductMapping): number {
  const trimmed = publicId.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split("/").map((s) => s.trim()).filter(Boolean);
  let best = 0;
  for (let i = 0; i < parts.length; i++) {
    let seg = parts[i]!;
    if (i === parts.length - 1 && /\.[a-z0-9]{2,5}$/i.test(seg)) {
      seg = seg.replace(/\.[^.]+$/, "");
    }
    const slug = slugify(seg);
    if (!slug || GENERIC_FOLDER_SLUGS.has(slug)) continue;
    best = Math.max(best, titleFolderWordMatchScore(slug, row));
  }
  if (parts.length === 0) {
    const slug = slugify(trimmed.replace(/\.[^./]+$/i, ""));
    if (slug && !GENERIC_FOLDER_SLUGS.has(slug)) {
      best = Math.max(best, titleFolderWordMatchScore(slug, row));
    }
  }
  return best;
}

function bestProductForImageGroup(
  folderSlug: string,
  samplePublicId: string,
  assetFolder: string | undefined,
  displayName: string | undefined,
  rows: ProductMapping[],
): { row: ProductMapping; score: number } | null {
  const af = assetFolder?.trim();
  const dn = displayName?.trim();
  let best: { row: ProductMapping; score: number } | null = null;
  for (const row of rows) {
    let score = Math.max(
      titleFolderWordMatchScore(folderSlug, row),
      bestTitleMatchScoreFromPublicIdSegments(samplePublicId, row),
    );
    if (af) {
      score = Math.max(
        score,
        titleFolderWordMatchScore(slugify(af), row),
        bestTitleMatchScoreFromPublicIdSegments(af.replace(/\\/g, "/"), row),
      );
    }
    if (dn) {
      score = Math.max(score, titleFolderWordMatchScore(slugify(dn), row));
    }
    if (score <= 0) continue;
    if (!best || score > best.score) best = { row, score };
  }
  return best;
}

/** Group key: UI folder (`asset_folder` in dynamic mode) wins over parsing `public_id`. */
function primaryGroupKeyFromAsset(a: CloudinaryAsset): string {
  const af = a.assetFolder?.trim();
  if (af) return slugify(af);
  return folderSlugForGrouping(a.publicId);
}

async function fetchCloudinaryPage(
  cfg: CloudinaryListConfig,
  cursor?: string,
): Promise<{ resources: CloudinaryAsset[]; nextCursor?: string }> {
  const { cloudName, apiKey, apiSecret } = cfg;
  const prefix = (cfg.prefix ?? "").trim();
  const params = new URLSearchParams();
  params.set("max_results", "500");
  params.set("type", "upload");
  if (prefix) params.set("prefix", prefix.replace(/^\//, ""));
  if (cursor) params.set("next_cursor", cursor);

  const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/resources/image?${params.toString()}`;
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cloudinary list failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    resources?: Array<{
      public_id?: string;
      secure_url?: string;
      /** Dynamic folders: Media Library path (often absent from public_id). */
      asset_folder?: string;
      display_name?: string;
    }>;
    next_cursor?: string;
  };
  const resources: CloudinaryAsset[] = (data.resources ?? [])
    .map((r) => {
      const assetFolder = String(r.asset_folder ?? "").trim() || undefined;
      const displayName = String(r.display_name ?? "").trim() || undefined;
      return {
        publicId: String(r.public_id ?? "").trim(),
        secureUrl: String(r.secure_url ?? "").trim(),
        ...(assetFolder ? { assetFolder } : {}),
        ...(displayName ? { displayName } : {}),
      };
    })
    .filter((r) => r.publicId && /^https:\/\//i.test(r.secureUrl));
  return { resources, nextCursor: data.next_cursor };
}

/** Paginate through all image resources under optional prefix. */
export async function listAllCloudinaryImages(cfg: CloudinaryListConfig): Promise<CloudinaryAsset[]> {
  const all: CloudinaryAsset[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchCloudinaryPage(cfg, cursor);
    all.push(...page.resources);
    cursor = page.nextCursor;
    if (all.length > 20_000) break;
  } while (cursor);
  return all;
}

export type FolderImageGroup = {
  folderSlug: string;
  samplePublicId: string;
  /** Cloudinary dynamic-folder UI path, when API returns it */
  assetFolder?: string;
  displayName?: string;
  urls: string[];
};

export function groupAssetsByFolder(assets: CloudinaryAsset[]): FolderImageGroup[] {
  const map = new Map<string, { urls: string[]; sample: string; assetFolder?: string; displayName?: string }>();
  for (const a of assets) {
    const key = primaryGroupKeyFromAsset(a);
    if (!key) continue;
    const cur = map.get(key) ?? {
      urls: [],
      sample: a.publicId,
      assetFolder: a.assetFolder?.trim() || undefined,
      displayName: a.displayName?.trim() || undefined,
    };
    cur.urls.push(a.secureUrl);
    if (!cur.assetFolder && a.assetFolder?.trim()) cur.assetFolder = a.assetFolder.trim();
    if (!cur.displayName && a.displayName?.trim()) cur.displayName = a.displayName.trim();
    map.set(key, cur);
  }
  return [...map.entries()].map(([folderSlug, v]) => ({
    folderSlug,
    samplePublicId: v.sample,
    ...(v.assetFolder ? { assetFolder: v.assetFolder } : {}),
    ...(v.displayName ? { displayName: v.displayName } : {}),
    urls: Array.from(new Set(v.urls)).sort(),
  }));
}

export type CloudinaryMatchPreview = {
  folderSlug: string;
  samplePublicId: string;
  clientSku: string;
  facebookLabel: string | null;
  score: number;
  imageCount: number;
  urls: string[];
};

export function buildCloudinaryAssignments(
  assets: CloudinaryAsset[],
  products: ProductMapping[],
): CloudinaryMatchPreview[] {
  const groups = groupAssetsByFolder(assets);
  /** SKU → merged URLs from every folder that best-matched this product */
  const bySku = new Map<
    string,
    { urls: Set<string>; bestScore: number; folderSlugs: string[]; samplePublicId: string; label: string | null }
  >();

  for (const g of groups) {
    const hit = bestProductForImageGroup(g.folderSlug, g.samplePublicId, g.assetFolder, g.displayName, products);
    if (!hit) continue;
    const sku = hit.row.clientSku;
    let cur = bySku.get(sku);
    if (!cur) {
      cur = {
        urls: new Set<string>(),
        bestScore: 0,
        folderSlugs: [],
        samplePublicId: g.samplePublicId,
        label: hit.row.facebookLabel,
      };
    }
    for (const u of g.urls) cur.urls.add(u);
    cur.bestScore = Math.max(cur.bestScore, hit.score);
    cur.folderSlugs.push(g.folderSlug);
    if (!cur.samplePublicId) cur.samplePublicId = g.samplePublicId;
    if (!cur.label) cur.label = hit.row.facebookLabel;
    bySku.set(sku, cur);
  }

  const out: CloudinaryMatchPreview[] = [];
  for (const [clientSku, v] of bySku) {
    const urls = [...v.urls].sort();
    out.push({
      folderSlug: v.folderSlugs.join(" + ") || clientSku,
      samplePublicId: v.samplePublicId,
      clientSku,
      facebookLabel: v.label,
      score: v.bestScore,
      imageCount: urls.length,
      urls,
    });
  }
  return out.sort((a, b) => a.clientSku.localeCompare(b.clientSku));
}

/**
 * Other metadata keys the portal and `extractCatalogAssets` merge with `images` for thumbnails / bot replies.
 * When Cloudinary sync wins, remove them so old URLs cannot appear alongside the new `images` list.
 */
const LEGACY_CATALOG_IMAGE_KEYS = [
  "image_urls",
  "image_url",
  "imageUrls",
  "imageUrl",
  "photos",
  "photoUrls",
  "photo",
  "thumbnail",
] as const;

/** Set `metadata.images` from Cloudinary URLs and drop legacy image-link fields so prior URLs are not reused. */
export function mergeMetadataImages(existing: unknown, imageUrls: string[]): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const k of LEGACY_CATALOG_IMAGE_KEYS) {
    delete base[k];
  }
  base.images = [...imageUrls];
  return base;
}

export type CloudinarySyncDiagnostics = {
  /** What Cloudinary returns as the path string (first few files). */
  samplePublicIds: string[];
  /** `asset_folder` when Cloudinary returns it (dynamic folder mode). */
  sampleAssetFolders: string[];
  /** Folder keys we grouped images under (slug of folder name). */
  groupKeysFromCloudinary: string[];
  /** SKUs with no title text at all — matching cannot run. */
  emptyTitleSkus: string[];
  /** What we compare against folder words (first rows). */
  productTitles: Array<{ clientSku: string; titleText: string; words: string }>;
  /** Short explanation for the operator. */
  hint: string;
};

export function buildCloudinarySyncDiagnostics(
  assets: CloudinaryAsset[],
  products: ProductMapping[],
): CloudinarySyncDiagnostics {
  const samplePublicIds = assets.slice(0, 12).map((a) => a.publicId);
  const sampleAssetFolders = [
    ...new Set(assets.map((a) => a.assetFolder?.trim()).filter((x): x is string => Boolean(x))),
  ].slice(0, 20);
  const groups = groupAssetsByFolder(assets);
  const groupKeysFromCloudinary = [...new Set(groups.map((g) => g.folderSlug))]
    .filter(Boolean)
    .sort()
    .slice(0, 30);
  const emptyTitleSkus = products.filter((p) => !productTitleText(p)).map((p) => p.clientSku);
  const productTitles = products.slice(0, 18).map((p) => ({
    clientSku: p.clientSku,
    titleText: productTitleText(p),
    words: [...wordTokensFromTitle(productTitleText(p))].sort().join(", "),
  }));

  let hint =
    "In Cloudinary, **Public ID is the file path** (folders use `/`, same as a path on disk). We need **at least two words** in common between that path’s segments and your catalog title (label + metadata name). SKU is not used. If the UI only shows “Public ID”, that string already is the path.";
  if (products.length > 0 && emptyTitleSkus.length === products.length) {
    hint =
      "No titles found on any catalog row: set **Facebook / label** in the form, or put the product name in metadata as **name** or **product_name**. Without words, matching cannot run.";
  } else if (groupKeysFromCloudinary.length === 1 && groupKeysFromCloudinary[0] === "home" && assets.length > 5) {
    hint =
      'Every image path ends at folder **Home** only (e.g. `Home/img123.jpg`). Cloudinary is not putting your product folder into `public_id`. Create a **subfolder under Home** with the product name and move files there, then run Preview again.';
  } else if (sampleAssetFolders.length === 0 && assets.length > 0 && samplePublicIds.some((id) => !id.includes("/"))) {
    hint =
      "Your `public_id` values look like random ids (no `/`, no product words). On **Dynamic folders** (default Cloudinary mode), the Media Library folder is stored separately as **asset_folder** in the API — we now read that for matching. If **Sample asset folders** below is still empty, your Cloudinary plan/API may not return `asset_folder`; then use **Fixed / classic folder mode**, or upload with a `public_id` that includes the path (e.g. `Spain_WC26_Away_Kit/photo_1`).";
  } else if (groupKeysFromCloudinary.length <= 2 && assets.length > 30) {
    hint =
      "Very few folder groups for many images — open **sample public_id** below. If you do not see your product folder name in the path, the API cannot match it to a title.";
  }

  return {
    samplePublicIds,
    sampleAssetFolders,
    groupKeysFromCloudinary,
    emptyTitleSkus,
    productTitles,
    hint,
  };
}
