"use client";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { getApiBase, getStoredApiKey, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Files, Loader2, Trash2, Upload } from "lucide-react";
import type { InputHTMLAttributes } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const folderPickerProps = {
  webkitdirectory: "",
  directory: "",
} as InputHTMLAttributes<HTMLInputElement>;

const BATCH_SIZE = 100;
const MAX_FILE_MB = 5;

type CorpusMeta = { lineCount: number; byteSize: number; updatedAt: string };

type BatchResponse = {
  ok: boolean;
  linesThisBatch: number;
  filesReceived: number;
  warnings?: { file: string; detail: string }[];
  corpus: CorpusMeta;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function pickJsonFiles(list: FileList | File[]): File[] {
  return Array.from(list).filter((f) => {
    const n = f.name.toLowerCase();
    return n.endsWith(".json") || n.endsWith(".jsonl");
  });
}

async function postTrainingBatch(files: File[]): Promise<BatchResponse> {
  const key = getStoredApiKey();
  if (!key) throw new Error("Not signed in");
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const res = await fetch(`${getApiBase()}/api/v1/training-json/batch`, {
    method: "POST",
    body: form,
    headers: { Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain */
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data ? JSON.stringify(data) : text || res.statusText;
    throw new ApiError(msg, res.status, text);
  }
  return data as BatchResponse;
}

export default function TrainingDataPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const [corpus, setCorpus] = useState<CorpusMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [msg, setMsg] = useState("");
  const [warnTail, setWarnTail] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const key = getStoredApiKey();
      if (!key) return;
      const res = await fetch(`${getApiBase()}/api/v1/training-json`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const j = (await res.json()) as { corpus: CorpusMeta };
      if (res.ok) setCorpus(j.corpus);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runUpload(list: FileList | File[]) {
    const files = Array.from(list);
    const jsonFiles = pickJsonFiles(files);
    if (jsonFiles.length === 0) {
      setMsg("No .json or .jsonl files in your selection.");
      return;
    }
    const skipped = files.length - jsonFiles.length;
    setMsg(
      skipped > 0
        ? `Uploading ${jsonFiles.length} JSON file(s) (${skipped} other file(s) ignored).`
        : `Uploading ${jsonFiles.length} JSON file(s) in batches of ${BATCH_SIZE}…`,
    );
    setWarnTail([]);
    setUploading(true);
    let totalLines = 0;
    const allWarns: string[] = [];
    try {
      for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
        const chunk = jsonFiles.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(jsonFiles.length / BATCH_SIZE);
        setProgress(`Batch ${batchNum} / ${totalBatches} (${chunk.length} files)…`);
        const r = await postTrainingBatch(chunk);
        totalLines += r.linesThisBatch;
        if (r.corpus) setCorpus(r.corpus);
        for (const w of r.warnings ?? []) {
          allWarns.push(`${w.file}: ${w.detail}`);
        }
      }
      setProgress("");
      setMsg(`Done. +${totalLines} line(s) added to your corpus.`);
      setWarnTail(allWarns.slice(-40));
      await refresh();
    } catch (e) {
      setProgress("");
      setMsg(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      if (folderRef.current) folderRef.current.value = "";
    }
  }

  async function clearCorpus() {
    if (!confirm("Delete all uploaded training data for this workspace?")) return;
    const key = getStoredApiKey();
    if (!key) return;
    setMsg("");
    try {
      const res = await fetch(`${getApiBase()}/api/v1/training-json`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(await res.text());
      setCorpus({ lineCount: 0, byteSize: 0, updatedAt: new Date(0).toISOString() });
      setMsg("Corpus cleared.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Clear failed");
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <>
            <Files className="h-3.5 w-3.5" /> Large uploads
          </>
        }
        title="Training JSON"
        description={`Drop thousands of small JSON files (up to ${MAX_FILE_MB} MB each). The server merges them into one JSONL corpus per workspace — no local scripts required.`}
      />

      <Section
        title="Corpus on server"
        description="One merged file per tenant: corpus.jsonl + line count."
      >
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : corpus ? (
          <ul className="space-y-1 font-mono text-sm text-slate-300">
            <li>Lines: {corpus.lineCount.toLocaleString()}</li>
            <li>Size: {formatBytes(corpus.byteSize)}</li>
            <li className="text-slate-500">Updated: {corpus.updatedAt || "—"}</li>
          </ul>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={() => void refresh()} disabled={loading}>
            Refresh stats
          </Button>
          <Button
            type="button"
            variant="danger"
            className="gap-1.5"
            onClick={() => void clearCorpus()}
            disabled={!corpus || corpus.lineCount === 0}
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear corpus
          </Button>
        </div>
      </Section>

      <Section
        title="Upload"
        description={`Select many files or an entire folder (Chrome / Edge). Batches of ${BATCH_SIZE} files per request, up to ${MAX_FILE_MB} MB per file.`}
      >
        <div className="flex flex-wrap gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".json,.jsonl,application/json"
            multiple
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files;
              if (f?.length) void runUpload(f);
            }}
          />
          <input
            ref={folderRef}
            type="file"
            multiple
            className="hidden"
            disabled={uploading}
            {...folderPickerProps}
            onChange={(e) => {
              const f = e.target.files;
              if (f?.length) void runUpload(f);
            }}
          />
          <Button
            type="button"
            className="gap-2"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Choose files
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="gap-2"
            disabled={uploading}
            onClick={() => folderRef.current?.click()}
          >
            <Files className="h-4 w-4" />
            Choose folder
          </Button>
        </div>
        {progress ? (
          <p className={cn("mt-3 text-sm text-accent-bright")}>{progress}</p>
        ) : null}
        {msg ? <p className="mt-3 text-sm text-slate-300">{msg}</p> : null}
        {warnTail.length > 0 ? (
          <details className="mt-3 text-xs text-amber-200/90">
            <summary className="cursor-pointer">Recent warnings ({warnTail.length})</summary>
            <ul className="mt-2 max-h-48 list-inside list-disc overflow-y-auto font-mono text-slate-400">
              {warnTail.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </Section>
    </div>
  );
}
