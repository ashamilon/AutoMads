/// <reference types="multer" />
import axios from "axios";
import { z } from "zod";
import { config } from "../config/index.js";
import type { BotPersona } from "../llm/ollamaService.js";
import { parseJsonObjectFromLlmContent } from "../llm/ollamaService.js";
import { logger } from "../utils/logger.js";

const synthesisSchema = z.object({
  name: z.string().optional(),
  tone: z.string().min(1),
  examples: z.array(z.object({ user: z.string(), assistant: z.string() })).min(1).max(20),
});

const MAX_TRANSCRIPT = 16_000;
const MIN_TRANSCRIPT = 40;

const SYNTH_SYSTEM = `You are preparing few-shot training for a Facebook Messenger shop bot in Bangladesh.
You receive raw text: exported chat logs, pasted threads, and/or messy OCR from screenshots of Messenger.
Infer how the SELLER (shop) writes: Banglish, Bangla in Latin script, short warm lines, emojis or not, etc.
Output a single JSON object with:
- "name" (optional string): a short display name for the shop persona if clear from the text
- "tone" (string, 2-6 sentences): how the bot should write — not marketing fluff, how THIS shop actually sounds
- "examples" (array, 8-15 items): { "user": "...", "assistant": "..." } where "user" is the customer and "assistant" is the shop's reply. Use real lines from the material when possible; if the export is one-sided, invent minimal realistic pairs in the same voice.
Rules: JSON only, no markdown fences, no code blocks.`;

function isTextishFile(f: Express.Multer.File): boolean {
  const n = f.originalname.toLowerCase();
  if (n.endsWith(".txt") || n.endsWith(".csv") || n.endsWith(".log") || n.endsWith(".json")) {
    return true;
  }
  if (/^text\//.test(f.mimetype) || f.mimetype === "application/json") return true;
  return false;
}

function isImageFile(f: Express.Multer.File): boolean {
  if (/^image\//.test(f.mimetype)) return true;
  const n = f.originalname.toLowerCase();
  return /\.(png|jpe?g|webp|gif)$/i.test(n);
}

export function fileSupportedForPersona(f: Express.Multer.File): boolean {
  return isTextishFile(f) || isImageFile(f);
}

export async function gatherTextFromUploads(
  files: Express.Multer.File[],
  paste: string,
): Promise<string> {
  const parts: string[] = [];
  if (paste?.trim()) {
    parts.push("--- Pasted by owner ---\n" + paste.trim());
  }
  for (const f of files) {
    if (!f.buffer?.length) continue;
    try {
      if (isTextishFile(f)) {
        const t = f.buffer.toString("utf8");
        if (t.trim()) parts.push(`--- File: ${f.originalname} ---\n${t.trim()}`);
        continue;
      }
      if (isImageFile(f)) {
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng", 1, { logger: () => undefined });
        const {
          data: { text },
        } = await worker.recognize(f.buffer);
        await worker.terminate();
        if (text?.trim()) {
          parts.push(`--- OCR: ${f.originalname} ---\n${text.trim()}`);
        }
      }
    } catch (e) {
      logger.warn({ e: String(e), file: f.originalname }, "persona: file skipped");
    }
  }
  return parts.join("\n\n");
}

export async function synthesizePersonaFromTranscript(
  transcript: string,
  businessName: string,
): Promise<BotPersona> {
  const raw = transcript.trim().slice(0, MAX_TRANSCRIPT);
  if (raw.length < MIN_TRANSCRIPT) {
    throw new Error("not_enough_text");
  }
  const userBlock = `Shop / business: ${businessName}

Material:
${raw}

Return the JSON object as specified.`;

  const res = await axios.post(
    `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`,
    {
      model: config.ollamaModel,
      messages: [
        { role: "system", content: SYNTH_SYSTEM },
        { role: "user", content: userBlock },
      ],
      stream: false,
      format: "json",
      options: { temperature: 0.25, num_predict: 4_000 },
    },
    { timeout: Math.min(config.ollamaTimeoutMs, 300_000) },
  );
  const content = res.data?.message?.content;
  const parsed = parseJsonObjectFromLlmContent(content);
  const o = synthesisSchema.parse(parsed);
  return { name: o.name, tone: o.tone, examples: o.examples };
}
