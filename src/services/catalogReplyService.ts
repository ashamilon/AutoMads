import type { ProductMapping } from "@prisma/client";
import type { TenantSettings } from "../types/tenant-settings.js";

export type TenantSizeChart = NonNullable<TenantSettings["sizeCharts"]>[number];

const MAX_CATALOG_CHARS = 42_000;
const MAX_ROW_JSON = 900;

/** Compact lines for the LLM: one row per mapping (SKU + label + metadata JSON). */
export function buildCatalogLinesForLlm(mappings: ProductMapping[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of mappings) {
    const meta =
      m.metadata && typeof m.metadata === "object" && !Array.isArray(m.metadata)
        ? (m.metadata as Record<string, unknown>)
        : {};
    let metaStr = JSON.stringify(meta);
    if (metaStr.length > MAX_ROW_JSON) metaStr = `${metaStr.slice(0, MAX_ROW_JSON)}…`;
    const label = (m.facebookLabel ?? "").replace(/\r?\n/g, " ").trim();
    const line = `${m.clientSku}\t${label}\t${metaStr}`;
    if (total + line.length + 1 > MAX_CATALOG_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

const META_PRIORITY = [
  "name",
  "slug",
  "price",
  "comparePrice",
  "fabricMaterial",
  "jerseyVersion",
  "stock",
  "categoryName",
  "categorySlug",
  "variants",
  "images",
  "isActive",
  "isFeatured",
  "isPreOrder",
  "allowNameNumber",
  "nameNumberPrice",
  "selectedBadges",
  "seoTitle",
  "seoKeywords",
  "weight",
  "dimensions",
  "id",
];

/** Human-readable facts for the reply LLM (no long prose). */
export function formatProductMappingForCustomer(m: ProductMapping): string {
  const parts: string[] = [];
  parts.push(`SKU: ${m.clientSku}`);
  if (m.facebookLabel?.trim()) parts.push(`Product name: ${m.facebookLabel.trim()}`);

  const meta =
    m.metadata && typeof m.metadata === "object" && !Array.isArray(m.metadata)
      ? (m.metadata as Record<string, unknown>)
      : {};

  const seen = new Set<string>();
  const ssMap = readSizeStocksMap(meta);
  if (Object.keys(ssMap).length > 0) {
    const line = sortSizeLabels(Object.keys(ssMap))
      .map((k) => `${k}=${ssMap[k]}`)
      .join(", ");
    parts.push(`sizeStocks: ${line}`);
    seen.add("sizeStocks");
    seen.add("size_stocks");
    seen.add("stock");
  }
  for (const k of META_PRIORITY) {
    if (!(k in meta)) continue;
    if (seen.has(k)) continue;
    const v = meta[k];
    if (v === null || v === undefined || v === "") continue;
    seen.add(k);
    parts.push(`${k}: ${String(v)}`);
  }
  for (const k of Object.keys(meta).sort()) {
    if (seen.has(k)) continue;
    const v = meta[k];
    if (v === null || v === undefined || v === "") continue;
    if (k === "description" || k === "seoDescription") continue;
    const s = String(v);
    if (s.length > 1200) parts.push(`${k}: ${s.slice(0, 1200)}…`);
    else parts.push(`${k}: ${s}`);
  }
  return parts.join("\n");
}

function readMetaObject(m: ProductMapping): Record<string, unknown> {
  if (m.metadata && typeof m.metadata === "object" && !Array.isArray(m.metadata)) {
    return m.metadata as Record<string, unknown>;
  }
  return {};
}

function parseNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const SIZE_LABEL_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL"];

function sortSizeLabels(sizes: string[]): string[] {
  const uniq = [...new Set(sizes.map((s) => s.trim()).filter(Boolean))];
  const rank = (s: string) => {
    const u = s.toUpperCase();
    const i = SIZE_LABEL_ORDER.indexOf(u);
    return i >= 0 ? i : 100;
  };
  return uniq.sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.toUpperCase().localeCompare(b.toUpperCase());
  });
}

/** Per-size quantities from `metadata.sizeStocks` (object) or `size_stocks`, or array of { size, stock }. */
export function readSizeStocksMap(meta: Record<string, unknown>): Record<string, number> {
  const raw = meta["sizeStocks"] ?? meta["size_stocks"];
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const key = String(k).trim().toUpperCase();
      if (!key) continue;
      const n = typeof v === "number" && Number.isFinite(v) ? v : Number(String(v ?? "").trim());
      if (!Number.isFinite(n)) continue;
      out[key] = n;
    }
    return out;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const o = entry as Record<string, unknown>;
      const key = String(o.size ?? o.Size ?? "").trim().toUpperCase();
      if (!key) continue;
      const n =
        typeof o.stock === "number" && Number.isFinite(o.stock)
          ? o.stock
          : Number(String(o.stock ?? o.qty ?? "").trim());
      if (!Number.isFinite(n)) continue;
      out[key] = n;
    }
  }
  return out;
}

function rowStock(m: ProductMapping): number | null {
  const meta = readMetaObject(m);
  const bySize = readSizeStocksMap(meta);
  const keys = Object.keys(bySize);
  if (keys.length > 0) {
    let sum = 0;
    for (const k of keys) sum += bySize[k] ?? 0;
    return sum;
  }
  return parseNumber(meta["stock"]);
}

function rowIsActive(m: ProductMapping): boolean {
  const meta = readMetaObject(m);
  const raw = meta["isActive"] ?? meta["isactive"];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (t === "true" || t === "1") return true;
    if (t === "false" || t === "0") return false;
  }
  return true;
}

function tokenize(input: string): string[] {
  const normalized = normalizeSearchText(input);
  return normalized
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function normalizeSearchText(input: string): string {
  let out = input;
  const map: Array<[RegExp, string]> = [
    [/\barg\b/gi, "argentina"],
    [/আর্জেন্টিনা/gi, "argentina"],
    [/ব্রাজিল/gi, "brazil"],
    [/ইংল্যান্ড/gi, "england"],
    [/পর্তুগাল/gi, "portugal"],
    [/ইতালি/gi, "italy"],
    [/জাপান/gi, "japan"],
    [/হোম/gi, "home"],
    [/অ্যাওয়ে|এওয়ে|away/gi, "away"],
    [/জার্সি/gi, "jersey"],
  ];
  for (const [rx, rep] of map) out = out.replace(rx, rep);
  return out;
}

const QUERY_STOPWORDS = new Set([
  "photo",
  "pic",
  "image",
  "chobi",
  "size",
  "chart",
  "measurement",
  "measure",
  "m",
  "den",
  "dao",
  "daw",
  "hobe",
  "ache",
  "ase",
  "ki",
  "koto",
  "jersey",
  "shirt",
  "kit",
  "lagbe",
  "chai",
  "dibo",
  "diben",
  "den",
  "dao",
  "ta",
  "er",
  "sathe",
  "gula",
  "available",
  "stock",
  "price",
  "nibo",
  "nite",
  "order",
  "buy",
]);

function rowSearchText(m: ProductMapping): string {
  const meta = readMetaObject(m);
  const name = String(meta["name"] ?? "");
  const slug = String(meta["slug"] ?? "");
  const seo = String(meta["seoKeywords"] ?? meta["seokeywords"] ?? "");
  const category = String(meta["categoryName"] ?? meta["category"] ?? meta["categorySlug"] ?? "");
  const tags = Array.isArray(meta["tags"])
    ? (meta["tags"] as unknown[]).map((t) => String(t ?? "").trim()).filter(Boolean).join(" ")
    : String(meta["tags"] ?? "");
  const fabric = String(meta["fabricMaterial"] ?? meta["fabric_type"] ?? "");
  const kit =
    String(meta["jerseyVersion"] ?? meta["jersey_version"] ?? "").toLowerCase() === "player"
      ? "player version"
      : String(meta["jerseyVersion"] ?? meta["jersey_version"] ?? "").toLowerCase() === "fan"
        ? "fan version"
        : "";
  return [m.facebookLabel ?? "", name, slug, seo, category, tags, fabric, kit].join(" ").toLowerCase();
}

/**
 * After vision labels a country/club, filter catalog rows that mention any of those names
 * (token match first, then substring fallback for short codes / nicknames).
 */
export function findCatalogByJerseyEntities(
  mappings: ProductMapping[],
  primaryNames: string[],
  limit = 12,
): ProductMapping[] {
  const cleaned = primaryNames.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  const bySku = new Map<string, ProductMapping>();
  const combinedQuery = cleaned.join(" ");
  for (const m of findCatalogMatchesByText(mappings, combinedQuery, limit)) {
    bySku.set(m.clientSku, m);
  }
  if (bySku.size < 2) {
    for (const part of cleaned) {
      for (const m of findCatalogMatchesByText(mappings, part, limit)) {
        if (!bySku.has(m.clientSku)) bySku.set(m.clientSku, m);
      }
    }
  }
  if (bySku.size > 0) return Array.from(bySku.values()).slice(0, limit);

  const needles = [
    ...new Set(
      cleaned
        .map((p) => p.toLowerCase().trim())
        .filter((p) => p.length >= 3),
    ),
  ];
  if (needles.length === 0) return [];
  const loose: ProductMapping[] = [];
  for (const m of mappings) {
    const blob = rowSearchText(m);
    if (needles.some((n) => blob.includes(n))) loose.push(m);
  }
  return loose.slice(0, limit);
}

/**
 * Deterministic catalog match for text queries.
 * Prefers rows with token overlap, then active rows, then in-stock rows.
 */
export function findBestCatalogMatchByText(
  mappings: ProductMapping[],
  query: string,
): ProductMapping | null {
  return findCatalogMatchesByText(mappings, query, 1)[0] ?? null;
}

function tokenMatches(rowToken: string, queryToken: string): boolean {
  if (rowToken === queryToken) return true;
  // Support short abbreviations like "arg" -> "argentina".
  if (queryToken.length >= 3 && rowToken.startsWith(queryToken)) return true;
  // Typo / stem overlap (e.g. "argentinar" vs "argentina") without fuzzy DB-wide substring noise.
  const minLen = Math.min(rowToken.length, queryToken.length);
  if (minLen >= 5) {
    const p = Math.min(6, minLen);
    if (rowToken.slice(0, p) === queryToken.slice(0, p)) return true;
  }
  return false;
}

export function findCatalogMatchesByText(
  mappings: ProductMapping[],
  query: string,
  limit = 8,
): ProductMapping[] {
  const rawQTokens = Array.from(new Set(tokenize(query)));
  const qTokens = rawQTokens.filter((t) => !QUERY_STOPWORDS.has(t));
  if (qTokens.length === 0) return [];
  const anchorTokens = qTokens.filter((t) => t.length >= 4);

  const queryTeams = detectAllTeamNamesInQuery(query);

  if (queryTeams.length >= 2) {
    const segments = parseTeamSegments(query);
    if (segments.length >= 2) {
      const segResults = findCatalogMatchesByTeamSegments(mappings, segments, limit);
      if (segResults.length > 0) return segResults;
    }
  }

  const queryTeam = queryTeams.length > 0 ? queryTeams[0] : null;
  const nonTeamTokens = queryTeams.length > 0 ? getNonTeamQueryTokens(query, queryTeams[0]!) : [];

  let pool = mappings;
  if (queryTeams.length > 0) {
    const teamLowers = queryTeams.map((t) => t.toLowerCase());
    pool = mappings.filter((m) => {
      const text = rowSearchText(m);
      return teamLowers.some((tl) => text.includes(tl));
    });
    if (pool.length === 0) pool = mappings;
  }

  const scored = pool
    .map((m) => {
      const text = rowSearchText(m);
      const rowTokens = Array.from(new Set(tokenize(text)));
      let overlap = 0;
      let nonTeamOverlap = 0;
      for (const t of qTokens) {
        if (rowTokens.some((rt) => tokenMatches(rt, t))) {
          overlap += 1;
          if (nonTeamTokens.includes(t)) nonTeamOverlap += 1;
        }
      }
      const overlapRatio = overlap / qTokens.length;
      const anchorMatched =
        anchorTokens.length === 0 ||
        anchorTokens.some((a) => rowTokens.some((rt) => tokenMatches(rt, a)));
      const stock = rowStock(m);
      return {
        m,
        overlapRatio,
        overlap,
        nonTeamOverlap,
        anchorMatched,
        isActive: rowIsActive(m),
        inStock: stock != null ? stock > 0 : false,
        stock: stock ?? -1,
      };
    })
    .filter((r) => r.overlapRatio > 0)
    .filter((r) => r.anchorMatched)
    .filter((r) => {
      if (queryTeam) {
        return r.overlap >= 1;
      }
      return qTokens.length >= 2 ? r.overlap >= 2 || r.overlapRatio >= 0.67 : r.overlap >= 1;
    })
    .sort((a, b) => {
      if (b.nonTeamOverlap !== a.nonTeamOverlap) return b.nonTeamOverlap - a.nonTeamOverlap;
      if (b.overlapRatio !== a.overlapRatio) return b.overlapRatio - a.overlapRatio;
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      if (b.stock !== a.stock) return b.stock - a.stock;
      return 0;
    });

  if (queryTeam && nonTeamTokens.length > 0) {
    const bestNonTeamOverlap = scored.length > 0 ? scored[0].nonTeamOverlap : 0;
    if (bestNonTeamOverlap > 0) {
      const topMatches = scored.filter((r) => r.nonTeamOverlap === bestNonTeamOverlap);
      return topMatches.slice(0, Math.max(1, limit)).map((x) => x.m);
    }
  }

  return scored.slice(0, Math.max(1, limit)).map((x) => x.m);
}

function detectTeamNameInQuery(query: string): string | null {
  const teams = detectAllTeamNamesInQuery(query);
  return teams.length > 0 ? teams[0] : null;
}

function detectAllTeamNamesInQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const found: string[] = [];
  for (const name of TEAM_NAMES_FOR_COLLECTION_EXPAND) {
    if (lower.includes(name.toLowerCase())) found.push(name);
  }
  return found;
}

function getNonTeamQueryTokens(query: string, team: string): string[] {
  const allTokens = Array.from(new Set(tokenize(query))).filter((t) => !QUERY_STOPWORDS.has(t));
  const allTeams = detectAllTeamNamesInQuery(query);
  const teamTokens = new Set<string>();
  for (const t of (allTeams.length > 0 ? allTeams : [team])) {
    for (const tok of tokenize(t)) teamTokens.add(tok);
  }
  return allTokens.filter((t) => !teamTokens.has(t));
}

type TeamSegment = { team: string; qualifiers: string[] };

function parseTeamSegments(query: string): TeamSegment[] {
  const teams = detectAllTeamNamesInQuery(query);
  if (teams.length <= 1) return [];
  const lower = query.toLowerCase();
  const segments: TeamSegment[] = [];
  const teamPositions = teams.map((t) => ({ team: t, pos: lower.indexOf(t.toLowerCase()) }))
    .sort((a, b) => a.pos - b.pos);

  for (let i = 0; i < teamPositions.length; i++) {
    const current = teamPositions[i]!;
    const segStart = current.pos + current.team.length;
    const segEnd = i < teamPositions.length - 1 ? teamPositions[i + 1]!.pos : lower.length;
    const segText = lower.slice(segStart, segEnd);
    const qualTokens = Array.from(new Set(tokenize(segText)))
      .filter((t) => !QUERY_STOPWORDS.has(t))
      .filter((t) => !teams.some((tm) => tokenize(tm.toLowerCase()).includes(t)));
    segments.push({ team: current.team, qualifiers: qualTokens });
  }
  return segments;
}

function findCatalogMatchesByTeamSegments(
  mappings: ProductMapping[],
  segments: TeamSegment[],
  limit: number,
): ProductMapping[] {
  const results = new Map<string, ProductMapping>();
  for (const seg of segments) {
    const teamLower = seg.team.toLowerCase();
    const teamPool = mappings.filter((m) => rowSearchText(m).includes(teamLower));
    if (seg.qualifiers.length === 0) {
      for (const m of teamPool.slice(0, limit)) results.set(m.clientSku, m);
    } else {
      const matched = teamPool.filter((m) => {
        const rowToks = Array.from(new Set(tokenize(rowSearchText(m))));
        return seg.qualifiers.every((q) => rowToks.some((rt) => tokenMatches(rt, q)));
      });
      if (matched.length > 0) {
        for (const m of matched) results.set(m.clientSku, m);
      } else {
        const partial = teamPool.filter((m) => {
          const rowToks = Array.from(new Set(tokenize(rowSearchText(m))));
          return seg.qualifiers.some((q) => rowToks.some((rt) => tokenMatches(rt, q)));
        });
        for (const m of (partial.length > 0 ? partial : teamPool).slice(0, 4)) results.set(m.clientSku, m);
      }
    }
  }
  return Array.from(results.values()).slice(0, limit);
}

/** Longest first so "Saudi Arabia" wins over "Arabia" if both ever appeared. */
const TEAM_NAMES_FOR_COLLECTION_EXPAND: string[] = [
  "Saudi Arabia",
  "Real Madrid",
  "Manchester United",
  "Manchester City",
  "Bayern Munich",
  "Inter Milan",
  "AC Milan",
  "Argentina",
  "Brazil",
  "Spain",
  "Portugal",
  "France",
  "Germany",
  "England",
  "Italy",
  "Netherlands",
  "Belgium",
  "Mexico",
  "Japan",
  "Colombia",
  "Uruguay",
  "Croatia",
  "Sweden",
  "Morocco",
  "USA",
  "Canada",
  "Bangladesh",
  "India",
  "Pakistan",
  "Korea",
  "Barcelona",
  "Liverpool",
  "Chelsea",
  "Juventus",
  "Inter",
  "Milan",
  "PSG",
  "Bayern",
  "Arsenal",
  "Napoli",
].sort((a, b) => b.length - a.length);

function stripBuyIntentWordsForCatalogQuery(q: string): string {
  return q
    .replace(/\b(vai|bro|bhai|please|pls|ami|tao)\b/gi, " ")
    .replace(
      /\b(nibo|nite\s*chai|nitechai|lagbe|chai|chay|dibo|diben|order|book|buy|nitam|nebo|niben)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function teamNamesRecognizedInRow(m: ProductMapping): string[] {
  const blob = `${rowSearchText(m)} ${String(m.facebookLabel ?? "").toLowerCase()}`;
  const hits: string[] = [];
  for (const name of TEAM_NAMES_FOR_COLLECTION_EXPAND) {
    if (blob.includes(name.toLowerCase())) hits.push(name);
  }
  return hits;
}

/**
 * When text search returns one SKU but the customer meant a whole team line (e.g. several
 * Argentina kits), widen to all catalog rows for that team. Also retries match on a query
 * stripped of buy-intent words ("nibo") so overlap scoring is not dominated by order verbs.
 */
export function expandCatalogMatchesForTeamCollection(
  mappings: ProductMapping[],
  query: string,
  initial: ProductMapping[],
  limit: number,
): ProductMapping[] {
  const queryTeams = detectAllTeamNamesInQuery(query);
  const queryTeam = queryTeams.length > 0 ? queryTeams[0] : null;

  if (queryTeams.length >= 2) {
    if (initial.length >= 1) return initial.slice(0, limit);
  }

  if (queryTeams.length === 1) {
    const nonTeamToks = getNonTeamQueryTokens(query, queryTeams[0]!);
    if (nonTeamToks.length === 0) {
      const teamLower = queryTeams[0]!.toLowerCase();
      const teamProducts = mappings.filter((m) => rowSearchText(m).includes(teamLower));
      if (teamProducts.length >= 1) return teamProducts.slice(0, limit);
    }
    if (initial.length >= 1) return initial.slice(0, limit);
  }

  if (initial.length >= 2) return initial.slice(0, limit);
  const stripped = stripBuyIntentWordsForCatalogQuery(query);
  if (stripped && stripped !== query.trim()) {
    const second = findCatalogMatchesByText(mappings, stripped, limit);
    if (second.length >= 2) return second.slice(0, limit);
  }
  if (initial.length === 1) {
    for (const team of teamNamesRecognizedInRow(initial[0]!)) {
      const expanded = findCatalogByJerseyEntities(mappings, [team], limit);
      if (expanded.length >= 2) return expanded.slice(0, limit);
    }
  }
  return initial.slice(0, limit);
}

function parseImageUrls(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(/[|,\n\r]+/g)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("http://") || s.startsWith("https://"));
  }
  if (Array.isArray(raw)) {
    return raw
      .map((v) => String(v ?? "").trim())
      .filter((s) => s.startsWith("http://") || s.startsWith("https://"));
  }
  return [];
}

function parseSizesFromVariants(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const rx = /size\s*:\s*([A-Za-z0-9]+)/gi;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(rx)) {
    const s = (m[1] ?? "").toUpperCase();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function sizesOfferedFromMeta(meta: Record<string, unknown>): string[] {
  const fromVariants = parseSizesFromVariants(meta["variants"]);
  const fromStock = Object.keys(readSizeStocksMap(meta));
  return sortSizeLabels([...fromVariants, ...fromStock]);
}

export function extractCatalogAssets(m: ProductMapping): {
  imageUrls: string[];
  sizes: string[];
  stock: number | null;
} {
  const meta = readMetaObject(m);
  const imageCandidates = [
    meta["images"],
    meta["image_urls"],
    meta["imageUrls"],
    meta["imageUrl"],
    meta["image_url"],
    meta["photos"],
    meta["photoUrls"],
  ];
  const mergedImages: string[] = [];
  const seen = new Set<string>();
  for (const c of imageCandidates) {
    for (const u of parseImageUrls(c)) {
      if (seen.has(u)) continue;
      seen.add(u);
      mergedImages.push(u);
    }
  }
  return {
    imageUrls: mergedImages,
    sizes: sizesOfferedFromMeta(meta),
    stock: rowStock(m),
  };
}

/** Pick a small flag/emoji prefix based on team/country in the product name or category. */
export function pickTeamEmoji(name: string, meta?: Record<string, unknown>): string {
  const blob = (
    `${name} ${meta?.["name"] ?? ""} ${meta?.["categoryName"] ?? meta?.["category"] ?? ""} ${meta?.["tags"] ?? ""}`
  ).toLowerCase();
  const table: Array<[RegExp, string]> = [
    [/\bargentina\b/, "🇦🇷"],
    [/\bbrazil\b|\bbrasil\b/, "🇧🇷"],
    [/\bspain\b|\bespana\b|\bespaña\b/, "🇪🇸"],
    [/\bportugal\b/, "🇵🇹"],
    [/\bfrance\b/, "🇫🇷"],
    [/\bgermany\b|\bdeutschland\b/, "🇩🇪"],
    [/\bengland\b/, "🏴󠁧󠁢󠁥󠁮󠁧󠁿"],
    [/\bitaly\b|\bitalia\b/, "🇮🇹"],
    [/\bnetherlands\b|\bholland\b/, "🇳🇱"],
    [/\bbelgium\b/, "🇧🇪"],
    [/\bmexico\b/, "🇲🇽"],
    [/\bjapan\b/, "🇯🇵"],
    [/\bcolombia\b/, "🇨🇴"],
    [/\buruguay\b/, "🇺🇾"],
    [/\bcroatia\b/, "🇭🇷"],
    [/\bsweden\b/, "🇸🇪"],
    [/\bsaudi\b/, "🇸🇦"],
    [/\bmorocco\b/, "🇲🇦"],
    [/\busa|united states|america\b/, "🇺🇸"],
    [/\bcanada\b/, "🇨🇦"],
    [/\bbangladesh\b/, "🇧🇩"],
    [/\bindia\b/, "🇮🇳"],
    [/\bpakistan\b/, "🇵🇰"],
    [/\bsouth korea|korea republic\b/, "🇰🇷"],
    [/\bbarcelona\b|\bbarca\b/, "🔵🔴"],
    [/\breal madrid\b/, "⚪"],
    [/\bmanchester united\b|\bman utd\b/, "🔴"],
    [/\bmanchester city\b|\bman city\b/, "🩵"],
    [/\bliverpool\b/, "🔴"],
    [/\bchelsea\b/, "🔵"],
    [/\bjuventus\b/, "⚫⚪"],
    [/\binter milan|\binter\b/, "🔵⚫"],
    [/\bac milan\b|\bmilan\b/, "🔴⚫"],
    [/\bpsg|paris saint/, "🔵"],
    [/\bbayern\b/, "🔴"],
    [/\barsenal\b/, "🔴"],
    [/\bnapoli\b/, "🔵"],
  ];
  for (const [rx, e] of table) if (rx.test(blob)) return e;
  return "⚽";
}

function availableSizesFromMeta(meta: Record<string, unknown>): string[] {
  const bySize = readSizeStocksMap(meta);
  const keys = Object.keys(bySize);
  if (keys.length > 0) {
    return sortSizeLabels(keys.filter((k) => (bySize[k] ?? 0) > 0));
  }
  return sortSizeLabels(parseSizesFromVariants(meta["variants"]));
}

function lowStockHighlights(meta: Record<string, unknown>): Array<{ size: string; qty: number }> {
  const bySize = readSizeStocksMap(meta);
  const out: Array<{ size: string; qty: number }> = [];
  for (const k of sortSizeLabels(Object.keys(bySize))) {
    const qty = bySize[k] ?? 0;
    if (qty > 0 && qty <= 3) out.push({ size: k, qty });
  }
  return out;
}

function formatPriceBdt(priceRaw: unknown): string | null {
  if (priceRaw === null || priceRaw === undefined) return null;
  const s = String(priceRaw).trim();
  if (!s) return null;
  return s;
}

function buildAddonLinesFromSettings(addOns?: TenantSettings["addOns"]): string[] {
  if (!addOns || addOns.length === 0) return [];
  const active = addOns.filter((a) => a && a.label?.trim() && a.enabled !== false);
  if (active.length === 0) return [];
  return active.slice(0, 6).map((a) => {
    const label = a.label.trim();
    const isFree = a.free === true || (typeof a.priceBdt === "number" && a.priceBdt === 0);
    const price = isFree ? " (FREE)" : typeof a.priceBdt === "number" ? ` (+${a.priceBdt})` : "";
    return `✔ ${label}${price}`;
  });
}

export type ProductReplyOpts = {
  addOns?: TenantSettings["addOns"];
  /** When true, include "Nite chaile size ar qty bolen." prompt at the end. */
  includeCta?: boolean;
};

export function buildDeterministicCatalogReply(
  m: ProductMapping,
  opts: ProductReplyOpts = {},
): string {
  const meta = readMetaObject(m);
  const name = (m.facebookLabel ?? String(meta["name"] ?? "Product")).trim();
  const flag = pickTeamEmoji(name, meta);
  const sections: string[] = [];
  sections.push(`${flag} ${name}`);

  const price = formatPriceBdt(meta["price"]);
  if (price) sections.push(`💰 ${price} BDT`);

  const bySize = readSizeStocksMap(meta);
  const sizeKeys = Object.keys(bySize);
  const available = availableSizesFromMeta(meta);
  const totalSizedStock = sizeKeys.reduce((s, k) => s + (bySize[k] ?? 0), 0);

  if (available.length > 0) {
    sections.push(`📏 Sizes:\n${available.join(" · ")}`);
  } else if (sizeKeys.length > 0 && totalSizedStock === 0) {
    sections.push("📏 Sizes:\nEkhon stock nai");
  }

  const lows = lowStockHighlights(meta);
  if (lows.length > 0) {
    const lines = lows.map((x) => `Only ${x.qty} pieces left in ${x.size}`).join("\n");
    sections.push(`⚠️ Low Stock:\n${lines}`);
  }

  sections.push(`🚚 Delivery: ${extractDeliveryEta(meta)}`);

  const addonLines = buildAddonLinesFromSettings(opts.addOns);
  if (addonLines.length > 0) {
    sections.push(`✨ Add-ons Available\n${addonLines.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Catalogs scraped from upstream e-commerce systems sometimes store placeholder
 * strings instead of real measurements (e.g. "Measurements not provided in
 * catalog; available sizes: ..."). Reject those — we'd rather fall through to
 * the fabric-aware default than echo junk back to the customer.
 */
function looksLikeRealMeasurementString(line: string): boolean {
  const t = line.toLowerCase();
  if (/(not\s+provided|not\s+available|tbd|to\s+be\s+confirmed|coming\s+soon|n\/?a)/i.test(t)) {
    return false;
  }
  // Must contain at least one digit paired with a measurement keyword OR a size
  // letter followed by two numbers (e.g. "M 27 38").
  if (/(chest|length|long|sleeve|shoulder|waist|hip)\s*[:=]?\s*\d/i.test(t)) return true;
  if (/\b[smlx]{1,4}\b[^\w]+\d+[^\w]+\d+/i.test(t)) return true;
  return false;
}

function extractMeasurementChartLines(meta: Record<string, unknown>): string[] {
  const candidates = [
    meta["sizeChart"],
    meta["size_chart"],
    meta["sizeGuide"],
    meta["size_guide"],
    meta["measurements"],
    meta["measurementChart"],
    meta["measurement_chart"],
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "string") {
      const txt = c.trim();
      if (!txt) continue;
      const split = txt
        .split(/\r?\n|;|\|/)
        .map((s) => s.trim())
        .filter(Boolean);
      const realRows = split.filter(looksLikeRealMeasurementString).slice(0, 12);
      if (realRows.length >= 2) return realRows;
      // String exists but is a placeholder ("Measurements not provided…",
      // "available sizes: …"). Skip — let the fabric / tenant-chart fallback win.
      continue;
    }
    if (Array.isArray(c)) {
      const lines = c
        .map((row) => {
          if (!row || typeof row !== "object") return "";
          const r = row as Record<string, unknown>;
          const size = String(r["size"] ?? "").trim();
          const chest = String(r["chest"] ?? r["chestIn"] ?? r["chest_in"] ?? "").trim();
          const length = String(r["length"] ?? r["lengthIn"] ?? r["length_in"] ?? "").trim();
          const sleeve = String(r["sleeve"] ?? "").trim();
          const parts = [`${size || "Size"}`];
          if (chest) parts.push(`chest ${chest}`);
          if (length) parts.push(`length ${length}`);
          if (sleeve) parts.push(`sleeve ${sleeve}`);
          return parts.join(", ");
        })
        .filter(Boolean)
        .slice(0, 12);
      if (lines.length > 0) return lines;
    }
    if (typeof c === "object") {
      const r = c as Record<string, unknown>;
      const lines: string[] = [];
      for (const [size, v] of Object.entries(r)) {
        if (!v || typeof v !== "object") continue;
        const x = v as Record<string, unknown>;
        const chest = String(x["chest"] ?? x["chestIn"] ?? x["chest_in"] ?? "").trim();
        const length = String(x["length"] ?? x["lengthIn"] ?? x["length_in"] ?? "").trim();
        const sleeve = String(x["sleeve"] ?? "").trim();
        const parts = [size.toUpperCase()];
        if (chest) parts.push(`chest ${chest}`);
        if (length) parts.push(`length ${length}`);
        if (sleeve) parts.push(`sleeve ${sleeve}`);
        lines.push(parts.join(", "));
      }
      if (lines.length > 0) return lines.slice(0, 12);
    }
  }
  return [];
}

const DEFAULT_PLAYER_VERSION_SIZE_CHART = [
  "S: long 26, chest 36",
  "M: long 27, chest 38",
  "L: long 28, chest 40",
  "XL: long 29, chest 42",
  "XXL: long 30, chest 44",
];

const DEFAULT_FAN_VERSION_SIZE_CHART = [
  "S: long 27, chest 38",
  "M: long 28, chest 40",
  "L: long 29, chest 42",
  "XL: long 30, chest 44",
  "XXL: long 31, chest 46",
];

type FabricVariant = "player" | "fan" | "unknown";

function detectFabricVariantFromText(text: string): FabricVariant {
  const t = text.toLowerCase();
  if (/player\s*version|player\s*kit|authentic|on-?field/.test(t)) return "player";
  if (/fan\s*version|fan\s*kit|replica|standard\s*fit/.test(t)) return "fan";
  return "unknown";
}

function detectFabricVariant(m: ProductMapping, customerHint?: string): FabricVariant {
  const meta = readMetaObject(m);
  const jv = String(meta["jerseyVersion"] ?? meta["jersey_version"] ?? "")
    .trim()
    .toLowerCase();
  if (jv === "player" || jv === "player_version") return "player";
  if (jv === "fan" || jv === "fan_version") return "fan";

  if (customerHint) {
    const v = detectFabricVariantFromText(customerHint);
    if (v !== "unknown") return v;
  }
  const haystack = [
    m.facebookLabel ?? "",
    String(meta["name"] ?? ""),
    String(meta["fabricType"] ?? ""),
    String(meta["fabric_type"] ?? ""),
    String(meta["fabricMaterial"] ?? ""),
    String(meta["fabric_types"] ?? ""),
    String(meta["variants"] ?? ""),
    String(meta["selectedBadges"] ?? ""),
  ]
    .join(" ")
    .toLowerCase();
  return detectFabricVariantFromText(haystack);
}

/** Format one row of a tenant chart into a single-line label. */
function formatTenantChartRow(r: TenantSizeChart["rows"][number]): string {
  const parts = [r.size];
  if (r.length !== undefined && r.length !== "") parts.push(`length ${r.length}`);
  if (r.chest !== undefined && r.chest !== "") parts.push(`chest ${r.chest}`);
  if (r.shoulder !== undefined && r.shoulder !== "") parts.push(`shoulder ${r.shoulder}`);
  if (r.sleeve !== undefined && r.sleeve !== "") parts.push(`sleeve ${r.sleeve}`);
  if (r.waist !== undefined && r.waist !== "") parts.push(`waist ${r.waist}`);
  if (r.hip !== undefined && r.hip !== "") parts.push(`hip ${r.hip}`);
  if (r.extra) parts.push(r.extra);
  return parts.join(" ");
}

/**
 * Pick the best tenant-defined chart for a customer hint + product label.
 * Scores each chart by token overlap against (label + aliases). Falls back to
 * the chart marked `isDefault: true`, otherwise the first chart.
 */
export function pickTenantSizeChart(
  charts: TenantSizeChart[] | undefined,
  customerHint: string | undefined,
  productLabel: string | undefined,
): TenantSizeChart | null {
  if (!charts || charts.length === 0) return null;
  const haystackTokens = new Set(
    [customerHint ?? "", productLabel ?? ""]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9\u0980-\u09ff]+/g)
      .filter((t) => t.length >= 2),
  );

  let best: { chart: TenantSizeChart; score: number } | null = null;
  for (const c of charts) {
    const corpus = [c.label, ...(c.aliases ?? [])].join(" ").toLowerCase();
    const corpusTokens = corpus.split(/[^a-z0-9\u0980-\u09ff]+/g).filter((t) => t.length >= 2);
    let score = 0;
    for (const t of corpusTokens) if (haystackTokens.has(t)) score += 1;
    // Multi-word aliases get a small phrase-match bonus (e.g. "player version")
    for (const alias of [c.label, ...(c.aliases ?? [])]) {
      const a = alias.toLowerCase().trim();
      if (a.includes(" ") && haystackTokens.size > 0) {
        const haystackJoined = (customerHint ?? "") + " " + (productLabel ?? "");
        if (haystackJoined.toLowerCase().includes(a)) score += 2;
      }
    }
    if (best == null || score > best.score) best = { chart: c, score };
  }

  if (best && best.score > 0) return best.chart;
  return charts.find((c) => c.isDefault) ?? charts[0];
}

/**
 * Build the size chart reply.
 *
 * Resolution order:
 *   1. Per-product `metadata.sizeChart` / `measurements` (CSV-driven, always wins)
 *   2. Tenant-level `sizeCharts` library (matched by customer hint + product label)
 *   3. Built-in fabric-aware fallback (player vs fan jersey defaults)
 */
export function buildSizeChartReply(
  m: ProductMapping,
  customerHint?: string,
  tenantSizeCharts?: TenantSizeChart[],
): string {
  const meta = readMetaObject(m);
  const name = (m.facebookLabel ?? String(meta["name"] ?? "Product")).trim();
  const rows = extractMeasurementChartLines(meta);
  const eta = extractDeliveryEta(meta);
  if (rows.length > 0) {
    return `${name} size chart:\n${rows.join("\n")}\nDelivery time: ${eta}.`;
  }

  const tenantPick = pickTenantSizeChart(tenantSizeCharts, customerHint, name);
  if (tenantPick) {
    const lines = tenantPick.rows.map(formatTenantChartRow);
    const tail = tenantPick.notes ? `\n${tenantPick.notes}` : "";
    return `${name} — ${tenantPick.label} size chart:\n${lines.join("\n")}\nDelivery time: ${eta}.${tail}`;
  }

  const variant = detectFabricVariant(m, customerHint);
  if (variant === "player") {
    return `${name} (Player Version) size chart:\n${DEFAULT_PLAYER_VERSION_SIZE_CHART.join("\n")}\nDelivery time: ${eta}.`;
  }
  if (variant === "fan") {
    return `${name} (Fan Version) size chart:\n${DEFAULT_FAN_VERSION_SIZE_CHART.join("\n")}\nDelivery time: ${eta}.`;
  }
  return [
    `${name} size chart:`,
    "",
    "Player Version:",
    ...DEFAULT_PLAYER_VERSION_SIZE_CHART,
    "",
    "Fan Version:",
    ...DEFAULT_FAN_VERSION_SIZE_CHART,
    "",
    `Delivery time: ${eta}.`,
    "Player na fan version chai janan, exact size suggest kori.",
  ].join("\n");
}

export function buildPriceStockReply(m: ProductMapping, opts: ProductReplyOpts = {}): string {
  const meta = readMetaObject(m);
  const name = (m.facebookLabel ?? String(meta["name"] ?? "Product")).trim();
  const flag = pickTeamEmoji(name, meta);
  const price = formatPriceBdt(meta["price"]);
  const available = availableSizesFromMeta(meta);
  const lows = lowStockHighlights(meta);
  const sections: string[] = [`${flag} ${name}`];
  if (price) sections.push(`💰 ${price} BDT`);
  if (available.length > 0) sections.push(`📏 Sizes:\n${available.join(" · ")}`);
  if (lows.length > 0) {
    const lines = lows.map((x) => `Only ${x.qty} pieces left in ${x.size}`).join("\n");
    sections.push(`⚠️ Low Stock:\n${lines}`);
  }
  sections.push(`🚚 Delivery: ${extractDeliveryEta(meta)}`);
  const addonLines = buildAddonLinesFromSettings(opts.addOns);
  if (addonLines.length > 0) sections.push(`✨ Add-ons Available\n${addonLines.join("\n")}`);
  return sections.join("\n\n");
}

function toTruthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v > 0;
  if (typeof v !== "string") return false;
  const t = v.trim().toLowerCase();
  return t === "true" || t === "1" || t === "yes" || t === "y";
}

function buildCustomizationSnippet(meta: Record<string, unknown>): string {
  const allow =
    toTruthy(meta["allowNameNumber"]) ||
    toTruthy(meta["allow_name_number"]) ||
    toTruthy(meta["customizationEnabled"]) ||
    toTruthy(meta["customization_enabled"]);
  const nameNumberPrice =
    meta["nameNumberPrice"] ??
    meta["name_number_price"] ??
    meta["customNameNumberPrice"] ??
    meta["custom_name_number_price"];
  const font =
    meta["fontOptions"] ??
    meta["fonts"] ??
    meta["font_options"] ??
    meta["customFontOptions"] ??
    meta["custom_font_options"];
  const badges = meta["selectedBadges"] ?? meta["badges"] ?? meta["patchOptions"] ?? meta["patch_options"];

  const lines: string[] = [];
  if (allow) {
    const p = String(nameNumberPrice ?? "").trim();
    lines.push(
      p
        ? `Name/number customization available (+${p} BDT).`
        : "Name/number customization available.",
    );
  }
  const fontStr = Array.isArray(font) ? font.map((x) => String(x ?? "").trim()).filter(Boolean).join(", ") : String(font ?? "").trim();
  if (fontStr) lines.push(`Fonts: ${fontStr}.`);
  const badgesStr = Array.isArray(badges)
    ? badges.map((x) => String(x ?? "").trim()).filter(Boolean).join(", ")
    : String(badges ?? "").trim();
  if (badgesStr) lines.push(`Add-ons: ${badgesStr}.`);

  const fabricMat = String(meta["fabricMaterial"] ?? meta["fabric_type"] ?? "").trim();
  if (fabricMat) lines.push(`Fabric: ${fabricMat}.`);
  const jv = String(meta["jerseyVersion"] ?? meta["jersey_version"] ?? "")
    .trim()
    .toLowerCase();
  if (jv === "player" || jv === "player_version") lines.push("Kit: Player (authentic) version.");
  if (jv === "fan" || jv === "fan_version") lines.push("Kit: Fan (replica) version.");

  return lines.join(" ");
}

export function buildTenantAddonSnippet(addOns: TenantSettings["addOns"]): string {
  const active = (addOns ?? []).filter((a) => a && a.label?.trim() && a.enabled !== false);
  if (active.length === 0) return "";
  const top = active.slice(0, 8).map((a) => {
    const name = a.label.trim();
    const isFree = a.free === true || (typeof a.priceBdt === "number" && a.priceBdt === 0);
    if (isFree) return `${name} (FREE)`;
    if (typeof a.priceBdt === "number") return `${name} (+${a.priceBdt} BDT)`;
    return name;
  });
  return `Available add-ons: ${top.join(", ")}.`;
}

function extractDeliveryEta(meta: Record<string, unknown>): string {
  const keys = ["deliveryTime", "deliveryDays", "shippingEta", "delivery_eta", "delivery", "shipping"];
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "1-3 days";
}
