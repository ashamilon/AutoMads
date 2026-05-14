import axios from "axios";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
const ENDPOINT = `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/embeddings`;

/** nomic-embed-text requires task-specific prefixes or every vector collapses to the same anchor.
 *  - Stored past conversation pairs are "documents".
 *  - The incoming customer message we search with is a "query". */
export type EmbedTask = "document" | "query";

function isNomic(model: string): boolean {
  return model.toLowerCase().includes("nomic");
}

function withTaskPrefix(text: string, task: EmbedTask): string {
  if (!isNomic(MODEL)) return text;
  return task === "query" ? `search_query: ${text}` : `search_document: ${text}`;
}

/**
 * Get one embedding vector for a string.
 * Uses Ollama's local nomic-embed-text by default — fast, no GPU needed.
 * Pass task="query" when embedding something you will search *with*,
 * and task="document" when embedding something you will be searched *against*.
 */
export async function embed(text: string, task: EmbedTask = "query"): Promise<number[] | null> {
  if (!text || !text.trim()) return null;
  try {
    const prompt = withTaskPrefix(text.slice(0, 4000), task);
    const res = await axios.post(
      ENDPOINT,
      { model: MODEL, prompt },
      { timeout: 30_000 },
    );
    const v = res.data?.embedding;
    return Array.isArray(v) ? v : null;
  } catch (e) {
    logger.warn({ e: String(e) }, "Embed failed");
    return null;
  }
}

/** Batch embeddings sequentially with a small delay so we don't blast Ollama. */
export async function embedBatch(
  texts: string[],
  opts?: { onProgress?: (done: number, total: number) => void; task?: EmbedTask },
): Promise<(number[] | null)[]> {
  const task = opts?.task ?? "document";
  const out: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i++) {
    const v = await embed(texts[i] ?? "", task);
    out.push(v);
    opts?.onProgress?.(i + 1, texts.length);
  }
  return out;
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
