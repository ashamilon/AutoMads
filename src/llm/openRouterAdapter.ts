/**
 * OpenRouter adapter with multi-key failover.
 *
 * Lets our existing Ollama-style code paths talk to OpenRouter's
 * OpenAI-compatible chat-completion endpoint without rewriting every call
 * site. Adds three failover layers on top:
 *
 *   1. **Multi-key OpenRouter rotation.** `OPENROUTER_API_KEY` accepts a
 *      comma-separated list. When a key returns 429 (rate limit), 401 / 403
 *      (auth), or 5xx, we move on to the next key. Keys that fail on a
 *      given hour are temporarily marked "cold" so we don't hammer them.
 *   2. **Ollama fallback.** When every OpenRouter key is exhausted AND
 *      `OPENROUTER_FALLBACK_TO_OLLAMA` is on, the request is reissued
 *      against the local / cloud Ollama at `OLLAMA_BASE_URL` in the
 *      original Ollama-shaped body so the existing local pipeline kicks
 *      in. (This only helps if the cloud Ollama account isn't itself
 *      rate-limited, but it's still a useful third tier.)
 *   3. **Transparent shape conversion.** Callers send Ollama-format
 *      requests and read Ollama-format responses. The interceptor
 *      translates request → OpenAI multimodal, response → Ollama envelope.
 *      Vision (`images: [base64]`) and JSON mode (`format: "json"`) are
 *      both preserved.
 *
 * Strict opt-in: if `OPENROUTER_API_KEY` is empty, the interceptor is a
 * no-op and Ollama is hit directly as before.
 */

import axios, { type AxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

let installed = false;

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
};

type OllamaRequestBody = {
  model?: string;
  messages?: OllamaMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
    [k: string]: unknown;
  };
  format?: string | object;
};

/**
 * Translate one Ollama message to OpenAI shape, handling attached images
 * via the multimodal `content: [{type:'image_url',...}]` array form.
 */
function translateMessage(m: OllamaMessage): {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }>;
} {
  if (!m.images || m.images.length === 0) {
    return { role: m.role, content: m.content };
  }
  const parts: Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }> = [];
  if (m.content && m.content.trim().length > 0) {
    parts.push({ type: "text", text: m.content });
  }
  for (const b64 of m.images) {
    if (!b64 || typeof b64 !== "string") continue;
    const dataUrl = b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
  }
  return { role: m.role, content: parts };
}

function isOllamaChatRequest(reqUrl: string | undefined, data: unknown): data is OllamaRequestBody {
  if (!reqUrl) return false;
  if (!reqUrl.endsWith("/api/chat") && !reqUrl.includes("/api/chat?")) return false;
  if (!data || typeof data !== "object") return false;
  return Array.isArray((data as OllamaRequestBody).messages);
}

function buildOpenAiBody(ollamaBody: OllamaRequestBody): Record<string, unknown> {
  const messages = (ollamaBody.messages ?? []).map(translateMessage);
  const out: Record<string, unknown> = {
    model: config.openRouter.model,
    messages,
  };
  if (ollamaBody.options?.temperature != null) out.temperature = ollamaBody.options.temperature;
  if (ollamaBody.options?.num_predict != null) out.max_tokens = ollamaBody.options.num_predict;
  if (ollamaBody.options?.top_p != null) out.top_p = ollamaBody.options.top_p;
  if (ollamaBody.format === "json") out.response_format = { type: "json_object" };
  return out;
}

/** OpenAI → Ollama envelope so callers reading `res.data.message.content` keep working. */
function wrapAsOllama(openRouterRes: AxiosResponse): AxiosResponse {
  const data = openRouterRes.data;
  const content = data?.choices?.[0]?.message?.content ?? "";
  const flat = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
          .join("")
      : "";
  return {
    ...openRouterRes,
    data: {
      model: data?.model,
      created_at: data?.created
        ? new Date(data.created * 1000).toISOString()
        : new Date().toISOString(),
      message: { role: "assistant", content: flat },
      done: true,
      total_duration: 0,
      _provider: "openrouter",
      _openrouter: data,
    },
  };
}

// ─── Per-key cooldown bookkeeping ────────────────────────────────────────────

type KeyState = {
  /** Epoch ms — earliest time this key may be used again. */
  coldUntil: number;
  /** Last seen status code (for diagnostics). */
  lastStatus: number;
};

const keyState = new Map<string, KeyState>();

/**
 * Mark a key as temporarily out of service. We don't try to be smart about
 * the OpenRouter `Retry-After` header (it's often missing on free-tier
 * 429s); a simple 60-second cooldown is enough for a multi-key rotation
 * to work, and we log the underlying status so an operator can see why.
 */
function coolDownKey(apiKey: string, status: number, ms = 60_000): void {
  keyState.set(apiKey, {
    coldUntil: Date.now() + ms,
    lastStatus: status,
  });
}

function isKeyAvailable(apiKey: string): boolean {
  const s = keyState.get(apiKey);
  return !s || Date.now() >= s.coldUntil;
}

function pickWarmKeys(apiKeys: string[]): string[] {
  const warm = apiKeys.filter(isKeyAvailable);
  // If every key is cold, return them all anyway — we'd rather try a 429 than
  // outright skip OpenRouter and go straight to Ollama. The cooldown is
  // a hint, not a hard ban.
  return warm.length > 0 ? warm : apiKeys;
}

// ─── Single-attempt POST ────────────────────────────────────────────────────

async function callOpenRouter(args: {
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<AxiosResponse> {
  const url = `${config.openRouter.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.apiKey}`,
    "Content-Type": "application/json",
  };
  if (config.openRouter.referer) headers["HTTP-Referer"] = config.openRouter.referer;
  if (config.openRouter.siteTitle) headers["X-Title"] = config.openRouter.siteTitle;
  return axios.post(url, args.body, {
    headers,
    timeout: args.timeoutMs,
    // We want to see 4xx as a regular response so the caller's retry logic
    // can inspect status without dealing with a thrown error.
    validateStatus: () => true,
  });
}

async function callLocalOllama(args: {
  ollamaBody: OllamaRequestBody;
  timeoutMs: number;
}): Promise<AxiosResponse> {
  // Direct call without our request interceptor (the interceptor only
  // matters when going to OpenRouter). We stamp `_skip_openrouter: true`
  // on the request config so the interceptor knows to leave us alone.
  const url = `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`;
  return axios.post(
    url,
    { ...args.ollamaBody, model: args.ollamaBody.model ?? config.ollamaModel, stream: false },
    {
      timeout: args.timeoutMs,
      validateStatus: () => true,
      // Sentinel so the request interceptor below skips this call.
      // Cast through unknown because axios's type doesn't expose extras.
      ...(({ _skipOpenRouter: true } as unknown) as AxiosRequestConfig),
    },
  );
}

// ─── The main interceptor entrypoint ────────────────────────────────────────

/** Try each warm key, then optionally fall through to local Ollama. */
async function dispatchWithFailover(
  ollamaBody: OllamaRequestBody,
  timeoutMs: number,
): Promise<AxiosResponse> {
  const apiKeys = config.openRouter.apiKeys;
  const openAiBody = buildOpenAiBody(ollamaBody);
  const warm = pickWarmKeys(apiKeys);

  let lastErrorRes: AxiosResponse | null = null;
  let lastError: AxiosError | Error | null = null;

  for (let i = 0; i < warm.length; i += 1) {
    const apiKey = warm[i]!;
    try {
      const res = await callOpenRouter({ apiKey, body: openAiBody, timeoutMs });
      const ok = res.status >= 200 && res.status < 300 && Array.isArray((res.data as any)?.choices);
      if (ok) {
        // Success — wrap to Ollama shape and return.
        return wrapAsOllama(res);
      }

      // Failure path — diagnose, cool down, try next key.
      const status = res.status;
      const detail = (res.data as any)?.error?.message ?? `HTTP ${status}`;
      logger.warn(
        {
          provider: "openrouter",
          keyIndex: i + 1,
          keyTotal: warm.length,
          status,
          detail: String(detail).slice(0, 200),
        },
        "openrouter: key failed, trying next",
      );
      // 429 / 5xx / 401 → key is unhealthy; cool it down. 429 cools longer.
      const cooldown = status === 429 ? 5 * 60_000 : 60_000;
      coolDownKey(apiKey, status, cooldown);
      lastErrorRes = res;
    } catch (err) {
      const e = err as AxiosError;
      logger.warn(
        { provider: "openrouter", keyIndex: i + 1, error: String(e.message) },
        "openrouter: key threw, trying next",
      );
      coolDownKey(apiKey, 0, 60_000);
      lastError = e;
    }
  }

  // All OpenRouter keys exhausted. Fall through to local Ollama if enabled.
  if (config.openRouter.fallbackToOllama) {
    logger.warn(
      { keyCount: apiKeys.length },
      "openrouter: all keys exhausted, falling through to local Ollama",
    );
    const fallback = await callLocalOllama({ ollamaBody, timeoutMs });
    if (fallback.status >= 200 && fallback.status < 300) return fallback;
    logger.warn(
      { status: fallback.status, detail: String((fallback.data as any)?.error ?? "").slice(0, 200) },
      "openrouter: Ollama fallback also failed",
    );
    // Surface the Ollama failure so the caller's existing fallback (the
    // deterministic template path) can run.
    return fallback;
  }

  // No fallback — surface the last OpenRouter response or rethrow the error.
  if (lastErrorRes) return lastErrorRes;
  throw lastError ?? new Error("openrouter: no keys configured");
}

// ─── Install global axios interceptor ────────────────────────────────────────

export function installOpenRouterAdapter(): void {
  if (installed) return;
  installed = true;

  if (config.openRouter.apiKeys.length === 0) {
    logger.info("openrouter: OPENROUTER_API_KEY not set — using local Ollama");
    return;
  }
  logger.info(
    {
      keyCount: config.openRouter.apiKeys.length,
      baseUrl: config.openRouter.baseUrl,
      model: config.openRouter.model,
      fallbackToOllama: config.openRouter.fallbackToOllama,
    },
    "openrouter: adapter installed (multi-key failover)",
  );

  axios.interceptors.request.use(async (req) => {
    // Sentinel: the Ollama-fallback path inside dispatchWithFailover sets
    // this so we don't loop forever.
    if ((req as unknown as { _skipOpenRouter?: boolean })._skipOpenRouter) return req;
    if (!isOllamaChatRequest(req.url, req.data)) return req;

    const ollamaBody = req.data as OllamaRequestBody;
    const timeoutMs = (req.timeout as number | undefined) ?? config.ollamaTimeoutMs ?? 60_000;

    // Run the failover chain ourselves and short-circuit axios' real
    // request by setting an `adapter` that returns our pre-baked response.
    // This is the official axios pattern for "intercept + replace".
    const adapter: NonNullable<AxiosRequestConfig["adapter"]> = async () => {
      try {
        return await dispatchWithFailover(ollamaBody, timeoutMs);
      } catch (e) {
        // Re-throw as an axios-shaped error so callers' existing catches
        // still work the way they used to.
        const err = new Error(String((e as Error).message ?? e));
        (err as AxiosError).config = req;
        (err as AxiosError).isAxiosError = true;
        throw err;
      }
    };
    req.adapter = adapter;
    return req;
  });
}
