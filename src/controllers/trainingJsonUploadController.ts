import type { Request, Response } from "express";
import fs from "node:fs/promises";
import {
  appendJsonlLines,
  clearTrainingCorpus,
  getTrainingCorpusStatus,
  parseJsonFileContentToLines,
} from "../services/trainingJsonCorpusService.js";

type MulterDiskFile = Express.Multer.File & { path: string };

function isDiskFile(f: Express.Multer.File): f is MulterDiskFile {
  return typeof (f as MulterDiskFile).path === "string" && (f as MulterDiskFile).path.length > 0;
}

export async function getTrainingJsonCorpus(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const corpus = await getTrainingCorpusStatus(t.id);
  res.json({ corpus });
}

export async function deleteTrainingJsonCorpus(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  await clearTrainingCorpus(t.id);
  res.json({ ok: true });
}

export async function postTrainingJsonBatch(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) {
    res.status(400).json({ error: "no_files", hint: "multipart field name must be 'files'" });
    return;
  }

  const allLines: string[] = [];
  const warnings: { file: string; detail: string }[] = [];

  for (const f of files) {
    const name = f.originalname || "unknown";
    const lower = name.toLowerCase();
    if (!lower.endsWith(".json") && !lower.endsWith(".jsonl")) {
      warnings.push({ file: name, detail: "skipped (not .json or .jsonl)" });
      if (isDiskFile(f)) await fs.unlink(f.path).catch(() => {});
      continue;
    }
    if (!isDiskFile(f)) {
      warnings.push({ file: name, detail: "internal: expected disk upload" });
      continue;
    }
    try {
      const raw = await fs.readFile(f.path, "utf8");
      const { lines, error } = parseJsonFileContentToLines(raw, name);
      if (error || lines.length === 0) {
        warnings.push({ file: name, detail: error || "no JSON lines extracted" });
      } else {
        allLines.push(...lines);
      }
    } catch (e) {
      warnings.push({ file: name, detail: e instanceof Error ? e.message : String(e) });
    }
    await fs.unlink(f.path).catch(() => {});
  }

  if (allLines.length === 0) {
    res.status(400).json({ error: "nothing_to_import", warnings });
    return;
  }

  await appendJsonlLines(t.id, allLines);
  const corpus = await getTrainingCorpusStatus(t.id);
  res.json({
    ok: true,
    linesThisBatch: allLines.length,
    filesReceived: files.length,
    warnings,
    corpus,
  });
}
