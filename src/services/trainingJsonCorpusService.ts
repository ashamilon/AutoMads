import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(process.cwd(), "data", "training-json");

function corpusPath(tenantId: string): string {
  return path.join(ROOT, tenantId, "corpus.jsonl");
}

export function getTrainingCorpusFilePath(tenantId: string): string {
  return corpusPath(tenantId);
}

function metaPath(tenantId: string): string {
  return path.join(ROOT, tenantId, "meta.json");
}

export type TrainingCorpusMeta = {
  lineCount: number;
  byteSize: number;
  updatedAt: string;
};

const appendChains = new Map<string, Promise<void>>();

function enqueueTenantWrite(tenantId: string, fn: () => Promise<void>): Promise<void> {
  const prev = appendChains.get(tenantId) ?? Promise.resolve();
  const next = prev.then(fn).catch((e) => {
    throw e;
  });
  appendChains.set(
    tenantId,
    next.catch(() => {
      /* swallow so chain continues */
    }),
  );
  return next;
}

async function readMeta(tenantId: string): Promise<TrainingCorpusMeta> {
  try {
    const raw = await fs.readFile(metaPath(tenantId), "utf8");
    const j = JSON.parse(raw) as TrainingCorpusMeta;
    if (typeof j.lineCount === "number" && typeof j.byteSize === "number") return j;
  } catch {
    /* missing */
  }
  return { lineCount: 0, byteSize: 0, updatedAt: new Date(0).toISOString() };
}

async function writeMeta(tenantId: string, m: TrainingCorpusMeta): Promise<void> {
  await fs.mkdir(path.dirname(metaPath(tenantId)), { recursive: true });
  await fs.writeFile(metaPath(tenantId), JSON.stringify(m, null, 0), "utf8");
}

/**
 * Parse one .json or .jsonl file into JSONL line strings (compact JSON per line).
 */
export function parseJsonFileContentToLines(
  raw: string,
  filename: string,
): { lines: string[]; error?: string } {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jsonl")) {
    const lines: string[] = [];
    const rows = raw.split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i]?.trim();
      if (!t) continue;
      try {
        lines.push(JSON.stringify(JSON.parse(t)));
      } catch {
        return { lines: [], error: `${filename}:${i + 1} invalid JSONL` };
      }
    }
    return { lines };
  }
  if (!lower.endsWith(".json")) {
    return { lines: [], error: `${filename}: use .json or .jsonl` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { lines: [], error: `${filename}: ${e instanceof Error ? e.message : "invalid JSON"}` };
  }
  if (Array.isArray(parsed)) {
    const lines: string[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i];
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        return { lines: [], error: `${filename}: array[${i}] must be a JSON object` };
      }
      lines.push(JSON.stringify(row));
    }
    return { lines };
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { lines: [JSON.stringify(parsed)] };
  }
  return { lines: [], error: `${filename}: root must be object or array of objects` };
}

export async function appendJsonlLines(tenantId: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const block = lines.map((l) => `${l}\n`).join("");
  await enqueueTenantWrite(tenantId, async () => {
    const c = corpusPath(tenantId);
    await fs.mkdir(path.dirname(c), { recursive: true });
    await fs.appendFile(c, block, "utf8");
    const meta = await readMeta(tenantId);
    const st = await fs.stat(c).catch(() => null);
    meta.lineCount += lines.length;
    meta.byteSize = st?.size ?? meta.byteSize + Buffer.byteLength(block, "utf8");
    meta.updatedAt = new Date().toISOString();
    await writeMeta(tenantId, meta);
  });
}

export async function getTrainingCorpusStatus(tenantId: string): Promise<TrainingCorpusMeta> {
  const c = corpusPath(tenantId);
  const st = await fs.stat(c).catch(() => null);
  if (!st) {
    return { lineCount: 0, byteSize: 0, updatedAt: new Date(0).toISOString() };
  }
  const meta = await readMeta(tenantId);
  meta.byteSize = st.size;
  if (meta.lineCount === 0 && st.size > 0) {
    meta.lineCount = await countLinesStreaming(c);
    await writeMeta(tenantId, meta);
  }
  return meta;
}

async function countLinesStreaming(filePath: string): Promise<number> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  let n = 0;
  for await (const chunk of stream) {
    const s = typeof chunk === "string" ? chunk : String(chunk);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\n") n++;
    }
  }
  return n;
}

export async function clearTrainingCorpus(tenantId: string): Promise<void> {
  const dir = path.join(ROOT, tenantId);
  await enqueueTenantWrite(tenantId, async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
}

export function trainingTempDir(tenantId: string): string {
  return path.join(ROOT, tenantId, "tmp");
}
