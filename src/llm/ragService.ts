import { prisma } from "../db/prisma.js";
import { config } from "../config/index.js";
import { cosine, embed } from "./embeddingService.js";
import { logger } from "../utils/logger.js";

export type RetrievedExample = {
  userText: string;
  assistantText: string;
  score: number;
};

type RagRow = {
  id: string;
  userText: string;
  assistantText: string;
  embedding: number[];
  metadata: unknown;
};

type CacheEntry = {
  loadedAt: number;
  rows: RagRow[];
};

const TENANT_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadTenantIndex(tenantId: string): Promise<CacheEntry["rows"]> {
  const hit = TENANT_CACHE.get(tenantId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.rows;

  const take = config.ragKnowledgeMaxRows;
  try {
    const rows = await prisma.knowledgeExample.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, userText: true, assistantText: true, embedding: true, metadata: true },
    });
    TENANT_CACHE.set(tenantId, { loadedAt: Date.now(), rows });
    logger.info({ tenantId, count: rows.length, take }, "RAG index loaded");
    return rows;
  } catch (e) {
    logger.warn(
      { tenantId, take, e: String(e) },
      "RAG knowledge load failed (timeout or DB error) — continuing without examples",
    );
    return [];
  }
}

/** Force a refresh, e.g. right after an import. */
export function invalidateRagCache(tenantId?: string): void {
  if (tenantId) TENANT_CACHE.delete(tenantId);
  else TENANT_CACHE.clear();
}

function isCorrectionMetadata(meta: unknown): boolean {
  return Boolean(meta && typeof meta === "object" && !Array.isArray(meta) && (meta as Record<string, unknown>)["kind"] === "correction");
}

/**
 * Live “correction” lessons (`metadata.kind=correction`) — prefer these hits when reminding
 * the model what not to repeat.
 */
export async function retrieveCorrectionLessons(opts: {
  tenantId: string;
  query: string;
  k?: number;
  minScore?: number;
}): Promise<RetrievedExample[]> {
  const k = opts.k ?? 5;
  const minScore = opts.minScore ?? 0.18;
  const queryVec = await embed(opts.query, "query");
  if (!queryVec) return [];
  const rows = (await loadTenantIndex(opts.tenantId)).filter((r) => isCorrectionMetadata(r.metadata));
  const scored: RetrievedExample[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.embedding) || r.embedding.length !== queryVec.length) continue;
    const score = cosine(queryVec, r.embedding);
    if (score >= minScore) {
      scored.push({ userText: r.userText, assistantText: r.assistantText, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Retrieve the top-k most similar past customer→assistant pairs for the given query text. */
export async function retrieveSimilarExamples(opts: {
  tenantId: string;
  query: string;
  k?: number;
  minScore?: number;
}): Promise<RetrievedExample[]> {
  const k = opts.k ?? 8;
  // nomic-embed-text tends to land 0.3–0.45 on genuinely similar Banglish short turns, so 0.2 is
  // a practical floor — above pure noise but inclusive of short-greeting matches.
  const minScore = opts.minScore ?? 0.2;
  const queryVec = await embed(opts.query, "query");
  if (!queryVec) return [];
  const rows = await loadTenantIndex(opts.tenantId);
  if (rows.length === 0) return [];

  const scored: RetrievedExample[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.embedding) || r.embedding.length !== queryVec.length) continue;
    const score = cosine(queryVec, r.embedding);
    if (score >= minScore) {
      scored.push({ userText: r.userText, assistantText: r.assistantText, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
