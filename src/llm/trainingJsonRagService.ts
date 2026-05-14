import fs from "node:fs/promises";
import { getTrainingCorpusFilePath } from "../services/trainingJsonCorpusService.js";
import { logger } from "../utils/logger.js";

type CorpusDoc = {
  text: string;
};

type CorpusIndexCache = {
  loadedAt: number;
  mtimeMs: number;
  docs: CorpusDoc[];
};

const CACHE = new Map<string, CorpusIndexCache>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_LINES_TO_INDEX = 1200;
const MAX_DOC_TEXT_CHARS = 420;
const MIN_TOKEN_LEN = 2;

function flattenJsonForSearch(value: unknown, path = ""): string[] {
  if (value == null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const key = path ? `${path}: ` : "";
    return [`${key}${String(value)}`];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(...flattenJsonForSearch(value[i], path ? `${path}[${i}]` : `[${i}]`));
    }
    return out;
  }
  if (typeof value === "object") {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(...flattenJsonForSearch(v, path ? `${path}.${k}` : k));
    }
    return out;
  }
  return [];
}

function toSearchableText(json: unknown): string {
  const fields = flattenJsonForSearch(json);
  return fields.join(" | ").slice(0, MAX_DOC_TEXT_CHARS).trim();
}

async function loadCorpusIndex(tenantId: string): Promise<CorpusDoc[]> {
  const filePath = getTrainingCorpusFilePath(tenantId);
  const st = await fs.stat(filePath).catch(() => null);
  if (!st) return [];

  const hit = CACHE.get(tenantId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS && hit.mtimeMs === st.mtimeMs) {
    return hit.docs;
  }

  const raw = await fs.readFile(filePath, "utf8");
  const rows = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_LINES_TO_INDEX);

  const texts: string[] = [];
  for (const line of rows) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const t = toSearchableText(parsed);
      if (t.length >= 4) texts.push(t);
    } catch {
      // Keep retrieval robust against mixed/invalid lines.
    }
  }

  if (texts.length === 0) return [];

  const docs: CorpusDoc[] = texts.map((t) => ({ text: t }));

  CACHE.set(tenantId, { loadedAt: Date.now(), mtimeMs: st.mtimeMs, docs });
  logger.info({ tenantId, docs: docs.length }, "training-json corpus index loaded");
  return docs;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

function lexicalScore(query: string, text: string): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  const tTokens = new Set(tokenize(text));
  if (tTokens.size === 0) return 0;

  let overlap = 0;
  for (const q of qTokens) {
    if (tTokens.has(q)) overlap += 1;
  }
  const overlapRatio = overlap / qTokens.size;
  const substringBoost = text.toLowerCase().includes(query.toLowerCase().trim()) ? 0.35 : 0;
  return overlapRatio + substringBoost;
}

export async function retrieveTrainingCorpusSnippets(opts: {
  tenantId: string;
  query: string;
  k?: number;
  minScore?: number;
  maxTotalChars?: number;
}): Promise<string[]> {
  const q = opts.query.trim();
  if (!q) return [];

  const docs = await loadCorpusIndex(opts.tenantId);
  if (docs.length === 0) return [];

  const minScore = opts.minScore ?? 0.25;
  const k = Math.max(1, opts.k ?? 4);
  const maxTotalChars = Math.max(200, opts.maxTotalChars ?? 1200);

  const scored: { text: string; score: number }[] = [];
  for (const d of docs) {
    const s = lexicalScore(q, d.text);
    if (s >= minScore) scored.push({ text: d.text, score: s });
  }
  scored.sort((a, b) => b.score - a.score);

  const out: string[] = [];
  let used = 0;
  for (const row of scored.slice(0, k)) {
    const candidate = row.text.slice(0, 380);
    if (used + candidate.length > maxTotalChars) break;
    out.push(candidate);
    used += candidate.length;
  }
  return out;
}

export function invalidateTrainingCorpusRagCache(tenantId?: string): void {
  if (tenantId) CACHE.delete(tenantId);
  else CACHE.clear();
}
