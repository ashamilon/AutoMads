/**
 * Learn from live Messenger turns: when customers signal the bot was wrong or clarify intent,
 * embed a compact lesson into KnowledgeExample so retrieval can steer future replies away from
 * repeating the same mistake.
 */

import { prisma } from "../db/prisma.js";
import { config } from "../config/index.js";
import { embed } from "../llm/embeddingService.js";
import { invalidateRagCache, retrieveCorrectionLessons } from "../llm/ragService.js";
import { logger } from "../utils/logger.js";

export function looksLikeCustomerCorrection(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || t.length > 900) return false;
  const lower = t.toLowerCase();

  const english =
    /\b(that['']?s\s+(wrong|incorrect|not\s+right|rubbish)|you('?re|\s+are)\s+wrong|incorrect\s+reply|wrong\s+(reply|answer)|not\s+what\s+i|don'?t\s+mean|mistake\b)\b/i.test(
      lower,
    );
  const bnBanglish =
    /\b(vul\s+(kor|c|ch|hoc|hocch|hocche|korso|korle)|tumi\s+vul|tmi\s+vul|thor\s+vul|ভুল|thik\s*nah\b|এটা\s*থিক\s*না|^naa,|^nah,|^nah\s|^nae,|^না,?)\b/i.test(lower) ||
    /\bami(\s+[tóo]?\s*k)?\s*boll(am|eci|eci|ebe|chilam)|(\baage|agol)\s+bollam\b/i.test(lower) ||
    /\bactually\b.*\b(i\s+meant|i\s+wanted|ami\s+)/i.test(lower);

  const clarifyingRedo =
    /^(nah|nae|ño|ña|না)+[,.\s!]+.{12,}/i.test(t.trim()) &&
    /\b(mean|meaning|mana|bollo|bola|wanted|chai|chte|chteci|chte\s+chilam)\b/i.test(lower);

  return english || bnBanglish || clarifyingRedo;
}

function clip(s: string, max: number): string {
  const x = s.replace(/\s+/g, " ").trim();
  return x.length <= max ? x : `${x.slice(0, max - 3)}…`;
}

function composeRagQueryForLessons(history: Array<{ role: string; text: string }>, customerMessage: string): string {
  const lastAssist = [...history].reverse().find((h) => h.role === "assistant")?.text?.trim() ?? "";
  const lastUserBefore = [...history].reverse().filter((h) => h.role === "user");
  const prevUser = lastUserBefore.length >= 2 ? lastUserBefore[1]?.text?.trim() : "";
  const parts = [
    prevUser ? `Prior customer msg: ${clip(prevUser, 260)}` : "",
    lastAssist ? `Last bot reply: ${clip(lastAssist, 340)}` : "",
    customerMessage.trim() ? `Current customer msg: ${clip(customerMessage, 360)}` : "",
  ].filter(Boolean);
  return parts.join("\n") || customerMessage.trim();
}

export async function fetchLessonHintsText(opts: {
  tenantId: string;
  history: Array<{ role: string; text: string }>;
  customerMessage?: string;
}): Promise<string> {
  if (!config.conversationLearningEnabled || !opts.customerMessage?.trim()) return "";
  const query = composeRagQueryForLessons(opts.history, opts.customerMessage);
  const hits = await retrieveCorrectionLessons({ tenantId: opts.tenantId, query, k: 4, minScore: 0.17 });
  if (hits.length === 0) return "";

  const lines = hits.map((h, i) => {
    const situation = clip(h.userText, 520);
    const rule = clip(h.assistantText, 420);
    return `${i + 1}. [similarity ${h.score.toFixed(2)}] Situation/context:\n${situation}\n   → Prefer this behavior:\n${rule}`;
  });

  return [
    "CONVERSATION_LESSONS from past shopper corrections — follow these over habitual templates when relevant:",
    ...lines,
    "If none apply to this exact turn, ignore.",
  ].join("\n\n");
}

export async function maybeRecordCorrectionFromInbound(args: {
  tenantId: string;
  conversationId: string;
  customerText: string;
}): Promise<void> {
  if (!config.conversationLearningEnabled) return;
  const raw = args.customerText?.trim();
  if (!raw || !looksLikeCustomerCorrection(raw)) return;

  try {
    const lastAssistant = await prisma.messengerMessage.findFirst({
      where: { conversationId: args.conversationId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    if (!lastAssistant?.text?.trim()) return;

    const prevUserTurn = await prisma.messengerMessage.findFirst({
      where: { conversationId: args.conversationId, role: "user" },
      orderBy: { createdAt: "desc" },
      skip: 1,
      select: { text: true },
    });

    const botSnippet = clip(lastAssistant.text, 450);
    const priorUser = prevUserTurn?.text ? clip(prevUserTurn.text, 320) : "";

    const userText =
      `PRIOR_CUSTOMER: ${priorUser || "(unknown)"}\n` +
      `BOT_SAID: ${botSnippet}\n` +
      `CUSTOMER_CORRECTION: ${clip(raw, 480)}`;

    const assistantText =
      `Do not repeat the misunderstood behavior from BOT_SAID. ` +
      `Treat the shopper's correction as ground truth and align the next reply with: ${clip(raw, 400)}`;

    const duplicate = await prisma.knowledgeExample.findFirst({
      where: { tenantId: args.tenantId, userText },
      select: { id: true },
    });
    if (duplicate) return;

    const embedding = await embed(userText, "document");
    if (!embedding || embedding.length === 0) {
      logger.warn({ tenantId: args.tenantId }, "conversation learning skipped — embed failed");
      return;
    }

    await prisma.knowledgeExample.create({
      data: {
        tenantId: args.tenantId,
        source: "live",
        userText,
        assistantText,
        embedding,
        metadata: {
          kind: "correction",
          conversationId: args.conversationId,
          learnedAt: new Date().toISOString(),
        },
      },
    });
    invalidateRagCache(args.tenantId);
    logger.info({ tenantId: args.tenantId, conversationId: args.conversationId }, "recorded conversation correction lesson");
  } catch (e) {
    logger.warn({ e: String(e), tenantId: args.tenantId }, "maybeRecordCorrectionFromInbound failed");
  }
}
