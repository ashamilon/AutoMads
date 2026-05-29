/**
 * Single point through which every Ollama `/api/chat` call goes.
 *
 * Why this exists
 * ───────────────
 * Cloud-hosted models like `gemma4:31b-cloud` enforce per-account weekly
 * quotas. When the quota is exhausted Ollama returns HTTP 429 with a JSON
 * body like:
 *
 *   {"error":"you (...) have reached your weekly usage limit, ..."}
 *
 * Without a fallback, every downstream feature — the conversational agent,
 * caption generation, jersey identification, persona learning — silently
 * stops working until the next billing cycle. The platform is supposed to
 * keep functioning even under quota pressure, so this wrapper transparently
 * retries the same request against a smaller LOCAL model that has no
 * external quota.
 *
 * Behaviour
 * ─────────
 * 1. First attempt uses the configured "primary" model (typically the cloud
 *    model from `OLLAMA_MODEL`).
 * 2. If the call fails with HTTP 429 or any error message containing the
 *    "weekly usage limit" / "upgrade for higher limits" markers, we mark
 *    the cloud as "exhausted" for `CLOUD_EXHAUSTED_TTL_MS` and retry the
 *    same request body against the local fallback model.
 * 3. While the cloud is marked exhausted, we skip the cloud entirely and
 *    go straight to the local fallback — so we don't waste time + bandwidth
 *    on requests we know will 429.
 * 4. The fallback model is configurable via env (`OLLAMA_FALLBACK_MODEL`).
 *    Default = `qwen3.5:2b` (matches the model the user already has
 *    installed locally).
 *
 * Anything beyond the model + the cooldown is left untouched: callers
 * supply the same `messages`, `images`, `format`, `options` payload as
 * before, and we forward it as-is.
 */

import axios, { type AxiosResponse } from "axios";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

/** Local backup model used when the cloud quota is hit. Override via env. */
const FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL?.trim() || "qwen3.5:2b";

/** How long to short-circuit the cloud after a quota error (default 5 min). */
const CLOUD_EXHAUSTED_TTL_MS = Number(process.env.OLLAMA_CLOUD_QUOTA_TTL_MS ?? 5 * 60 * 1000);

let cloudExhaustedUntil = 0;

function markCloudExhausted(): void {
  cloudExhaustedUntil = Date.now() + CLOUD_EXHAUSTED_TTL_MS;
}

function cloudIsExhausted(): boolean {
  return Date.now() < cloudExhaustedUntil;
}

/** Heuristic: any Ollama response that screams "quota exceeded". */
function isCloudQuotaResponse(status: number, data: unknown): boolean {
  if (status === 429) return true;
  const msg = (data && typeof data === "object" && (data as { error?: unknown }).error) || "";
  if (typeof msg !== "string") return false;
  const m = msg.toLowerCase();
  return (
    m.includes("weekly usage limit") ||
    m.includes("daily usage limit") ||
    m.includes("upgrade for higher limits") ||
    m.includes("rate limit")
  );
}

export interface OllamaChatBody {
  /** Caller-supplied; if omitted we use the configured primary model. */
  model?: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
    images?: string[];
  }>;
  /** Pass-through flag — see Ollama docs. We always force `false` so the
   *  caller never has to deal with newline-delimited JSON. */
  stream?: false;
  /** Pass-through. */
  format?: string | object;
  /** Pass-through. */
  options?: Record<string, unknown>;
  /** Pass-through. */
  keep_alive?: string | number;
}

export interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  done?: boolean;
  // …other fields Ollama returns; we don't typecheck them.
  [key: string]: unknown;
}

export interface OllamaChatOptions {
  /** Per-call timeout (ms). Default 60s. */
  timeoutMs?: number;
  /** Set true to disable failover (e.g. for tests that explicitly pin the
   *  primary model). Default: false. */
  noFallback?: boolean;
}

async function postChat(
  baseUrl: string,
  model: string,
  body: OllamaChatBody,
  timeoutMs: number,
): Promise<AxiosResponse<OllamaChatResponse>> {
  return axios.post<OllamaChatResponse>(
    `${baseUrl.replace(/\/$/, "")}/api/chat`,
    { ...body, model, stream: false },
    { timeout: timeoutMs, validateStatus: () => true },
  );
}

/**
 * Single entry point for every Ollama chat call. Returns the same response
 * shape Ollama's REST API does. Throws on terminal errors (network down,
 * fallback also fails). Never throws purely because the cloud is over
 * quota — that path is handled silently.
 */
export async function ollamaChat(
  body: OllamaChatBody,
  opts: OllamaChatOptions = {},
): Promise<AxiosResponse<OllamaChatResponse>> {
  const baseUrl = config.ollamaBaseUrl;
  const timeoutMs = opts.timeoutMs ?? config.ollamaTimeoutMs ?? 60_000;
  const primaryModel = body.model ?? config.ollamaModel;

  // Skip the cloud when we already know it's over quota for the cooldown
  // window. This both speeds up requests and avoids burning whatever the
  // platform's per-IP rate limit is on the cloud endpoint.
  if (!opts.noFallback && cloudIsExhausted()) {
    return postChat(baseUrl, FALLBACK_MODEL, body, timeoutMs);
  }

  const primary = await postChat(baseUrl, primaryModel, body, timeoutMs);
  if (primary.status === 200) return primary;

  if (opts.noFallback) {
    return primary; // caller wants the raw error
  }

  if (isCloudQuotaResponse(primary.status, primary.data)) {
    logger.warn(
      {
        primaryModel,
        fallbackModel: FALLBACK_MODEL,
        status: primary.status,
        cooldownMs: CLOUD_EXHAUSTED_TTL_MS,
      },
      "ollamaChat: cloud quota hit — failing over to local model",
    );
    markCloudExhausted();
    return postChat(baseUrl, FALLBACK_MODEL, body, timeoutMs);
  }

  // Non-quota errors: propagate to caller — the fallback isn't always a
  // good substitute (e.g. for vision-only requests qwen3.5:2b text-only
  // can't help). Caller decides how to handle.
  return primary;
}

/** Force the cooldown to expire — useful for tests + admin cache-clear endpoints. */
export function resetCloudExhaustedCache(): void {
  cloudExhaustedUntil = 0;
}

/** Read-only: how the cooldown looks right now. */
export function getCloudExhaustedState(): { exhausted: boolean; untilMs: number } {
  return {
    exhausted: cloudIsExhausted(),
    untilMs: cloudExhaustedUntil,
  };
}
