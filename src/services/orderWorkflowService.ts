import { Prisma, type ProductMapping, type Tenant, type TenantIntegration } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import {
  classifyImageContent,
  classifyMessengerImageAsFinancialPaymentScreenshot,
  extractOrderFromTextAndImages,
  generateReply,
  identifyJerseyFromPhoto,
  matchClientSkuFromCatalog,
  pickCatalogByVisualComparison,
  type BotPersona,
  type ConversationTurn,
  type ReplyIntent,
} from "../llm/ollamaService.js";
import axios from "axios";
import {
  buildCatalogLinesForLlm,
  buildDeterministicCatalogReply,
  findCatalogByJerseyEntities,
  findCatalogMatchesByText,
  expandCatalogMatchesForTeamCollection,
  buildPriceStockReply,
  buildSizeChartReply,
  buildTenantAddonSnippet,
  extractCatalogAssets,
  findBestCatalogMatchByText,
  pickTeamEmoji,
} from "./catalogReplyService.js";
import { matchCustomerPhotoAgainstCatalog } from "./photoMatchService.js";
import {
  buildBanglishCartLinesUpdateReply,
  buildBanglishCartShowReply,
  buildBanglishNameNumberAddedReply,
  buildBanglishProductAddedReply,
} from "./banglishCartReplyService.js";
import { validateOrderForClientSync } from "./orderValidationService.js";
import { decideOrderCreate } from "./orderDecisionGraph.js";
import { ensureTelegramWebhook, sendTelegramDocument, sendTelegramMessage } from "./telegramService.js";
import { generateInvoicePdf } from "./invoicePdfService.js";
import { getIntegrationAdapter } from "../integrations/integrationFactory.js";
import { initiatePaymentSession } from "../integrations/sslcommerz/sslcommerzService.js";
import {
  sendMessengerText,
  sendMessengerImage,
  sendMessengerFile,
  isWithinMessagingWindow,
  downloadMessengerAttachment,
  isSimulatorPsid,
} from "../integrations/facebook/messengerService.js";
import { runWithMessengerReplyTo } from "../integrations/facebook/messengerReplyContext.js";
import { createPathaoOrder, getPathaoOrderStatus, type PathaoTenantConfig } from "../integrations/pathao/pathaoService.js";
import { config } from "../config/index.js";
import { parseTenantSettings } from "../types/tenant-settings.js";
import type { StructuredOrder } from "../types/order-extraction.js";
import { logger } from "../utils/logger.js";
import {
  buildCatalogMessengerImageProxyUrl,
  signCatalogImageToken,
} from "../utils/catalogMessengerImageSign.js";
import {
  fetchLessonHintsText,
  maybeRecordCorrectionFromInbound,
} from "./conversationLearningService.js";
import { isAgentEnabledForTenant, runAgentInbound } from "../agent/runner.js";
import { resolveProductAddons } from "../agent/addonResolver.js";
import {
  buildHandoffTelegramText,
  HANDOFF_CUSTOMER_REPLY,
  hasInFlightOrder,
  isAgentMuted,
  isTenantInGraceWindow,
  looksLikePastOrderQuestion,
  muteAgent,
} from "../agent/handoffPolicy.js";
import { loadSnapshot } from "../agent/state.js";

function buildTranId(orderId: string): string {
  return `TXN_${orderId.slice(0, 12)}_${Date.now()}`;
}

/** Country / club tokens — if present with jersey/kit, do not ask vague "kon jersey". */
const JERSEY_ENTITY_HINT =
  /\b(argentina|argentinar|brazil|spain|england|france|portugal|italy|germany|netherlands|holland|belgium|mexico|japan|colombia|uruguay|croatia|sweden|barcelona|madrid|manchester|inter|liverpool|chelsea|juventus|psg|real\s*madrid|atletico|bayern|arsenal|ac\s*milan|napoli)\b/i;

const GENERIC_JERSEY_WORDS = new Set([
  "jersey",
  "kit",
  "shirt",
  "football",
  "soccer",
  "home",
  "away",
  "player",
  "fan",
  "version",
  "lagbe",
  "chai",
  "dibo",
  "diben",
  "den",
  "dao",
  "daw",
  "ache",
  "ase",
  "ki",
  "ta",
  "er",
  "gula",
  "photo",
  "image",
  "pic",
  "chobi",
  "size",
  "stock",
  "price",
  "bdt",
  "tk",
]);

function hasFreeformJerseyTarget(text: string): boolean {
  const tokens = text
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  // Treat any non-generic token as a potential country/club/team cue.
  return tokens.some((t) => !GENERIC_JERSEY_WORDS.has(t));
}

function hasJerseyEntityHint(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return JERSEY_ENTITY_HINT.test(normalized) || hasFreeformJerseyTarget(normalized);
}

function isLikelyProductQuery(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (looksLikeNegotiationOrGeneralQuestion(t)) return false;
  if (looksLikeGeneralInfoQuestion(t)) return false;
  if (JERSEY_ENTITY_HINT.test(t)) {
    return true;
  }
  if (/\b(jersey|kit|shirt|home kit|away kit|player version|retro)\b/i.test(t)) {
    return true;
  }
  if (/\b(price|stock|available|size|photo|image|chobi|tk|bdt)\b/i.test(t)) {
    return true;
  }
  return false;
}

function looksLikeGeneralInfoQuestion(t: string): boolean {
  const hasComparisonKeyword = /\b(difference|diff|parthokyo|farak|fark|vs|versus|compare|comparison|better|valo|bhalo|quality)\b/i.test(t);
  const hasQuestionIndicator = /\b(ki|kি|ache|hobe|ase|bolo|bolun|bolben|explain|tell|বলো|বলুন)\b/i.test(t) ||
    /\?/.test(t) ||
    /\b(ache\s*tho|ache\s*ki|ki\s*difference|ki\s*farak)\b/i.test(t);
  const hasVersionKeywords = /\b(fan\s*version|player\s*version|authentic|replica)\b/i.test(t);
  const hasNoTeamName = !JERSEY_ENTITY_HINT.test(t);

  if (hasVersionKeywords && hasComparisonKeyword && hasNoTeamName) return true;
  if (hasVersionKeywords && hasQuestionIndicator && hasNoTeamName && !/\b(lagbe|nibo|chai|dorkar|order|buy|dekhao|show)\b/i.test(t)) return true;
  return false;
}

function isTooGenericJerseyQuery(text: string, hasOpenCatalogOptionList = false): boolean {
  if (hasOpenCatalogOptionList) return false;
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (!/\b(jersey|kit|shirt|football shirt)\b/i.test(t)) return false;
  // If no strong team/club/country token exists, ask a clarifying question.
  return !hasJerseyEntityHint(text);
}

function isAddonOnlyRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const hasAddonTerm =
    /\b(add-?on|addons?|name\s*number|nam\s*number|number print|official font|font|patch|patches|badge|shoho|সহ|sathe|with|plus|\+)\b/i.test(
      t,
    );
  if (!hasAddonTerm) return false;
  const hasQty = parseRequestedQuantity(t) != null;
  const hasNewProductHint = /\b(argentina|brazil|england|portugal|japan|italy|germany)\b/i.test(t);
  // treat as add-on-only when no qty and not clearly introducing a new product choice
  return !hasQty && !hasNewProductHint;
}

async function hasRepeatedProductCard(conversationId: string, productName: string, maxRepeats = 2): Promise<boolean> {
  const recentMessages = await prisma.messengerMessage.findMany({
    where: { conversationId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { text: true },
  });
  let count = 0;
  const marker = productName.toLowerCase();
  for (const m of recentMessages) {
    if (m.text?.toLowerCase().includes(marker) && (m.text.includes("Order korte:") || m.text.includes("BDT"))) count++;
    if (count >= maxRepeats) return true;
  }
  return false;
}

async function hasRepeatedCollectionList(conversationId: string, collectionText: string, maxRepeats = 2): Promise<boolean> {
  const recentMessages = await prisma.messengerMessage.findMany({
    where: { conversationId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { text: true },
  });
  let count = 0;
  const marker = "Collection Available";
  const firstProduct = collectionText.split("\n").find((l) => l.includes("1️⃣"))?.toLowerCase() ?? "";
  for (const m of recentMessages) {
    if (!m.text) continue;
    if (m.text.includes(marker) && firstProduct && m.text.toLowerCase().includes(firstProduct.slice(3).trim())) count++;
    if (count >= maxRepeats) return true;
  }
  return false;
}

function looksLikeAddonRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return /\b(add-?on|addons?|name\s*number|nam\s*number|number print|official font|font|patch|patches|badge|shoho|সহ|sathe|with|plus|\+)\b/i.test(
    t,
  );
}

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/** Max products in a numbered “pick one” list (Messenger + draft `catalogOptionSkus`). */
const MAX_CATALOG_OPTION_LIST = 30;

function nToListIndex(n: number, max: number): number | null {
  if (!Number.isFinite(n) || n < 1 || n > max) return null;
  return n - 1;
}

/**
 * Detect which numbered option the customer meant (1-based → 0-based index).
 * Supports Banglish/Bengali/English ordinals, emoji numbers, “5 ta”, “no 3”, “option 7”, etc.
 */
function detectCatalogOptionSelection(text: string, max: number): number | null {
  if (!text.trim() || max <= 0) return null;
  const raw = text.trim();
  const lower = raw.toLowerCase();
  const norm = lower.replace(/\s+/g, " ");
  const compact = lower.replace(/\s+/g, "");

  const tryN = (n: number) => nToListIndex(n, max);

  // Reply may copy our 1️⃣ … 🔟 line — match first hit only (left to right order of checks).
  for (let i = 0; i < NUMBER_EMOJI.length && i < max; i++) {
    if (raw.includes(NUMBER_EMOJI[i]!)) return i;
  }

  const marked =
    norm.match(/\b(?:option|serial|list|line|item)\s*[#:]?\s*(\d{1,2})\b/i) ??
    norm.match(/\b(?:#|no\.?|number|nombor|nambar)\s*[:]?\s*(\d{1,2})\b/i) ??
    norm.match(/\b(\d{1,2})\s*(?:no\.?|number|nombor|nambar)\b/i);
  if (marked) {
    const idx = tryN(parseInt(marked[1]!, 10));
    if (idx != null) return idx;
  }

  const ord = norm.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (ord) {
    const idx = tryN(parseInt(ord[1]!, 10));
    if (idx != null) return idx;
  }

  // Bangla script + common romanizations (1 … 20+)
  const bn: Array<[RegExp, number]> = [
    [/প্রথম|prothom|prothomta|prothomটা|first|1st/, 1],
    [/দ্বিতীয়|দ্বিতীয়|ditiyo|ditiyota|ditio|second|2nd/, 2],
    [/তৃতীয়|তৃতীয়|tritiyo|tritiyota|tritio|third|3rd/, 3],
    [/চতুর্থ|choturtho|choturthota|choturth|fourth|4th/, 4],
    [/পঞ্চম|ponchom|ponchomta|ponchom|panchom|fifth|5th/, 5],
    [/ষষ্ঠ|shostho|shastho|sixth|6th/, 6],
    [/সপ্তম|saptom|shoptom|seventh|7th/, 7],
    [/অষ্টম|oshtom|eighth|8th/, 8],
    [/নবম|nobom|ninth|9th/, 9],
    [/দশম|doshom|tenth|10th/, 10],
    [/একাদশ|ekadosh|ekados|eleventh|11th/, 11],
    [/দ্বাদশ|dadosh|dvadosh|twelfth|12th/, 12],
    [/ত্রয়োদশ|trorodosh|trayodosh|thirteenth|13th/, 13],
    [/চতুর্দশ|choturdosh|chaturdosh|fourteenth|14th/, 14],
    [/পঞ্চদশ|ponchodosh|panchodosh|fifteenth|15th/, 15],
    [/ষোড়শ|shorosh|shodash|sixteenth|16th/, 16],
    [/সপ্তদশ|shoptodosh|saptadosh|seventeenth|17th/, 17],
    [/অষ্টাদশ|oshtadosh|ashtadosh|eighteenth|18th/, 18],
    [/ঊনবিংশ|unobingsho|unovingsho|nineteenth|19th/, 19],
    [/বিংশ|bingsho|vingsho|twentieth|20th/, 20],
  ];
  for (const [rx, n] of bn) {
    if ((rx.test(lower) || rx.test(compact)) && n <= max) return n - 1;
  }

  const englishOrd: Array<[RegExp, number]> = [
    [/\b(first|1st)\b/, 1],
    [/\b(second|2nd)\b/, 2],
    [/\b(third|3rd)\b/, 3],
    [/\b(fourth|4th)\b/, 4],
    [/\b(fifth|5th)\b/, 5],
    [/\b(sixth|6th)\b/, 6],
    [/\b(seventh|7th)\b/, 7],
    [/\b(eighth|8th)\b/, 8],
    [/\b(ninth|9th)\b/, 9],
    [/\b(tenth|10th)\b/, 10],
    [/\b(eleventh|11th)\b/, 11],
    [/\b(twelfth|12th)\b/, 12],
    [/\b(thirteenth|13th)\b/, 13],
    [/\b(fourteenth|14th)\b/, 14],
    [/\b(fifteenth|15th)\b/, 15],
    [/\b(sixteenth|16th)\b/, 16],
    [/\b(seventeenth|17th)\b/, 17],
    [/\b(eighteenth|18th)\b/, 18],
    [/\b(nineteenth|19th)\b/, 19],
    [/\b(twentieth|20th)\b/, 20],
    [/\b(twenty[\s-]?first|21st)\b/, 21],
    [/\b(twenty[\s-]?second|22nd)\b/, 22],
    [/\b(twenty[\s-]?third|23rd)\b/, 23],
    [/\b(twenty[\s-]?fourth|24th)\b/, 24],
    [/\b(twenty[\s-]?fifth|25th)\b/, 25],
    [/\b(twenty[\s-]?sixth|26th)\b/, 26],
    [/\b(twenty[\s-]?seventh|27th)\b/, 27],
    [/\b(twenty[\s-]?eighth|28th)\b/, 28],
    [/\b(twenty[\s-]?ninth|29th)\b/, 29],
    [/\b(thirtieth|30th)\b/, 30],
  ];
  for (const [rx, n] of englishOrd) {
    if (rx.test(norm) && n <= max) return n - 1;
  }

  // Spoken English digits (short replies)
  if (norm.length <= 48) {
    if (/\bone\b/.test(lower) && max >= 1 && !/\b(first|second|third)\b/.test(lower)) return 0;
    if (/\btwo\b/.test(lower) && max >= 2) return 1;
    if (/\bthree\b/.test(lower) && max >= 3) return 2;
    if (/\bfour\b/.test(lower) && max >= 4) return 3;
    if (/\bfive\b/.test(lower) && max >= 5) return 4;
    if (/\bsix\b/.test(lower) && max >= 6) return 5;
    if (/\bseven\b/.test(lower) && max >= 7) return 6;
    if (/\beight\b/.test(lower) && max >= 8) return 7;
    if (/\bnine\b/.test(lower) && max >= 9) return 8;
    if (/\bten\b/.test(lower) && max >= 10) return 9;
  }

  // “5 ta” / “12 number” / lone “7” on a tiny message
  const ta = norm.match(/^\s*(\d{1,2})\s*(?:ta|টি|টা|tai|tay)?\s*$/i);
  if (ta) {
    const idx = tryN(parseInt(ta[1]!, 10));
    if (idx != null) return idx;
  }
  const lone = norm.match(/^\s*#?(\d{1,2})\s*$/);
  if (lone) {
    const idx = tryN(parseInt(lone[1]!, 10));
    if (idx != null) return idx;
  }

  // Trailing “… 5” or “5 nibo” (still list-ish)
  const tail = norm.match(/\b(\d{1,2})\s*(?:ta|টি|টা)?\s*(?:nibo|lagbe|chai|chay|nitam|nebo|den|diben|niben)\b/i);
  if (tail) {
    const idx = tryN(parseInt(tail[1]!, 10));
    if (idx != null) return idx;
  }

  const n = norm.match(/\b(?:no\.?\s*)?([1-9]|[12][0-9]|30)(?:st|nd|rd|th)?(?:a|ta)?\b/);
  if (n) {
    const idx = tryN(parseInt(n[1]!, 10));
    if (idx != null) return idx;
  }

  return null;
}

function detectMultipleCatalogOptionSelections(text: string, max: number): number[] {
  if (!text.trim() || max <= 0) return [];
  const lower = text.trim().toLowerCase();
  const indices: Set<number> = new Set();

  const allNums = lower.match(/\d+/g);
  if (allNums && allNums.length >= 2) {
    for (const numStr of allNums) {
      const n = parseInt(numStr, 10);
      if (n >= 1 && n <= max) indices.add(n - 1);
    }
  }

  const ordinals = lower.matchAll(/(\d{1,2})(?:st|nd|rd|th)/gi);
  for (const m of ordinals) {
    const n = parseInt(m[1]!, 10);
    if (n >= 1 && n <= max) indices.add(n - 1);
  }

  for (let i = 0; i < NUMBER_EMOJI.length && i < max; i++) {
    if (text.includes(NUMBER_EMOJI[i]!)) indices.add(i);
  }

  if (indices.size < 2) return [];
  return Array.from(indices).sort((a, b) => a - b);
}

function deriveCollectionName(
  matches: Array<{ name: string }>,
  businessCategory?: string | null,
): { name: string; flag: string } {
  const KEYWORDS = [
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
    "Saudi Arabia",
    "Morocco",
    "USA",
    "Canada",
    "Bangladesh",
    "India",
    "Pakistan",
    "Korea",
    "Barcelona",
    "Real Madrid",
    "Manchester United",
    "Manchester City",
    "Liverpool",
    "Chelsea",
    "Juventus",
    "Inter",
    "Milan",
    "PSG",
    "Bayern",
    "Arsenal",
    "Napoli",
  ];
  const blob = matches.map((m) => m.name).join(" ").toLowerCase();
  for (const kw of KEYWORDS) {
    if (blob.includes(kw.toLowerCase())) {
      return { name: kw, flag: pickTeamEmoji(kw, undefined, businessCategory) };
    }
  }
  // For non-jersey shops a "Jersey" collection name + ⚽ flag would be
  // bewildering. Fall through to the matched product's name with no
  // category-themed emoji (or themed emoji from `pickTeamEmoji`).
  const cat = (businessCategory ?? "").trim().toLowerCase();
  if (cat && cat !== "jersey") {
    const first = matches[0]?.name ?? "Products";
    return { name: first, flag: pickTeamEmoji(first, undefined, businessCategory) };
  }
  return { name: "Jersey", flag: matches[0] ? pickTeamEmoji(matches[0].name, undefined, businessCategory) : "⚽" };
}

function buildCatalogOptionsReply(
  matches: Array<{ name: string; price?: string }>,
  opts: { collectionName?: string; flag?: string; businessCategory?: string | null } = {},
): string {
  if (matches.length === 0) return "Ekhon kono matching product nai.";
  const trimmed = matches.slice(0, MAX_CATALOG_OPTION_LIST);
  const derived = deriveCollectionName(trimmed, opts.businessCategory);
  const collection = opts.collectionName?.trim() || derived.name;
  const flag = opts.flag?.trim() || derived.flag;

  const headLine = flag ? `${flag} ${collection} Collection Available` : `${collection} Available`;
  const itemLines = trimmed
    .map((m, i) => {
      const emoji = NUMBER_EMOJI[i] ?? `${i + 1}.`;
      const price = m.price ? ` — ${m.price} BDT` : "";
      return `${emoji} ${m.name}${price}`;
    })
    .join("\n");

  const sections = [
    headLine,
    itemLines,
    "━━━━━━━━━━",
    "Kon product ta niben bolun.",
  ];
  return sections.join("\n\n");
}

function mappingMeta(m: ProductMapping): Record<string, unknown> {
  return m.metadata && typeof m.metadata === "object" && !Array.isArray(m.metadata)
    ? (m.metadata as Record<string, unknown>)
    : {};
}

function buildCatalogOptionItem(m: ProductMapping): { name: string; price?: string } {
  const meta = mappingMeta(m);
  const name = (m.facebookLabel ?? String(meta["name"] ?? m.clientSku)).trim();
  const priceRaw = meta["price"];
  const price = priceRaw !== undefined && priceRaw !== null && String(priceRaw).trim() ? String(priceRaw) : undefined;
  return { name, price };
}

function findBroadJerseyCandidates(mappings: ProductMapping[], limit = MAX_CATALOG_OPTION_LIST): ProductMapping[] {
  const rows = mappings
    .map((m) => {
      const meta = mappingMeta(m);
      const blob = [
        m.facebookLabel ?? "",
        String(meta["name"] ?? ""),
        String(meta["category"] ?? meta["categoryName"] ?? meta["categorySlug"] ?? ""),
        String(meta["slug"] ?? ""),
        String(meta["tags"] ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      const jerseySignal = /\b(jersey|kit|shirt|football|soccer|home|away|retro|player|fan)\b/i.test(blob);
      const entitySignal = hasJerseyEntityHint(blob);
      const firstImage = extractCatalogAssets(m).imageUrls[0];
      const hasImage = typeof firstImage === "string" && firstImage.trim().length > 0;
      const score = (entitySignal ? 4 : 0) + (jerseySignal ? 2 : 0) + (hasImage ? 1 : 0);
      return { m, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return rows.slice(0, Math.max(1, limit)).map((r) => r.m);
}

async function fetchUrlAsBase64(url: string, maxBytes = 4 * 1024 * 1024): Promise<string | null> {
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
    if (buf.length < 32) return null;
    return buf.toString("base64");
  } catch {
    return null;
  }
}

function buildVisualCandidateDescriptors(m: ProductMapping): string {
  const meta = mappingMeta(m);
  const bits: string[] = [];
  const jv = String(meta["jerseyVersion"] ?? meta["jersey_version"] ?? "").trim().toLowerCase();
  if (jv) bits.push(`version=${jv}`);
  const fab = String(meta["fabricMaterial"] ?? meta["fabric_type"] ?? "").trim();
  if (fab) bits.push(`fabric=${fab}`);
  const cat = String(meta["categoryName"] ?? meta["category"] ?? "").trim();
  if (cat) bits.push(`category=${cat}`);
  return bits.join(", ");
}

async function pickCandidateByCustomerImage(args: {
  customerImageBase64: string;
  /** Original Messenger CDN / data URL — used by `photoMatchService` for the URL-equality shortcut. */
  customerImageUrl?: string | null;
  /** REQUIRED. The hash-based scan now sweeps the whole tenant catalog so a
   * SKU not present in the team-text top-6 (e.g. "Brazil WC26 Special
   * Edition" sitting at row #11 by stock rank) can still win on visual
   * similarity. */
  tenantId: string;
  /** Pre-narrowed candidate list (e.g. team-filtered). Passed through to
   * the URL/Cloudinary shortcut so it stays cheap, but the perceptual-hash
   * scan ignores this and runs against the full catalog. */
  candidates: ProductMapping[];
  validSkus: Set<string>;
}): Promise<ProductMapping | null> {
  const top = args.candidates.slice(0, 6);

  // ── Stage 1+2: deterministic match (URL equality / perceptual hash) ──
  // Runs locally — no LLM round-trip — and short-circuits when the
  // customer reused our own marketing image (very common). Falls through
  // to the LLM visual comparison only when neither shortcut succeeds.
  const customerBuffer = Buffer.from(args.customerImageBase64, "base64");
  if (customerBuffer.length >= 256) {
    try {
      const outcome = await matchCustomerPhotoAgainstCatalog({
        customerImage: customerBuffer,
        customerImageUrl: args.customerImageUrl ?? null,
        tenantId: args.tenantId,
        prefilterCandidates: top.length > 0 ? top : undefined,
      });

      if (
        outcome.kind === "exact_url" ||
        outcome.kind === "exact_cloudinary" ||
        outcome.kind === "near_exact_hash"
      ) {
        logger.info(
          {
            event: "photo_match_deterministic",
            kind: outcome.kind,
            sku: outcome.sku,
            distance: outcome.hammingDistance,
          },
          "photoMatch: deterministic match",
        );
        return outcome.row;
      }

      // No deterministic match — feed the LLM the BEST-angle photo per
      // candidate (smallest hash distance) instead of always the first
      // photo. Dramatically improves auto-pick rate for products with
      // multiple photos when the customer's angle differs from photo #1.
      if (outcome.kind === "ranked" && outcome.ranked.length > 0) {
        const enriched = outcome.ranked.map((r) => ({
          sku: r.row.clientSku,
          label: (r.row.facebookLabel ?? String(mappingMeta(r.row)["name"] ?? r.row.clientSku)).trim(),
          descriptors: buildVisualCandidateDescriptors(r.row) || undefined,
          imageBase64: r.bestImageBase64,
          row: r.row,
        }));
        if (enriched.length === 1) return enriched[0]!.row;
        const picked = await pickCatalogByVisualComparison({
          customerImageBase64: args.customerImageBase64,
          candidates: enriched.map((e) => ({
            clientSku: e.sku,
            label: e.label,
            descriptors: e.descriptors,
            imageBase64: e.imageBase64,
          })),
          validSkus: args.validSkus,
        });
        if (!picked) return null;
        return enriched.find((e) => e.sku === picked)?.row ?? null;
      }
    } catch (e) {
      // photoMatchService threw (network, sharp, etc.) — swallow and fall
      // back to the legacy first-photo path so a transient failure can
      // never fully disable image matching.
      logger.warn({ e: String(e) }, "photoMatchService failed; falling back to first-photo path");
    }
  }

  // ── Legacy fallback: only first photo per candidate ───────────────
  const enriched: Array<{
    sku: string;
    label: string;
    descriptors?: string;
    imageBase64: string;
    row: ProductMapping;
  }> = [];
  for (const m of top) {
    const url = extractCatalogAssets(m).imageUrls[0];
    if (!url) continue;
    const b64 = await fetchUrlAsBase64(url);
    if (!b64) continue;
    enriched.push({
      sku: m.clientSku,
      label: (m.facebookLabel ?? String(mappingMeta(m)["name"] ?? m.clientSku)).trim(),
      descriptors: buildVisualCandidateDescriptors(m) || undefined,
      imageBase64: b64,
      row: m,
    });
  }
  if (enriched.length === 0) return null;
  if (enriched.length === 1) return enriched[0]!.row;
  const picked = await pickCatalogByVisualComparison({
    customerImageBase64: args.customerImageBase64,
    candidates: enriched.map((e) => ({
      clientSku: e.sku,
      label: e.label,
      descriptors: e.descriptors,
      imageBase64: e.imageBase64,
    })),
    validSkus: args.validSkus,
  });
  if (!picked) return null;
  return enriched.find((e) => e.sku === picked)?.row ?? null;
}

type PerPhotoCatalogMatch = {
  photoIndex: number;
  row: ProductMapping;
  teamLabel: string;
};

/**
 * One customer photo → catalog match.
 *
 * Domain-agnostic gate: we first call the generic image classifier
 * (`classifyImageContent`) which returns one of several content types
 * without assuming what the catalog contains. Only when the photo is a
 * plausible product photo do we attempt catalog matching at all.
 *
 * Jersey identification still runs as an enrichment pass for jersey-shaped
 * catalogs — when it returns a team / club, we use that to narrow candidates
 * and to feed the visual-compare prompt — but the JERSEY pass NEVER gates
 * the matcher. Other tenant catalogs (shoes, electronics, sarees) just see
 * the jersey pass come back empty and continue with the generic catalog
 * matcher, which is itself catalog-agnostic.
 */
async function resolveBestCatalogMatchForSingleCustomerImage(args: {
  imageBase64: string;
  /** Original Messenger CDN URL for this photo, used by the URL-equality shortcut. */
  imageUrl?: string | null;
  mappings: ProductMapping[];
  catalogLines: string;
  validSkus: Set<string>;
  caption?: string;
}): Promise<{ row: ProductMapping; teamLabel: string } | null> {
  const { imageBase64, mappings, catalogLines, validSkus, caption } = args;

  // ── STEP 1: domain-agnostic content classification ─────────────────────
  const content = await classifyImageContent([imageBase64], caption);

  // Hard gate: classifier confidently said "this is not a product".
  // We refuse to bounce into the catalog matcher for non-product photos
  // (selfies, screenshots, documents, random objects) regardless of what the
  // shop sells. This is what stops "girl photo → jersey SKU" misfires.
  const captionHasContent = (caption?.trim().length ?? 0) >= 3;
  if (content && !content.isProductLikely) {
    if (
      content.contentType === "person_or_selfie" ||
      content.contentType === "random_object" ||
      content.contentType === "document" ||
      content.contentType === "chat_screenshot"
    ) {
      logger.info(
        {
          contentType: content.contentType,
          confidence: content.confidence,
          shortDescription: content.shortDescription?.slice(0, 80),
        },
        "Vision: photo is not a product — skipping catalog match",
      );
      return null;
    }
    if (content.contentType === "unclear" && !captionHasContent) {
      logger.info(
        { confidence: content.confidence },
        "Vision: photo unclear and no caption — skipping catalog match",
      );
      return null;
    }
    // payment_screenshot is handled upstream in the manual-payment path; if
    // we ever reach here on one, we still don't catalog-match it.
    if (content.contentType === "payment_screenshot") {
      return null;
    }
  }

  // ── STEP 2: jersey-domain enrichment (best-effort) ──────────────────────
  // For jersey-shaped catalogs the jersey identifier gives us a tighter
  // candidate set and a better visual-compare prompt. For non-jersey
  // catalogs the helper just comes back empty / unknown and we drop through
  // to the generic matcher. Note: we deliberately do NOT gate on
  // `kind === "not_jersey"` here anymore — the generic classifier above is
  // the only gate, and a "not_jersey" verdict on a sneaker shop's catalog
  // would be a false negative.
  let vision: Awaited<ReturnType<typeof identifyJerseyFromPhoto>> = null;
  try {
    vision = await identifyJerseyFromPhoto([imageBase64], caption);
  } catch (e) {
    logger.warn({ e: String(e) }, "Per-photo jersey vision skipped");
  }
  const visionNames = vision?.primaryNames?.filter((n) => n?.trim()) ?? [];
  const teamLabel = visionNames.slice(0, 2).join(" / ").trim();
  const jerseyDetected = vision && vision.kind !== "not_jersey" && visionNames.length > 0;

  if (jerseyDetected) {
    const candidates = findCatalogByJerseyEntities(mappings, visionNames, MAX_CATALOG_OPTION_LIST);
    if (candidates.length === 1) {
      return { row: candidates[0]!, teamLabel };
    }
    if (candidates.length >= 2) {
      // Try the team-narrowed visual compare first (cheap — only fingerprints
      // the team-filtered candidates' photos). When it succeeds with a
      // deterministic match (URL/Cloudinary/near-exact hash), we're done.
      const visuallyPicked = await pickCandidateByCustomerImage({
        customerImageBase64: imageBase64,
        customerImageUrl: args.imageUrl ?? null,
        tenantId: mappings[0]?.tenantId ?? "",
        candidates,
        validSkus,
      }).catch((e) => {
        logger.warn({ e: String(e) }, "Per-photo visual catalog compare failed");
        return null;
      });
      if (visuallyPicked) return { row: visuallyPicked, teamLabel };

      // CRITICAL: do NOT fall back to `findBestCatalogMatchByText` here.
      // That picks the highest-stock team row, which is the *popular*
      // jersey, not the one the customer actually photographed. Letting
      // it return would silently overwrite the customer's intent (e.g.
      // a customer photographing the "Brazil WC26 Special Edition" but
      // getting handed the "Brazil WC26 Away Player" because that row
      // ranks higher by stock). Instead we drop through to the full-
      // catalog visual sweep below, and if THAT also fails, the LLM
      // matcher / clarifier handles ambiguity properly.
    }
  }

  // ── STEP 2.5: full-catalog visual sweep ─────────────────────────────────
  // Even when jersey vision didn't fire (or fired but the team-filtered
  // candidates didn't include the right SKU at the top), the customer
  // photo may still match a product elsewhere in the catalog by visual
  // similarity. Run the deterministic hash scan against the WHOLE tenant
  // catalog before falling through to the generic LLM matcher. This is
  // what catches a "Brazil WC26 Special Edition" sitting at row #11 of
  // a Brazil-text-rank list.
  const tenantIdForSweep = mappings[0]?.tenantId ?? "";
  if (tenantIdForSweep) {
    const visualSweep = await pickCandidateByCustomerImage({
      customerImageBase64: imageBase64,
      customerImageUrl: args.imageUrl ?? null,
      tenantId: tenantIdForSweep,
      candidates: [],
      validSkus,
    }).catch((e) => {
      logger.warn({ e: String(e) }, "Full-catalog visual sweep failed");
      return null;
    });
    if (visualSweep) {
      const sweepLabel = (visualSweep.facebookLabel ?? visualSweep.clientSku).trim();
      return { row: visualSweep, teamLabel: teamLabel || sweepLabel };
    }
  }

  // ── STEP 3: generic catalog match ───────────────────────────────────────
  // The catalog matcher accepts any image+text pair. We only get here when
  // the content gate said "product likely" (or returned null and the caller
  // gave us a useful caption). The matcher itself is conservative — it
  // returns null when nothing in the catalog clearly matches.
  const enrichedCaption = (() => {
    const parts: string[] = [];
    if (caption?.trim()) parts.push(caption.trim());
    if (jerseyDetected) parts.push(`Jersey in photo (identified): ${visionNames.join(", ")}`);
    if (content?.shortDescription) parts.push(`Image shows: ${content.shortDescription}`);
    if (content?.productCategory) parts.push(`Category hint: ${content.productCategory}`);
    return parts.length > 0 ? parts.join(" | ") : caption;
  })();
  const matchedSku = await matchClientSkuFromCatalog({
    catalogLines,
    text: enrichedCaption,
    imagesBase64: [imageBase64],
    validSkus,
  });
  if (matchedSku) {
    const row = mappings.find((m) => m.clientSku === matchedSku) ?? null;
    if (row) {
      return { row, teamLabel: teamLabel || (row.facebookLabel ?? row.clientSku).trim() };
    }
  }

  return null;
}

async function resolveCatalogMatchesPerCustomerPhoto(args: {
  imagesB64: string[];
  /** Original Messenger CDN URLs aligned with `imagesB64` indices. */
  imageUrls?: string[];
  mappings: ProductMapping[];
  catalogLines: string;
  validSkus: Set<string>;
  caption?: string;
}): Promise<PerPhotoCatalogMatch[]> {
  const out: PerPhotoCatalogMatch[] = [];
  const seenSkus = new Set<string>();
  for (let i = 0; i < args.imagesB64.length; i++) {
    const imageBase64 = args.imagesB64[i]!;
    const hit = await resolveBestCatalogMatchForSingleCustomerImage({
      imageBase64,
      imageUrl: args.imageUrls?.[i] ?? null,
      mappings: args.mappings,
      catalogLines: args.catalogLines,
      validSkus: args.validSkus,
      caption: args.caption,
    });
    if (!hit || seenSkus.has(hit.row.clientSku)) continue;
    seenSkus.add(hit.row.clientSku);
    out.push({
      photoIndex: i + 1,
      row: hit.row,
      teamLabel: hit.teamLabel || (hit.row.facebookLabel ?? hit.row.clientSku).trim(),
    });
  }
  return out;
}

async function sendMultiPhotoCatalogMatchReply(args: {
  matches: PerPhotoCatalogMatch[];
  settings: ReturnType<typeof parseTenantSettings>;
  pageAccessToken: string;
  psid: string;
  within24hWindow: boolean;
  conversationId: string;
  tenantSlug: string;
  businessCategory?: string | null;
}): Promise<void> {
  const { matches, settings, pageAccessToken, psid, within24hWindow, conversationId, tenantSlug, businessCategory } = args;
  const text = matches
    .map((m) => buildDeterministicCatalogReply(m.row, { addOns: settings.addOns, businessCategory: businessCategory ?? null }))
    .join("\n\n");
  await sendMessengerText({ pageAccessToken, psid, text, within24hWindow });
  await logAssistantTurn(conversationId, text);

  const last = matches[matches.length - 1]!.row;
  await setLastCatalogSku(conversationId, last.clientSku);
  if (matches.length >= 2) {
    await setCatalogOptionSkus(
      conversationId,
      matches.map((m) => m.row.clientSku),
    );
  }

  const proxySecret = (config.catalogImageProxySecret || config.encryptionKey || "").trim();
  const pubBase = config.publicBaseUrl.replace(/\/$/, "");
  const useMessengerImageProxy =
    proxySecret.length > 0 && pubBase.startsWith("https://") && !pubBase.includes("localhost");

  for (const m of matches) {
    const assets = extractCatalogAssets(m.row);
    const firstUrl = assets.imageUrls[0];
    if (!firstUrl) continue;
    const imageUrl = useMessengerImageProxy
      ? buildCatalogMessengerImageProxyUrl({
          publicBaseUrl: pubBase,
          tenantSlug,
          clientSku: m.row.clientSku,
          index: 0,
          token: signCatalogImageToken(proxySecret, tenantSlug, m.row.clientSku, 0),
        })
      : firstUrl;
    await sendImageAndLog({
      pageAccessToken,
      psid,
      imageUrl,
      within24hWindow,
      conversationId,
    }).catch((e) => logger.warn({ e: String(e), sku: m.row.clientSku }, "Multi-photo catalog image send skipped"));
  }
}

async function sendCatalogFirstImagePreviews(args: {
  rows: ProductMapping[];
  pageAccessToken: string;
  psid: string;
  within24hWindow: boolean;
  tenantSlug: string;
  conversationId: string;
}): Promise<{ failedImageUrls: string[]; sentImageMidToSku: Record<string, string> }> {
  const proxySecret = (config.catalogImageProxySecret || config.encryptionKey || "").trim();
  const pubBase = config.publicBaseUrl.replace(/\/$/, "");
  const useMessengerImageProxy = proxySecret.length > 0 && pubBase.startsWith("https://") && !pubBase.includes("localhost");
  const failedImageUrls: string[] = [];
  const sentImageMidToSku: Record<string, string> = {};
  for (const row of args.rows.slice(0, MAX_CATALOG_OPTION_LIST)) {
    const firstUrl = extractCatalogAssets(row).imageUrls[0];
    if (!firstUrl) continue;
    const imageUrl = useMessengerImageProxy
      ? buildCatalogMessengerImageProxyUrl({
          publicBaseUrl: pubBase,
          tenantSlug: args.tenantSlug,
          clientSku: row.clientSku,
          index: 0,
          token: signCatalogImageToken(proxySecret, args.tenantSlug, row.clientSku, 0),
        })
      : firstUrl;
    try {
      const result = await sendImageAndLog({
        pageAccessToken: args.pageAccessToken,
        psid: args.psid,
        imageUrl,
        within24hWindow: args.within24hWindow,
        conversationId: args.conversationId,
      });
      if (result.messageId) {
        sentImageMidToSku[result.messageId] = row.clientSku;
      }
    } catch (e) {
      failedImageUrls.push(firstUrl);
      logger.warn({ e: String(e), sku: row.clientSku }, "Catalog option preview image send skipped");
    }
  }
  return { failedImageUrls, sentImageMidToSku };
}

type CatalogIntent =
  | "ask_photo"
  | "ask_size_chart"
  | "ask_price_stock"
  | "ask_order"
  | "ask_checkout_policy"
  | "general";

/**
 * Detect a Bangladeshi mobile number (`01XXXXXXXXX`, optional +880 / spaces /
 * dashes). Used to recognise that a message is supplying order details rather
 * than asking a question.
 */
const BD_PHONE_REGEX = /(?:\+?880|0)1[\d\s\-]{8,12}/;

function looksLikeOrderDetailsSupply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\s*address\s*:/i.test(t)) return true;
  if (BD_PHONE_REGEX.test(t.replace(/[^\d+]/g, (c) => (/[\s\-()]/.test(c) ? "" : c)))) return true;
  // Multi-line message with a size + an address-shaped line is almost always
  // the customer filling in checkout details.
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length >= 3) {
    const hasSizeLine = lines.some((l) =>
      /^(size\s+)?(xs|s|m|l|xl|xxl|3xl|4xl|5xl)\b/i.test(l),
    );
    const hasAddressLine = lines.some((l) => /,\s|dhaka|chitt|cumilla|sylhet|khulna|rajshahi|barisal|rangpur|mymensing|comilla/i.test(l));
    if (hasSizeLine && hasAddressLine) return true;
  }
  return false;
}

/**
 * Messages like "Ami ki jersey order dite cheyechi?" are questions about state,
 * not a checkout submission. If we auto-merge memory and create an order on
 * these, customers get irrelevant payment links.
 */
function isOrderClarificationQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const isQuestion = t.includes("?") || /\b(ki|kobe|keno|why|what|did i|am i)\b/i.test(t);
  if (!isQuestion) return false;
  return /\b(order|confirm|payment|pay|book|nite chai|dite cheyechi)\b/i.test(t);
}

function looksLikeNegotiationOrGeneralQuestion(t: string): boolean {
  if (/\b(fixed|negotiate|negotiable|discount|kom|komo|komano|কম|ছাড়|offer|deal)\b/i.test(t) &&
      /\b(price|daam|dam|দাম|rate|tk|bdt)\b/i.test(t)) return true;
  if (/\b(kom\s*rak|komi[ey]e|komiye|kome|কমানো|komano|komaben|komabe)\b/i.test(t)) return true;
  if (/\bprice\b.{0,20}\b(fixed|fix|kom|komi[ey]e|komano|negotiate|negotiable)\b/i.test(t)) return true;
  if (/\b(ki\s*bepar|kotha\s*bujh|bujhen\s*na)\b/i.test(t)) return true;
  return false;
}

function classifyCatalogIntent(text: string): CatalogIntent {
  const t = text.trim().toLowerCase();
  if (!t) return "general";
  if (isOrderClarificationQuestion(text)) return "general";
  if (looksLikeNegotiationOrGeneralQuestion(t)) return "general";
  if (looksLikeGeneralInfoQuestion(t)) return "general";
  // If the message is clearly the customer supplying checkout details (phone /
  // multi-line address + size), don't misroute to size-chart even if the word
  // "size" appears.
  if (looksLikeOrderDetailsSupply(text)) return "ask_order";
  if (
    /\b(advance|booking\s*money|booking|delivery\s*charge|delivery\s*fee|charge|courier\s*charge|cash\s*on\s*delivery|cod)\b/i.test(
      t,
    )
  ) {
    return "ask_checkout_policy";
  }
  if (/\b(photo|pic|image|chobi|ছবি)\b/i.test(t)) return "ask_photo";
  if (
    /\b(xs|s|m|l|xl|xxl|3xl|4xl|5xl)\b/i.test(t) &&
    (/\b(qty|quantity|pc|pcs|piece|ta|x\s*\d+|\d+\s*(pc|pcs|piece|ta)?)\b/i.test(t) || /\bsize\b/i.test(t))
  ) {
    return "ask_order";
  }
  if (/\b(size chart|measurement|measure|m\s*chart)\b/i.test(t)) return "ask_size_chart";
  if (/\b(price|tk|bdt|stock|available|ache|hobe|ase|custom|customize|customise|name\s*number|font|addons?|patch)\b/i.test(t)) return "ask_price_stock";
  if (/\b(order|buy|nibo|nite chai|confirm|book|qty|quantity|address|phone)\b/i.test(t)) return "ask_order";
  // Bare "size" only counts as a chart request when there's nothing that looks
  // like a size selection ("L i nibo", "xl size lagbe"). A size token followed
  // by "lagbe / nibo / chai / dorkar" is a pick, not a chart request.
  if (/\bsize\b/i.test(t)) {
    if (/\b(xs|s|m|l|xl|xxl|3xl|4xl|5xl)\b.{0,20}\b(lagbe|nibo|chai|dorkar|lagbo|den|dao|dau)\b/i.test(t)) {
      return "ask_order";
    }
    return "ask_size_chart";
  }
  return "general";
}

function isExplicitSizeChartRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /\b(size\s*chart|measurement|measure|m\s*chart)\b/i.test(t);
}

/** Format a tenant size chart entry as a customer-facing block. */
function formatTenantChartBlock(
  chart: NonNullable<ReturnType<typeof parseTenantSettings>["sizeCharts"]>[number],
): string {
  const lines = chart.rows.map((r) => {
    const parts = [r.size];
    if (r.length !== undefined && r.length !== "") parts.push(`length ${r.length}`);
    if (r.chest !== undefined && r.chest !== "") parts.push(`chest ${r.chest}`);
    if (r.shoulder !== undefined && r.shoulder !== "") parts.push(`shoulder ${r.shoulder}`);
    if (r.sleeve !== undefined && r.sleeve !== "") parts.push(`sleeve ${r.sleeve}`);
    if (r.waist !== undefined && r.waist !== "") parts.push(`waist ${r.waist}`);
    if (r.hip !== undefined && r.hip !== "") parts.push(`hip ${r.hip}`);
    if (r.extra) parts.push(r.extra);
    return parts.join(" ");
  });
  const header = `${chart.label} size chart:`;
  const tail = chart.notes ? `\n${chart.notes}` : "";
  return `${header}\n${lines.join("\n")}${tail}`;
}

/**
 * Build a deterministic "no-product-context" reply for catalog intents.
 * Never calls the LLM, never references prices / sizes that aren't real.
 */
function buildNoContextCatalogReply(
  intent: CatalogIntent,
  settings: ReturnType<typeof parseTenantSettings>,
): string | null {
  if (intent === "ask_checkout_policy") {
    const lines: string[] = [];
    if (typeof settings.advancePaymentBdt === "number") {
      lines.push(`- Advance required: ${settings.advancePaymentBdt} BDT`);
    }
    if (typeof settings.deliveryChargeBdt === "number") {
      lines.push(`- Delivery charge: ${settings.deliveryChargeBdt} BDT`);
    }
    if (lines.length === 0) {
      return "Advance / delivery charge settings deya nai. Dashboard e set korle exact amount auto-reply dibo.";
    }
    return lines.join("\n");
  }
  if (intent === "ask_size_chart") {
    const charts = settings.sizeCharts ?? [];
    if (charts.length > 0) {
      const def = charts.find((c) => c.isDefault) ?? charts[0]!;
      return `${formatTenantChartBlock(def)}\n\nKon product er size chart? Product name bollei specific chart pathai.`;
    }
    return "Konta product er size chart chai? Product name bollei chart pathai.";
  }
  if (intent === "ask_photo") {
    return "Konta product er photo dekhte chan? Product name bolen.";
  }
  if (intent === "ask_price_stock") {
    const addon = buildTenantAddonSnippet(settings.addOns);
    if (addon) return `Konta product er price/stock? Product name bolen, ami check kore bolchi.\n${addon}`;
    return "Konta product er price/stock? Product name bolen, ami check kore bolchi.";
  }
  if (intent === "ask_order") {
    return "Order korte: product name, size, qty, naam, address, phone — ei tothyo gulo den, ami order place kori.";
  }
  return null;
}

type ManualPaymentRail = "BKASH_MANUAL" | "NAGAD_MANUAL";

type CartMemoryItem = {
  sku: string;
  product: string;
  quantity: number;
  size?: string;
  unitPriceBdt?: number;
  addOns?: Array<{ id: string; label: string; priceBdt: number; value?: string }>;
};

export async function appendManualPaymentAdminLog(args: {
  tenantId: string;
  event: string;
  level?: "info" | "warn" | "error";
  message?: string;
  orderId?: string;
  psid?: string;
  rail?: "BKASH_MANUAL" | "NAGAD_MANUAL";
  reference?: string;
}): Promise<void> {
  const tenant = await prisma.tenant
    .findUnique({ where: { id: args.tenantId }, select: { settings: true } })
    .catch(() => null);
  if (!tenant) return;
  const current =
    tenant.settings && typeof tenant.settings === "object" && !Array.isArray(tenant.settings)
      ? (tenant.settings as Record<string, unknown>)
      : {};
  const prevLogsRaw = current["manualPaymentAdminLogs"];
  const prevLogs = Array.isArray(prevLogsRaw)
    ? prevLogsRaw.filter((x) => x && typeof x === "object" && !Array.isArray(x))
    : [];
  const nextEntry = {
    at: new Date().toISOString(),
    level: args.level ?? "info",
    event: args.event,
    message: args.message,
    orderId: args.orderId,
    psid: args.psid,
    rail: args.rail,
    reference: args.reference,
  };
  const next = {
    ...current,
    manualPaymentAdminLogs: [nextEntry, ...prevLogs].slice(0, 100),
  };
  await prisma.tenant
    .update({
      where: { id: args.tenantId },
      data: { settings: next as Prisma.InputJsonValue },
    })
    .catch(() => undefined);
}

export async function findLatestPendingPaymentOrder(args: {
  tenantId: string;
  psid: string;
}) {
  return prisma.order.findFirst({
    where: {
      tenantId: args.tenantId,
      messengerPsid: args.psid,
      paymentStatus: { in: ["PENDING", "INITIATED"] },
      status: { notIn: ["CANCELLED", "COMPLETED"] },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function sendManualPaymentTelegramAlert(args: {
  settings: ReturnType<typeof parseTenantSettings>;
  tenantSlug: string;
  psid: string;
  orderId?: string;
  rail: "BKASH_MANUAL" | "NAGAD_MANUAL" | "UNKNOWN";
  reference: string;
  details?: Record<string, unknown>;
  screenshotUrls?: string[];
  customerText?: string;
}): Promise<boolean> {
  const tg = args.settings.telegram;
  if (!tg?.enabled || !tg.botToken?.trim() || !tg.chatId?.trim()) return false;
  const tgWebhookBase = config.publicBaseUrl.replace(/\/$/, "");
  const webhookUrl = `${tgWebhookBase}/webhooks/telegram/${encodeURIComponent(args.tenantSlug)}`;
  const webhookProbe = await ensureTelegramWebhook({
    botToken: tg.botToken.trim(),
    webhookUrl,
  });
  if (!webhookProbe.ok) {
    logger.warn(
      { orderId: args.orderId ?? null, webhookUrl, detail: webhookProbe.detail },
      "Telegram webhook ensure failed",
    );
  } else {
    logger.info({ orderId: args.orderId ?? null, webhookUrl, detail: webhookProbe.detail }, "Telegram webhook ensured");
  }
  const sd = args.details ?? {};
  const isScreenshotOnly = args.reference === "(screenshot)" || args.reference === "(image)";
  const title = isScreenshotOnly
    ? args.orderId
      ? "Manual payment screenshot received"
      : "Manual payment screenshot received (no open order match)"
    : args.orderId
      ? "Manual payment detected"
      : "Manual payment reference detected (no open order match)";
  const screenshotLines = (args.screenshotUrls ?? []).slice(0, 4).map((u, i) => `Screenshot ${i + 1}: ${u}`);

  // Render every line in the cart (Req: multi-product orders must show all
  // products in the alert, not just structuredData.product which mirrors the
  // first item only). Falls back to the flat top-level scalars when `items`
  // is missing (legacy orders pre-multi-line schema).
  const items = Array.isArray(sd["items"]) ? (sd["items"] as Array<Record<string, unknown>>) : [];
  const productLines: string[] = [];
  if (items.length > 0) {
    productLines.push(`Items (${items.length}):`);
    items.forEach((it, idx) => {
      const product = String(it["product"] ?? "").trim() || "(unnamed)";
      const size = String(it["size"] ?? "").trim();
      const qty = Number(it["quantity"] ?? 1);
      const unit = Number(it["unitPriceBdt"] ?? 0);
      const addOnPerUnit = Number(it["unitAddOnBdt"] ?? 0);
      const lineTotal = (unit + addOnPerUnit) * (Number.isFinite(qty) && qty > 0 ? qty : 1);
      const sizeStr = size ? ` (${size})` : "";
      const qtyStr = Number.isFinite(qty) && qty > 1 ? ` x${qty}` : "";
      productLines.push(`  ${idx + 1}. ${product}${sizeStr}${qtyStr} — ${lineTotal} BDT`);
      const addOns = Array.isArray(it["addOns"]) ? (it["addOns"] as Array<Record<string, unknown>>) : [];
      for (const ao of addOns) {
        const label = String(ao["label"] ?? "").trim();
        if (!label) continue;
        const value = String(ao["value"] ?? "").trim();
        const aoPrice = Number(ao["priceBdt"] ?? 0);
        const valStr = value ? ` "${value}"` : "";
        const priceStr = Number.isFinite(aoPrice) && aoPrice > 0 ? ` +${aoPrice} BDT` : "";
        productLines.push(`     • ${label}${valStr}${priceStr}`);
      }
    });
  } else if (sd["product"]) {
    // Legacy fallback — pre-multi-line orders only carried scalar product/size/quantity.
    const sizeStr = sd["size"] ? ` (${String(sd["size"])})` : "";
    const qtyStr = sd["quantity"] != null ? ` x${String(sd["quantity"])}` : "";
    productLines.push(`Product: ${String(sd["product"])}${sizeStr}${qtyStr}`);
  }

  const tgLines = [
    title,
    args.orderId ? `Order: ${args.orderId}` : "",
    `Rail: ${args.rail}`,
    isScreenshotOnly ? "TrxID: (sent as screenshot)" : `TrxID: ${args.reference}`,
    `Customer PSID: ${args.psid}`,
    args.customerText ? `Message: ${args.customerText.slice(0, 200)}` : "",
    sd["name"] ? `Name: ${String(sd["name"])}` : "",
    sd["phone"] ? `Phone: ${String(sd["phone"])}` : "",
    sd["address"] ? `Address: ${String(sd["address"])}` : "",
    ...productLines,
    sd["amount"] ? `Amount: ${String(sd["amount"])}` : "",
    ...screenshotLines,
    "",
    args.orderId ? "Confirm: / via inline button" : "Action: match this TrxID to the correct order in portal.",
  ]
    .filter(Boolean)
    .join("\n");
  const inlineKeyboard = args.orderId
    ? [
        [
          { text: "Confirm payment", callback_data: `mp_ok:${args.orderId}` },
          { text: "Reject", callback_data: `mp_no:${args.orderId}` },
        ],
      ]
    : undefined;
  await sendTelegramMessage({
    botToken: tg.botToken.trim(),
    chatId: tg.chatId.trim(),
    text: tgLines,
    inlineKeyboard,
  }).catch((e) => {
    logger.warn({ e: String(e), orderId: args.orderId ?? null }, "Telegram alert send failed");
    throw e;
  });
  return true;
}

/**
 * Centralised manual-payment turn handler. Must run BEFORE the catalog/intent
 * routing so that short "bkash <id>" / "nagad <id>" always trigger the Telegram
 * admin alert — even when the customer's message wouldn't otherwise look like a product query.
 *
 * Image-only "payment proof" is accepted only after a vision pass detects real
 * financial / payment-app content (not arbitrary product photos).
 *
 * Returns true when the turn was handled (caller should stop further processing).
 */
async function tryHandleManualPaymentTurn(args: {
  tenantId: string;
  tenantSlug: string;
  psid: string;
  pageAccessToken: string;
  settings: ReturnType<typeof parseTenantSettings>;
  conversationId: string;
  trimmed: string;
  imageUrlList: string[];
  within24h: boolean;
  /**
   * Phase 3.5: when the agent loop is on, treat manual-payment detection STRICTLY.
   * Only intercept on a hard TrxID match (`bkash AB12CD34`, `nagad 9X7Y6Z5`) or a verified
   * payment-screenshot image — not on conversational phrases like "payment korbo" / "bkash number din".
   * Those go to the agent so it can answer with policy/manual numbers without looping.
   */
  agentEnabled?: boolean;
}): Promise<boolean> {
  const {
    tenantId,
    tenantSlug,
    psid,
    pageAccessToken,
    settings,
    conversationId,
    trimmed,
    imageUrlList,
    within24h,
    agentEnabled,
  } = args;
  const hasIncomingImages = imageUrlList.length > 0;

  const openOrder = await findLatestPendingPaymentOrder({ tenantId, psid });

  const strictManualRef = trimmed ? detectManualPaymentReference(trimmed) : null;
  let manualRef: { rail: "BKASH_MANUAL" | "NAGAD_MANUAL"; reference: string } | null =
    strictManualRef;

  if (!manualRef && openOrder) {
    const loose = detectLooseTxnReference(trimmed);
    const short = loose ?? detectShortTxnReferenceWithOpenOrder(trimmed);
    if (short) {
      const looksManualish =
        looksLikeManualPaymentMessage(trimmed) || /^[A-Z0-9]{3,24}$/i.test(trimmed.trim());
      if (looksManualish) {
        manualRef = {
          rail:
            openOrder.paymentMethod === "NAGAD_MANUAL"
              ? ("NAGAD_MANUAL" as const)
              : ("BKASH_MANUAL" as const),
          reference: short,
        };
      }
    }
  }

  // Possible payment proof by image: open order + image(s) + short/empty or payment-ish text.
  // We do NOT treat this as proof until vision confirms financial / payment-app content.
  const screenshotProofCandidate =
    !manualRef &&
    hasIncomingImages &&
    Boolean(openOrder) &&
    (!trimmed || looksLikeManualPaymentMessage(trimmed) || trimmed.length <= 40);

  let screenshotProof = false;
  if (screenshotProofCandidate) {
    const imagesB64: string[] = [];
    for (const url of imageUrlList.slice(0, 2)) {
      try {
        const buf = await downloadAttachment(url, pageAccessToken, psid);
        if (buf.length > 32) imagesB64.push(buf.toString("base64"));
      } catch (e) {
        logger.warn({ e: String(e) }, "Manual-payment vision: attachment download skipped");
      }
    }
    screenshotProof =
      imagesB64.length > 0 &&
      (await classifyMessengerImageAsFinancialPaymentScreenshot(imagesB64, trimmed || undefined));
    if (!screenshotProof) {
      logger.info(
        { orderId: openOrder?.id, psid, hadImages: imagesB64.length > 0 },
        "Manual payment: image(s) not classified as financial screenshot — skipping Telegram payment alert",
      );
    }
  }

  // Customer said "bkash done" / "payment kore diyechi" but no parsable id at all.
  if (!manualRef && !screenshotProof && openOrder && looksLikeManualPaymentMessage(trimmed)) {
    // Agent on: prose like "payment korbo" / "bkash number din" goes to the agent so it can
    // share manual numbers via get_shop_policies. Don't loop the customer with "TrxID din".
    if (agentEnabled) return false;
    const askTrx =
      "Payment note korlam. TrxID / Txn ID ta din (example: bkash AB12CD34 / nagad 9X7Y6Z5) — na thakle screenshot pathaben. Tahole admin verify korte parbe.";
    await sendMessengerText({
      pageAccessToken,
      psid,
      text: askTrx,
      within24hWindow: within24h,
    });
    await logAssistantTurn(conversationId, askTrx);
    await appendManualPaymentAdminLog({
      tenantId,
      event: "trx_prompted_customer",
      level: "info",
      orderId: openOrder.id,
      psid,
      message: `Customer mentioned payment but no TrxID parsed from: "${trimmed.slice(0, 80)}"`,
    });
    return true;
  }

  if (!manualRef && !screenshotProof) return false;

  const rail = manualRef?.rail ??
    (openOrder?.paymentMethod === "NAGAD_MANUAL" ? "NAGAD_MANUAL" : "BKASH_MANUAL");
  const reference = manualRef?.reference ?? (hasIncomingImages ? "(screenshot)" : "(image)");

  if (openOrder) {
    await appendManualPaymentAdminLog({
      tenantId,
      event: screenshotProof ? "screenshot_detected_matched_order" : "trx_detected_matched_order",
      orderId: openOrder.id,
      psid,
      rail,
      reference,
    });
    logger.info(
      { orderId: openOrder.id, rail, reference, psid, screenshotProof },
      "Manual payment evidence detected",
    );
    await prisma.order.update({
      where: { id: openOrder.id },
      data: {
        paymentMethod: rail,
        paymentStatus: "INITIATED",
        ...(manualRef ? { manualTxnId: manualRef.reference } : {}),
        manualPaymentNote: screenshotProof
          ? `Customer-sent screenshot via Messenger (${rail})`
          : `Customer-supplied via Messenger (${rail})`,
      },
    });
    const refreshed = await prisma.order.findUnique({ where: { id: openOrder.id } });
    const sd =
      refreshed?.structuredData && typeof refreshed.structuredData === "object"
        ? (refreshed.structuredData as Record<string, unknown>)
        : {};
    const telegramSent = await sendManualPaymentTelegramAlert({
      settings,
      tenantSlug,
      psid,
      orderId: openOrder.id,
      rail,
      reference,
      details: {
        ...sd,
        amount: `${refreshed?.totalAmount?.toString() ?? "0"} ${refreshed?.currency ?? "BDT"}`,
      },
      screenshotUrls: imageUrlList,
      customerText: trimmed || undefined,
    }).catch(() => false);
    await appendManualPaymentAdminLog({
      tenantId,
      event: telegramSent ? "telegram_alert_sent" : "telegram_alert_failed",
      level: telegramSent ? "info" : "warn",
      orderId: openOrder.id,
      psid,
      rail,
      reference,
    });
    const ack = screenshotProof
      ? telegramSent
        ? "Screenshot peyechi ✅ — admin ke alert diyechi. Verify hole automatic janabo (5-10 min)."
        : "Screenshot peyechi. Admin ke alert dite issue hoise, amra check kortechi."
      : telegramSent
        ? `Got it — TrxID ${reference} note kore nilam. Admin verify korbe (5-10 min). Confirm hole automatic janabo.`
        : `TrxID ${reference} note kora hoyeche. Admin ke alert dite issue hoise, amra check kortechi.`;
    await sendMessengerText({ pageAccessToken, psid, text: ack, within24hWindow: within24h });
    await logAssistantTurn(conversationId, ack);
    return true;
  }

  // No open order — still alert admin so they can match it manually.
  await appendManualPaymentAdminLog({
    tenantId,
    event: screenshotProof ? "screenshot_detected_no_open_order" : "trx_detected_no_open_order",
    level: "warn",
    psid,
    rail,
    reference,
    message: "No open pending-payment order matched this PSID",
  });
  const telegramSent = await sendManualPaymentTelegramAlert({
    settings,
    tenantSlug,
    psid,
    rail,
    reference,
    screenshotUrls: imageUrlList,
    customerText: trimmed || undefined,
  }).catch(() => false);
  await appendManualPaymentAdminLog({
    tenantId,
    event: telegramSent ? "telegram_unmatched_alert_sent" : "telegram_unmatched_alert_failed",
    level: telegramSent ? "info" : "warn",
    psid,
    rail,
    reference,
  });
  const ack = screenshotProof
    ? telegramSent
      ? "Screenshot peyechi ✅ — open order automatic match korte pari nai, admin ke alert diyechi. Tara verify kore update dibe."
      : "Screenshot peyechi, kintu alert pathate issue hoise. Order ID / phone den, ami match korte help korbo."
    : telegramSent
      ? `TrxID ${reference} peyechi. Open order automatic match korte pari nai, admin ke alert diyechi — tara verify kore update dibe.`
      : `TrxID ${reference} peyechi, kintu alert pathate issue hoise. Order ID / phone den, ami match korte help korbo.`;
  await sendMessengerText({ pageAccessToken, psid, text: ack, within24hWindow: within24h });
  await logAssistantTurn(conversationId, ack);
  return true;
}

/**
 * Detect customer messages that look like a manual MFS payment confirmation
 * (e.g. "bkash 8A4G7P9R", "nagad txn 12345678", "send korechi 9XYZ").
 * Returns the rail + extracted reference if obvious.
 */
export function detectManualPaymentReference(
  text: string,
): { rail: ManualPaymentRail; reference: string } | null {
  const t = text.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const hasBkash = /\bb[\s-]?kash|bkas|bks?\b/i.test(lower);
  const hasNagad = /\bnagad|ngad\b/i.test(lower);
  if (!hasBkash && !hasNagad) {
    if (!/\b(trxid|trx|txn|tx[-\s]?id|reference|ref(?:erence)?|payment\s*id)\b/i.test(lower)) {
      return null;
    }
  }
  // Pull the longest alphanumeric chunk of length >= 6 — typical bKash/Nagad txn ids
  const candidates = t.match(/\b[A-Z0-9]{5,24}\b/gi) ?? [];
  const reference =
    candidates
      .filter((c) => /\d/.test(c))
      .filter(
        (c) =>
          !/^bkash$|^nagad$|^trxid$|^txn$|^txnid$|^trx$|^ref$|^reference$|^payment$|^sendmoney$|^money$/i.test(
            c,
          ),
      )
      .sort((a, b) => b.length - a.length)[0] ?? "";
  if (!reference) return null;
  if (hasBkash) return { rail: "BKASH_MANUAL", reference };
  if (hasNagad) return { rail: "NAGAD_MANUAL", reference };
  // Generic txn id — attribute to bKash by default, admin can correct
  return { rail: "BKASH_MANUAL", reference };
}

/** Fallback parser for cases where customer sends only raw trx id (no bkash/nagad keyword). */
export function detectLooseTxnReference(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (looksLikeOrderDetailsSupply(t)) return null;
  if (/^01\d{9}$/.test(t.replace(/[^\d]/g, ""))) return null;
  if (t.split(/\s+/).length > 6) return null;
  const candidates = t.match(/\b[A-Z0-9]{5,24}\b/gi) ?? [];
  const reference =
    candidates
      .filter((c) => /\d/.test(c))
      .filter((c) => !/^01\d{9}$/.test(c))
      .filter(
        (c) =>
          !/^bkash$|^nagad$|^trxid$|^txn$|^txnid$|^trx$|^ref$|^reference$|^payment$|^sendmoney$|^money$/i.test(
            c,
          ),
      )
      .sort((a, b) => b.length - a.length)[0] ?? "";
  return reference || null;
}

/**
 * Even-looser parser used only when an open AWAITING_PAYMENT order exists. Accepts
 * short tokens (e.g. last 3-4 digits the customer types) — "766", "766gjc", "3942".
 */
function detectShortTxnReferenceWithOpenOrder(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (looksLikeOrderDetailsSupply(t)) return null;
  if (/^01\d{9}$/.test(t.replace(/[^\d]/g, ""))) return null;
  if (t.split(/\s+/).length > 8) return null;
  const candidates = t.match(/\b[A-Z0-9]{3,24}\b/gi) ?? [];
  const reference =
    candidates
      .filter((c) => /\d/.test(c))
      .filter((c) => !/^01\d{9}$/.test(c))
      .filter(
        (c) =>
          !/^bkash$|^bkas$|^bks$|^nagad$|^ngad$|^trxid$|^txn$|^txnid$|^trx$|^tx$|^ref$|^reference$|^payment$|^paid$|^done$|^sendmoney$|^money$|^last$|^digit$|^digits$|^number$/i.test(
            c,
          ),
      )
      .sort((a, b) => b.length - a.length)[0] ?? "";
  return reference || null;
}

export function looksLikeManualPaymentMessage(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return /\b(b[\s-]?kash|bkas|nagad|payment|paid|send\s*money|sendmoney|transaction|trx|txn|txid|trax)\b/i.test(
    t,
  );
}

function parseDraftObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function getCartItemsFromDraft(raw: unknown): CartMemoryItem[] {
  const draft = parseDraftObject(raw);
  const items = draft["cartItems"];
  if (!Array.isArray(items)) return [];
  const out: CartMemoryItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const r = it as Record<string, unknown>;
    const sku = String(r["sku"] ?? "").trim();
    const product = String(r["product"] ?? "").trim();
    const q = Number(r["quantity"] ?? 1);
    if (!sku || !product || !Number.isFinite(q) || q <= 0) continue;
    out.push({
      sku,
      product,
      quantity: q,
      size: String(r["size"] ?? "").trim() || undefined,
      unitPriceBdt:
        typeof r["unitPriceBdt"] === "number" && Number.isFinite(r["unitPriceBdt"] as number)
          ? (r["unitPriceBdt"] as number)
          : undefined,
      addOns: Array.isArray(r["addOns"])
        ? (r["addOns"] as Array<Record<string, unknown>>)
            .map((a) => ({
              id: String(a?.id ?? "").trim(),
              label: String(a?.label ?? "").trim(),
              priceBdt: Number(a?.priceBdt ?? 0),
              value: String(a?.value ?? "").trim() || undefined,
            }))
            .filter((a) => a.id && a.label && Number.isFinite(a.priceBdt) && a.priceBdt >= 0)
        : undefined,
    });
  }
  return out.slice(0, 30);
}

function draftCartNeedsNameNumberSlotFilled(raw: unknown): boolean {
  return getCartItemsFromDraft(raw).some((it) =>
    (it.addOns ?? []).some((a) => looksLikeNameNumberAddOn(a) && !String(a.value ?? "").trim()),
  );
}

async function setDraftCartItems(conversationId: string, cartItems: CartMemoryItem[]): Promise<void> {
  if (!conversationId) return;
  const convo = await prisma.messengerConversation
    .findUnique({ where: { id: conversationId }, select: { pendingDraftJson: true } })
    .catch(() => null);
  const prev = parseDraftObject(convo?.pendingDraftJson);
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: {
        pendingDraftJson: {
          ...prev,
          cartItems: cartItems.slice(0, 30),
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}

function parseRequestedQuantity(text: string): number | null {
  const t = text.toLowerCase();
  // If the message looks like it's providing a name+number value (e.g. "Limon 10", "Name number nibo: Limon 10"),
  // don't treat the trailing jersey number as a quantity.
  const nnValue = extractNameNumberValue(text);
  if (nnValue) {
    // Either has explicit name/number keywords, or the whole text IS just the name+number value
    if (/\b(name|nam|number|numb|nibo|shoho|সহ)\b/i.test(t)) return null;
    // Short text where the entire content is basically "Name Number" (e.g. "Limon 10", "Messi 7")
    const stripped = t.replace(/[^a-z0-9\u0980-\u09ff ]/gi, "").trim();
    if (stripped.split(/\s+/).length <= 3) return null;
  }
  const m1 = t.match(/\b(?:qty|quantity|x)\s*[:=]?\s*(\d{1,2})\b/i);
  if (m1) {
    const n = Number(m1[1]);
    if (n > 0) return n;
  }
  const m2 = t.match(/\b(\d{1,2})\s*(?:ta|pcs|piece|pc)?\b/i);
  if (m2) {
    const n = Number(m2[1]);
    if (n > 0) return n;
  }
  return null;
}

function parseRequestedSize(text: string): string | null {
  const m = text.match(/\b(xs|s|m|l|xl|xxl|3xl|4xl|5xl)\b/i);
  return m ? m[1]!.toUpperCase() : null;
}

function parseAllSizes(text: string): string[] {
  const matches = text.match(/\b(xs|s|m|l|xl|xxl|3xl|4xl|5xl)\b/gi);
  if (!matches) return [];
  return matches.map((s) => s.toUpperCase());
}

function parseTeamSizePairs(text: string, cartItems: CartMemoryItem[]): Array<{ sku: string; size: string }> {
  const lower = text.toLowerCase();
  const sizeRx = /\b(xs|s|m|l|xl|xxl|3xl|4xl|5xl)\b/gi;
  const results: Array<{ sku: string; size: string }> = [];

  for (const item of cartItems) {
    if (item.size?.trim()) continue;
    const productLower = item.product.toLowerCase();
    const teamWords = productLower.split(/\s+/).filter((w) => w.length >= 3);
    const teamMatch = teamWords.find((w) => lower.includes(w));
    if (!teamMatch) continue;
    const teamPos = lower.indexOf(teamMatch);
    const afterTeam = lower.slice(teamPos);
    const sizeMatch = afterTeam.match(sizeRx);
    if (sizeMatch && sizeMatch[0]) {
      results.push({ sku: item.sku, size: sizeMatch[0].toUpperCase() });
    }
  }
  return results;
}

function detectCartIntent(text: string): "add" | "remove" | "set_qty" | "show" | "clear" | "checkout" | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/\b(cart|bucket|ঝুড়ি|ঝুড়িতে|কার্ট).*(clear|empty|reset)|\b(clear cart|empty cart)\b/i.test(t))
    return "clear";
  if (/\b(cart|bucket|ঝুড়ি|কার্ট|list|show|dekhao|দেখাও)\b/i.test(t)) return "show";
  if (/\b(remove|delete|bad|bad den|felao|batil|cancel item|komao|hatao|hatiye|বাদ)\b/i.test(t)) return "remove";
  if (/\b(set qty|quantity|qty|update qty|change qty)\b/i.test(t)) return "set_qty";
  if (/\b(checkout|confirm order|order confirm|final|place order)\b/i.test(t)) return "checkout";
  if (hasNegationAroundBuyCue(t)) return "remove";
  if (/\b(nibo|nite chai|nitechai|add|lagbe|order|book|shoho|সহ|sathe|dibo)\b/i.test(t)) return "add";
  return null;
}

function hasNegationAroundBuyCue(t: string): boolean {
  return (
    /\bnibo\s*na\b/.test(t) ||
    /\bnebo\s*na\b/.test(t) ||
    /\blagbe\s*na\b/.test(t) ||
    /\bchai\s*na\b/.test(t) ||
    /\bdorkar\s*n[ae]i?\b/.test(t) ||
    /\bhobe\s*na\b/.test(t) ||
    /\bdibo\s*na\b/.test(t) ||
    /\b(nibo|nebo|lagbe|chai|dorkar|dibo)\b.*\bna\b/.test(t) ||
    /\bna\b.*\b(nibo|nebo|lagbe)\b/.test(t) ||
    /\bcancel\b/.test(t) ||
    /\brakhbo\s*na\b/.test(t) ||
    /\b(রাখব না|নিব না|লাগবে না|চাই না|দরকার নাই|দরকার নেই)\b/.test(t)
  );
}

/**
 * "Germany home jersey lagbe" — customer wants product info first; no size/qty yet.
 * Strong buy cues (nibo, order confirm, explicit qty/size) skip this and go to order-line flow.
 */
function isBrowseOnlyProductInterest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (parseRequestedSize(text) != null) return false;
  if (parseRequestedQuantity(text) != null) return false;
  if (/\b(confirm\s+order|order\s+confirm|add\s+kore|book\s+korte|order\s+line)\b/i.test(t)) return false;
  const hasProductCue =
    /\b(jersey|kit|shirt|home|away|player|version)\b/i.test(t) || hasJerseyEntityHint(text);
  // "Argentina jersey nibo" — still browsing variants / collection, not ready to lock one line item.
  if (hasProductCue && /\b(nibo|nite\s*chai|nitechai|nitam|nebo)\b/i.test(t)) return true;
  if (/\b(nibo|nite\s*chai|nitechai)\b/i.test(t)) return false;
  return /\b(lagbe|chai|dorkar|chaiyen)\b/i.test(t);
}

/** "size lagbe na??" — asks whether size is required; must not merge another cart line. */
function looksLikeSizeRequirementQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (!/\bsize\b|\bsa[iy]z\b/i.test(t)) return false;
  if (/\b(xs|s|m|l|xl|xxl|3xl|4xl|5xl)\b/i.test(t)) return false;
  return (
    t.includes("?") ||
    /\b(ki|keno)\b/i.test(t) ||
    /\blagbe\s+na\b/i.test(t)
  );
}

function buildBrowseFirstCatalogReply(
  row: ProductMapping,
  settings: ReturnType<typeof parseTenantSettings>,
  _addonSnippet: string,
  businessCategory?: string | null,
): string {
  return buildDeterministicCatalogReply(row, { addOns: settings.addOns, businessCategory: businessCategory ?? null });
}

function buildCartSummaryText(
  cart: CartMemoryItem[],
  settings?: ReturnType<typeof parseTenantSettings>,
): string {
  if (cart.length === 0) return "Ekhono kono jersey select kora nai 🙂 Kon jersey lagben bolun.";
  if (!settings) return "Apnar list e product ache. Ektu por abar try korben.";
  const cartForTotals = enrichCartNameNumberPrices(cart, settings);
  return buildBanglishCartShowReply({ fullCart: cartForTotals, settings });
}

function findCartItemByTextMention(text: string, cart: CartMemoryItem[]): number {
  if (cart.length === 0) return -1;
  const t = text.toLowerCase().replace(/[^a-z0-9\u0980-\u09ff ]/gi, " ").replace(/\s+/g, " ").trim();
  const tokens = t.split(" ").filter(Boolean);
  const stopwords = new Set([
    "er", "ta", "nibo", "na", "nebo", "lagbe", "chai", "dorkar", "nai", "nei",
    "hobe", "korte", "oi", "eta", "ota", "remove", "bad", "den", "cancel",
    "hatao", "dibo", "rakhbo", "the", "a", "an", "jersey", "kit",
  ]);
  const meaningful = tokens.filter((w) => !stopwords.has(w) && w.length > 1);
  if (meaningful.length === 0) return -1;

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < cart.length; i++) {
    const name = (cart[i]!.product ?? "").toLowerCase();
    let score = 0;
    for (const word of meaningful) {
      if (name.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function upsertCartItem(cart: CartMemoryItem[], incoming: CartMemoryItem): CartMemoryItem[] {
  const incomingAddonKey = (incoming.addOns ?? [])
    .map((a) => canonicalAddonDedupeKey(a))
    .sort()
    .join("|");
  const idx = cart.findIndex(
    (x) =>
      x.sku === incoming.sku &&
      String(x.size ?? "").toLowerCase() === String(incoming.size ?? "").toLowerCase() &&
      (x.addOns ?? [])
        .map((a) => canonicalAddonDedupeKey(a))
        .sort()
        .join("|") === incomingAddonKey,
  );
  if (idx < 0) return [...cart, incoming];
  const next = [...cart];
  const prev = next[idx]!;
  next[idx] = { ...prev, quantity: Math.max(1, prev.quantity + incoming.quantity) };
  return next;
}

function getPendingNameNumberSkuFromDraft(raw: unknown): string | null {
  const draft = parseDraftObject(raw);
  const v = draft["pendingNameNumberSku"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function extractPrefixedAddressLine(text: string): string | null {
  const m = text.trim().match(/^\s*address\s*:\s*(.+)$/im);
  const v = m?.[1]?.trim();
  return v && v.length >= 4 ? v : null;
}

async function mergeDraftCustomerProfileField(
  conversationId: string,
  field: "address" | "phone" | "name",
  value: string,
): Promise<void> {
  const v = value.trim();
  if (!conversationId || !v) return;
  const convo = await prisma.messengerConversation
    .findUnique({ where: { id: conversationId }, select: { pendingDraftJson: true } })
    .catch(() => null);
  const prev = parseDraftObject(convo?.pendingDraftJson);
  const prevProfile =
    prev.customerProfile && typeof prev.customerProfile === "object" && !Array.isArray(prev.customerProfile)
      ? (prev.customerProfile as Record<string, unknown>)
      : {};
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: {
        pendingDraftJson: {
          ...prev,
          customerProfile: { ...prevProfile, [field]: v },
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}

function catalogOptionRowBlob(m: ProductMapping): string {
  const meta =
    m.metadata && typeof m.metadata === "object" && !Array.isArray(m.metadata)
      ? (m.metadata as Record<string, unknown>)
      : {};
  return `${m.facebookLabel ?? ""} ${String(meta["name"] ?? "")}`.toLowerCase();
}

/** Match "special kit ta lagbe" → row whose label mentions special/home/away, etc. */
function pickRowFromListedCatalogOptions(
  text: string,
  optionSkus: string[],
  mappings: ProductMapping[],
): ProductMapping | null {
  const rows = optionSkus.map((sku) => mappings.find((x) => x.clientSku === sku)).filter(Boolean) as ProductMapping[];
  if (rows.length === 0) return null;
  const t = text.trim().toLowerCase();
  const keywordHints = [
    "special",
    "away",
    "home",
    "third",
    "player",
    "retro",
    "training",
    "goalkeeper",
  ];
  const blobs = rows.map(catalogOptionRowBlob);
  const sharedByAll = (w: string) => blobs.length > 0 && blobs.every((b) => b.includes(w));
  const meaninglessForScore = new Set(["kit", "jersey", "shirt", "lagbe", "chai", "dorkar", "den", "dao", "dau", "size", "qty"]);
  let best: { row: ProductMapping; score: number } | null = null;
  for (const row of rows) {
    const blob = catalogOptionRowBlob(row);
    let score = 0;
    for (const kw of keywordHints) {
      if (t.includes(kw) && blob.includes(kw)) score += 5;
    }
    const tokens = t.split(/[^a-z0-9\u0980-\u09ff]+/g).filter((x) => x.length >= 3 && !meaninglessForScore.has(x));
    for (const w of tokens) {
      if (sharedByAll(w)) continue;
      if (blob.includes(w)) score += 2;
    }
    if (!best || score > best.score) best = { row, score };
  }
  if (!best) return null;
  if (best.score >= 2) return best.row;
  if (rows.length <= 3 && best.score >= 1) return best.row;
  return null;
}

async function setPendingNameNumberSku(conversationId: string, sku: string | null): Promise<void> {
  if (!conversationId) return;
  const convo = await prisma.messengerConversation
    .findUnique({ where: { id: conversationId }, select: { pendingDraftJson: true } })
    .catch(() => null);
  const prev = parseDraftObject(convo?.pendingDraftJson);
  const next: Record<string, unknown> = { ...prev, updatedAt: new Date().toISOString() };
  if (sku) next["pendingNameNumberSku"] = sku;
  else delete next["pendingNameNumberSku"];
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: { pendingDraftJson: next as Prisma.InputJsonValue },
    })
    .catch(() => undefined);
}

function extractNameNumberValue(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const explicit = t.match(
    /\b(?:name|nam)\s*[:\-]?\s*([A-Za-z\u0980-\u09ff .]{2,24})\s*(?:number|no|#)\s*[:\-]?\s*(\d{1,2})\b/i,
  );
  if (explicit) return `${explicit[1]!.trim()} ${explicit[2]!.trim()}`;
  const simple = t.match(/\b([A-Za-z\u0980-\u09ff]{2,24})\s+(\d{1,2})\b/);
  if (simple) return `${simple[1]!.trim()} ${simple[2]!.trim()}`;
  return null;
}

function extractMultipleNameNumbers(text: string, cartItems: CartMemoryItem[]): Array<{ sku: string; value: string }> | null {
  const lines = text.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const results: Array<{ sku: string; value: string }> = [];
  const usedSkus = new Set<string>();
  for (const line of lines) {
    const nnVal = extractNameNumberValue(line);
    if (!nnVal) continue;
    const lineLower = line.toLowerCase();
    let bestMatch: CartMemoryItem | undefined;
    let bestScore = 0;
    for (const item of cartItems) {
      if (usedSkus.has(item.sku)) continue;
      const productWords = item.product.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
      const score = productWords.filter((w) => lineLower.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }
    if (bestMatch) {
      results.push({ sku: bestMatch.sku, value: nnVal });
      usedSkus.add(bestMatch.sku);
    }
  }

  if (results.length >= 2) return results;

  if (lines.length >= 2) {
    const itemsNeedingNn = cartItems.filter((it) =>
      (it.addOns ?? []).some((a) => looksLikeNameNumberAddOn(a) && !String((a as Record<string, unknown>).value ?? "").trim())
    );
    const extracted: Array<{ sku: string; value: string }> = [];
    for (let i = 0; i < lines.length && i < itemsNeedingNn.length; i++) {
      const val = extractNameNumberValue(lines[i]!);
      if (val) extracted.push({ sku: itemsNeedingNn[i]!.sku, value: val });
    }
    if (extracted.length >= 2) return extracted;
  }

  return null;
}

/** Short replies like "Limon 10" must still hit catalog/draft logic when NN is pending or cart expects it. */
function catalogMatcherShouldIncludeDraftContinuation(text: string, draftRaw: unknown): boolean {
  if (getPendingNameNumberSkuFromDraft(draftRaw)) return true;
  const nn = extractNameNumberValue(text);
  return Boolean(nn && draftCartNeedsNameNumberSlotFilled(draftRaw));
}

function isNameNumberPriceQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (!/\b(name|nam)\b.*\b(number|nambar|namber)\b|\b(number|nambar|namber)\b.*\b(name|nam)\b/i.test(t))
    return false;
  return /\b(price|koto|dam|cost|tk|bdt)\b/i.test(t);
}

/** Price from DB/JSON — supports number or numeric string when schema passthrough slips through. */
function coerceAddonPriceBdt(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

/**
 * True for the configured Name+Number add-on row (canonical id OR label like "Nam + Number").
 * Dashboard UI generates ids like `addon-xxxx`; enrichment must not depend on literal `name-number` only.
 */
function looksLikeNameNumberAddOn(a: { id?: string; label?: string }): boolean {
  const id = String(a?.id ?? "").toLowerCase().trim().replace(/^["']|["']$/g, "");
  if (id === "name-number") return true;
  const lbl = String(a?.label ?? "").trim();
  if (!lbl) return false;
  if (/\bofficial\s*font\b/i.test(lbl)) return true;
  return /\bnam\s*[+＋\-]?\s*number\b|\bname\s*[+＋\-]?\s*number\b/i.test(lbl) ||
    (/name/i.test(lbl) && /number|num|nambar|namber/i.test(lbl));
}

/** Treat legacy dashboard ids (addon-*) as same slot as canonical name-number for merge keys. */
function canonicalAddonDedupeKey(a: { id: string; label?: string }): string {
  return looksLikeNameNumberAddOn(a) ? "name-number" : a.id;
}

/** Dashboard "Name + Number" add-on price — used when cart lines store 0 or legacy values. */
function getNameNumberPriceBdtFromSettings(settings: ReturnType<typeof parseTenantSettings>): number {
  const active = (settings.addOns ?? []).filter((a) => a && a.enabled !== false);
  const row =
    active.find((x) =>
      looksLikeNameNumberAddOn({
        id: String(x?.id ?? ""),
        label: String(x?.label ?? ""),
      }),
    ) ?? null;
  if (!row) return 0;
  return row.free === true ? 0 : coerceAddonPriceBdt(row.priceBdt);
}

function patchNameNumberAddonPrices(
  addOns: Array<{ id: string; label: string; priceBdt: number }> | undefined,
  settings: ReturnType<typeof parseTenantSettings>,
): Array<{ id: string; label: string; priceBdt: number }> | undefined {
  const p = getNameNumberPriceBdtFromSettings(settings);
  if (!addOns || p <= 0) return addOns;
  return addOns.map((a) =>
    looksLikeNameNumberAddOn(a) && (!a.priceBdt || a.priceBdt <= 0)
      ? { ...a, id: "name-number", priceBdt: p }
      : a,
  );
}

/** User indicates they want more jerseys / items — not a Name+Number value. */
function looksLikeCartContinueShoppingIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  // Common typo "nami …" (~ami); same jersey + name/number add-on
  if (/^\s*nami\b/i.test(text.trim()) && /\b(number|nambar|namber|nam\s+number)\b/i.test(t)) {
    return false;
  }
  // "ami sathe nam number o nibo" — not "another product", same jersey add-on
  if (
    /\b(name\s*\+?\s*number|nam\s*\+?\s*number|nam\s+number|name\s+number|nambar|namber|number\s*print)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (/\b(sathe|shathe|sthe|ek\s*sath|একসাথে)\b/i.test(t) && /\b(nam|name|number|nambar)\b/i.test(t)) {
    return false;
  }
  if (/\b(aro|আরো|arek|আরেক)\b/i.test(t) && /\b(jersey|shirt|kit|product|item|জার্সি)\b/i.test(t))
    return true;
  if (/\b(koyek|কয়েক|kisu|kichu)\b/i.test(t) && /\b(nibo|nite|nebo|nitam|chay|chai)\b/i.test(t)) return true;
  // "Spain player version o nibo" — but NOT "nam number o nibo"
  const oExtra = /\b(o|ও)\s+(nibo|nebo|lagbe|lagbo|chai|chay|nitam)\b/i.test(t);
  if (oExtra) {
    const avoid =
      /(nam|name|নাম).{0,20}\bnumber\b|\bnumber\b.{0,20}(nam|name|নাম)|\bnam\s*number\b|\bname\s*number\b/i.test(
        t,
      );
    if (!avoid) return true;
  }
  if (/\b(aaro|aar\s*o)\s+(.*?)\s*(nibo|lagbe)\b/i.test(t)) {
    return true;
  }
  // "ji, Spain ... nibo" — ack + another product line
  if (
    /^(ji|jee|হ্যাঁ|ha|han|acha|acha|ache|ache|thik|ঠিক)\b[,.\s]/i.test(t.trim()) &&
    /\b(nibo|chai|lagbe|nitam|nebo)\b/i.test(t) &&
    /\b(jersey|kit|shirt|player|version|home|away|retro)\b/i.test(t)
  ) {
    return true;
  }
  if (
    /\b(ek\s*sath|ekshathe|eksthe|একসাথে|together)\b/i.test(t) &&
    /\b(nibo|lagbe|add|chay|chai)\b/i.test(t)
  ) {
    return true;
  }
  if (/\b(add\s+more|more\s+items?|another\s+one|extra\s+jersey)\b/i.test(t)) return true;
  return false;
}

function enrichCartNameNumberPrices(
  cart: CartMemoryItem[],
  settings: ReturnType<typeof parseTenantSettings>,
): CartMemoryItem[] {
  const p = getNameNumberPriceBdtFromSettings(settings);
  if (p <= 0) return cart;
  return cart.map((it) => ({
    ...it,
    addOns: (it.addOns ?? []).map((a) =>
      looksLikeNameNumberAddOn(a) && (!a.priceBdt || a.priceBdt <= 0)
        ? { ...a, id: "name-number", priceBdt: p }
        : a,
    ),
  }));
}

/**
 * Compose a short customer-facing instructions block for the configured manual
 * payment rails. Returns "" when manual payment is not enabled / configured.
 */
function buildManualPaymentInstructions(
  manual: ReturnType<typeof parseTenantSettings>["manualPayment"],
  _amountBdt: number,
  orderId: string,
): string {
  if (!manual?.enabled) return "";
  const bkashNum = manual.bkash?.number?.trim();
  const nagadNum = manual.nagad?.number?.trim();
  if (!bkashNum && !nagadNum) return "";

  const sections: string[] = ["📲 Manual Payment"];
  if (bkashNum) sections.push(`🟣 bKash:\nSend Money → ${bkashNum}`);
  if (nagadNum) sections.push(`🔵 Nagad:\nSend Money → ${nagadNum}`);

  const replyParts: string[] = ["💬 After payment, reply with:"];
  if (bkashNum) replyParts.push("bkash <TrxID>");
  if (bkashNum && nagadNum) replyParts.push("or");
  if (nagadNum) replyParts.push("nagad <TrxID>");
  sections.push(replyParts.join("\n"));

  sections.push(`📌 Reference:\n${orderId.slice(0, 12)}`);

  if (manual.instructions?.trim()) {
    sections.push(`📝 Note:\n${manual.instructions.trim()}`);
  }
  sections.push("📷 Kindly send Transaction ID or Screenshot after payment.");

  return sections.join("\n\n");
}

function buildAddonSelectionGuide(addOns: ReturnType<typeof parseTenantSettings>["addOns"]): string[] {
  const active = (addOns ?? []).filter((a) => a && a.label?.trim() && a.enabled !== false);
  if (active.length === 0) return [];
  const lines: string[] = [];
  lines.push("- Add-ons (optional):");
  active.slice(0, 8).forEach((a, i) => {
    const price = typeof a.priceBdt === "number" ? ` (+${a.priceBdt} BDT)` : "";
    lines.push(`  ${i + 1}) ${a.label.trim()}${price}`);
  });
  lines.push("- Add-on dile format: Add-ons: Official Font, Patches");
  lines.push("- Na nile likhun: Add-ons: none");
  return lines;
}

function resolveProductAddOnCatalog(args: {
  settings: ReturnType<typeof parseTenantSettings>;
  meta: Record<string, unknown>;
}): Array<{ id: string; label: string; priceBdt: number }> {
  // Per-product opt-in is now the authoritative source — see src/agent/addonResolver.ts.
  // We map its result through the legacy normalisation below (slug rewrite for name-number,
  // legacy `allowNameNumber` shim) so existing reply builders keep working unchanged.
  const resolved = resolveProductAddons({
    productMetadata: args.meta,
    tenantSettings: args.settings,
  });

  const out: Array<{ id: string; label: string; priceBdt: number }> = [];
  const seen = new Set<string>();
  for (const a of resolved) {
    const slug = String(a.id ?? "").trim();
    const id = looksLikeNameNumberAddOn({ id: slug, label: a.label }) ? "name-number" : slug;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: a.label, priceBdt: a.priceBdt });
  }
  // Legacy `allowNameNumber=true` flag on a product still adds Name+Number when the new system
  // isn't in use. Once the merchant uses the new per-product picker, this flag is irrelevant.
  const allowNameNumber =
    String(args.meta["allowNameNumber"] ?? args.meta["allow_name_number"] ?? "").toLowerCase() === "true" ||
    args.meta["allowNameNumber"] === true;
  const nameNumberPrice = parsePriceNumber(
    args.meta["nameNumberPrice"] ?? args.meta["name_number_price"] ?? args.meta["customNameNumberPrice"],
  );
  if (allowNameNumber && !seen.has("name-number")) {
    out.push({ id: "name-number", label: "Name + Number", priceBdt: nameNumberPrice ?? 0 });
  }
  return out;
}

function selectAddOnsFromText(
  text: string,
  available: Array<{ id: string; label: string; priceBdt: number }>,
): Array<{ id: string; label: string; priceBdt: number }> {
  const t = text.toLowerCase();
  if (!t || /\b(add-ons?\s*:\s*none|no add-?on|without add-?on)\b/i.test(t)) return [];
  const picked: Array<{ id: string; label: string; priceBdt: number }> = [];
  for (const a of available) {
    const labelTokens = a.label.toLowerCase().split(/[^a-z0-9\u0980-\u09ff]+/g).filter((x) => x.length >= 3);
    if (labelTokens.some((tk) => t.includes(tk))) picked.push(a);
  }
  // Common aliases
  if (!picked.some((x) => looksLikeNameNumberAddOn(x))) {
    if (
      /\b(name\s*\+?\s*number|name number|player name|jersey name|nam\s*\+?\s*number|nam number|name\s*\+?\s*nambar|namber|number print)\b/i.test(
        t,
      )
    ) {
      const nn =
        available.find((x) => x.id === "name-number") ?? available.find((x) => looksLikeNameNumberAddOn(x));
      if (nn) picked.push(nn);
      else picked.push({ id: "name-number", label: "Name + Number", priceBdt: 0 });
    }
  }
  if (/\bofficial font|font|front\b/i.test(t)) {
    const f = available.find((x) => /font/i.test(x.label));
    if (f && !picked.some((x) => x.id === f.id)) picked.push(f);
  }
  if (/\bpatch|patches|badge|batch|logo patch|sleeve patch\b/i.test(t)) {
    const p = available.find((x) => /patch|badge/i.test(x.label));
    if (p && !picked.some((x) => x.id === p.id)) picked.push(p);
  }
  return picked;
}

function buildCheckoutChargesBlock(settings: ReturnType<typeof parseTenantSettings>): string {
  const lines: string[] = [];
  if (typeof settings.advancePaymentBdt === "number") {
    lines.push(`- Advance required: ${settings.advancePaymentBdt} BDT`);
  }
  if (typeof settings.deliveryChargeBdt === "number") {
    lines.push(`- Delivery charge: ${settings.deliveryChargeBdt} BDT`);
  }
  return lines.join("\n");
}

/**
 * Build a structured "facts" block from prior orders, drafts and the last catalog
 * SKU so Gemma keeps context across long threads even when the rolling window
 * trims older turns.
 */
async function buildCustomerFactsBlock(args: {
  tenantId: string;
  conversationId: string;
  psid: string;
  pendingDraftJson: unknown;
}): Promise<string> {
  const facts: string[] = [];
  const draft =
    args.pendingDraftJson && typeof args.pendingDraftJson === "object" && !Array.isArray(args.pendingDraftJson)
      ? (args.pendingDraftJson as Record<string, unknown>)
      : {};

  const tenantSettings = await prisma.tenant.findUnique({
    where: { id: args.tenantId },
    select: { settings: true },
  });
  const parsedTenantSettings = parseTenantSettings(tenantSettings?.settings);
  const draftCartCount = getCartItemsFromDraft(args.pendingDraftJson).length;
  const cartBuilding = draftCartCount > 0;
  if (cartBuilding) {
    facts.push(
      "Order list in progress: do NOT ask for advance payment or share bKash/Nagad numbers until they give full order details (name, address, phone) and want to confirm.",
      "Do NOT use the English words \"cart\" or \"checkout\" in replies — use Banglish like \"list\", \"order list\", \"selection\", or \"order confirm\".",
    );
    facts.push(`Draft order list: ${draftCartCount} line(s). Ask if they want to add more products first.`);
  } else {
    if (typeof parsedTenantSettings.advancePaymentBdt === "number") {
      facts.push(`Advance payment policy: ${parsedTenantSettings.advancePaymentBdt} BDT`);
    }
    if (typeof parsedTenantSettings.deliveryChargeBdt === "number") {
      facts.push(`Delivery charge policy: ${parsedTenantSettings.deliveryChargeBdt} BDT`);
    }
  }

  const lastSku = typeof draft.lastCatalogSku === "string" ? draft.lastCatalogSku.trim() : "";
  if (lastSku) facts.push(`Last product they asked about (SKU): ${lastSku}`);

  const customerProfile =
    draft.customerProfile && typeof draft.customerProfile === "object"
      ? (draft.customerProfile as Record<string, unknown>)
      : null;
  if (customerProfile) {
    const name = String(customerProfile["name"] ?? "").trim();
    const phone = String(customerProfile["phone"] ?? "").trim();
    const address = String(customerProfile["address"] ?? "").trim();
    if (name) facts.push(`Customer name: ${name}`);
    if (phone) facts.push(`Customer phone: ${phone}`);
    if (address) facts.push(`Customer address: ${address}`);
  }

  /** Portal chat sandbox uses SIM_ PSIDs — no real orders; skip query to avoid pool contention (P2024). */
  const recentOrders = isSimulatorPsid(args.psid)
    ? []
    : await prisma.order.findMany({
        where: { tenantId: args.tenantId, messengerPsid: args.psid },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          structuredData: true,
          createdAt: true,
          manualTxnId: true,
        },
      });
  if (recentOrders.length > 0) {
    const summarised = recentOrders.map((o) => {
      const sd = (o.structuredData ?? {}) as Record<string, unknown>;
      const product = String(sd["product"] ?? "").trim();
      const size = String(sd["size"] ?? "").trim();
      const qty = String(sd["quantity"] ?? "").trim();
      const bits = [
        `#${o.id.slice(0, 8)}`,
        product && `product=${product}`,
        size && `size=${size}`,
        qty && `qty=${qty}`,
        `status=${o.status}`,
        `payment=${o.paymentStatus}`,
        o.manualTxnId && `manualTxn=${o.manualTxnId}`,
      ].filter(Boolean);
      return bits.join(" ");
    });
    facts.push(`Recent orders for this customer (newest first):\n- ${summarised.join("\n- ")}`);
  }
  return facts.join("\n");
}

/**
 * Merge a freshly-extracted order with the conversation's persisted memory
 * (last product the customer was looking at, previously-collected
 * name/phone/address). Returns null only when there is nothing useful at all
 * — otherwise returns a `StructuredOrder` with as many fields filled as we can
 * justify from context.
 *
 * Why this matters: when a customer types just "Size XL\nLimon\nCumilla\n01…"
 * the LLM extracts `{name, size, address, phone}` with no `product`. Without
 * backfilling, validation fails (`product_required`) and we loop. With
 * backfill we know which jersey they meant — it's the last one we discussed.
 */
function mergeStructuredOrderWithContext(args: {
  extracted: StructuredOrder | null;
  lastProductLabel: string | null;
  pendingDraftJson: unknown;
}): StructuredOrder | null {
  const draft =
    args.pendingDraftJson &&
    typeof args.pendingDraftJson === "object" &&
    !Array.isArray(args.pendingDraftJson)
      ? (args.pendingDraftJson as Record<string, unknown>)
      : {};
  const profile =
    draft.customerProfile && typeof draft.customerProfile === "object"
      ? (draft.customerProfile as Record<string, unknown>)
      : {};

  const profileName = String(profile["name"] ?? "").trim();
  const profilePhone = String(profile["phone"] ?? "").trim();
  const profileAddress = String(profile["address"] ?? "").trim();
  const draftCart = getCartItemsFromDraft(args.pendingDraftJson);

  const e = args.extracted ?? ({} as StructuredOrder);
  const cartItems =
    draftCart.length > 0
      ? draftCart.map((x) => ({
          product: x.product,
          size: x.size,
          quantity: x.quantity,
          addOns: (x.addOns ?? []).map((a) => a.label),
          unitPriceBdt: x.unitPriceBdt,
          unitAddOnBdt: (x.addOns ?? []).reduce((s, a) => s + a.priceBdt, 0),
        }))
      : undefined;
  const items =
    Array.isArray(e.items) && e.items.length > 0 ? e.items : cartItems;
  const firstItem = items?.[0];
  const merged: StructuredOrder = {
    name: (e.name?.toString().trim() || profileName) || undefined,
    product:
      (e.product?.toString().trim() || firstItem?.product?.toString().trim() || (args.lastProductLabel ?? "").trim()) || undefined,
    size:
      (e.size?.toString().trim() || firstItem?.size?.toString().trim()) || undefined,
    quantity: e.quantity ?? (firstItem?.quantity != null ? Number(firstItem.quantity) : undefined),
    items,
    address: (e.address?.toString().trim() || profileAddress) || undefined,
    phone: (e.phone?.toString().trim() || profilePhone) || undefined,
  };

  // If literally everything is empty after merge, treat as no extraction.
  const anyField =
    merged.name ||
    merged.product ||
    merged.size ||
    merged.quantity ||
    (Array.isArray(merged.items) && merged.items.length > 0) ||
    merged.address ||
    merged.phone;
  return anyField ? merged : null;
}

async function persistCustomerProfile(args: {
  conversationId: string;
  pendingDraftJson: unknown;
  structured: StructuredOrder;
}): Promise<void> {
  if (!args.conversationId) return;
  const prev =
    args.pendingDraftJson && typeof args.pendingDraftJson === "object" && !Array.isArray(args.pendingDraftJson)
      ? (args.pendingDraftJson as Record<string, unknown>)
      : {};
  const prevProfile =
    prev.customerProfile && typeof prev.customerProfile === "object"
      ? (prev.customerProfile as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = {
    ...prevProfile,
    ...(args.structured.name ? { name: args.structured.name } : {}),
    ...(args.structured.phone ? { phone: args.structured.phone } : {}),
    ...(args.structured.address ? { address: args.structured.address } : {}),
  };
  await prisma.messengerConversation
    .update({
      where: { id: args.conversationId },
      data: {
        pendingDraftJson: {
          ...prev,
          customerProfile: merged,
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}

/** Last-resort fixed templates if Ollama is down or generates an empty reply. */
function fallbackTemplate(intent: ReplyIntent): string {
  switch (intent.kind) {
    case "general_chat":
      return "Ji bolen?";
    case "ask_for_order_details":
      return "Product, size, qty, address r phone den.";
    case "could_not_parse":
      return "Bujhte parlam na, abar likhun?";
    case "missing_fields":
      return `${intent.missing.join(", ")} den.`;
    case "no_integration":
      return "Ektu pore try korun, system update cholche.";
    case "order_created":
      return `Payment link:\n${intent.gatewayUrl}\nRef: ${intent.tranId}`;
    case "order_failed":
      return "Order process e problem hoyeche, pore abar try korun.";
    case "payment_confirmed":
      return "Payment confirmed. Thank you!";
    case "product_info":
      return `${intent.productFacts}\n\nNite chaile size, qty, address r phone den.`;
  }
}

/**
 * Generate a styled reply with conversation memory + RAG.
 * Logs both the customer message (if not already logged) and the bot reply.
 * Falls back to deterministic templates if the LLM fails or returns empty.
 */
async function speak(opts: {
  tenantId: string;
  conversationId: string;
  persona?: BotPersona;
  intent: ReplyIntent;
  customerMessage?: string;
  /** Set to false on the second+ call within a single inbound (we already logged the customer turn) */
  logIncoming?: boolean;
  /** Optional psid; used to load recent orders into the pinned facts block */
  psid?: string;
}): Promise<string> {
  const hasConvo = Boolean(opts.conversationId);
  // Serialize reads: tiny servers / pooled DB URLs often allow only 1 logical connection — parallel
  // prisma calls exhaust the pool (P2024) under load.
  const recent = hasConvo
    ? await prisma.messengerMessage.findMany({
        where: { conversationId: opts.conversationId },
        orderBy: { createdAt: "desc" },
        take: 32,
      })
    : [];
  const textByFacebookMid = new Map<string, string>();
  for (const m of recent) {
    if (m.facebookMessageId) {
      const t = m.text.trim();
      const snippet = t.length > 220 ? `${t.slice(0, 220)}…` : t;
      textByFacebookMid.set(m.facebookMessageId, snippet);
    }
  }
  const convoForFacts = hasConvo
    ? await prisma.messengerConversation.findUnique({
        where: { id: opts.conversationId },
        select: { pendingDraftJson: true, psid: true },
      })
    : null;
  const history: ConversationTurn[] = recent
    .reverse()
    .map((m) => {
      let text = m.text;
      if (m.role === "user" && m.replyToFacebookMessageId) {
        const quoted = textByFacebookMid.get(m.replyToFacebookMessageId);
        const prefix = quoted
          ? `[Replying to earlier message: ${quoted}]`
          : "[Replying to an earlier message — parent not in recent window]";
        text = `${prefix}\n${text}`;
      }
      return { role: m.role === "assistant" ? "assistant" : "user", text };
    });

  const psid = opts.psid ?? convoForFacts?.psid;
  const histForLearning = history.map((h) => ({ role: h.role, text: h.text }));
  const customerFacts =
    hasConvo && psid
      ? await buildCustomerFactsBlock({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          psid,
          pendingDraftJson: convoForFacts?.pendingDraftJson ?? null,
        })
      : "";
  const lessonHints = await fetchLessonHintsText({
    tenantId: opts.tenantId,
    history: histForLearning,
    customerMessage: opts.customerMessage,
  });

  const generated = await generateReply({
    persona: opts.persona,
    intent: opts.intent,
    customerMessage: opts.customerMessage,
    history,
    customerFacts,
    lessonHints,
  });

  let reply = generated && generated.length > 0 ? generated : fallbackTemplate(opts.intent);
  logger.info(
    { intent: opts.intent.kind, modelReply: Boolean(generated && generated.length > 0) },
    "speak generated response",
  );
  const prevAssistant = [...history].reverse().find((h) => h.role === "assistant")?.text?.trim();
  if (prevAssistant && reply.trim().toLowerCase() === prevAssistant.toLowerCase()) {
    if (opts.intent.kind === "missing_fields") {
      reply = `Ager motoi, sudhu ${opts.intent.missing.join(", ")} dile order confirm korte parbo.`;
    } else if (opts.intent.kind === "product_info") {
      reply = "Details dilam upore. Nite chaile size ar qty bolen, ami order process kori.";
    } else {
      reply = "Bujhlam. Aro details dile better help korte parbo.";
    }
  }

  if (opts.intent.kind === "order_created") {
    const url = opts.intent.gatewayUrl;
    const tran = opts.intent.tranId;
    if (!reply.includes(url)) reply += `\n${url}`;
    if (!reply.includes(tran)) reply += `\nRef: ${tran}`;
  }

  if (hasConvo) {
    if (opts.logIncoming !== false && opts.customerMessage) {
      await prisma.messengerMessage
        .create({
          data: {
            conversationId: opts.conversationId,
            role: "user",
            text: opts.customerMessage,
          },
        })
        .catch(() => undefined);
    }
    await prisma.messengerMessage
      .create({
        data: {
          conversationId: opts.conversationId,
          role: "assistant",
          text: reply,
        },
      })
      .catch(() => undefined);
    await prisma.messengerConversation
      .update({
        where: { id: opts.conversationId },
        data: { lastBotMsgAt: new Date() },
      })
      .catch(() => undefined);
  }

  return reply;
}

async function logAssistantTurn(
  conversationId: string,
  text: string,
  imageUrls?: string[],
): Promise<void> {
  if (!conversationId || (!text.trim() && !(imageUrls?.length))) return;
  await prisma.messengerMessage
    .create({
      data: {
        conversationId,
        role: "assistant",
        text: text || "",
        ...(imageUrls?.length ? { imageUrls } : {}),
      },
    })
    .catch(() => undefined);
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: { lastBotMsgAt: new Date() },
    })
    .catch(() => undefined);
}

async function downloadAttachment(url: string, pageAccessToken: string, psid: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    if (commaIdx < 0) throw new Error("invalid_data_url");
    return Buffer.from(url.slice(commaIdx + 1), "base64");
  }
  if (isSimulatorPsid(psid)) {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 20_000,
    });
    return Buffer.from(res.data);
  }
  return downloadMessengerAttachment(url, pageAccessToken);
}

async function sendImageAndLog(opts: {
  pageAccessToken: string;
  psid: string;
  imageUrl: string;
  within24hWindow: boolean;
  conversationId: string;
  replyToMid?: string;
}): Promise<{ messageId?: string }> {
  const result = await sendMessengerImage({
    pageAccessToken: opts.pageAccessToken,
    psid: opts.psid,
    imageUrl: opts.imageUrl,
    within24hWindow: opts.within24hWindow,
    replyToMid: opts.replyToMid,
  });
  if (isSimulatorPsid(opts.psid)) {
    await logAssistantTurn(opts.conversationId, "", [opts.imageUrl]);
  }
  return result;
}

async function setLastCatalogSku(conversationId: string, sku: string): Promise<void> {
  if (!conversationId || !sku) return;
  const convo = await prisma.messengerConversation
    .findUnique({ where: { id: conversationId }, select: { pendingDraftJson: true } })
    .catch(() => null);
  const prev =
    convo?.pendingDraftJson && typeof convo.pendingDraftJson === "object" && !Array.isArray(convo.pendingDraftJson)
      ? (convo.pendingDraftJson as Record<string, unknown>)
      : {};
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: {
        pendingDraftJson: {
          ...prev,
          lastCatalogSku: sku,
          // Once a specific product is chosen, old option list becomes stale.
          catalogOptionSkus: [],
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}

function getLastCatalogSkuFromDraft(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>)["lastCatalogSku"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function setCatalogOptionSkus(conversationId: string, skus: string[]): Promise<void> {
  if (!conversationId) return;
  const convo = await prisma.messengerConversation
    .findUnique({ where: { id: conversationId }, select: { pendingDraftJson: true } })
    .catch(() => null);
  const prev =
    convo?.pendingDraftJson && typeof convo.pendingDraftJson === "object" && !Array.isArray(convo.pendingDraftJson)
      ? (convo.pendingDraftJson as Record<string, unknown>)
      : {};
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: {
        pendingDraftJson: {
          ...prev,
          catalogOptionSkus: skus.slice(0, MAX_CATALOG_OPTION_LIST),
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}

function getCatalogOptionSkusFromDraft(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const v = (raw as Record<string, unknown>)["catalogOptionSkus"];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean);
}

async function saveSentImageMidToSku(
  conversationId: string,
  newEntries: Record<string, string>,
): Promise<void> {
  if (!conversationId || Object.keys(newEntries).length === 0) return;
  const convo = await prisma.messengerConversation
    .findUnique({ where: { id: conversationId }, select: { pendingDraftJson: true } })
    .catch(() => null);
  const prev =
    convo?.pendingDraftJson && typeof convo.pendingDraftJson === "object" && !Array.isArray(convo.pendingDraftJson)
      ? (convo.pendingDraftJson as Record<string, unknown>)
      : {};
  const existing =
    prev.sentImageMidToSku && typeof prev.sentImageMidToSku === "object" && !Array.isArray(prev.sentImageMidToSku)
      ? (prev.sentImageMidToSku as Record<string, string>)
      : {};
  const merged = { ...existing, ...newEntries };
  const keys = Object.keys(merged);
  const trimmed = keys.length > 120
    ? Object.fromEntries(keys.slice(-120).map((k) => [k, merged[k]!]))
    : merged;
  await prisma.messengerConversation
    .update({
      where: { id: conversationId },
      data: {
        pendingDraftJson: {
          ...prev,
          sentImageMidToSku: trimmed,
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}

function lookupSkuByImageMid(raw: unknown, mid: string | undefined): string | null {
  if (!mid || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const map = (raw as Record<string, unknown>)["sentImageMidToSku"];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const sku = (map as Record<string, unknown>)[mid];
  return typeof sku === "string" && sku.trim() ? sku.trim() : null;
}

async function resolveOrderClientSku(tenantId: string, structured: StructuredOrder): Promise<string | null> {
  const direct = String(structured.product ?? "").trim();
  if (!direct) return null;
  const bySku = await prisma.productMapping.findFirst({
    where: { tenantId, clientSku: direct },
    select: { clientSku: true },
  });
  if (bySku?.clientSku) return bySku.clientSku;

  const byLabelExact = await prisma.productMapping.findFirst({
    where: { tenantId, facebookLabel: { equals: direct, mode: "insensitive" } },
    select: { clientSku: true },
  });
  if (byLabelExact?.clientSku) return byLabelExact.clientSku;

  const byLabelLike = await prisma.productMapping.findFirst({
    where: { tenantId, facebookLabel: { contains: direct, mode: "insensitive" } },
    select: { clientSku: true },
  });
  return byLabelLike?.clientSku ?? null;
}

function parsePriceNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolveCatalogUnitPriceBdt(args: {
  tenantId: string;
  conversationId: string;
  structured: StructuredOrder;
}): Promise<number | null> {
  const { tenantId, conversationId, structured } = args;
  let sku = await resolveOrderClientSku(tenantId, structured);
  if (!sku) {
    const convo = await prisma.messengerConversation.findUnique({
      where: { id: conversationId },
      select: { pendingDraftJson: true },
    });
    sku = getLastCatalogSkuFromDraft(convo?.pendingDraftJson);
  }
  if (!sku) return null;
  const mapping = await prisma.productMapping.findFirst({
    where: { tenantId, clientSku: sku },
    select: { metadata: true },
  });
  const meta =
    mapping?.metadata && typeof mapping.metadata === "object" && !Array.isArray(mapping.metadata)
      ? (mapping.metadata as Record<string, unknown>)
      : null;
  if (!meta) return null;
  const candidates = [
    meta["price"],
    meta["unitPrice"],
    meta["unit_price"],
    meta["salePrice"],
    meta["sale_price"],
    meta["mrp"],
  ];
  for (const c of candidates) {
    const parsed = parsePriceNumber(c);
    if (parsed != null) return parsed;
  }
  return null;
}

type TenantForOrder = Tenant & { integration: TenantIntegration | null };

type NormalizedOrderItem = {
  product: string;
  size?: string;
  quantity: number;
  addOns?: string[];
  unitPriceBdt?: number;
  unitAddOnBdt?: number;
};

function normalizeOrderItems(structured: StructuredOrder): NormalizedOrderItem[] {
  const out: NormalizedOrderItem[] = [];
  if (Array.isArray(structured.items)) {
    for (const raw of structured.items) {
      const product = String(raw?.product ?? "").trim();
      if (!product) continue;
      const qRaw = Number(raw?.quantity ?? 1);
      const quantity = Number.isFinite(qRaw) && qRaw > 0 ? qRaw : 1;
      out.push({
        product,
        size: String(raw?.size ?? "").trim() || undefined,
        quantity,
        addOns: Array.isArray(raw?.addOns)
          ? (raw!.addOns as unknown[]).map((a) => String(a ?? "").trim()).filter(Boolean)
          : undefined,
        unitPriceBdt: typeof raw?.unitPriceBdt === "number" ? raw.unitPriceBdt : undefined,
        unitAddOnBdt: typeof raw?.unitAddOnBdt === "number" ? raw.unitAddOnBdt : undefined,
      });
    }
  }
  if (out.length > 0) return out;
  const single = String(structured.product ?? "").trim();
  if (!single) return [];
  const qRaw = Number(structured.quantity ?? 1);
  const quantity = Number.isFinite(qRaw) && qRaw > 0 ? qRaw : 1;
  return [{ product: single, size: String(structured.size ?? "").trim() || undefined, quantity }];
}

/**
 * `skuHasVariants` mirror for the legacy path: looks at the catalog meta
 * blob and returns true when the row declares per-size stock or a non-empty
 * `variants[]` list. Same predicate as `agent/tools/missingSlots.ts` so the
 * legacy switchboard and the agent loop agree on which products require a
 * size at confirm time.
 */
function productMetaHasVariants(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false;
  for (const key of ["sizeStocks", "size_stocks", "stockBySize", "stock_by_size"]) {
    const map = meta[key];
    if (
      map &&
      typeof map === "object" &&
      !Array.isArray(map) &&
      Object.keys(map as Record<string, unknown>).length > 0
    ) {
      return true;
    }
  }
  const variants = meta["variants"];
  if (Array.isArray(variants) && variants.length > 0) return true;
  return false;
}

/**
 * Look up a tenant's catalog by product label / sku and return the
 * metadata blob. The legacy switchboard's `NormalizedOrderItem` carries
 * the customer-facing product NAME (not the SKU) so we try both — exact
 * SKU first, then a label-based search. Returns `null` when no row
 * matches; callers should treat that as "size not required" so a partial
 * catalog can never block the order.
 */
async function resolveProductMetaByName(
  tenantId: string,
  productOrSku: string,
): Promise<Record<string, unknown> | null> {
  const v = productOrSku.trim();
  if (!v) return null;
  const bySku = await prisma.productMapping
    .findUnique({
      where: { tenantId_clientSku: { tenantId, clientSku: v } },
      select: { metadata: true },
    })
    .catch(() => null);
  if (bySku?.metadata && typeof bySku.metadata === "object" && !Array.isArray(bySku.metadata)) {
    return bySku.metadata as Record<string, unknown>;
  }
  const byLabel = await prisma.productMapping
    .findFirst({
      where: { tenantId, facebookLabel: { equals: v, mode: "insensitive" } },
      select: { metadata: true },
    })
    .catch(() => null);
  if (byLabel?.metadata && typeof byLabel.metadata === "object" && !Array.isArray(byLabel.metadata)) {
    return byLabel.metadata as Record<string, unknown>;
  }
  return null;
}

async function resolveCatalogUnitPriceForProductName(tenantId: string, productName: string): Promise<number | null> {
  const direct = productName.trim();
  if (!direct) return null;
  const bySku = await prisma.productMapping.findFirst({
    where: { tenantId, clientSku: direct },
    select: { metadata: true },
  });
  if (bySku?.metadata && typeof bySku.metadata === "object" && !Array.isArray(bySku.metadata)) {
    const meta = bySku.metadata as Record<string, unknown>;
    const p = parsePriceNumber(meta["price"] ?? meta["unitPrice"] ?? meta["unit_price"]);
    if (p != null) return p;
  }
  const byLabel = await prisma.productMapping.findFirst({
    where: { tenantId, facebookLabel: { contains: direct, mode: "insensitive" } },
    select: { metadata: true },
  });
  if (byLabel?.metadata && typeof byLabel.metadata === "object" && !Array.isArray(byLabel.metadata)) {
    const meta = byLabel.metadata as Record<string, unknown>;
    const p = parsePriceNumber(meta["price"] ?? meta["unitPrice"] ?? meta["unit_price"]);
    if (p != null) return p;
  }
  return null;
}

async function runOrderPipelineAfterValidation(opts: {
  tenant: TenantForOrder;
  tenantId: string;
  conversationId: string;
  psid: string;
  structured: StructuredOrder;
  customerSummary?: string;
  within24h: boolean;
  persona?: BotPersona;
  settings: ReturnType<typeof parseTenantSettings>;
}): Promise<void> {
  const {
    tenant,
    tenantId,
    conversationId,
    psid,
    structured,
    customerSummary,
    within24h,
    persona,
    settings,
  } = opts;
  const token = tenant.facebookPageAccessToken;
  if (!token) return;
  const hasSsl =
    Boolean(settings.sslcommerz?.storeId?.trim()) && Boolean(settings.sslcommerz?.storePassword?.trim());
  const manual = settings.manualPayment;
  const hasManualBkash = Boolean(manual?.enabled && manual.bkash?.number?.trim());
  const hasManualNagad = Boolean(manual?.enabled && manual.nagad?.number?.trim());
  const hasManual = hasManualBkash || hasManualNagad;
  if (!tenant.integration && !hasSsl && !hasManual) {
    await sendMessengerText({
      pageAccessToken: token,
      psid,
      text: await speak({
        tenantId,
        conversationId,
        persona,
        intent: { kind: "no_integration" },
        customerMessage: customerSummary,
        logIncoming: false,
      }),
      within24hWindow: within24h,
    });
    return;
  }

  const items = normalizeOrderItems(structured);
  let productSubtotalBdt: number | null = null;
  if (items.length > 0) {
    let sum = 0;
    let allPriced = true;
    for (const it of items) {
      const resolvedUnit =
        typeof it.unitPriceBdt === "number"
          ? it.unitPriceBdt
          : await resolveCatalogUnitPriceForProductName(tenantId, it.product);
      if (resolvedUnit == null) {
        allPriced = false;
        break;
      }
      const unitAddOn = typeof it.unitAddOnBdt === "number" ? it.unitAddOnBdt : 0;
      sum += (resolvedUnit + unitAddOn) * it.quantity;
    }
    if (allPriced) productSubtotalBdt = sum;
  } else {
    const singleUnitPriceFromCatalog = await resolveCatalogUnitPriceBdt({
      tenantId,
      conversationId,
      structured,
    });
    if (singleUnitPriceFromCatalog != null) {
      const q = Number(structured.quantity ?? 1) > 0 ? Number(structured.quantity ?? 1) : 1;
      productSubtotalBdt = singleUnitPriceFromCatalog * q;
    }
  }
  if (productSubtotalBdt == null) productSubtotalBdt = settings.defaultOrderAmountBdt ?? 100;
  // Payment request can be advance-only; order total stores product subtotal.
  const payableNowBdt = settings.advancePaymentBdt ?? productSubtotalBdt;

  const order = await prisma.order.create({
    data: {
      tenantId,
      messengerPsid: psid,
      structuredData: structured as unknown as Prisma.InputJsonValue,
      status: "PENDING_CLIENT_SYNC",
      paymentStatus: "PENDING",
      totalAmount: new Prisma.Decimal(productSubtotalBdt),
      currency: "BDT",
      paymentMethod: hasSsl ? "SSLCOMMERZ" : hasManualBkash ? "BKASH_MANUAL" : "NAGAD_MANUAL",
    },
  });

  try {
    let externalOrderId: string | undefined;
    if (tenant.integration) {
      const adapter = getIntegrationAdapter(tenant.integration.type);
      const push = await adapter.pushOrder(tenantId, {
        internalOrderId: order.id,
        structuredData: structured as unknown as Record<string, unknown>,
        amount: productSubtotalBdt,
        currency: "BDT",
      });
      externalOrderId = push.externalOrderId;
    }

    let gatewayUrl: string | null = null;
    let tranId: string | null = null;
    if (hasSsl) {
      tranId = buildTranId(order.id);
      const base = config.publicBaseUrl.replace(/\/$/, "");
      const successUrl = `${base}/webhooks/sslcommerz/return?status=success&tran_id=${encodeURIComponent(tranId)}`;
      const failUrl = `${base}/webhooks/sslcommerz/return?status=failure`;
      const cancelUrl = `${base}/webhooks/sslcommerz/return?status=cancel`;
      const ipnUrl = `${base}/webhooks/sslcommerz/ipn`;

      const session = await initiatePaymentSession({
        tranId,
        totalAmount: payableNowBdt.toFixed(2),
        currency: "BDT",
        successUrl,
        failUrl,
        cancelUrl,
        ipnUrl,
        customerName: structured.name ?? "Customer",
        customerPhone: structured.phone ?? "000",
        customerEmail: `fb-${psid}@customers.placeholder.local`,
        customerAddress: structured.address,
        storeId: settings.sslcommerz?.storeId,
        storePassword: settings.sslcommerz?.storePassword,
        isLive: settings.sslcommerz?.isLive,
      });
      gatewayUrl = session.gatewayUrl;
    }

    await prisma.order.update({
      where: { id: order.id },
      data: {
        ...(externalOrderId ? { externalOrderId } : {}),
        status: "AWAITING_PAYMENT",
        ...(tranId ? { sslcommerzTranId: tranId } : {}),
      },
    });

    const summaryItems =
      items.length > 0
        ? items
            .slice(0, 4)
            .map((it) => `${it.product}${it.size ? ` (${it.size})` : ""} x${it.quantity}`)
            .join(", ")
        : structured.product ?? "Order";
    const summary = [summaryItems, `${payableNowBdt} BDT`].filter(Boolean).join(", ");

    const manualBlock = buildManualPaymentInstructions(settings.manualPayment, payableNowBdt, order.id);

    const headerSections: string[] = ["✅ Order Confirmed"];
    headerSections.push(`🆔 Order ID:\n${tranId ?? order.id.slice(0, 12)}`);
    const chargesLines: string[] = [];
    if (typeof settings.advancePaymentBdt === "number") {
      chargesLines.push(`💵 Advance Payment: ${settings.advancePaymentBdt} BDT`);
    }
    if (typeof settings.deliveryChargeBdt === "number") {
      chargesLines.push(`🚚 Delivery Charge: ${settings.deliveryChargeBdt} BDT`);
    }
    if (chargesLines.length === 0 && payableNowBdt > 0) {
      chargesLines.push(`💵 Advance Payment: ${payableNowBdt} BDT`);
    }
    if (chargesLines.length > 0) headerSections.push(chargesLines.join("\n"));

    if (gatewayUrl) {
      headerSections.push(`🔗 Payment Link:\n${gatewayUrl}`);
    }

    let replyText = headerSections.join("\n\n");

    if (manualBlock) {
      replyText = `${replyText}\n\n━━━━━━━━━━\n\n${manualBlock}`;
    } else if (!gatewayUrl) {
      replyText = `${replyText}\n\n📝 Note:\nPayment options niye admin contact korben.`;
    }

    void summary;
    await logAssistantTurn(conversationId, replyText);

    await sendMessengerText({
      pageAccessToken: token,
      psid,
      text: replyText,
      within24hWindow: within24h,
    });
  } catch (e) {
    logger.error({ e, orderId: order.id }, "Order pipeline failed");
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "FAILED", failureReason: String(e) },
    });
    await sendMessengerText({
      pageAccessToken: token,
      psid,
      text: await speak({
        tenantId,
        conversationId,
        persona,
        intent: { kind: "order_failed", reason: String(e).slice(0, 200) },
        customerMessage: customerSummary,
        logIncoming: false,
      }),
      within24hWindow: within24h,
    });
  }
}

const CART_SESSION_TTL_MS = 3 * 60 * 60 * 1000;

function draftHasActiveShoppingSession(raw: unknown): boolean {
  if (getCartItemsFromDraft(raw).length > 0) return true;
  if (getCatalogOptionSkusFromDraft(raw).length > 0) return true;
  if (getPendingNameNumberSkuFromDraft(raw)) return true;
  if (getLastCatalogSkuFromDraft(raw)) return true;
  return false;
}

/** Clears cart + picker context if `pendingDraftJson.updatedAt` is older than 3 hours. */
async function expireStaleMessengerCartSession(conversationId: string): Promise<void> {
  const row = await prisma.messengerConversation.findUnique({
    where: { id: conversationId },
    select: { pendingDraftJson: true },
  });
  const rawDraft = row?.pendingDraftJson;
  if (!draftHasActiveShoppingSession(rawDraft)) return;

  const draft = parseDraftObject(rawDraft);
  const rawAt = draft["updatedAt"];
  const ts = typeof rawAt === "string" && rawAt.trim() ? Date.parse(rawAt.trim()) : NaN;
  if (!Number.isFinite(ts)) {
    const next = { ...draft, updatedAt: new Date().toISOString() };
    await prisma.messengerConversation.update({
      where: { id: conversationId },
      data: { pendingDraftJson: next as Prisma.InputJsonValue },
    });
    return;
  }
  if (Date.now() - ts <= CART_SESSION_TTL_MS) return;

  const next: Record<string, unknown> = { ...draft };
  next["cartItems"] = [];
  next["catalogOptionSkus"] = [];
  delete next["pendingNameNumberSku"];
  delete next["lastCatalogSku"];
  next["updatedAt"] = new Date().toISOString();
  await prisma.messengerConversation.update({
    where: { id: conversationId },
    data: { pendingDraftJson: next as Prisma.InputJsonValue },
  });
  logger.info({ conversationId }, "Messenger cart session expired (3h idle)");
}

export async function handleInboundMessengerMessage(params: {
  tenantId: string;
  tenantSlug: string;
  psid: string;
  text?: string;
  imageUrls?: string[];
  /** Webhook `message.mid` for this inbound turn — used to thread outbound replies in Messenger */
  customerMessageMid?: string;
  /** When the customer used "reply" on a specific message in the thread */
  replyToParentMid?: string;
  /** Override the default page access token (used for multi-page support) */
  pageAccessTokenOverride?: string;
}): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: params.tenantId },
    include: { integration: true },
  });
  if (!tenant?.isActive) {
    logger.warn({ tenantId: params.tenantId }, "Tenant inactive — skipping inbound");
    return;
  }
  // For real Messenger traffic the page token is mandatory (we have to reply via Graph).
  // For sandbox traffic (SIM_* PSIDs from the portal /chat/simulate endpoint) we never
  // call Graph — `sendMessengerText` short-circuits on `isSimulatorPsid` — so a missing
  // token must NOT block the agent. Otherwise newly onboarded tenants (who haven't
  // connected a real FB page yet) get a silent no-reply when they try the sandbox.
  const isSandboxPsid = isSimulatorPsid(params.psid);
  const effectivePageToken =
    params.pageAccessTokenOverride ?? tenant.facebookPageAccessToken ?? "";
  if (!effectivePageToken && !isSandboxPsid) {
    logger.warn(
      { tenantId: params.tenantId },
      "Tenant missing facebookPageAccessToken — cannot reply to real Messenger traffic. Connect a Facebook page in Integration settings.",
    );
    return;
  }
  // Patch the tenant object so all downstream helpers use the correct page token.
  // (Empty string is fine for sandbox — Graph helpers gate on `isSimulatorPsid` first.)
  (tenant as { facebookPageAccessToken: string }).facebookPageAccessToken = effectivePageToken;

  const agentEnabled = await isAgentEnabledForTenant(params.tenantId);

  const now = new Date();
  const convoUpsert = await prisma.messengerConversation.upsert({
    where: { tenantId_psid: { tenantId: params.tenantId, psid: params.psid } },
    create: { tenantId: params.tenantId, psid: params.psid, lastUserMsgAt: now },
    update: { lastUserMsgAt: now },
  });
  const conversationId = convoUpsert.id;
  await expireStaleMessengerCartSession(conversationId);
  const convo = await prisma.messengerConversation.findUniqueOrThrow({
    where: { id: conversationId },
  });

  const within24h = isWithinMessagingWindow(convo.lastUserMsgAt);

  const settings = parseTenantSettings(tenant.settings);
  const persona = settings.botPersona as BotPersona | undefined;

  const trimmed = params.text?.trim() ?? "";
  const imageUrlList = (params.imageUrls ?? []).slice(0, 4);
  const hasIncomingImages = imageUrlList.length > 0;

  // Log the incoming customer turn once so it's available as memory for ALL replies in this turn
  if (trimmed || hasIncomingImages) {
    await prisma.messengerMessage
      .create({
        data: {
          conversationId,
          role: "user",
          text: trimmed || `[sent ${imageUrlList.length} photo(s)]`,
          imageUrls: imageUrlList,
          facebookMessageId: params.customerMessageMid ?? null,
          replyToFacebookMessageId: params.replyToParentMid ?? null,
        },
      })
      .catch(() => undefined);
    if (trimmed && config.conversationLearningEnabled) {
      void maybeRecordCorrectionFromInbound({
        tenantId: params.tenantId,
        conversationId,
        customerText: trimmed,
      }).catch(() => undefined);
    }
  }

  // ── Per-conversation mute (handoff window) ──────────────────────────────
  // Set by `muteAgent()` after a past-order escalation. While active, we
  // record the inbound (above) but do NOT respond. Admin handles the
  // conversation directly via Messenger.
  {
    const muted = await isAgentMuted(conversationId);
    if (muted) {
      logger.info(
        { tenantId: params.tenantId, conversationId, psid: params.psid },
        "agent muted — skipping reply",
      );
      return;
    }
  }

  // ── Post-connection grace handoff ───────────────────────────────────────
  // For 48h after the tenant connected their Page, a past-order question
  // from a returning customer escalates to admin (we don't have their
  // pre-connection order in our DB so the agent would just say "no order
  // found", which is rude). Telegram alert + Banglish ack + 10h mute.
  //
  // CRITICAL GUARD: only escalate when the conversation is NOT already
  // mid-flow. A customer who's actively building a cart and just sent us
  // their name + phone + address cannot be a "past order" question — the
  // agent literally just asked them for those details. Without this guard,
  // a phone number leaking into a regex (or a phrase like "amar order"
  // mid-checkout) was hijacking fresh orders into admin handoff.
  if (trimmed && (await isTenantInGraceWindow(params.tenantId))) {
    if (looksLikePastOrderQuestion(trimmed)) {
      const snap = await loadSnapshot(conversationId);
      const inFlight = hasInFlightOrder(snap);
      if (inFlight) {
        logger.info(
          {
            tenantId: params.tenantId,
            conversationId,
            psid: params.psid,
            cart: snap.cart.length,
            order_state: snap.order_state,
            snippet: trimmed.slice(0, 80),
          },
          "grace window: matched past-order regex but conversation has an in-flight order — skipping handoff",
        );
      } else {
        logger.info(
          { tenantId: params.tenantId, conversationId, psid: params.psid, snippet: trimmed.slice(0, 80) },
          "grace window: past-order question → handoff",
        );
      // Send the ack (best-effort, within the 24h messaging window).
      try {
        await sendMessengerText({
          pageAccessToken: effectivePageToken,
          psid: params.psid,
          text: HANDOFF_CUSTOMER_REPLY,
          within24hWindow: within24h,
        });
        await prisma.messengerMessage
          .create({
            data: { conversationId, role: "assistant", text: HANDOFF_CUSTOMER_REPLY },
          })
          .catch(() => undefined);
        await prisma.messengerConversation
          .update({ where: { id: conversationId }, data: { lastBotMsgAt: new Date() } })
          .catch(() => undefined);
      } catch (e) {
        logger.warn({ e: String(e), conversationId }, "grace handoff: messenger ack failed");
      }
      // Telegram alert. Best-effort — if the tenant hasn't configured
      // Telegram, this is a no-op.
      try {
        const tg = settings.telegram;
        if (tg?.enabled && tg.botToken?.trim() && tg.chatId?.trim()) {
          const text = buildHandoffTelegramText({
            tenantSlug: params.tenantSlug,
            psid: params.psid,
            customerText: trimmed,
            conversationUrl: null,
          });
          await sendTelegramMessage({
            botToken: tg.botToken.trim(),
            chatId: tg.chatId.trim(),
            text,
          }).catch((e) =>
            logger.warn({ e: String(e), conversationId }, "grace handoff: telegram alert failed"),
          );
        }
      } catch (e) {
        logger.warn({ e: String(e), conversationId }, "grace handoff: telegram outer failed");
      }
      // Mute for 10h. Idempotent — repeated past-order questions during the
      // mute don't extend it.
      await muteAgent(conversationId);
      return;
      } // end of `else { ...escalate... }`
    }
  }

  await runWithMessengerReplyTo(params.customerMessageMid, async () => {
  const pageAccessToken = effectivePageToken;
  // Manual payment detection MUST run before the catalog/intent short-circuit;
  // otherwise short messages like "Bkash 766gjc" get routed to the LLM general
  // chat branch and the admin Telegram alert never fires.
  const manualHandled = await tryHandleManualPaymentTurn({
    tenantId: params.tenantId,
    tenantSlug: params.tenantSlug,
    psid: params.psid,
    pageAccessToken: pageAccessToken,
    settings,
    conversationId,
    trimmed,
    imageUrlList,
    within24h,
    agentEnabled,
  });
  if (manualHandled) return;

  // ── Agent loop (phase 1, opt-in via tenant.settings.agent.enabled) ────────
  // Runs after manual payment so bKash/Nagad TrxIDs continue to flow through legacy.
  // On "handled" or "errored" the agent has already replied → return.
  // On "skipped" we fall through to the legacy switchboard.
  if (agentEnabled) {
    const agentResult = await runAgentInbound({
      tenantId: params.tenantId,
      tenantSlug: params.tenantSlug,
      psid: params.psid,
      conversationId,
      userText: trimmed,
      imageUrls: imageUrlList,
      pageAccessToken,
      within24h,
    });
    if (agentResult !== "skipped") return;
  }


  const mappings = await prisma.productMapping.findMany({
    where: { tenantId: params.tenantId },
    orderBy: { clientSku: "asc" },
    take: 600,
  });

  // --- Reply-to-product-image shortcut ---
  // If the customer replied to a specific product image we previously sent, identify that product.
  // When the message has actionable content (add-on, name+number, size, cart intent), just set
  // the product context and let the normal flow handle it. Only show product details card when
  // the reply is a simple selection/inquiry without meaningful order content.
  const repliedToProductSku = lookupSkuByImageMid(convo.pendingDraftJson, params.replyToParentMid);
  if (repliedToProductSku && mappings.length > 0) {
    const repliedRow = mappings.find((m) => m.clientSku === repliedToProductSku) ?? null;
    if (repliedRow) {
      await setLastCatalogSku(conversationId, repliedRow.clientSku);
      const replyHasActionableContent =
        looksLikeAddonRequest(trimmed) ||
        !!detectCartIntent(trimmed) ||
        !!parseRequestedSize(trimmed) ||
        !!extractNameNumberValue(trimmed) ||
        /\b(name|number|নাম|নম্বর|font|official|patch|patches|badge)\b/i.test(trimmed);
      if (!replyHasActionableContent) {
        const repliedLabel = (repliedRow.facebookLabel ?? repliedRow.clientSku).trim();
        if (await hasRepeatedProductCard(conversationId, repliedLabel)) {
          const short = `${repliedLabel} er details already dekhiyechi 😊 Size ar qty dile add kore dibo, or onno jersey name bolun.`;
          await sendMessengerText({ pageAccessToken, psid: params.psid, text: short, within24hWindow: within24h });
          await logAssistantTurn(conversationId, short);
          return;
        }
        const addonSnippetReply = buildTenantAddonSnippet(settings.addOns);
        const browseReply = buildBrowseFirstCatalogReply(repliedRow, settings, addonSnippetReply, tenant.businessCategory);
        const assets = extractCatalogAssets(repliedRow);
        if (assets.imageUrls.length > 0) {
          for (const imgUrl of assets.imageUrls.slice(0, 3)) {
            await sendImageAndLog({
              pageAccessToken,
              psid: params.psid,
              imageUrl: imgUrl,
              within24hWindow: within24h,
              conversationId,
            }).catch(() => undefined);
          }
        }
        await sendMessengerText({
          pageAccessToken,
          psid: params.psid,
          text: browseReply,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, browseReply);
        return;
      }
    }
  }

  // --- Post-order cooldown ---
  // If the customer just confirmed/paid an order within the last 30 min and the cart is empty,
  // treat all messages as general chat. Don't try to push products again.
  const POST_ORDER_COOLDOWN_MS = 30 * 60 * 1000;
  const recentPaidOrder = await prisma.order.findFirst({
    where: {
      tenantId: params.tenantId,
      messengerPsid: params.psid,
      paymentStatus: { in: ["PAID"] },
      updatedAt: { gte: new Date(Date.now() - POST_ORDER_COOLDOWN_MS) },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  const cartItems = getCartItemsFromDraft(convo.pendingDraftJson);
  const hasJustCompletedOrder = !!recentPaidOrder && cartItems.length === 0;

  const lastSku = repliedToProductSku || getLastCatalogSkuFromDraft(convo.pendingDraftJson);
  const lastRow = lastSku ? mappings.find((m) => m.clientSku === lastSku) ?? null : null;
  const earlyCartIntent = detectCartIntent(trimmed);
  const draftOptionSkus = getCatalogOptionSkusFromDraft(convo.pendingDraftJson);
  const pickedDraftOptionIndex = detectCatalogOptionSelection(trimmed, draftOptionSkus.length);
  const pickedMultiIndices = detectMultipleCatalogOptionSelections(trimmed, draftOptionSkus.length);
  const hasDraftOptionPick = pickedDraftOptionIndex != null || pickedMultiIndices.length >= 2;
  const earlySelectedOptionRow =
    pickedDraftOptionIndex != null
      ? mappings.find((m) => m.clientSku === draftOptionSkus[pickedDraftOptionIndex]) ?? null
      : null;
  const earlyIntent = classifyCatalogIntent(trimmed);
  const catalogMatcherEligible =
    !hasJustCompletedOrder &&
    mappings.length > 0 &&
    (hasIncomingImages ||
      isLikelyProductQuery(trimmed) ||
      Boolean(earlyCartIntent) ||
      hasDraftOptionPick ||
      (earlyIntent !== "general" && Boolean(lastRow)) ||
      catalogMatcherShouldIncludeDraftContinuation(trimmed, convo.pendingDraftJson));

  if (!hasIncomingImages && !catalogMatcherEligible) {
    // Pure chitchat / unknown → Gemma. Catalog intents never reach here unless we
    // truly have nothing in the catalog.
    if (earlyIntent !== "general") {
      const fixed = buildNoContextCatalogReply(earlyIntent, settings);
      if (fixed) {
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: fixed,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, fixed);
        return;
      }
    }
    await sendMessengerText({
      pageAccessToken: pageAccessToken,
      psid: params.psid,
      text: await speak({
        tenantId: params.tenantId,
        conversationId,
        persona,
        intent: { kind: "general_chat" },
        customerMessage: trimmed || undefined,
        logIncoming: false,
      }),
      within24hWindow: within24h,
    });
    return;
  }

  const imagesB64: string[] = [];
  for (const url of imageUrlList.slice(0, 3)) {
    try {
      const buf = await downloadAttachment(url, pageAccessToken, params.psid);
      if (buf.length > 32) imagesB64.push(buf.toString("base64"));
    } catch (e) {
      logger.warn({ e: String(e) }, "Messenger image download skipped");
    }
  }

  let jerseyVision: Awaited<ReturnType<typeof identifyJerseyFromPhoto>> = null;
  if (hasIncomingImages && imagesB64.length > 0) {
    try {
      jerseyVision = await identifyJerseyFromPhoto(imagesB64, trimmed || undefined);
      if (jerseyVision?.primaryNames?.length) {
        logger.info(
          { kind: jerseyVision.kind, primaryNames: jerseyVision.primaryNames },
          "Jersey photo vision identify",
        );
      }
    } catch (e) {
      logger.warn({ e: String(e) }, "identifyJerseyFromPhoto skipped");
    }
  }

  if (hasIncomingImages && imagesB64.length === 0 && !trimmed) {
    await sendMessengerText({
      pageAccessToken: pageAccessToken,
      psid: params.psid,
      text: await speak({
        tenantId: params.tenantId,
        conversationId,
        persona,
        intent: { kind: "general_chat" },
        customerMessage: "[photos could not be loaded — try again or send text]",
        logIncoming: false,
      }),
      within24hWindow: within24h,
    });
    return;
  }

  const customerSummary =
    [trimmed || undefined, hasIncomingImages ? `${imageUrlList.length} photo(s)` : undefined]
      .filter(Boolean)
      .join(" · ") || undefined;
  const catalogIntent = classifyCatalogIntent(trimmed);
  const asksForPhoto = catalogIntent === "ask_photo";
  const asksForSizeChart = catalogIntent === "ask_size_chart";
  const asksForOrder = catalogIntent === "ask_order";
  const asksForImagesOrSize = asksForPhoto || asksForSizeChart;
  const isAssetOnlyFollowup =
    asksForImagesOrSize &&
    !/\b(argentina|brazil|sweden|germany|barcelona|madrid|manchester|inter|liverpool|chelsea)\b/i.test(
      trimmed.toLowerCase(),
    );
  const hasLastCatalogContext = Boolean(lastRow);

  const addrOnly = trimmed && !hasIncomingImages ? extractPrefixedAddressLine(trimmed) : null;
  if (addrOnly) {
    const cartAddr = getCartItemsFromDraft(convo.pendingDraftJson);
    if (cartAddr.length > 0) {
      await mergeDraftCustomerProfileField(conversationId, "address", addrOnly);
      const fresh =
        (
          await prisma.messengerConversation.findUnique({
            where: { id: conversationId },
            select: { pendingDraftJson: true },
          })
        )?.pendingDraftJson ?? null;
      const enriched = enrichCartNameNumberPrices(getCartItemsFromDraft(fresh), settings);
      const freshParsed = parseDraftObject(fresh);
      const rawProf = freshParsed["customerProfile"];
      const prof =
        rawProf && typeof rawProf === "object" && !Array.isArray(rawProf)
          ? (rawProf as Record<string, unknown>)
          : {};
      const phone = String(prof["phone"] ?? "").trim();
      const needSize = enriched.some((it) => !String(it.size ?? "").trim());
      const linesAddr: string[] = [buildCartSummaryText(enriched, settings), "", `Address note kore nilam: ${addrOnly}`];
      if (needSize) linesAddr.push("Size din (e.g. L, XL).");
      if (!phone) linesAddr.push("Order confirm korar jonno phone number din.");
      else if (!needSize)
        linesAddr.push(`Jodi thik thake, "${lastRow?.facebookLabel ?? "product"}" er order confirm korte "order confirm" likhun.`);
      const txtAddr = linesAddr.join("\n");
      await sendMessengerText({
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        text: txtAddr,
        within24hWindow: within24h,
      });
      await logAssistantTurn(conversationId, txtAddr);
      return;
    }
  }

  // Handle MULTIPLE list selections ("2nd r 4th ta nibo") — add all to cart and ask sizes
  if (pickedMultiIndices.length >= 2 && draftOptionSkus.length >= 2 && !hasIncomingImages) {
    const selectedRows = pickedMultiIndices
      .map((idx) => mappings.find((m) => m.clientSku === draftOptionSkus[idx]))
      .filter((r): r is ProductMapping => r != null);
    if (selectedRows.length >= 2) {
      const currentCart = getCartItemsFromDraft(convo.pendingDraftJson);
      const newItems: CartMemoryItem[] = selectedRows.map((r) => {
        const meta = mappingMeta(r);
        const priceRaw = meta["price"];
        const priceBdt = priceRaw ? parseInt(String(priceRaw), 10) || 0 : 0;
        return {
          sku: r.clientSku,
          product: (r.facebookLabel ?? r.clientSku).trim(),
          quantity: 1,
          size: undefined,
          addOns: [],
          unitPriceBdt: priceBdt,
        };
      });
      const mergedCart = [...currentCart];
      for (const item of newItems) {
        if (!mergedCart.some((c) => c.sku === item.sku)) mergedCart.push(item);
      }
      await setDraftCartItems(conversationId, mergedCart);
      await setLastCatalogSku(conversationId, selectedRows[selectedRows.length - 1]!.clientSku);
      const addedNames = selectedRows.map((r) => `${pickTeamEmoji((r.facebookLabel ?? "").trim())} ${(r.facebookLabel ?? r.clientSku).trim()}`);
      const sizeAsk = [
        `${addedNames.join("\n")}`,
        "",
        "Add kore dilam 😊",
        "",
        "Ekhon size bolun (M / L / XL):",
        ...selectedRows.map((r) => `${pickTeamEmoji((r.facebookLabel ?? "").trim())} ${(r.facebookLabel ?? r.clientSku).trim()} — ?`),
      ].join("\n");
      await sendMessengerText({ pageAccessToken, psid: params.psid, text: sizeAsk, within24hWindow: within24h });
      await logAssistantTurn(conversationId, sizeAsk);
      return;
    }
  }

  // Handle "2nd ta lagbe / prothomta / 1st one" style list selection BEFORE
  // LLM order extraction; otherwise it can be misread as raw product text.
  if (earlySelectedOptionRow && !hasIncomingImages && !looksLikeOrderDetailsSupply(trimmed)) {
    await setLastCatalogSku(conversationId, earlySelectedOptionRow.clientSku);
    if (earlyIntent === "ask_size_chart") {
      const reply = buildSizeChartReply(
        earlySelectedOptionRow,
        trimmed,
        settings.sizeCharts,
        tenant.businessCategory,
      );
      await sendMessengerText({
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        text: reply,
        within24hWindow: within24h,
      });
      await logAssistantTurn(conversationId, reply);
      return;
    }
    const selectionAck = buildDeterministicCatalogReply(earlySelectedOptionRow, { addOns: settings.addOns,
      includeCta: false, businessCategory: tenant.businessCategory });
    await sendMessengerText({
      pageAccessToken: pageAccessToken,
      psid: params.psid,
      text: selectionAck,
      within24hWindow: within24h,
    });
    await logAssistantTurn(conversationId, selectionAck);
    return;
  }

  const pendingNameNumberSku = getPendingNameNumberSkuFromDraft(convo.pendingDraftJson);
  if (isNameNumberPriceQuestion(trimmed)) {
    const activeAddOns = (settings.addOns ?? []).filter((a) => a && a.enabled !== false);
    const nn =
      activeAddOns.find((a) => /name/i.test(a.label) && /number|num|nambar|namber/i.test(a.label)) ?? null;
    const msg = nn
      ? `Name + Number price: ${typeof nn.priceBdt === "number" ? nn.priceBdt : 0} BDT.`
      : "Name + Number price set kora nai. Dashboard theke add-on pricing set korun.";
    await sendMessengerText({
      pageAccessToken: pageAccessToken,
      psid: params.psid,
      text: msg,
      within24hWindow: within24h,
    });
    await logAssistantTurn(conversationId, msg);
    return;
  }

  if (looksLikeCartContinueShoppingIntent(trimmed)) {
    await setPendingNameNumberSku(conversationId, null);
    const currentCart = getCartItemsFromDraft(convo.pendingDraftJson);
    const reply =
      currentCart.length > 0
        ? `Thik ache 😊 Aro jersey lagbe?\n\n${buildCartSummaryText(enrichCartNameNumberPrices(currentCart, settings), settings)}`
        : "Thik ache 😊 Kon jersey lagben bolun — naam/size diye bolen.";
    await sendMessengerText({
      pageAccessToken: pageAccessToken,
      psid: params.psid,
      text: reply,
      within24hWindow: within24h,
    });
    await logAssistantTurn(conversationId, reply);
    return;
  }

  if (pendingNameNumberSku) {
    const requestedSizeEarly = parseRequestedSize(trimmed);
    const requestedQtyEarly = parseRequestedQuantity(trimmed);
    const nnFromTextEarly = extractNameNumberValue(trimmed);
    if ((requestedSizeEarly || requestedQtyEarly != null) && !nnFromTextEarly) {
      const cartEarly = getCartItemsFromDraft(convo.pendingDraftJson);
      const idxEarly = cartEarly.findIndex((it) => it.sku === pendingNameNumberSku);
      if (idxEarly >= 0) {
        const updatedEarly = cartEarly.map((it, i) =>
          i === idxEarly
            ? {
                ...it,
                ...(requestedSizeEarly ? { size: requestedSizeEarly } : {}),
                ...(requestedQtyEarly != null ? { quantity: Math.max(1, requestedQtyEarly) } : {}),
              }
            : it,
        );
        await setDraftCartItems(conversationId, updatedEarly);
        const stillNeedsNn = (updatedEarly[idxEarly]!.addOns ?? []).some(
          (a) => looksLikeNameNumberAddOn(a) && !String(a.value ?? "").trim(),
        );
        if (stillNeedsNn) {
          const ask =
            "Size/qty update korlam. Ekhon Name + Number din: Messi 10 (or Name: Messi, Number: 10)";
          await sendMessengerText({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            text: ask,
            within24hWindow: within24h,
          });
          await logAssistantTurn(conversationId, ask);
          return;
        }
        await setPendingNameNumberSku(conversationId, null);
        const replyEarly = buildBanglishCartLinesUpdateReply({
          fullCart: enrichCartNameNumberPrices(updatedEarly, settings),
          settings,
        });
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: replyEarly,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, replyEarly);
        return;
      }
    }

    const currentCart = getCartItemsFromDraft(convo.pendingDraftJson);
    const multiNn = extractMultipleNameNumbers(trimmed, currentCart);
    if (multiNn && multiNn.length >= 2) {
      const nnUnitPrice = getNameNumberPriceBdtFromSettings(settings);
      let updatedCart = [...currentCart];
      for (const pair of multiNn) {
        updatedCart = updatedCart.map((it) => {
          if (it.sku !== pair.sku) return it;
          const nextAddOns = [...(it.addOns ?? [])];
          const idx = nextAddOns.findIndex((a) => looksLikeNameNumberAddOn(a));
          if (idx >= 0) {
            const prev = nextAddOns[idx]!;
            const pb = prev.priceBdt && prev.priceBdt > 0 ? prev.priceBdt : nnUnitPrice;
            nextAddOns[idx] = { ...prev, id: "name-number", value: pair.value, priceBdt: pb };
          } else {
            nextAddOns.push({ id: "name-number", label: "Name + Number", priceBdt: nnUnitPrice, value: pair.value });
          }
          return { ...it, addOns: nextAddOns };
        });
      }
      await setDraftCartItems(conversationId, updatedCart);
      await setPendingNameNumberSku(conversationId, null);
      const enriched = enrichCartNameNumberPrices(updatedCart, settings);
      const names = multiNn.map((p) => `👕 ${p.value}`).join("\n");
      const replyMulti = `ঠিক আছে 👌\n\n${names}\n\nSob add kore dilam 😊\n\n${buildBanglishCartLinesUpdateReply({ fullCart: enriched, settings })}`;
      await sendMessengerText({ pageAccessToken, psid: params.psid, text: replyMulti, within24hWindow: within24h });
      await logAssistantTurn(conversationId, replyMulti);
      return;
    }

    const nnValue = extractNameNumberValue(trimmed);
    if (!nnValue) {
      const ask = "Name + Number din eivabe: Messi 10 (or Name: Messi, Number: 10)";
      await sendMessengerText({
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        text: ask,
        within24hWindow: within24h,
      });
      await logAssistantTurn(conversationId, ask);
      return;
    }
    const nnUnitPrice = getNameNumberPriceBdtFromSettings(settings);
    const nextCart = currentCart.map((it) => {
      if (it.sku !== pendingNameNumberSku) return it;
      const nextAddOns = [...(it.addOns ?? [])];
      const idx = nextAddOns.findIndex((a) => looksLikeNameNumberAddOn(a));
      if (idx >= 0) {
        const prev = nextAddOns[idx]!;
        const pb = prev.priceBdt && prev.priceBdt > 0 ? prev.priceBdt : nnUnitPrice;
        nextAddOns[idx] = { ...prev, id: "name-number", value: nnValue, priceBdt: pb };
      } else {
        nextAddOns.push({
          id: "name-number",
          label: "Name + Number",
          priceBdt: nnUnitPrice,
          value: nnValue,
        });
      }
      return { ...it, addOns: nextAddOns };
    });
    await setDraftCartItems(conversationId, nextCart);
    await setPendingNameNumberSku(conversationId, null);
    const enrichedNn = enrichCartNameNumberPrices(nextCart, settings);
    const nnLine =
      enrichedNn.find((it) => it.sku === pendingNameNumberSku) ??
      enrichedNn.find((it) =>
        (it.addOns ?? []).some((a) => looksLikeNameNumberAddOn(a) && String(a.value ?? "").trim()),
      ) ??
      enrichedNn[enrichedNn.length - 1]!;
    const reply = buildBanglishNameNumberAddedReply({
      customNameNumber: nnValue,
      line: nnLine,
      fullCart: enrichedNn,
      settings,
    });
    await sendMessengerText({
      pageAccessToken: pageAccessToken,
      psid: params.psid,
      text: reply,
      within24hWindow: within24h,
    });
    await logAssistantTurn(conversationId, reply);
    return;
  }

  // Fallback: even if pending flag is missing, bind "Messi 10" style value to the
  // latest cart item that has Name+Number addon without value.
  if (!pendingNameNumberSku) {
    const nnValue = extractNameNumberValue(trimmed);
    if (nnValue) {
      const currentCart = getCartItemsFromDraft(convo.pendingDraftJson);
      const targetIdx = currentCart.findIndex((it) =>
        (it.addOns ?? []).some((a) => looksLikeNameNumberAddOn(a) && !String(a.value ?? "").trim()),
      );
      if (targetIdx >= 0) {
        const updated = [...currentCart];
        const target = updated[targetIdx]!;
        const nnP = getNameNumberPriceBdtFromSettings(settings);
        updated[targetIdx] = {
          ...target,
          addOns: (target.addOns ?? []).map((a) =>
            looksLikeNameNumberAddOn(a)
              ? {
                  ...a,
                  id: "name-number",
                  value: nnValue,
                  priceBdt: a.priceBdt && a.priceBdt > 0 ? a.priceBdt : nnP,
                }
              : a,
          ),
        };
        await setDraftCartItems(conversationId, updated);
        await setPendingNameNumberSku(conversationId, null);
        const reply = buildBanglishNameNumberAddedReply({
          customNameNumber: nnValue,
          line: enrichCartNameNumberPrices(updated, settings).find((it) => it.sku === target.sku) ?? updated[targetIdx]!,
          fullCart: enrichCartNameNumberPrices(updated, settings),
          settings,
        });
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: reply,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, reply);
        return;
      }
    }
  }

  const cartItemsNow = getCartItemsFromDraft(convo.pendingDraftJson);
  if (!isExplicitSizeChartRequest(trimmed) && cartItemsNow.length > 0) {
    const itemsMissingSz = cartItemsNow.filter((it) => !it.size?.trim());

    if (itemsMissingSz.length >= 1) {
      const teamSizePairs = parseTeamSizePairs(trimmed, cartItemsNow);
      if (teamSizePairs.length >= 1) {
        const updated = [...cartItemsNow];
        for (const pair of teamSizePairs) {
          const idx = updated.findIndex((it) => it.sku === pair.sku);
          if (idx >= 0) updated[idx] = { ...updated[idx]!, size: pair.size };
        }
        await setDraftCartItems(conversationId, updated);
        const stillMissing = updated.filter((it) => !it.size?.trim());
        if (stillMissing.length > 0) {
          const askNext = stillMissing.map((it) => `${pickTeamEmoji(it.product, undefined, tenant.businessCategory)} ${it.product} — kon size?`).join("\n");
          await sendMessengerText({ pageAccessToken, psid: params.psid, text: askNext, within24hWindow: within24h });
          await logAssistantTurn(conversationId, askNext);
          return;
        }
        const replySz = buildBanglishCartLinesUpdateReply({
          fullCart: enrichCartNameNumberPrices(updated, settings),
          settings,
        });
        await sendMessengerText({ pageAccessToken, psid: params.psid, text: replySz, within24hWindow: within24h });
        await logAssistantTurn(conversationId, replySz);
        return;
      }
    }

    const allSizes = parseAllSizes(trimmed);

    if (allSizes.length >= 2 && itemsMissingSz.length >= 2) {
      const updated = [...cartItemsNow];
      let sizeIdx = 0;
      for (let i = 0; i < updated.length && sizeIdx < allSizes.length; i++) {
        if (!updated[i]!.size?.trim()) {
          updated[i] = { ...updated[i]!, size: allSizes[sizeIdx]! };
          sizeIdx++;
        }
      }
      await setDraftCartItems(conversationId, updated);
      const replySz = buildBanglishCartLinesUpdateReply({
        fullCart: enrichCartNameNumberPrices(updated, settings),
        settings,
      });
      await sendMessengerText({ pageAccessToken, psid: params.psid, text: replySz, within24hWindow: within24h });
      await logAssistantTurn(conversationId, replySz);
      return;
    }

    const requestedSize = parseRequestedSize(trimmed);
    const requestedQty = parseRequestedQuantity(trimmed);

    if (requestedSize && itemsMissingSz.length >= 1 && !lastRow) {
      const updated = [...cartItemsNow];
      for (let i = 0; i < updated.length; i++) {
        if (!updated[i]!.size?.trim()) {
          updated[i] = { ...updated[i]!, size: requestedSize };
          break;
        }
      }
      await setDraftCartItems(conversationId, updated);
      const stillMissing = updated.filter((it) => !it.size?.trim());
      if (stillMissing.length > 0) {
        const askNext = stillMissing.map((it) => `${pickTeamEmoji(it.product, undefined, tenant.businessCategory)} ${it.product} — kon size?`).join("\n");
        await sendMessengerText({ pageAccessToken, psid: params.psid, text: askNext, within24hWindow: within24h });
        await logAssistantTurn(conversationId, askNext);
        return;
      }
      const replySz = buildBanglishCartLinesUpdateReply({
        fullCart: enrichCartNameNumberPrices(updated, settings),
        settings,
      });
      await sendMessengerText({ pageAccessToken, psid: params.psid, text: replySz, within24hWindow: within24h });
      await logAssistantTurn(conversationId, replySz);
      return;
    }

    const targetSku = lastRow?.clientSku ?? cartItemsNow[cartItemsNow.length - 1]?.sku;
    if (targetSku && (requestedSize || requestedQty != null)) {
      const updated = cartItemsNow.map((it) =>
        it.sku === targetSku
          ? {
              ...it,
              ...(requestedSize ? { size: requestedSize } : {}),
              ...(requestedQty != null ? { quantity: Math.max(1, requestedQty) } : {}),
            }
          : it,
      );
      await setDraftCartItems(conversationId, updated);
      const replySz = buildBanglishCartLinesUpdateReply({
        fullCart: enrichCartNameNumberPrices(updated, settings),
        settings,
      });
      await sendMessengerText({
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        text: replySz,
        within24hWindow: within24h,
      });
      await logAssistantTurn(conversationId, replySz);
      return;
    }
  }

  // ── Early addon intercept ──
  // When the customer says "name number soho nibo" / "official font nibo" etc.
  // and we have a lastRow context, handle it as an addon request immediately
  // rather than letting it fall through to product matching which re-shows the card.
  if (trimmed && !hasIncomingImages && looksLikeAddonRequest(trimmed) && lastRow) {
    const earlyCartForAddon = getCartItemsFromDraft(convo.pendingDraftJson);
    const metaEA = lastRow.metadata && typeof lastRow.metadata === "object" && !Array.isArray(lastRow.metadata)
      ? (lastRow.metadata as Record<string, unknown>)
      : {};
    const availableEA = resolveProductAddOnCatalog({ settings, meta: metaEA });
    const selectedEA =
      patchNameNumberAddonPrices(selectAddOnsFromText(trimmed, availableEA), settings) ??
      selectAddOnsFromText(trimmed, availableEA);
    if (selectedEA.length > 0) {
      const existIdxEA = earlyCartForAddon.findIndex((x) => x.sku === lastRow.clientSku);
      if (existIdxEA >= 0) {
        const existItemEA = earlyCartForAddon[existIdxEA]!;
        const mergedEA = [
          ...(existItemEA.addOns ?? []),
          ...selectedEA.filter(
            (a) => !(existItemEA.addOns ?? []).some((e) => canonicalAddonDedupeKey(e) === canonicalAddonDedupeKey(a)),
          ),
        ];
        const nextCartEA = [...earlyCartForAddon];
        nextCartEA[existIdxEA] = { ...existItemEA, addOns: mergedEA };
        await setDraftCartItems(conversationId, nextCartEA);
        await setLastCatalogSku(conversationId, lastRow.clientSku);
        const needsNnEA = mergedEA.some((a) => looksLikeNameNumberAddOn(a) && !String((a as Record<string, unknown>).value ?? "").trim());
        if (needsNnEA) {
          await setPendingNameNumberSku(conversationId, lastRow.clientSku);
          const ask = "Name + Number add hobe. Jersey te ki Name ar Number print korben? (e.g. Messi 10)";
          await sendMessengerText({ pageAccessToken, psid: params.psid, text: ask, within24hWindow: within24h });
          await logAssistantTurn(conversationId, ask);
          return;
        }
        const replyEA = buildBanglishCartLinesUpdateReply({ fullCart: enrichCartNameNumberPrices(nextCartEA, settings), settings });
        await sendMessengerText({ pageAccessToken, psid: params.psid, text: replyEA, within24hWindow: within24h });
        await logAssistantTurn(conversationId, replyEA);
        return;
      }
      // Not yet in cart — add with addon
      const productNameEA = (lastRow.facebookLabel ?? String(metaEA["name"] ?? lastRow.clientSku)).trim();
      const unitPriceEA = parsePriceNumber(metaEA["price"] ?? metaEA["unitPrice"] ?? metaEA["unit_price"]) ?? undefined;
      const nextCartEA2 = upsertCartItem(earlyCartForAddon, {
        sku: lastRow.clientSku,
        product: productNameEA,
        quantity: 1,
        size: undefined,
        unitPriceBdt: unitPriceEA,
        addOns: selectedEA,
      });
      await setDraftCartItems(conversationId, nextCartEA2);
      await setLastCatalogSku(conversationId, lastRow.clientSku);
      if (selectedEA.some((a) => looksLikeNameNumberAddOn(a))) {
        await setPendingNameNumberSku(conversationId, lastRow.clientSku);
        const ask = "Name + Number add hobe. Jersey te ki Name ar Number print korben? (e.g. Messi 10)";
        await sendMessengerText({ pageAccessToken, psid: params.psid, text: ask, within24hWindow: within24h });
        await logAssistantTurn(conversationId, ask);
        return;
      }
      const flag = pickTeamEmoji(productNameEA, undefined, tenant.businessCategory);
      const askSzEA = `${flag} ${productNameEA} + ${selectedEA.map((a) => a.label).join(", ")} add korlam 😊\n\nEkhon size bolen pls — M / L / XL?`;
      await sendMessengerText({ pageAccessToken, psid: params.psid, text: askSzEA, within24hWindow: within24h });
      await logAssistantTurn(conversationId, askSzEA);
      return;
    }
  }

  const rawExtracted = await extractOrderFromTextAndImages(trimmed || undefined, imagesB64);

  // Backfill missing fields from conversation memory (last product the customer
  // was discussing + previously-supplied name/phone/address). This is what
  // makes follow-up turns like "Size XL\nLimon\nCumilla\n0186…" actually
  // proceed to the order pipeline instead of looping back to "tell me size,
  // name, address, phone".
  const structured = mergeStructuredOrderWithContext({
    extracted: rawExtracted,
    lastProductLabel: lastRow?.facebookLabel ?? null,
    pendingDraftJson: convo.pendingDraftJson,
  });

  const hasOrderConfirmationVerb = /(?:^|\b)(confirm|order now|book now|place order|final|done|checkout)(?:\b|$)/i.test(
    trimmed,
  );
  const orderDecision = await decideOrderCreate({
    catalogIntent,
    isClarificationQuestion: isOrderClarificationQuestion(trimmed),
    looksLikeDetailsSupply: looksLikeOrderDetailsSupply(trimmed),
    hasOrderConfirmationVerb,
    hasStructured: Boolean(structured),
    validationOk: Boolean(structured && validateOrderForClientSync(structured).ok),
  });
  const canAutoCreateOrder = orderDecision === "create_order";

  if (structured && validateOrderForClientSync(structured).ok && canAutoCreateOrder) {
    await persistCustomerProfile({
      conversationId,
      pendingDraftJson: convo.pendingDraftJson,
      structured,
    });
    await runOrderPipelineAfterValidation({
      tenant: tenant as TenantForOrder,
      tenantId: params.tenantId,
      conversationId,
      psid: params.psid,
      structured,
      customerSummary,
      within24h,
      persona,
      settings,
    });
    await setDraftCartItems(conversationId, []);
    return;
  }

  if (structured && !validateOrderForClientSync(structured).ok && looksLikeOrderDetailsSupply(trimmed)) {
    await persistCustomerProfile({
      conversationId,
      pendingDraftJson: convo.pendingDraftJson,
      structured,
    });
    const cartNow = enrichCartNameNumberPrices(getCartItemsFromDraft(convo.pendingDraftJson), settings);
    if (cartNow.length > 0) {
      const itemsMissingSize = cartNow.filter((it) => !String(it.size ?? "").trim());
      if (itemsMissingSize.length > 0) {
        const askLines = itemsMissingSize.map((it) => {
          const flag = pickTeamEmoji(it.product, undefined, tenant.businessCategory);
          return `${flag} ${it.product} — kon size? (M / L / XL)`;
        });
        const sizeAsk = ["Size confirm korun 😊", "", ...askLines].join("\n");
        await sendMessengerText({ pageAccessToken, psid: params.psid, text: sizeAsk, within24hWindow: within24h });
        await logAssistantTurn(conversationId, sizeAsk);
        return;
      }
      const validation = validateOrderForClientSync(structured);
      if (!validation.ok && validation.reason === "size_required") {
        const sizeAsk = "Size ta bolun — M / L / XL?";
        await sendMessengerText({ pageAccessToken, psid: params.psid, text: sizeAsk, within24hWindow: within24h });
        await logAssistantTurn(conversationId, sizeAsk);
        return;
      }
      const advBdt = typeof settings.advancePaymentBdt === "number" ? settings.advancePaymentBdt : 0;
      const deliveryBdt = typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
      const manual = settings.manualPayment;
      const bkashNum = manual?.enabled ? manual.bkash?.number?.trim() : undefined;
      const nagadNum = manual?.enabled ? manual.nagad?.number?.trim() : undefined;
      const payLines: string[] = [];
      payLines.push("✅ Order Ready");
      payLines.push("");
      if (advBdt > 0) payLines.push(`💵 Advance Payment: ${advBdt} BDT`);
      if (deliveryBdt > 0) payLines.push(`🚚 Delivery Charge: ${deliveryBdt} BDT`);
      if (advBdt > 0 || deliveryBdt > 0) payLines.push("");
      if (bkashNum || nagadNum) {
        payLines.push("━━━━━━━━━━");
        payLines.push("");
        payLines.push("📲 Manual Payment");
        payLines.push("");
        if (bkashNum) {
          payLines.push("🟣 bKash:");
          payLines.push(`Send Money → ${bkashNum}`);
          payLines.push("");
        }
        if (nagadNum) {
          payLines.push("🔵 Nagad:");
          payLines.push(`Send Money → ${nagadNum}`);
          payLines.push("");
        }
        payLines.push("💬 After payment, reply with:");
        if (bkashNum) payLines.push("bkash <TrxID>");
        if (bkashNum && nagadNum) payLines.push("or");
        if (nagadNum) payLines.push("nagad <TrxID>");
        payLines.push("");
        payLines.push("📷 Kindly send Transaction ID or Screenshot after payment.");
      } else {
        payLines.push('"order confirm" likhun — order place hoye jabe ✔️');
      }
      const paymentMsg = payLines.join("\n");
      await sendMessengerText({ pageAccessToken, psid: params.psid, text: paymentMsg, within24hWindow: within24h });
      await logAssistantTurn(conversationId, paymentMsg);
      return;
    }
  }

  if (
    mappings.length > 0 &&
    (hasIncomingImages ||
      isLikelyProductQuery(trimmed) ||
      isAssetOnlyFollowup ||
      (catalogIntent !== "general" && hasLastCatalogContext))
  ) {
    const optionSkus = draftOptionSkus;
    const pickedOptionIndex = pickedDraftOptionIndex;
    const phrasePickedRow =
      !hasIncomingImages && optionSkus.length >= 2 && pickedOptionIndex == null && trimmed
        ? pickRowFromListedCatalogOptions(trimmed, optionSkus, mappings)
        : null;
    const selectedFromOptions =
      pickedOptionIndex != null
        ? mappings.find((m) => m.clientSku === optionSkus[pickedOptionIndex]) ?? null
        : phrasePickedRow;
    if (selectedFromOptions) {
      await setLastCatalogSku(conversationId, selectedFromOptions.clientSku);
    }

    if (
      hasIncomingImages &&
      imagesB64.length >= 2 &&
      !selectedFromOptions &&
      !looksLikeOrderDetailsSupply(trimmed)
    ) {
      const catalogLinesMulti = buildCatalogLinesForLlm(mappings);
      const validSkusMulti = new Set(mappings.map((m) => m.clientSku));
      const perPhotoMatches = await resolveCatalogMatchesPerCustomerPhoto({
        imagesB64,
        imageUrls: imageUrlList,
        mappings,
        catalogLines: catalogLinesMulti,
        validSkus: validSkusMulti,
        caption: trimmed || undefined,
      });
      if (perPhotoMatches.length > 0) {
        await sendMultiPhotoCatalogMatchReply({
          matches: perPhotoMatches,
          settings,
          pageAccessToken,
          psid: params.psid,
          within24hWindow: within24h,
          conversationId,
          tenantSlug: params.tenantSlug,
          businessCategory: tenant.businessCategory,
        });
        return;
      }
    }

    const cartEmpty = getCartItemsFromDraft(convo.pendingDraftJson).length === 0;
    if (
      !hasIncomingImages &&
      isTooGenericJerseyQuery(trimmed, draftOptionSkus.length >= 2) &&
      (!hasLastCatalogContext || cartEmpty) &&
      !isAddonOnlyRequest(trimmed)
    ) {
      const broad = findBroadJerseyCandidates(mappings, MAX_CATALOG_OPTION_LIST);
      if (broad.length > 0) {
        const options = broad.map(buildCatalogOptionItem);
        const listReply = buildCatalogOptionsReply(options, { businessCategory: tenant.businessCategory });
        if (await hasRepeatedCollectionList(conversationId, listReply)) {
          const short = "Already collection dekhiyechi 😊 Kon team er jersey lagbe bolun, or uporer list theke product name + size din.";
          await sendMessengerText({ pageAccessToken, psid: params.psid, text: short, within24hWindow: within24h });
          await logAssistantTurn(conversationId, short);
          return;
        }
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: listReply,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, listReply);
        const imgResult = await sendCatalogFirstImagePreviews({
          rows: broad,
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          within24hWindow: within24h,
          tenantSlug: params.tenantSlug,
          conversationId,
        });
        if (imgResult.failedImageUrls.length > 0) {
          const fallbackText =
            "Kichu photo direct pathate pari nai, image link dilam:\n" +
            imgResult.failedImageUrls.map((u, i) => `${i + 1}. ${u}`).join("\n");
          await sendMessengerText({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            text: fallbackText,
            within24hWindow: within24h,
          }).catch((e) => logger.warn({ e: String(e) }, "Catalog option image URL fallback send failed"));
          await logAssistantTurn(conversationId, fallbackText);
        }
        await setCatalogOptionSkus(
          conversationId,
          broad.map((m) => m.clientSku),
        );
        await saveSentImageMidToSku(conversationId, imgResult.sentImageMidToSku);
        return;
      }
      const clarify = "Kon jersey lagbe bolen? (example: Argentina home, Argentina away, Brazil player version).";
      await sendMessengerText({
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        text: clarify,
        within24hWindow: within24h,
      });
      await logAssistantTurn(conversationId, clarify);
      return;
    }

    const textMatchesRaw =
      !hasIncomingImages && trimmed ? findCatalogMatchesByText(mappings, trimmed, MAX_CATALOG_OPTION_LIST) : [];
    const textMatches =
      !hasIncomingImages && trimmed
        ? expandCatalogMatchesForTeamCollection(mappings, trimmed, textMatchesRaw, MAX_CATALOG_OPTION_LIST)
        : [];
    if (
      !hasIncomingImages &&
      textMatches.length >= 2 &&
      pickedOptionIndex == null &&
      !looksLikeOrderDetailsSupply(trimmed)
    ) {
      const options = textMatches.map(buildCatalogOptionItem);
      const listReply = buildCatalogOptionsReply(options, { businessCategory: tenant.businessCategory });
      if (await hasRepeatedCollectionList(conversationId, listReply)) {
        const short = "Ei collection already dekhiyechi 😊 List theke kon product ta niben bolun — product name + size dile order add kori.";
        await sendMessengerText({ pageAccessToken, psid: params.psid, text: short, within24hWindow: within24h });
        await logAssistantTurn(conversationId, short);
        return;
      }
      await sendMessengerText({
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        text: listReply,
        within24hWindow: within24h,
      });
      await logAssistantTurn(conversationId, listReply);
      const imgResult2 = await sendCatalogFirstImagePreviews({
        rows: textMatches,
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        within24hWindow: within24h,
        tenantSlug: params.tenantSlug,
        conversationId,
      });
      if (imgResult2.failedImageUrls.length > 0) {
        const fallbackText =
          "Kichu photo direct pathate pari nai, image link dilam:\n" +
          imgResult2.failedImageUrls.map((u, i) => `${i + 1}. ${u}`).join("\n");
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: fallbackText,
          within24hWindow: within24h,
        }).catch((e) => logger.warn({ e: String(e) }, "Catalog option image URL fallback send failed"));
        await logAssistantTurn(conversationId, fallbackText);
      }
      await setCatalogOptionSkus(
        conversationId,
        textMatches.map((m) => m.clientSku),
      );
      await saveSentImageMidToSku(conversationId, imgResult2.sentImageMidToSku);
      return;
    }

    const rowFromCurrentQuery =
      !hasIncomingImages && isLikelyProductQuery(trimmed) && trimmed
        ? textMatches[0] ?? findBestCatalogMatchByText(mappings, trimmed)
        : null;
    let row = selectedFromOptions ?? rowFromCurrentQuery;
    const selectedExplicitly = selectedFromOptions != null;

    if (!row && (hasIncomingImages || isLikelyProductQuery(trimmed))) {
      const catalogLines = buildCatalogLinesForLlm(mappings);
      const validSkus = new Set(mappings.map((m) => m.clientSku));
      const visionNames = jerseyVision?.primaryNames?.filter((n) => n?.trim()) ?? [];
      const useVisionCaption =
        hasIncomingImages &&
        visionNames.length > 0 &&
        jerseyVision &&
        jerseyVision.kind !== "not_jersey";
      // Domain-agnostic gate: if the customer sent ONLY images and the
      // generic image classifier said it's not a product (selfie, document,
      // random object, chat screenshot), do NOT bounce into the catalog
      // matcher — that matcher is greedy and will pick the closest SKU even
      // for irrelevant photos. We reply with a warm "send a clearer product
      // photo or type the product name" instead. Works for any catalog
      // (jerseys, shoes, electronics, sarees) without baking in
      // jersey-shaped assumptions.
      const captionHasContent = (trimmed?.trim().length ?? 0) >= 3;
      let imageContent: Awaited<ReturnType<typeof classifyImageContent>> = null;
      if (hasIncomingImages && imagesB64.length > 0 && !captionHasContent) {
        imageContent = await classifyImageContent(imagesB64, trimmed || undefined).catch((e) => {
          logger.warn({ e: String(e) }, "classifyImageContent skipped");
          return null;
        });
      }
      const nonProductPhoto =
        !!imageContent &&
        !imageContent.isProductLikely &&
        (imageContent.contentType === "person_or_selfie" ||
          imageContent.contentType === "random_object" ||
          imageContent.contentType === "document" ||
          imageContent.contentType === "chat_screenshot" ||
          imageContent.contentType === "unclear");

      if (nonProductPhoto && !captionHasContent && imageContent) {
        logger.info(
          {
            contentType: imageContent.contentType,
            confidence: imageContent.confidence,
            shortDescription: imageContent.shortDescription?.slice(0, 80),
          },
          "Single-image fallback: photo is not a product — skipping forced catalog match",
        );
        // Chat screenshots and documents may be shop-related ("amar previous
        // chat", "ei doc dekhen") — let the conversational LLM handle those
        // naturally instead of a templated rejection. Only the truly
        // off-topic categories (selfie, random object, unclear) get a short
        // definitive reply.
        const handHandledHere =
          imageContent.contentType === "person_or_selfie" ||
          imageContent.contentType === "random_object" ||
          imageContent.contentType === "unclear";
        if (handHandledHere) {
          // ONE short, definitive reply. No instructions, no lecturing,
          // and no internal vocabulary like "catalog" — the customer just
          // needs to know the item isn't available.
          const friendly = "Eta amader kache nei 🙂 Apni ki khujchen?";
          await sendMessengerText({
            pageAccessToken,
            psid: params.psid,
            text: friendly,
            within24hWindow: within24h,
          });
          await logAssistantTurn(conversationId, friendly);
          return;
        }
        // For chat_screenshot / document we DON'T short-circuit — fall
        // through to the LLM, which can read the visible text and respond
        // contextually (e.g. acknowledging a previous order screenshot or
        // answering a question shown in a chat clip).
      } else {
        // ── Photo-first matching: run the deterministic perceptual-hash
        //    sweep BEFORE the LLM-based catalog text matcher. The LLM
        //    matcher pattern-matches on jersey vision text + catalog
        //    text, which silently picks the most popular team row even
        //    when the customer's actual photographed product is a
        //    lower-stock special edition. The hash sweep, by contrast,
        //    compares the exact pixels of the customer photo against
        //    every cached photo in the catalog — so a "Brazil WC26
        //    Special Edition" sitting at row #11 by stock rank still
        //    wins as long as one of its cached photos hashes near the
        //    customer image.
        let photoMatched: ProductMapping | null = null;
        if (hasIncomingImages && imagesB64[0]) {
          photoMatched = await pickCandidateByCustomerImage({
            customerImageBase64: imagesB64[0],
            customerImageUrl: imageUrlList[0] ?? null,
            tenantId: params.tenantId,
            // Pass the team-narrowed list ONLY for the URL/Cloudinary
            // shortcut (it's cheap to walk). The hash sweep itself
            // ignores this and runs against the full tenant catalog.
            candidates:
              jerseyVision && jerseyVision.kind !== "not_jersey" && (jerseyVision.primaryNames?.length ?? 0) > 0
                ? findCatalogByJerseyEntities(mappings, jerseyVision.primaryNames, MAX_CATALOG_OPTION_LIST)
                : [],
            validSkus,
          }).catch((e) => {
            logger.warn({ e: String(e) }, "Photo-first hash sweep failed");
            return null;
          });
          if (photoMatched) {
            logger.info(
              { event: "photo_first_match_won", sku: photoMatched.clientSku },
              "photo-first match overrode the LLM catalog matcher",
            );
            row = photoMatched;
          }
        }

        if (!row) {
          const catalogMatchCaption = useVisionCaption
            ? [trimmed, `Jersey in photo (identified): ${visionNames.join(", ")}`].filter(Boolean).join(" | ")
            : trimmed || undefined;
          const matchedSku = await matchClientSkuFromCatalog({
            catalogLines,
            text: catalogMatchCaption,
            imagesBase64: imagesB64,
            validSkus,
          });
          row =
            (matchedSku ? mappings.find((m) => m.clientSku === matchedSku) : undefined) ??
            (matchedSku
              ? await prisma.productMapping.findFirst({
                  where: { tenantId: params.tenantId, clientSku: matchedSku },
                })
              : null);
        }
      }
    }

    // Photo: no single SKU match but vision named a team → offer filtered catalog choices
    if (
      !row &&
      hasIncomingImages &&
      imagesB64.length > 0 &&
      jerseyVision &&
      jerseyVision.kind !== "not_jersey" &&
      (jerseyVision.primaryNames?.length ?? 0) > 0
    ) {
      const candidates = findCatalogByJerseyEntities(mappings, jerseyVision.primaryNames, MAX_CATALOG_OPTION_LIST);
      const label = jerseyVision.primaryNames.slice(0, 3).join(" / ");
      if (candidates.length >= 2 && imagesB64[0]) {
        const visuallyPicked = await pickCandidateByCustomerImage({
          customerImageBase64: imagesB64[0],
          customerImageUrl: imageUrlList[0] ?? null,
          tenantId: params.tenantId,
          candidates,
          validSkus: new Set(mappings.map((m) => m.clientSku)),
        }).catch((e) => {
          logger.warn({ e: String(e) }, "visual catalog comparison failed");
          return null;
        });
        if (visuallyPicked) {
          row = visuallyPicked;
          await setLastCatalogSku(conversationId, row.clientSku);
        }
      }
      if (!row && candidates.length >= 2) {
        const options = candidates.map(buildCatalogOptionItem);
        const listReply = buildCatalogOptionsReply(options, { businessCategory: tenant.businessCategory });
        if (await hasRepeatedCollectionList(conversationId, listReply)) {
          const short = "Ei collection already dekhiyechi 😊 List theke kon product ta niben bolun — product name + size dile order add kori.";
          await sendMessengerText({ pageAccessToken, psid: params.psid, text: short, within24hWindow: within24h });
          await logAssistantTurn(conversationId, short);
          return;
        }
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: listReply,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, listReply);
        const imgResult3 = await sendCatalogFirstImagePreviews({
          rows: candidates,
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          within24hWindow: within24h,
          tenantSlug: params.tenantSlug,
          conversationId,
        });
        if (imgResult3.failedImageUrls.length > 0) {
          const fallbackText =
            "Kichu photo direct pathate pari nai, image link dilam:\n" +
            imgResult3.failedImageUrls.map((u, i) => `${i + 1}. ${u}`).join("\n");
          await sendMessengerText({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            text: fallbackText,
            within24hWindow: within24h,
          }).catch((e) => logger.warn({ e: String(e) }, "Catalog option image URL fallback send failed"));
          await logAssistantTurn(conversationId, fallbackText);
        }
        await setCatalogOptionSkus(
          conversationId,
          candidates.map((m) => m.clientSku),
        );
        await saveSentImageMidToSku(conversationId, imgResult3.sentImageMidToSku);
        return;
      }
      if (candidates.length === 1) {
        row = candidates[0]!;
        await setLastCatalogSku(conversationId, row.clientSku);
      }
      if (candidates.length === 0) {
        const sorry = [
          `Chobir theke "${label}" team/club jersey mone hocche.`,
          "Kintu apnar catalog e ei team/club er kono product match korte parlam na — dashboard e product name/category te team naam add korle search better hobe.",
          "Chaile type kore product naam bolen (example: Spain home player version).",
        ].join("\n");
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: sorry,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, sorry);
        return;
      }
    }

    // Final fallback: any ask_* intent inherits the last catalog row in the
    // conversation so "size chart den" / "L order korte chai" stick to the
    // product the customer was just discussing.
    // Skip fallback when the user clearly wants to REMOVE an item — inheriting
    // lastRow would target the wrong product.
    const preRowCartIntent = detectCartIntent(trimmed);
    if (!row && catalogIntent !== "general" && lastRow && preRowCartIntent !== "remove") {
      row = lastRow;
    }

    if (!row) {
      const cartIntent = detectCartIntent(trimmed);
      if (cartIntent === "show") {
        const currentCart = getCartItemsFromDraft(convo.pendingDraftJson);
        const reply = buildCartSummaryText(currentCart, settings);
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: reply,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, reply);
        return;
      }
      if (cartIntent === "clear") {
        await setDraftCartItems(conversationId, []);
        const reply = "Thik ache 🙂 Apnar list ta fresh kore dilam. Kon jersey lagben bolun.";
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: reply,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, reply);
        return;
      }
      if (cartIntent === "remove") {
        const currentCart = getCartItemsFromDraft(convo.pendingDraftJson);
        if (currentCart.length > 0) {
          const matchedIdx = findCartItemByTextMention(trimmed, currentCart);
          if (matchedIdx >= 0) {
            const removed = currentCart[matchedIdx]!;
            const nextCart = currentCart.filter((_, i) => i !== matchedIdx);
            await setDraftCartItems(conversationId, nextCart);
            const ack = nextCart.length > 0
              ? `✅ ${removed.product} remove kore dilam.\n\n${buildBanglishCartLinesUpdateReply({ fullCart: enrichCartNameNumberPrices(nextCart, settings), settings })}`
              : `✅ ${removed.product} remove kore dilam. List e ar kono jersey nai 🙂 Kon jersey lagben bolun.`;
            await sendMessengerText({ pageAccessToken, psid: params.psid, text: ack, within24hWindow: within24h });
            await logAssistantTurn(conversationId, ack);
            return;
          }
          const askWhich = "Kon jersey ta remove korte chan? Product er naam bolun 🙂";
          await sendMessengerText({ pageAccessToken, psid: params.psid, text: askWhich, within24hWindow: within24h });
          await logAssistantTurn(conversationId, askWhich);
          return;
        }
      }
    }

    if (row) {
      if (selectedExplicitly) {
        const selectionAck = buildDeterministicCatalogReply(row, { addOns: settings.addOns,
          includeCta: false, businessCategory: tenant.businessCategory });
        await sendMessengerText({
          pageAccessToken: pageAccessToken,
          psid: params.psid,
          text: selectionAck,
          within24hWindow: within24h,
        });
        await logAssistantTurn(conversationId, selectionAck);
        return;
      }
      const assets = extractCatalogAssets(row);
      const addonSnippet = buildTenantAddonSnippet(settings.addOns);
      const cartIntent = detectCartIntent(trimmed);
      if (cartIntent && cartIntent !== "checkout") {
        const meta =
          row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : {};
        const productName = (row.facebookLabel ?? String(meta["name"] ?? row.clientSku)).trim();
        const unitPrice = parsePriceNumber(meta["price"] ?? meta["unitPrice"] ?? meta["unit_price"]) ?? undefined;
        const availableAddOns = resolveProductAddOnCatalog({ settings, meta });
        const selectedAddOns =
          patchNameNumberAddonPrices(selectAddOnsFromText(trimmed, availableAddOns), settings) ??
          selectAddOnsFromText(trimmed, availableAddOns);
        const addonRequest = looksLikeAddonRequest(trimmed);
        const qty = parseRequestedQuantity(trimmed) ?? 1;
        const qtyExplicit = parseRequestedQuantity(trimmed) != null;
        const size = parseRequestedSize(trimmed) ?? undefined;
        const currentCart = getCartItemsFromDraft(convo.pendingDraftJson);
        let nextCart = currentCart;
        if (cartIntent === "add") {
          if (looksLikeSizeRequirementQuestion(trimmed)) {
            const metaSz =
              row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
                ? (row.metadata as Record<string, unknown>)
                : {};
            const productNameSz = (row.facebookLabel ?? String(metaSz["name"] ?? row.clientSku)).trim();
            const replySz =
              `${productNameSz}: Haan — order complete korar jonno size must. Kon size din (e.g. L, XL)? Size + qty dile ami order line e add kore dibo.`;
            await sendMessengerText({
              pageAccessToken: pageAccessToken,
              psid: params.psid,
              text: replySz,
              within24hWindow: within24h,
            });
            await logAssistantTurn(conversationId, replySz);
            return;
          }
          if (isBrowseOnlyProductInterest(trimmed)) {
            await setLastCatalogSku(conversationId, row.clientSku);
            const productLabel = (row.facebookLabel ?? row.clientSku).trim();
            if (await hasRepeatedProductCard(conversationId, productLabel)) {
              const short = `${productLabel} er details already dekhiyechi 😊 Size ar qty dile add kore dibo, or onno jersey name bolun.`;
              await sendMessengerText({ pageAccessToken, psid: params.psid, text: short, within24hWindow: within24h });
              await logAssistantTurn(conversationId, short);
              return;
            }
            const browseReply = buildBrowseFirstCatalogReply(row, settings, addonSnippet, tenant.businessCategory);
            await sendMessengerText({
              pageAccessToken: pageAccessToken,
              psid: params.psid,
              text: browseReply,
              within24hWindow: within24h,
            });
            await logAssistantTurn(conversationId, browseReply);
            return;
          }
          if (addonRequest && selectedAddOns.length === 0) {
            const hint =
              availableAddOns.length > 0
                ? `Ei product e available add-ons: ${availableAddOns
                    .map((a) => `${a.label}${a.priceBdt ? ` (+${a.priceBdt} BDT)` : ""}`)
                    .join(", ")}.`
                : "Ei product e extra add-on configure kora nai.";
            const reply = `${hint}\nJeta niben seta likhen (example: Official Font / Patches / Name + Number).`;
            await sendMessengerText({
              pageAccessToken: pageAccessToken,
              psid: params.psid,
              text: reply,
              within24hWindow: within24h,
            });
            await logAssistantTurn(conversationId, reply);
            return;
          }
          // Addon-only intent MUST be checked BEFORE the generic "ask for size" block,
          // otherwise "Official font nibo" or "Name number nibo" would always ask size
          // and never actually process the addon.
          const addonOnlyIntent =
            addonRequest &&
            selectedAddOns.length > 0 &&
            !qtyExplicit &&
            !size;
          // When NOT an addon request and no size given, ask for size before adding.
          if (!addonOnlyIntent && !size) {
            const flag = pickTeamEmoji(productName, undefined, tenant.businessCategory);
            const askSize = [
              "Sure 😊",
              "",
              `${flag} ${productName}`,
              "",
              "Prothome size ta bolen pls — M / L / XL jeta nite chan 🙏",
              "",
              "Size ar qty dile ei jersey ta apnar order list e add kore dibo.",
            ].join("\n\n");
            await sendMessengerText({
              pageAccessToken: pageAccessToken,
              psid: params.psid,
              text: askSize,
              within24hWindow: within24h,
            });
            await logAssistantTurn(conversationId, askSize);
            return;
          }
          if (addonOnlyIntent) {
            const existingIdx = currentCart.findIndex(
              (x) =>
                x.sku === row.clientSku &&
                String(x.size ?? "").toLowerCase() === String(size ?? x.size ?? "").toLowerCase(),
            );
            if (existingIdx >= 0) {
              const existing = currentCart[existingIdx]!;
              if (!String(existing.size ?? "").trim()) {
                const flag = pickTeamEmoji(productName, undefined, tenant.businessCategory);
                const askSz = [
                  "Age oi jersey er size ta fix korte hobe 😊",
                  "",
                  `${flag} ${existing.product}`,
                  "",
                  "Kon size? (M / L / XL likhun)",
                ].join("\n\n");
                await sendMessengerText({
                  pageAccessToken: pageAccessToken,
                  psid: params.psid,
                  text: askSz,
                  within24hWindow: within24h,
                });
                await logAssistantTurn(conversationId, askSz);
                return;
              }
              const mergedAddOns = [
                ...(existing.addOns ?? []),
                ...selectedAddOns.filter(
                  (a) =>
                    !(existing.addOns ?? []).some((e) => canonicalAddonDedupeKey(e) === canonicalAddonDedupeKey(a)),
                ),
              ];
              nextCart = [...currentCart];
              nextCart[existingIdx] = { ...existing, addOns: mergedAddOns };
              await setDraftCartItems(conversationId, nextCart);
              await setLastCatalogSku(conversationId, row.clientSku);
              const needsNameNumberValue = mergedAddOns.some((a) => looksLikeNameNumberAddOn(a));
              if (needsNameNumberValue) {
                const nnValue = extractNameNumberValue(trimmed);
                if (!nnValue) {
                  await setPendingNameNumberSku(conversationId, row.clientSku);
                  const ask = "Name + Number add hobe. Jersey te ki Name ar Number print korben? (e.g. Messi 10)";
                  await sendMessengerText({
                    pageAccessToken: pageAccessToken,
                    psid: params.psid,
                    text: ask,
                    within24hWindow: within24h,
                  });
                  await logAssistantTurn(conversationId, ask);
                  return;
                }
                const nnP = getNameNumberPriceBdtFromSettings(settings);
                nextCart[existingIdx] = {
                  ...nextCart[existingIdx]!,
                  addOns: mergedAddOns.map((a) =>
                    looksLikeNameNumberAddOn(a)
                      ? {
                          ...a,
                          id: "name-number",
                          value: nnValue,
                          priceBdt: a.priceBdt && a.priceBdt > 0 ? a.priceBdt : nnP,
                        }
                      : a,
                  ),
                };
                await setDraftCartItems(conversationId, nextCart);
                await setPendingNameNumberSku(conversationId, null);
              }
              const enrichedAdd = enrichCartNameNumberPrices(nextCart, settings);
              const reply = buildBanglishCartLinesUpdateReply({ fullCart: enrichedAdd, settings });
              await sendMessengerText({
                pageAccessToken: pageAccessToken,
                psid: params.psid,
                text: reply,
                within24hWindow: within24h,
              });
              await logAssistantTurn(conversationId, reply);
              return;
            }
          }
          nextCart = upsertCartItem(currentCart, {
            sku: row.clientSku,
            product: productName,
            quantity: qty,
            size,
            unitPriceBdt: unitPrice,
            addOns: selectedAddOns,
          });
          await setDraftCartItems(conversationId, nextCart);
          await setLastCatalogSku(conversationId, row.clientSku);
          if (selectedAddOns.some((a) => looksLikeNameNumberAddOn(a))) {
            const nnValue = extractNameNumberValue(trimmed);
            if (!nnValue) {
              await setPendingNameNumberSku(conversationId, row.clientSku);
              const ask = "Name + Number add hobe. Jersey te ki Name ar Number print korben? (e.g. Messi 10)";
              await sendMessengerText({
                pageAccessToken: pageAccessToken,
                psid: params.psid,
                text: ask,
                within24hWindow: within24h,
              });
              await logAssistantTurn(conversationId, ask);
              return;
            }
            const nnP2 = getNameNumberPriceBdtFromSettings(settings);
            const updated = getCartItemsFromDraft((await prisma.messengerConversation.findUnique({
              where: { id: conversationId },
              select: { pendingDraftJson: true },
            }))?.pendingDraftJson).map((it) =>
              it.sku === row.clientSku
                ? {
                    ...it,
                    addOns: (it.addOns ?? []).map((a) =>
                      looksLikeNameNumberAddOn(a)
                        ? {
                            ...a,
                            id: "name-number",
                            value: nnValue,
                            priceBdt: a.priceBdt && a.priceBdt > 0 ? a.priceBdt : nnP2,
                          }
                        : a,
                    ),
                  }
                : it,
            );
            await setDraftCartItems(conversationId, updated);
            await setPendingNameNumberSku(conversationId, null);
            nextCart = updated;
          }
          const enrichedFinal = enrichCartNameNumberPrices(nextCart, settings);
          const featuredLine =
            enrichedFinal.find(
              (x) =>
                x.sku === row.clientSku &&
                String(x.size ?? "").toLowerCase() === String((size ?? "") as string).toLowerCase(),
            ) ?? enrichedFinal[enrichedFinal.length - 1]!;
          const reply = buildBanglishProductAddedReply({
            featured: featuredLine,
            fullCart: enrichedFinal,
            settings,
          });
          await sendMessengerText({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            text: reply,
            within24hWindow: within24h,
          });
          await logAssistantTurn(conversationId, reply);
          return;
        }
        if (cartIntent === "remove") {
          nextCart = currentCart.filter(
            (x) =>
              !(
                x.sku === row.clientSku &&
                (!size || String(x.size ?? "").toLowerCase() === String(size ?? "").toLowerCase())
              ),
          );
          await setDraftCartItems(conversationId, nextCart);
          const replyRm = buildBanglishCartLinesUpdateReply({
            fullCart: enrichCartNameNumberPrices(nextCart, settings),
            settings,
          });
          await sendMessengerText({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            text: replyRm,
            within24hWindow: within24h,
          });
          await logAssistantTurn(conversationId, replyRm);
          return;
        }
        if (cartIntent === "set_qty") {
          if (qty <= 0) {
            const reply = "Qty zero hoite parbe na. 1 ba tar beshi qty din.";
            await sendMessengerText({
              pageAccessToken: pageAccessToken,
              psid: params.psid,
              text: reply,
              within24hWindow: within24h,
            });
            await logAssistantTurn(conversationId, reply);
            return;
          }
          nextCart = currentCart.map((x) =>
            x.sku === row.clientSku &&
            (!size || String(x.size ?? "").toLowerCase() === String(size ?? "").toLowerCase())
              ? { ...x, quantity: qty, ...(size ? { size } : {}) }
              : x,
          );
          await setDraftCartItems(conversationId, nextCart);
          const replyQty = buildBanglishCartLinesUpdateReply({
            fullCart: enrichCartNameNumberPrices(nextCart, settings),
            settings,
          });
          await sendMessengerText({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            text: replyQty,
            within24hWindow: within24h,
          });
          await logAssistantTurn(conversationId, replyQty);
          return;
        }
        if (cartIntent === "show") {
          const reply = buildCartSummaryText(currentCart, settings);
          await sendMessengerText({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            text: reply,
            within24hWindow: within24h,
          });
          await logAssistantTurn(conversationId, reply);
          return;
        }
      }
      // Addon / name-number request without explicit cart keyword ("hobe na?", "available?")
      // — handle as addon intent so we don't just re-show the product card.
      if (looksLikeAddonRequest(trimmed)) {
        const metaAd =
          row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : {};
        const availableAd = resolveProductAddOnCatalog({ settings, meta: metaAd });
        const selectedAd =
          patchNameNumberAddonPrices(selectAddOnsFromText(trimmed, availableAd), settings) ??
          selectAddOnsFromText(trimmed, availableAd);
        if (selectedAd.length > 0) {
          const currentCartAd = getCartItemsFromDraft(convo.pendingDraftJson);
          const existingAd = currentCartAd.findIndex((x) => x.sku === row.clientSku);
          if (existingAd >= 0) {
            const existItem = currentCartAd[existingAd]!;
            const mergedAd = [
              ...(existItem.addOns ?? []),
              ...selectedAd.filter(
                (a) => !(existItem.addOns ?? []).some((e) => canonicalAddonDedupeKey(e) === canonicalAddonDedupeKey(a)),
              ),
            ];
            const nextCartAd = [...currentCartAd];
            nextCartAd[existingAd] = { ...existItem, addOns: mergedAd };
            await setDraftCartItems(conversationId, nextCartAd);
            await setLastCatalogSku(conversationId, row.clientSku);
            const needsNnVal = mergedAd.some((a) => looksLikeNameNumberAddOn(a) && !String((a as Record<string, unknown>).value ?? "").trim());
            if (needsNnVal) {
              await setPendingNameNumberSku(conversationId, row.clientSku);
              const ask = "Name + Number add hobe. Jersey te ki Name ar Number print korben? (e.g. Messi 10)";
              await sendMessengerText({ pageAccessToken, psid: params.psid, text: ask, within24hWindow: within24h });
              await logAssistantTurn(conversationId, ask);
              return;
            }
            const enrichedAd = enrichCartNameNumberPrices(nextCartAd, settings);
            const replyAd = buildBanglishCartLinesUpdateReply({ fullCart: enrichedAd, settings });
            await sendMessengerText({ pageAccessToken, psid: params.psid, text: replyAd, within24hWindow: within24h });
            await logAssistantTurn(conversationId, replyAd);
            return;
          }
          // Product not yet in cart: add it with addon, ask for size
          const productNameAd = (row.facebookLabel ?? String(metaAd["name"] ?? row.clientSku)).trim();
          const unitPriceAd = parsePriceNumber(metaAd["price"] ?? metaAd["unitPrice"] ?? metaAd["unit_price"]) ?? undefined;
          const nextCartAd2 = upsertCartItem(currentCartAd, {
            sku: row.clientSku,
            product: productNameAd,
            quantity: 1,
            size: undefined,
            unitPriceBdt: unitPriceAd,
            addOns: selectedAd,
          });
          await setDraftCartItems(conversationId, nextCartAd2);
          await setLastCatalogSku(conversationId, row.clientSku);
          if (selectedAd.some((a) => looksLikeNameNumberAddOn(a))) {
            await setPendingNameNumberSku(conversationId, row.clientSku);
            const ask = "Name + Number add hobe. Jersey te ki Name ar Number print korben? (e.g. Messi 10)";
            await sendMessengerText({ pageAccessToken, psid: params.psid, text: ask, within24hWindow: within24h });
            await logAssistantTurn(conversationId, ask);
            return;
          }
          const flag = pickTeamEmoji(productNameAd, undefined, tenant.businessCategory);
          const askSz = `${flag} ${productNameAd} + ${selectedAd.map((a) => a.label).join(", ")} add korlam 😊\n\nEkhon size bolen pls — M / L / XL?`;
          await sendMessengerText({ pageAccessToken, psid: params.psid, text: askSz, within24hWindow: within24h });
          await logAssistantTurn(conversationId, askSz);
          return;
        }
        if (availableAd.length > 0) {
          const hint = `Ei product e available add-ons: ${availableAd.map((a) => `${a.label}${a.priceBdt === 0 ? " (FREE)" : a.priceBdt ? ` (+${a.priceBdt} BDT)` : ""}`).join(", ")}.`;
          const replyHint = `${hint}\nJeta niben seta likhen (example: Official Font / Patches / Name + Number).`;
          await sendMessengerText({ pageAccessToken, psid: params.psid, text: replyHint, within24hWindow: within24h });
          await logAssistantTurn(conversationId, replyHint);
          return;
        }
      }

      const rowLabel = (row.facebookLabel ?? row.clientSku).trim();
      const isRepeat = await hasRepeatedProductCard(conversationId, rowLabel);
      let deterministicReply = isRepeat
        ? `${rowLabel} er details already dekhiyechi 😊 Size ar qty dile add kore dibo, or onno jersey name bolun.`
        : buildDeterministicCatalogReply(row, { addOns: settings.addOns, businessCategory: tenant.businessCategory });
      if (!isRepeat && catalogIntent === "ask_size_chart")
        deterministicReply = buildSizeChartReply(
          row,
          trimmed,
          settings.sizeCharts,
          tenant.businessCategory,
        );
      else if (!isRepeat && catalogIntent === "ask_price_stock") {
        deterministicReply = buildPriceStockReply(row, { addOns: settings.addOns });
      }
      else if (catalogIntent === "ask_checkout_policy") {
        const charges = buildCheckoutChargesBlock(settings);
        deterministicReply =
          charges ||
          "Advance / delivery charge settings deya nai. Dashboard e set korle exact amount auto-reply dibo.";
      } else if (catalogIntent === "ask_photo")
        deterministicReply =
          assets.imageUrls.length > 0
            ? "Chobi ditesi, ektu wait korun."
            : "Ei product er chobi ekhono catalog e add kora nai. Chaile ami image link add hole auto pathabo.";
      else if (asksForOrder) {
        const cartNow = enrichCartNameNumberPrices(getCartItemsFromDraft(convo.pendingDraftJson), settings);
        if (cartNow.length > 0) {
          const itemsMissingSize = cartNow.filter((it) => !String(it.size ?? "").trim());
          if (itemsMissingSize.length > 0) {
            const askLines = itemsMissingSize.map((it) => {
              const flag = pickTeamEmoji(it.product, undefined, tenant.businessCategory);
              return `${flag} ${it.product} — kon size? (M / L / XL)`;
            });
            deterministicReply = [
              "Size confirm korun 😊",
              "",
              ...askLines,
            ].join("\n");
          } else {
            const draftObj = parseDraftObject(convo.pendingDraftJson).customerProfile;
            const custProf =
              draftObj && typeof draftObj === "object" && !Array.isArray(draftObj)
                ? (draftObj as Record<string, unknown>)
                : {};
            const cn = String(custProf["name"] ?? "").trim();
            const cp = String(custProf["phone"] ?? "").trim();
            const ca = String(custProf["address"] ?? "").trim();
            if (!cn || !ca || !cp) {
              const miss: string[] = [];
              if (!cn) miss.push("👤 Name");
              if (!cp) miss.push("📱 Mobile");
              if (!ca) miss.push("🚚 Courier Address");
              deterministicReply = [
                "Order confirm korar jonno nicher details din:",
                "",
                ...miss,
                "",
                "✔️ Order confirm hoye jabe",
              ].join("\n");
            } else {
              const advBdt = typeof settings.advancePaymentBdt === "number" ? settings.advancePaymentBdt : 0;
              const deliveryBdt = typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
              const manual = settings.manualPayment;
              const bkashNum = manual?.enabled ? manual.bkash?.number?.trim() : undefined;
              const nagadNum = manual?.enabled ? manual.nagad?.number?.trim() : undefined;
              const payLines: string[] = [];
              payLines.push("✅ Order Ready");
              payLines.push("");
              if (advBdt > 0) payLines.push(`💵 Advance Payment: ${advBdt} BDT`);
              if (deliveryBdt > 0) payLines.push(`🚚 Delivery Charge: ${deliveryBdt} BDT`);
              if (advBdt > 0 || deliveryBdt > 0) payLines.push("");
              if (bkashNum || nagadNum) {
                payLines.push("━━━━━━━━━━");
                payLines.push("");
                payLines.push("📲 Manual Payment");
                payLines.push("");
                if (bkashNum) {
                  payLines.push("🟣 bKash:");
                  payLines.push(`Send Money → ${bkashNum}`);
                  payLines.push("");
                }
                if (nagadNum) {
                  payLines.push("🔵 Nagad:");
                  payLines.push(`Send Money → ${nagadNum}`);
                  payLines.push("");
                }
                payLines.push("💬 After payment, reply with:");
                if (bkashNum) payLines.push("bkash <TrxID>");
                if (bkashNum && nagadNum) payLines.push("or");
                if (nagadNum) payLines.push("nagad <TrxID>");
                payLines.push("");
                payLines.push("📷 Kindly send Transaction ID or Screenshot after payment.");
              } else {
                payLines.push('"order confirm" likhun — order place hoye jabe ✔️');
              }
              deterministicReply = payLines.join("\n");
            }
          }
        } else {
          deterministicReply = "Kon jersey ta order korte chan bolun 😊 Product name + size dile ami order list e add kore dibo.";
        }
      }
      await sendMessengerText({
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        text: deterministicReply,
        within24hWindow: within24h,
      });
      await logAssistantTurn(conversationId, deterministicReply);
      await setLastCatalogSku(conversationId, row.clientSku);
      if (asksForPhoto && assets.imageUrls.length > 0) {
        const proxySecret = (config.catalogImageProxySecret || config.encryptionKey || "").trim();
        const pubBase = config.publicBaseUrl.replace(/\/$/, "");
        const useMessengerImageProxy =
          proxySecret.length > 0 &&
          pubBase.startsWith("https://") &&
          !pubBase.includes("localhost");

        const failedImageUrls: string[] = [];
        for (let i = 0; i < assets.imageUrls.length && i < 3; i++) {
          const u = assets.imageUrls[i]!;
          const imageUrl = useMessengerImageProxy
            ? buildCatalogMessengerImageProxyUrl({
                publicBaseUrl: pubBase,
                tenantSlug: params.tenantSlug,
                clientSku: row.clientSku,
                index: i,
                token: signCatalogImageToken(proxySecret, params.tenantSlug, row.clientSku, i),
              })
            : u;
          await sendImageAndLog({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            imageUrl,
            within24hWindow: within24h,
            conversationId,
          }).catch((e) => {
            failedImageUrls.push(u);
            logger.warn({ e: String(e) }, "Catalog image send skipped");
          });
        }
        if (failedImageUrls.length > 0) {
          const fallbackText =
            "Messenger e direct photo dite parlam na. Eikhane image link dilam:\n" +
            failedImageUrls.map((u, i) => `${i + 1}. ${u}`).join("\n");
          await sendMessengerText({
            pageAccessToken: pageAccessToken,
            psid: params.psid,
            text: fallbackText,
            within24hWindow: within24h,
          }).catch((e) => logger.warn({ e: String(e) }, "Catalog image URL fallback send failed"));
          await logAssistantTurn(conversationId, fallbackText);
        }
      }
      return;
    }
  }

  // No row matched + a clear catalog intent → deterministic clarifier (no Gemma,
  // no persona examples). Prevents fabricating prices / size charts.
  if (catalogIntent !== "general") {
    const fixed = buildNoContextCatalogReply(catalogIntent, settings);
    if (fixed) {
      await sendMessengerText({
        pageAccessToken: pageAccessToken,
        psid: params.psid,
        text: fixed,
        within24hWindow: within24h,
      });
      await logAssistantTurn(conversationId, fixed);
      return;
    }
  }

  if (!structured) {
    await sendMessengerText({
      pageAccessToken: pageAccessToken,
      psid: params.psid,
      text: await speak({
        tenantId: params.tenantId,
        conversationId,
        persona,
        intent: { kind: "general_chat" },
        customerMessage: customerSummary,
        logIncoming: false,
      }),
      within24hWindow: within24h,
    });
    return;
  }

  const validation = validateOrderForClientSync(structured);
  if (!validation.ok) {
    const structuredItems = normalizeOrderItems(structured);
    const productLabel = lastRow
      ? (lastRow.facebookLabel ?? lastRow.clientSku).trim()
      : structured.product?.toString().trim() || structuredItems[0]?.product;
    const isGenericProduct = !productLabel ||
      /^(jersey|kit|shirt|football)$/i.test(productLabel.trim());
    if (isGenericProduct && getCartItemsFromDraft(convo.pendingDraftJson).length === 0) {
      const clarify = "Kon team er jersey lagbe bolun? (e.g. Argentina, Brazil, Spain)";
      await sendMessengerText({ pageAccessToken, psid: params.psid, text: clarify, within24hWindow: within24h });
      await logAssistantTurn(conversationId, clarify);
      return;
    }
    const missing: string[] = [];
    if (!structured.product && structuredItems.length === 0) missing.push("product");
    if (!structured.name?.toString().trim()) missing.push("name");
    if (!structured.address) missing.push("courier address");
    if (!structured.phone) missing.push("mobile");
    // Size is only required when the underlying product actually has variants.
    // For cosmetics / restaurant / electronics / accessories where the catalog
    // row carries no `sizeStocks` / `variants[]`, a "size" prompt would
    // deadlock the order. We resolve each item's product to its catalog row
    // and use the same `skuHasVariants` predicate the cart agent uses.
    let sizeMissing = false;
    if (structuredItems.length > 0) {
      for (const it of structuredItems) {
        if (!it.product) continue;
        if (String(it.size ?? "").trim()) continue;
        const meta = await resolveProductMetaByName(params.tenantId, it.product);
        if (productMetaHasVariants(meta)) {
          sizeMissing = true;
          break;
        }
      }
    } else if (structured.product && !String(structured.size ?? "").trim()) {
      const meta = await resolveProductMetaByName(params.tenantId, String(structured.product));
      if (productMetaHasVariants(meta)) sizeMissing = true;
    }
    if (sizeMissing) missing.push("size");
    const introBits: string[] = [];
    if (productLabel) introBits.push(`${productLabel} order confirm korte nicher details din:`);
    else introBits.push("Order confirm korte nicher details din:");
    introBits.push(missing.join(", "));
    const fallback = introBits.join("\n");
    await sendMessengerText({
      pageAccessToken: pageAccessToken,
      psid: params.psid,
      text: fallback,
      within24hWindow: within24h,
    });
    await logAssistantTurn(conversationId, fallback);
    return;
  }
  });
}

/** Called after SSLCommerz validation API confirms payment — never trust raw webhook alone */
export async function confirmPaidAndDeliver(orderId: string, validatedTranId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { tenant: true },
  });
  if (!order || order.sslcommerzTranId !== validatedTranId) {
    throw new Error("Order mismatch");
  }
  if (order.paymentStatus === "PAID") return;
  await runPostPaymentPipeline({ order, paidVia: "SSLCOMMERZ", reference: validatedTranId });
}

/**
 * Mark an order paid based on admin verification of a manual mobile-financial-service
 * (bKash / Nagad) transaction. Re-uses the same downstream pipeline (stock + courier
 * + customer notification) as the SSL flow.
 */
export async function confirmManualPayment(args: {
  orderId: string;
  tenantId: string;
  rail: "BKASH_MANUAL" | "NAGAD_MANUAL";
  reference?: string;
  verifiedBy?: string;
  note?: string;
}): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: args.orderId },
    include: { tenant: true },
  });
  if (!order || order.tenantId !== args.tenantId) {
    throw new Error("order_not_found");
  }
  if (order.paymentStatus === "PAID") return;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentMethod: args.rail,
      manualTxnId: args.reference ?? order.manualTxnId,
      manualPaymentNote: args.note ?? order.manualPaymentNote,
      manuallyVerifiedBy: args.verifiedBy ?? null,
      manuallyVerifiedAt: new Date(),
    },
  });

  const refreshed = await prisma.order.findUnique({
    where: { id: order.id },
    include: { tenant: true },
  });
  if (!refreshed) throw new Error("order_disappeared");
  await runPostPaymentPipeline({
    order: refreshed,
    paidVia: args.rail,
    reference: args.reference ?? `manual:${args.rail.toLowerCase()}`,
  });
}

type OrderWithTenant = Prisma.OrderGetPayload<{ include: { tenant: true } }>;

/**
 * Ship a copy of the just-generated invoice PDF to the tenant's own Telegram
 * chat so the merchant has a record without opening the dashboard. Pure
 * best-effort: returns silently when Telegram isn't configured for the
 * tenant or when the upload fails.
 *
 * Caption is one short line — the upload is the artifact, the line is the
 * scannable summary in the Telegram timeline.
 */
async function sendInvoicePdfToTenantTelegram(args: {
  settings: ReturnType<typeof parseTenantSettings>;
  order: OrderWithTenant;
  paidVia: "SSLCOMMERZ" | "BKASH_MANUAL" | "NAGAD_MANUAL";
  invoiceFilePath: string;
  invoicePublicUrl: string;
  items: ReturnType<typeof normalizeOrderItems>;
  structured: StructuredOrder;
}): Promise<void> {
  const tg = args.settings.telegram;
  if (!tg?.enabled || !tg.botToken?.trim() || !tg.chatId?.trim()) return;

  const orderShort = args.order.id.slice(0, 12);
  const amount = `${args.order.totalAmount?.toString() ?? "0"} ${args.order.currency ?? "BDT"}`;
  const customerName = String(args.structured.name ?? "").trim();
  const customerPhone = String(args.structured.phone ?? "").trim();
  const itemsLine =
    args.items.length > 0
      ? args.items
          .slice(0, 3)
          .map((it) => `${it.product}${it.size ? ` (${it.size})` : ""} x${it.quantity}`)
          .join(", ") + (args.items.length > 3 ? ` +${args.items.length - 3} more` : "")
      : "";

  const captionLines = [
    "Invoice — payment received",
    `Order: ${orderShort}`,
    `Rail: ${args.paidVia}`,
    `Amount: ${amount}`,
    customerName ? `Customer: ${customerName}${customerPhone ? ` (${customerPhone})` : ""}` : "",
    itemsLine ? `Items: ${itemsLine}` : "",
  ].filter(Boolean);
  const caption = captionLines.join("\n");

  await sendTelegramDocument({
    botToken: tg.botToken.trim(),
    chatId: tg.chatId.trim(),
    filePath: args.invoiceFilePath,
    filename: `invoice-${orderShort}.pdf`,
    caption,
  }).catch(async (e) => {
    // If the file upload fails for any reason (network, quota, oversize),
    // fall back to a text message with the public invoice URL so the owner
    // still gets the receipt.
    logger.warn(
      { e: String(e), orderId: args.order.id },
      "Telegram sendDocument failed — falling back to URL",
    );
    await sendTelegramMessage({
      botToken: tg.botToken!.trim(),
      chatId: tg.chatId!.trim(),
      text: `${caption}\nInvoice: ${args.invoicePublicUrl}`,
    }).catch((err) =>
      logger.warn(
        { e: String(err), orderId: args.order.id },
        "Telegram fallback URL message also failed",
      ),
    );
  });
}

async function runPostPaymentPipeline(opts: {
  order: OrderWithTenant;
  paidVia: "SSLCOMMERZ" | "BKASH_MANUAL" | "NAGAD_MANUAL";
  reference: string;
}): Promise<void> {
  const { order, paidVia, reference } = opts;
  const structured = order.structuredData as StructuredOrder;
  const items = normalizeOrderItems(structured);
  const primaryItem = items[0];
  const settings = parseTenantSettings(order.tenant.settings);

  await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: "PAID",
      status: "PAID",
      paymentMethod: paidVia,
    },
  });

  const tenantId = order.tenantId;
  const integration = await prisma.tenantIntegration.findUnique({ where: { tenantId } });
  if (integration) {
    const adapter = getIntegrationAdapter(integration.type);
    try {
      if (adapter.deductStock) {
        const clientSku = await resolveOrderClientSku(tenantId, structured);
        await adapter.deductStock(tenantId, {
          clientSku: clientSku ?? undefined,
          productName: String(primaryItem?.product ?? structured.product ?? ""),
          size: String(primaryItem?.size ?? structured.size ?? ""),
          quantity: Number(primaryItem?.quantity ?? structured.quantity ?? 1),
        });
      }
    } catch (e) {
      logger.error({ e, orderId: order.id }, "Stock deduction failed");
    }
    if (order.externalOrderId && adapter.updateOrderStatus) {
      try {
        await adapter.updateOrderStatus(tenantId, order.externalOrderId, "paid", {
          tranId: reference,
          paymentMethod: paidVia,
        });
      } catch (e) {
        logger.error({ e }, "Client notify paid failed");
      }
    }
  }

  const pathaoCfgRaw = settings.pathao as
    | (PathaoTenantConfig & { isLive?: boolean; bookingMode?: "automatic" | "manual" | "smart" })
    | undefined;
  const pathaoCfg: PathaoTenantConfig | undefined = pathaoCfgRaw
    ? {
        ...pathaoCfgRaw,
        baseUrl:
          pathaoCfgRaw.baseUrl ??
          (pathaoCfgRaw.isLive ? "https://api-hermes.pathao.com" : "https://courier-api-sandbox.pathao.com"),
      }
    : undefined;
  const steadfastCfg = settings.steadfast;
  const hasSteadfast = Boolean(steadfastCfg?.apiKey?.trim() && steadfastCfg?.secretKey?.trim());

  // Pick the active courier. `settings.courierProvider` wins; otherwise fall
  // back to whichever courier is configured. If both are configured and no
  // explicit choice was made, default to Pathao for backward compatibility.
  const courierProvider: "pathao" | "steadfast" | "none" = (() => {
    const explicit = (settings as { courierProvider?: "pathao" | "steadfast" }).courierProvider;
    if (explicit === "pathao" && pathaoCfg) return "pathao";
    if (explicit === "steadfast" && hasSteadfast) return "steadfast";
    if (pathaoCfg) return "pathao";
    if (hasSteadfast) return "steadfast";
    return "none";
  })();

  const bookingMode =
    courierProvider === "steadfast"
      ? steadfastCfg?.bookingMode ?? "automatic"
      : pathaoCfgRaw?.bookingMode ?? "automatic";
  const hasCustomizedItems = items.some((it) => Array.isArray(it.addOns) && it.addOns.length > 0);
  const shouldAutoBook =
    bookingMode === "automatic" || (bookingMode === "smart" && !hasCustomizedItems);

  // When the customer chose "full payment in advance" (gift orders / trusted
  // repeat customers), the Order's `structuredData.advance.fullPayment` flag
  // is set true by `confirm_order` and the entire bill (subtotal + delivery)
  // has already been collected up-front via the gateway. The courier MUST
  // collect 0 BDT cash on delivery — otherwise the customer would be charged
  // twice. We compute this once and feed it into both Pathao and Steadfast
  // branches below.
  const structuredAdvance = (structured as { advance?: { fullPayment?: boolean } }).advance;
  const isFullPaymentOrder = structuredAdvance?.fullPayment === true;

  if (courierProvider === "pathao" && pathaoCfg && shouldAutoBook) {
    try {
      const subtotal = Number(order.totalAmount?.toString() ?? "0");
      const deliveryCharge = typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
      const configuredAdvance =
        typeof settings.advancePaymentBdt === "number" ? settings.advancePaymentBdt : subtotal;
      const payableTotal = subtotal + deliveryCharge;
      const amountToCollect = isFullPaymentOrder
        ? 0
        : Math.max(payableTotal - Math.min(configuredAdvance, payableTotal), 0);
      const recipientName = structured.name?.trim() || "Customer";
      const recipientPhone = structured.phone?.trim() || "";
      const recipientAddress = structured.address?.trim() || "";
      const quantity = items.reduce((sum, it) => sum + it.quantity, 0) || 1;
      if (!recipientPhone || !recipientAddress) {
        throw new Error("Pathao booking skipped: missing recipient phone/address in confirmed order");
      }
      const itemDescription =
        items.length > 0
          ? items
              .slice(0, 3)
              .map((it) => `${it.product}${it.size ? `(${it.size})` : ""}x${it.quantity}`)
              .join(", ")
          : String(structured.product ?? "Order");
      const delivery = await createPathaoOrder(pathaoCfg, {
        merchantOrderId: order.id,
        recipientName,
        recipientPhone,
        recipientAddress,
        itemDescription,
        itemQuantity: quantity,
        amountToCollect,
      });
      await prisma.order.update({
        where: { id: order.id },
        data: {
          pathaoConsignmentId: delivery.consignmentId,
          status: "DELIVERY_SCHEDULED",
          deliveryStatus: "BOOKED",
        },
      });

      if (order.tenant.facebookPageAccessToken) {
        scheduleTrackingNotification({
          orderId: order.id,
          consignmentId: delivery.consignmentId,
          tenantId,
          psid: order.messengerPsid,
          pageAccessToken: order.tenant.facebookPageAccessToken,
          pathaoCfg,
          bookedAt: Date.now(),
        });
      }
    } catch (e) {
      logger.error({ e, orderId: order.id }, "Pathao booking failed");
      await prisma.order.update({
        where: { id: order.id },
        data: { failureReason: `pathao:${String(e)}` },
      });
    }
  } else if (courierProvider === "steadfast" && hasSteadfast && shouldAutoBook) {
    try {
      const recipientName = structured.name?.trim() || "Customer";
      const recipientPhone = structured.phone?.trim() || "";
      const recipientAddress = structured.address?.trim() || "";
      if (!recipientPhone || !recipientAddress) {
        throw new Error("Steadfast booking skipped: missing recipient phone/address in confirmed order");
      }
      const subtotal = Number(order.totalAmount?.toString() ?? "0");
      const deliveryCharge = typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
      const configuredAdvance =
        typeof settings.advancePaymentBdt === "number" ? settings.advancePaymentBdt : subtotal;
      const payableTotal = subtotal + deliveryCharge;
      const cashAmount = isFullPaymentOrder
        ? 0
        : Math.max(payableTotal - Math.min(configuredAdvance, payableTotal), 0);
      const itemDescription =
        items.length > 0
          ? items
              .slice(0, 3)
              .map((it) => `${it.product}${it.size ? `(${it.size})` : ""}x${it.quantity}`)
              .join(", ")
          : String(structured.product ?? "Order");

      const { createSteadfastOrder } = await import("../integrations/steadfast/steadfastService.js");
      const delivery = await createSteadfastOrder(
        { apiKey: steadfastCfg!.apiKey, secretKey: steadfastCfg!.secretKey },
        {
          merchantOrderId: order.id,
          recipientName,
          recipientPhone,
          recipientAddress,
          itemDescription,
          cashAmount,
        },
      );
      await prisma.order.update({
        where: { id: order.id },
        data: {
          // Reuse pathaoConsignmentId / pathaoMerchantOrderId as the universal
          // courier consignment + tracking columns. Naming is historical.
          pathaoConsignmentId: delivery.consignmentId,
          pathaoMerchantOrderId: delivery.trackingCode || null,
          status: "DELIVERY_SCHEDULED",
          deliveryStatus: "BOOKED",
        },
      });
      logger.info(
        { orderId: order.id, consignmentId: delivery.consignmentId, trackingCode: delivery.trackingCode },
        "Steadfast booking succeeded",
      );
    } catch (e) {
      logger.error({ e, orderId: order.id }, "Steadfast booking failed");
      await prisma.order.update({
        where: { id: order.id },
        data: { failureReason: `steadfast:${String(e)}` },
      });
    }
  } else if (courierProvider !== "none" && !shouldAutoBook) {
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "COMPLETED", deliveryStatus: "PENDING" },
    });
  } else {
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "COMPLETED", deliveryStatus: "NONE" },
    });
  }

  if (order.tenant.facebookPageAccessToken) {
    const pageAccessToken = order.tenant.facebookPageAccessToken;
    const convo = await prisma.messengerConversation.findUnique({
      where: { tenantId_psid: { tenantId, psid: order.messengerPsid } },
    });
    const within24h = convo ? isWithinMessagingWindow(convo.lastUserMsgAt) : false;
    const persona = settings.botPersona as BotPersona | undefined;
    const summary =
      items.length > 0
        ? items
            .slice(0, 4)
            .map((it) => `${it.product}${it.size ? ` (${it.size})` : ""} x${it.quantity}`)
            .join(", ")
        : [structured.product && `${structured.product}`, structured.quantity != null && `qty ${structured.quantity}`]
            .filter(Boolean)
            .join(", ");
    await sendMessengerText({
      pageAccessToken,
      psid: order.messengerPsid,
      text: await speak({
        tenantId,
        conversationId: convo?.id ?? "",
        psid: order.messengerPsid,
        persona,
        intent: { kind: "payment_confirmed", orderSummary: summary },
        logIncoming: false,
      }),
      within24hWindow: within24h,
    });
    const invoice = await generateInvoicePdf({
      orderId: order.id,
      amountBdt: Number(order.totalAmount?.toString() ?? "0"),
      currency: order.currency,
      paymentMethod: paidVia,
      structured,
      settings,
      paid: true,
    }).catch((e) => {
      logger.warn({ e: String(e), orderId: order.id }, "Invoice PDF generation failed");
      return null;
    });
    if (invoice?.publicUrl) {
      await prisma.order.update({
        where: { id: order.id },
        data: { invoiceUrl: invoice.publicUrl },
      }).catch(() => undefined);
      await sendMessengerFile({
        pageAccessToken,
        psid: order.messengerPsid,
        fileUrl: invoice.publicUrl,
        within24hWindow: within24h,
      }).catch(async (e) => {
        logger.warn({ e: String(e), orderId: order.id }, "Invoice file send failed, falling back to URL");
        await sendMessengerText({
          pageAccessToken,
          psid: order.messengerPsid,
          text: `Invoice PDF: ${invoice.publicUrl}`,
          within24hWindow: within24h,
        }).catch(() => undefined);
      });

      // Ship a copy of the invoice to the tenant's Telegram bot so the owner
      // has a clean record without opening the dashboard. Best-effort — if
      // Telegram isn't configured or the upload fails, the customer-facing
      // path above is unaffected.
      await sendInvoicePdfToTenantTelegram({
        settings,
        order,
        paidVia,
        invoiceFilePath: invoice.filePath,
        invoicePublicUrl: invoice.publicUrl,
        items,
        structured,
      }).catch((e) =>
        logger.warn({ e: String(e), orderId: order.id }, "Telegram invoice copy failed"),
      );
    }
  }
}

export async function findOrderIdBySslTranId(tranId: string): Promise<string | null> {
  const o = await prisma.order.findFirst({ where: { sslcommerzTranId: tranId } });
  return o?.id ?? null;
}

// ─── Tracking Number Auto-Send ───────────────────────────────────────────────

const TRACKING_CHECK_INTERVAL_MS = 30 * 60 * 1000; // check every 30 minutes
const TRACKING_MAX_AGE_MS = 23 * 60 * 60 * 1000; // stop checking after 23 hours

/**
 * Schedules periodic checks for a Pathao tracking number.
 * Sends it to the customer via Messenger as soon as available.
 * Stops checking after 23 hours — after that, only send if customer asks.
 */
export function scheduleTrackingCheck(opts: {
  orderId: string;
  consignmentId: string;
  tenantId: string;
  psid: string;
  pageAccessToken: string;
  pathaoCfg: PathaoTenantConfig;
  bookedAt: number;
}): void {
  scheduleTrackingNotification(opts);
}

function scheduleTrackingNotification(opts: {
  orderId: string;
  consignmentId: string;
  tenantId: string;
  psid: string;
  pageAccessToken: string;
  pathaoCfg: PathaoTenantConfig;
  bookedAt: number;
}): void {
  const { orderId, consignmentId, tenantId, psid, pageAccessToken, pathaoCfg, bookedAt } = opts;

  const timer = setInterval(async () => {
    const elapsed = Date.now() - bookedAt;
    if (elapsed > TRACKING_MAX_AGE_MS) {
      clearInterval(timer);
      logger.info({ orderId, consignmentId }, "Tracking check expired (23h), stopping");
      return;
    }

    try {
      const status = await getPathaoOrderStatus(pathaoCfg, consignmentId);
      if (status.trackingId && status.trackingId !== consignmentId) {
        clearInterval(timer);
        const trackingUrl = `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(status.trackingId)}`;
        const convo = await prisma.messengerConversation.findUnique({
          where: { tenantId_psid: { tenantId, psid } },
        });
        const within24h = convo ? isWithinMessagingWindow(convo.lastUserMsgAt) : false;

        const msg = [
          "📦 Delivery Update!",
          "",
          `🔗 Tracking ID: ${status.trackingId}`,
          `📍 Track: ${trackingUrl}`,
          "",
          "Apnar parcel ship hoye geche! 🚚",
        ].join("\n");

        await sendMessengerText({ pageAccessToken, psid, text: msg, within24hWindow: within24h });
        logger.info({ orderId, trackingId: status.trackingId }, "Tracking number sent to customer");
      }
    } catch (e) {
      logger.warn({ e: String(e), orderId, consignmentId }, "Tracking check failed, will retry");
    }
  }, TRACKING_CHECK_INTERVAL_MS);
}
