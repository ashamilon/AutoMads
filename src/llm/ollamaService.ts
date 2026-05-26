import axios from "axios";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { catalogProductMatchSchema } from "../types/catalog-match.js";
import { jerseyPhotoIdentifySchema, type JerseyPhotoIdentify } from "../types/jersey-vision.js";
import { structuredOrderSchema, type StructuredOrder } from "../types/order-extraction.js";

const SYSTEM_PROMPT = `You are an order-intent parser for a Messenger commerce assistant in Bangladesh.
Users write in Banglish (Bangla in Latin script) and English mixed together.

Rules:
- Extract ONLY structured fields from the user's message. Never invent payment status, delivery status, or whether payment succeeded.
- Never decide if an order is confirmed or paid — only extract what the user said.
- Output a single JSON object with keys: name, product, size, quantity, address, phone.
- For unknown fields, omit the key or use empty string — avoid JSON null.
- quantity may be a number or a numeric string.
- Respond with JSON only, no markdown or explanation.

Example output:
{"name":"Rahim","product":"Blue jeans","size":"32","quantity":1,"address":"Dhanmondi 15","phone":"01711111111"}`;

export type BotPersona = {
  /** Name the bot uses to refer to itself if asked */
  name?: string;
  /** Free-form description of how to talk: tone, vocabulary, pet phrases, do's & don'ts */
  tone?: string;
  /** Few-shot examples — pairs of how a user wrote and how *you* would reply */
  examples?: { user: string; assistant: string }[];
};

export type ReplyIntent =
  /** Greeting, chit-chat, or a product/price/availability question with no matched catalog row.
   *  Bot should converse in persona voice — NOT demand order details. */
  | { kind: "general_chat" }
  /** Customer is clearly trying to order but we could not extract usable fields at all. */
  | { kind: "ask_for_order_details" }
  | { kind: "could_not_parse" } // LLM couldn't extract structured fields
  | { kind: "missing_fields"; missing: string[] }
  | { kind: "no_integration" }
  | { kind: "order_created"; gatewayUrl: string; tranId: string; orderSummary?: string }
  | { kind: "order_failed"; reason?: string }
  | { kind: "payment_confirmed"; orderSummary?: string }
  /** Catalog row matched — only share provided facts */
  | { kind: "product_info"; productFacts: string };

const INTENT_HINTS: Record<ReplyIntent["kind"], string> = {
  general_chat:
    "Reply naturally like a real Bangladeshi seller on Messenger. Use Banglish/Bangla naturally (not robotic). Answer what they asked directly. Do NOT demand full order details unless they clearly want to place an order now. If pinned memory says an order list / multi-item selection is in progress, do NOT mention advance payment, bKash, or Nagad — suggest adding more items or ask what else they need first. Never use the English words \"cart\" or \"checkout\" — say \"list\", \"order list\", \"selection\", or \"order confirm\" instead.",
  ask_for_order_details:
    "The customer has indicated they want to place an order but gave no product details yet. Briefly (in your normal voice) ask for the product/size/quantity/address/phone — keep it short, match the example replies above.",
  could_not_parse:
    "You couldn't parse their last message. Reply briefly in your normal voice and ask them to clarify. Match the tone of the example replies above — do not send a long template.",
  missing_fields:
    "The user is trying to order but some required fields are missing. Ask for ONLY the listed missing fields, briefly.",
  no_integration:
    "The shop's backend integration isn't configured. Apologise briefly and tell them to try again later.",
  order_created:
    "An order is recorded and a payment link was created. Share the payment link and the order reference. Tell them to complete payment to confirm.",
  order_failed:
    "The order pipeline failed. Apologise briefly and ask them to try again later.",
  payment_confirmed:
    "Payment has been confirmed. Thank the customer warmly and let them know the order is on its way.",
  product_info:
    "The system matched a product from the shop catalog. Share ONLY the facts given below (price, stock, sizes/variants, SKU). Do not invent delivery time or discounts. If they only asked availability/price, answer just that naturally. Ask for order fields only when they explicitly want to order.",
};

function buildPersonaSystemPrompt(
  persona: BotPersona | undefined,
  opts?: { suppressExamples?: boolean },
): string {
  const tone =
    persona?.tone?.trim() ||
    "You are a friendly Bangladeshi small-shop owner replying on Messenger. Use natural Banglish or Bangla depending on the customer's style. Keep replies short (1-2 sentences), warm, and direct. Never sound like a bot template.";
  const intro = persona?.name
    ? `You are ${persona.name}, replying personally to a customer on Messenger.`
    : "You are replying personally to a customer on Messenger.";

  const combined: { user: string; assistant: string }[] = [...(persona?.examples ?? [])];

  let examplesBlock = "";
  if (combined.length > 0 && !opts?.suppressExamples) {
    examplesBlock =
      "\n\nVoice samples from this shop. Match TONE and BREVITY only. Numbers/prices/sizes inside examples are illustrative — DO NOT copy them. Use only catalog facts you are explicitly given.\n" +
      combined
        .slice(0, 8)
        .map(
          (ex, i) =>
            `Example ${i + 1}:\nCustomer: ${ex.user}\nMe: ${ex.assistant}`,
        )
        .join("\n\n");
  }

  return [
    intro,
    tone,
    "Rules:",
    "- ONE short reply only. No essays. Prefer 1 sentence.",
    "- Read the full recent conversation below and keep context.",
    "- Do NOT repeat the same sentence you sent previously.",
    "- Do NOT ask for information the customer already gave.",
    "- If the customer only said hi / salam / kemon achen etc., reply warmly — do not demand order details.",
    "- HARD RULE: never quote a price, stock count, size measurement, delivery duration, payment number, or order id unless this turn's instruction message gave it to you verbatim. If you don't have the fact, say `confirm kore janabo` instead.",
    "- HONESTY RULE: be truthful about being an AI assistant. If a customer asks 'are you a bot?', 'tumi ki AI?', 'manush?' or similar, answer naturally that you're the shop's AI assistant — never claim to be a human moderator. Example: 'ji, ami ei shop er AI assistant 🙂 ki shahajjo lagbe?'.",
    "- Voice examples are TONE references only. Their numbers are stale and MUST NOT be repeated.",
    "- Output the reply text only — no labels, no JSON, no markdown, no quotes.",
    examplesBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

export type ConversationTurn = { role: "user" | "assistant"; text: string };

/**
 * Generate a tenant-styled reply.
 * - history: last N turns of THIS conversation (chat memory, prevents repetition)
 * - customerFacts: optional structured snapshot the bot should remember across turns
 *   (customer name, last asked product, open order, language, etc). Injected as a
 *   pinned system message so the model never "forgets" it even if the rolling
 *   history slice ages it out.
 * Returns null on failure so the caller can fall back to a fixed template.
 */
export async function generateReply(opts: {
  persona?: BotPersona;
  intent: ReplyIntent;
  customerMessage?: string;
  history?: ConversationTurn[];
  customerFacts?: string;
  /** Live correction lessons retrieved for this tenant (RAG); higher priority than examples. */
  lessonHints?: string;
}): Promise<string | null> {
  try {
    // For ANY intent that doesn't ship verbatim catalog facts in this turn we
    // strip persona examples — they cause the model to reuse stale prices /
    // size charts from learned chats.
    const factBearingIntents: ReplyIntent["kind"][] = ["product_info", "order_created", "payment_confirmed"];
    const suppressExamples = !factBearingIntents.includes(opts.intent.kind);

    const intentParts: string[] = [];
    intentParts.push(`Intent: ${opts.intent.kind}`);
    intentParts.push(`Guidance: ${INTENT_HINTS[opts.intent.kind]}`);

    if (opts.intent.kind === "missing_fields") {
      intentParts.push(`Missing fields: ${opts.intent.missing.join(", ")}`);
    }
    if (opts.intent.kind === "order_created") {
      intentParts.push(`Payment link to share: ${opts.intent.gatewayUrl}`);
      intentParts.push(`Order reference: ${opts.intent.tranId}`);
      if (opts.intent.orderSummary) intentParts.push(`Order summary: ${opts.intent.orderSummary}`);
    }
    if (opts.intent.kind === "payment_confirmed" && opts.intent.orderSummary) {
      intentParts.push(`Order summary: ${opts.intent.orderSummary}`);
    }
    if (opts.intent.kind === "product_info") {
      intentParts.push(
        "Catalog facts to share (verbatim values — you may translate labels, not numbers):",
      );
      intentParts.push(opts.intent.productFacts);
    }
    if (opts.intent.kind === "order_failed" && opts.intent.reason) {
      intentParts.push(`Internal reason (do NOT share verbatim): ${opts.intent.reason}`);
    }
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: buildPersonaSystemPrompt(opts.persona, { suppressExamples }) },
    ];

    if (opts.customerFacts && opts.customerFacts.trim().length > 0) {
      messages.push({
        role: "system",
        content:
          "Pinned conversation memory (already known about THIS customer — do not ask for these again unless they correct you):\n" +
          opts.customerFacts.trim(),
      });
    }

    if (opts.lessonHints && opts.lessonHints.trim().length > 0) {
      messages.push({
        role: "system",
        content:
          opts.lessonHints.trim() +
          "\n\nHARD RULE: If a lesson matches this situation, follow it — do not repeat the old mistake.",
      });
    }

    // Larger window so order details / earlier product mentions stay visible to
    // the model across longer threads.
    const trimmedHistory = (opts.history ?? []).slice(-24);
    for (const turn of trimmedHistory) {
      if (turn.text && turn.text.trim()) {
        messages.push({ role: turn.role, content: turn.text });
      }
    }

    const finalParts = [...intentParts];
    if (opts.customerMessage && !trimmedHistory.some((t) => t.role === "user" && t.text === opts.customerMessage)) {
      finalParts.push(`Customer just said: ${opts.customerMessage}`);
    }
    finalParts.push("Now write your reply (one short message, in your voice):");
    messages.push({ role: "user", content: finalParts.join("\n") });

    const res = await axios.post(
      `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
      {
        model: config.ollamaModel,
        messages,
        stream: false,
        options: { temperature: 0.7, num_predict: 220 },
      },
      { timeout: Math.min(config.ollamaTimeoutMs, 30_000) },
    );
    const content = res.data?.message?.content;
    if (typeof content !== "string") return null;
    const cleaned = content
      .replace(/^[\s"`]+|[\s"`]+$/g, "")
      .replace(/^Me:\s*/i, "")
      .replace(/^Reply:\s*/i, "")
      .trim();
    return cleaned.length > 0 ? cleaned : null;
  } catch (e) {
    logger.warn({ e: String(e) }, "generateReply failed — caller should fallback");
    return null;
  }
}

/** Pull JSON out of model output — handles ```json fences, prose, and trailing junk */
export function parseJsonObjectFromLlmContent(content: unknown): unknown {
  if (typeof content === "object" && content !== null) return content;
  if (typeof content !== "string") throw new Error("non_string_content");

  let s = content.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/im.exec(s);
  if (fenced) s = fenced[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error("json_parse_failed");
  }
}

const EXTRACT_RETRY_HINT =
  "\n\nOutput ONLY one JSON object. No markdown, no ``` fences, no explanation — keys: name, product, size, quantity, address, phone.";

async function extractOrderFromMessageOnce(userMessage: string): Promise<StructuredOrder | null> {
  const res = await axios.post(
    `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
    {
      model: config.ollamaModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      stream: false,
      format: "json",
      options: { temperature: 0.1 },
    },
    { timeout: Math.min(config.ollamaTimeoutMs, 120_000) },
  );
  const content = res.data?.message?.content;
  const parsed = parseJsonObjectFromLlmContent(content);
  return structuredOrderSchema.parse(parsed);
}

export async function extractOrderFromMessage(userMessage: string): Promise<StructuredOrder | null> {
  try {
    return await extractOrderFromMessageOnce(userMessage);
  } catch (first) {
    logger.warn({ e: String(first) }, "Ollama extract first pass failed, retrying");
  }
  try {
    return await extractOrderFromMessageOnce(userMessage + EXTRACT_RETRY_HINT);
  } catch (e) {
    logger.error({ e }, "Ollama extract failed");
    return null;
  }
}

const VISION_SYSTEM_PROMPT = `You are an order-intent parser for a Messenger commerce assistant in Bangladesh.
The customer may send product photos, screenshots, or Banglish/English text together.

Rules:
- Extract ONLY structured fields from what you SEE and READ. Never invent payment or delivery status.
- Output a single JSON object with keys: name, product, size, quantity, address, phone.
- For unknown fields, omit the key (preferred) or use empty string — avoid JSON null.
- quantity may be a number or a numeric string.
- Respond with JSON only, no markdown or explanation.

Example output:
{"product":"Black hoodie","size":"XL","quantity":2}`;

async function extractOrderWithVisionOnce(
  caption: string | undefined,
  imagesBase64: string[],
): Promise<StructuredOrder | null> {
  const capped = imagesBase64.slice(0, 3);
  const userText = caption?.trim()
    ? `Customer wrote: "${caption.trim()}"\n\nExtract order fields from the attached image(s).`
    : `The customer sent only image(s). Extract order fields from what is visible (product, labels, handwritten address, phone on paper/screen, etc.).`;

  const res = await axios.post(
    `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
    {
      model: config.ollamaModel,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        { role: "user", content: userText, images: capped },
      ],
      stream: false,
      format: "json",
      options: { temperature: 0.12 },
    },
    { timeout: Math.min(config.ollamaTimeoutMs, 180_000) },
  );
  const content = res.data?.message?.content;
  const parsed = parseJsonObjectFromLlmContent(content);
  return structuredOrderSchema.parse(parsed);
}

/**
 * Text-only uses the standard extractor; with images uses Ollama vision (`images` array, base64).
 */
export async function extractOrderFromTextAndImages(
  text: string | undefined,
  imagesBase64: string[],
): Promise<StructuredOrder | null> {
  const b64 = imagesBase64.filter((s) => s.length > 0);
  if (b64.length === 0) {
    if (!text?.trim()) return null;
    return extractOrderFromMessage(text);
  }
  try {
    return await extractOrderWithVisionOnce(text, b64);
  } catch (first) {
    logger.warn({ e: String(first) }, "Ollama vision extract first pass failed, retrying");
  }
  try {
    const hint = text?.trim() ? text + EXTRACT_RETRY_HINT : EXTRACT_RETRY_HINT;
    return await extractOrderWithVisionOnce(hint, b64);
  } catch (e) {
    logger.error({ e }, "Ollama vision extract failed");
    return null;
  }
}

const JERSEY_IDENTIFY_SYSTEM = `You are a precision football-jersey identifier. Be CONSERVATIVE — when in doubt, output a lower kind / lower confidence rather than guess.

You will see ONE OR MORE PHOTOS the customer sent. The image MAY be:
  • a football (soccer) jersey — full kit, torso crop, hanger, folded, sleeve / badge close-up — partial photo is OK
  • a different garment (t-shirt, polo, hoodie, dress)
  • a person photo (selfie, model, bystander) with no jersey
  • a screen / random / blurry / OCR-friendly junk

STEP 1 — gate. Decide whether the image clearly shows an association football (soccer) jersey:
  - If you can see a football crest / federation badge / club crest / clear football kit pattern → continue.
  - If it's a t-shirt without crest → kind="not_jersey". Random garment / person / screenshot → kind="not_jersey".
  - If a jersey is plausible but image too dark/blurry/cropped to tell → kind="unknown".

STEP 2 — identify (only if jersey detected):
  - NATIONAL TEAM (e.g. Spain, Brazil, Argentina) — federation badge / flag colors / "ARGENTINA" wordmark.
  - CLUB (e.g. Real Madrid, Barcelona, Manchester United) — crest pattern, sponsor, distinctive stripes.
  - "primaryNames" — 1 to 4 short ENGLISH strings (e.g. ["Spain"] or ["Real Madrid"]). Do NOT invent.

STEP 3 — confidence:
  - "high"   → crest clearly readable AND dominant colors / sponsor / wordmark all consistent with one team. Multiple discriminators agree.
  - "medium" → strong color cue (e.g. all-white + Adidas + Spanish flag accent → likely Real Madrid) but crest not crisp.
  - "low"    → only one weak cue (e.g. "blue jersey", "white shirt") with no badge or wordmark visible.

STEP 4 — detectedFeatures (always fill what you can see):
  - hasCrest: true only when an actual badge is visible.
  - crestDescription: 3-12 word description ("Real Madrid lion + Adidas stripes" / "FIFA crest, ARG wordmark").
  - dominantColors: up to 4 ("white", "navy", "red", "yellow").
  - sponsor: brand on the chest if readable ("Emirates Fly Better", "Standard Chartered", "Spotify").
  - kitVariant: home / away / third / retro / goalkeeper / unknown.

Output ONE JSON object only:
{"kind":"national_team"|"club"|"ambiguous"|"not_jersey"|"unknown","primaryNames":["..."],"confidence":"high"|"medium"|"low","detectedFeatures":{"hasCrest":bool,"crestDescription":"...","dominantColors":["..."],"sponsor":"...","kitVariant":"home|away|third|retro|goalkeeper|unknown"},"notes":"optional short reason"}

Hard rules:
- "not_jersey" → primaryNames MUST be empty array.
- "unknown" → primaryNames MUST be empty array.
- "ambiguous" → primaryNames MAY contain 2-4 candidate teams; confidence MUST be "low" or "medium".
- Never set confidence "high" for a kit you cannot fully discriminate (e.g. plain blue jersey with no badge).
- Never invent a team name. If unsure, downgrade kind/confidence rather than guess.`;

/**
 * Vision pass: country/club (or not a jersey) from customer photos.
 * Returns null if Ollama fails — caller should fall back to generic catalog match.
 */
export async function identifyJerseyFromPhoto(
  imagesBase64: string[],
  caption?: string,
): Promise<JerseyPhotoIdentify | null> {
  const capped = imagesBase64.filter((s) => s.length > 0).slice(0, 3);
  if (capped.length === 0) return null;
  const userLine = caption?.trim()
    ? `Customer also wrote: """${caption.trim()}"""\nUse text + images together.`
    : "Customer sent only image(s). Identify the jersey from what is visible.";
  try {
    const res = await axios.post(
      `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
      {
        model: config.ollamaModel,
        messages: [
          { role: "system", content: JERSEY_IDENTIFY_SYSTEM },
          { role: "user", content: userLine, images: capped },
        ],
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
      },
      { timeout: Math.min(config.ollamaTimeoutMs, 120_000) },
    );
    const content = res.data?.message?.content;
    const parsed = parseJsonObjectFromLlmContent(content);
    const out = jerseyPhotoIdentifySchema.safeParse(parsed);
    if (!out.success) return null;
    return out.data;
  } catch (e) {
    logger.warn({ e: String(e) }, "identifyJerseyFromPhoto failed");
    return null;
  }
}

const PAYMENT_SCREENSHOT_VISION_SYSTEM = `You classify images for a Bangladesh Messenger shop that collects bKash/Nagad payment proofs.

Decide if the image(s) clearly show FINANCIAL / PAYMENT-RELATED content that could reasonably be used to verify a money transfer.

Set isFinancialPaymentScreenshot to TRUE only when you see clear evidence such as:
- bKash, Nagad, Rocket, Upay, or major bank app screens: Send Money, Cash Out, payment success, transaction details, statement with Txn ID and amount
- Card/SSLCommerz/merchant checkout confirmation with amount and transaction reference
- SMS or messaging screenshot that explicitly shows a money-sent confirmation with amount and reference (not generic chat)

Set to FALSE for:
- Product photos (jersey, shoes, electronics), memes, random photos, chat UI without payment text
- Maps, delivery screenshots, order screenshots without payment amounts or MFS/bank receipt layout
- Blurry or unreadable images where you cannot confirm payment UI
- If you are unsure → FALSE

Output ONE JSON object only:
{"isFinancialPaymentScreenshot":true|false,"confidence":"high"|"medium"|"low","briefReason":"max 100 chars"}`;

function parsePaymentScreenshotVisionResult(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const o = parsed as Record<string, unknown>;
  if (o["isFinancialPaymentScreenshot"] !== true) return false;
  const conf = o["confidence"];
  if (conf === "low") return false;
  return true;
}

/**
 * Vision gate: true only when the image(s) look like a real payment / financial receipt,
 * not arbitrary product or chat screenshots. On model/network failure returns false.
 */
export async function classifyMessengerImageAsFinancialPaymentScreenshot(
  imagesBase64: string[],
  customerCaption?: string,
): Promise<boolean> {
  const capped = imagesBase64.filter((s) => s.length > 32).slice(0, 2);
  if (capped.length === 0) return false;
  const userLine = customerCaption?.trim()
    ? `Customer also wrote: """${customerCaption.trim()}"""\nClassify the image(s) with the text in mind.`
    : "The customer sent only image(s). Classify them.";
  try {
    const res = await axios.post(
      `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
      {
        model: config.ollamaModel,
        messages: [
          { role: "system", content: PAYMENT_SCREENSHOT_VISION_SYSTEM },
          { role: "user", content: userLine, images: capped },
        ],
        stream: false,
        format: "json",
        options: { temperature: 0.05 },
      },
      { timeout: Math.min(config.ollamaTimeoutMs, 90_000) },
    );
    const content = res.data?.message?.content;
    const parsed = parseJsonObjectFromLlmContent(content);
    const ok = parsePaymentScreenshotVisionResult(parsed);
    logger.info(
      { ok, preview: typeof content === "string" ? content.slice(0, 120) : null },
      "Payment-screenshot vision classification",
    );
    return ok;
  } catch (e) {
    logger.warn({ e: String(e) }, "classifyMessengerImageAsFinancialPaymentScreenshot failed");
    return false;
  }
}

const CATALOG_MATCH_SYSTEM = `You are a catalog lookup assistant for Messenger commerce.
The user may send a product name in Banglish/English OR a product photo (you receive images).

Rules:
- You will receive lines: clientSku TAB storefront label TAB JSON metadata (name, price, stock, variants, images, etc.).
- Pick the ONE best-matching row for what the user asked or showed in the image. Use visual cues (colors, logos, kit design) and text; do not invent SKUs.
- If nothing in the catalog matches, return an empty clientSku.
- Output one JSON object only: {"clientSku":"<exact sku from column 1>"} or {"clientSku":""}.
- clientSku must be copied exactly from the catalog — never guess or paraphrase.`;

async function matchCatalogOnce(
  catalogLines: string,
  text: string | undefined,
  imagesBase64: string[],
): Promise<string | null> {
  const body =
    `CATALOG (clientSku TAB label TAB metadata_json):\n` +
    catalogLines +
    `\n\n` +
    (text?.trim()
      ? `Customer message: """${text.trim()}"""\n\nPick the matching row.`
      : "Customer sent only image(s). Pick the matching catalog row from what is visible.");

  const capped = imagesBase64.filter((s) => s.length > 0).slice(0, 3);
  const userMsg: { role: "user"; content: string; images?: string[] } = {
    role: "user",
    content: body,
  };
  if (capped.length > 0) userMsg.images = capped;

  const res = await axios.post(
    `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
    {
      model: config.ollamaModel,
      messages: [{ role: "system", content: CATALOG_MATCH_SYSTEM }, userMsg],
      stream: false,
      format: "json",
      options: { temperature: 0.05 },
    },
    { timeout: Math.min(config.ollamaTimeoutMs, 180_000) },
  );
  const content = res.data?.message?.content;
  const parsed = parseJsonObjectFromLlmContent(content);
  const out = catalogProductMatchSchema.safeParse(parsed);
  if (!out.success) return null;
  const sku = out.data.clientSku.trim();
  return sku.length > 0 ? sku : null;
}

/**
 * Visual side-by-side compare: customer photo vs each shortlisted candidate's reference image.
 * Returns the picked clientSku (must be in validSkus), or null if none confidently match.
 */
const CATALOG_VISUAL_PICK_SYSTEM = `You are a precision matcher. The customer photo (Image 1) MUST match exactly one CANDIDATE catalog photo (Image 2..N). Be CONSERVATIVE — return empty when discriminators don't agree.

You receive in this exact order:
  Image 1: customer's jersey photo
  Image 2..N: catalog reference photos (one per candidate, same order as the candidate list)

You also receive a numbered candidate list with: index, clientSku, label, and key descriptors.

Match procedure (run all checks, ALL must agree before "high"):
  1. Crest — same shape / federation badge / club badge?
  2. Dominant colors — same primary + secondary colors?
  3. Pattern — stripes / chevron / sash / solid / gradient — same family?
  4. Sponsor / wordmark — readable text on chest matches?
  5. Kit variant — home / away / third / retro — consistent?

Confidence:
  - "high"   — at least 3 of the 5 checks clearly agree AND no check disagrees.
  - "medium" — 2 checks agree, 0 disagree (rest unclear).
  - "low"    — only 1 check agrees, or any check actively disagrees.

Output ONE JSON object only:
{"clientSku":"<exact sku from list>","confidence":"high"|"medium"|"low","reason":"one short line of why"}

Hard rules:
- Use clientSku "" (empty string) when:
  * Customer photo is not a jersey at all (random object / person / screenshot).
  * No candidate clearly matches — even if one is "closest", do NOT guess.
  * The crest in the customer photo contradicts every candidate's crest.
- Never invent SKUs not present in the candidate list.
- Returning "" is the SAFE answer — the agent will ask the customer to clarify rather than ship the wrong jersey.`;

export async function pickCatalogByVisualComparison(args: {
  customerImageBase64: string;
  candidates: Array<{
    clientSku: string;
    label: string;
    descriptors?: string;
    imageBase64: string;
  }>;
  validSkus: Set<string>;
}): Promise<string | null> {
  const cands = args.candidates.filter((c) => c.imageBase64.length > 32).slice(0, 6);
  if (cands.length === 0 || args.customerImageBase64.length < 32) return null;

  const list = cands
    .map(
      (c, i) =>
        `${i + 1}. clientSku=${c.clientSku} | ${c.label}${
          c.descriptors ? ` | ${c.descriptors}` : ""
        }`,
    )
    .join("\n");

  const userMsg = {
    role: "user" as const,
    content:
      `CANDIDATES (image order: 2..${cands.length + 1}):\n${list}\n\n` +
      `Image 1 = customer photo. Compare and return JSON: {"clientSku":"...","confidence":"high|medium|low"}`,
    images: [args.customerImageBase64, ...cands.map((c) => c.imageBase64)],
  };

  try {
    const res = await axios.post(
      `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
      {
        model: config.ollamaModel,
        messages: [{ role: "system", content: CATALOG_VISUAL_PICK_SYSTEM }, userMsg],
        stream: false,
        format: "json",
        options: { temperature: 0.05 },
      },
      { timeout: Math.min(config.ollamaTimeoutMs, 180_000) },
    );
    const content = res.data?.message?.content;
    const parsed = parseJsonObjectFromLlmContent(content) as
      | { clientSku?: unknown; confidence?: unknown; reason?: unknown }
      | null;
    const sku = typeof parsed?.clientSku === "string" ? parsed.clientSku.trim() : "";
    const confidence =
      typeof parsed?.confidence === "string" ? parsed.confidence.trim().toLowerCase() : "";
    const reason = typeof parsed?.reason === "string" ? parsed.reason.slice(0, 160) : "";
    if (!sku || !args.validSkus.has(sku)) return null;
    // Conservative: only auto-pick on `high`. `medium` and `low` fall through
    // so the caller can choose to ask the customer to confirm rather than
    // silently dropping the wrong jersey into the cart.
    if (confidence !== "high") {
      logger.info(
        { sku, confidence, reason },
        "pickCatalogByVisualComparison: confidence below high → not auto-selecting",
      );
      return null;
    }
    logger.info({ sku, confidence, reason }, "pickCatalogByVisualComparison: high-confidence pick");
    return sku;
  } catch (e) {
    logger.warn({ e: String(e) }, "pickCatalogByVisualComparison failed");
    return null;
  }
}

/**
 * Ask Ollama (text and/or vision) which catalog SKU best matches the customer input.
 * Vision uses the customer's image together with catalog text (SKU, label, metadata JSON)
 * — not a pixel-for-pixel match against catalog thumbnails. Adding reference thumbnails would
 * be a separate retrieval + multi-image pass.
 * Returns null if unmatched or invalid — caller must only trust SKUs in validSkus.
 */
export async function matchClientSkuFromCatalog(args: {
  catalogLines: string;
  text: string | undefined;
  imagesBase64: string[];
  validSkus: Set<string>;
}): Promise<string | null> {
  if (args.catalogLines.length < 2) return null;
  try {
    const sku = await matchCatalogOnce(args.catalogLines, args.text, args.imagesBase64);
    return sku && args.validSkus.has(sku) ? sku : null;
  } catch (first) {
    logger.warn({ e: String(first) }, "catalog match first pass failed");
  }
  try {
    const hint =
      (args.text?.trim() ? `${args.text.trim()}\n\n` : "") +
      `Return JSON only: {"clientSku":"<exact sku from catalog>"} or {"clientSku":""}.`;
    const sku = await matchCatalogOnce(args.catalogLines, hint, args.imagesBase64);
    return sku && args.validSkus.has(sku) ? sku : null;
  } catch (e) {
    logger.error({ e }, "catalog match failed");
    return null;
  }
}
