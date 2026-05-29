import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:4000",
  /** External https URL of the Next.js portal (where /activate, /login live).
   *  Defaults to PUBLIC_PORTAL_URL or the API base URL for dev where they
   *  share a host. Must be set in production where the portal lives on a
   *  different domain than the API. */
  publicPortalUrl: process.env.PUBLIC_PORTAL_URL ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  /** Comma-separated list of allowed origins for browser CORS calls. The
   *  dashboard subdomain MUST be in here in production so the Next.js portal
   *  can call the API with credentials. Empty = allow all (dev-friendly). */
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  /** Must match `ollama list` exactly, e.g. gemma4:31b-cloud */
  ollamaModel: process.env.OLLAMA_MODEL ?? "gemma4:31b-cloud",
  /** Large / cloud models often need 3–10+ minutes first call */
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 600_000),
  adminApiKey: process.env.ADMIN_API_KEY ?? "",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  /** HMAC secret for `/public/messenger-catalog-image`. Falls back to ENCRYPTION_KEY. */
  catalogImageProxySecret: process.env.CATALOG_IMAGE_PROXY_SECRET ?? "",
  sslcommerz: {
    storeId: process.env.SSLCOMMERZ_STORE_ID ?? "",
    storePassword: process.env.SSLCOMMERZ_STORE_PASSWORD ?? "",
    isSandbox: (process.env.SSLCOMMERZ_IS_SANDBOX ?? "true") === "true",
  },
  facebookAppSecret: process.env.FACEBOOK_APP_SECRET ?? "",
  /** Meta App ID — paired with `facebookAppSecret` to drive the self-serve
   *  "Connect with Facebook" OAuth flow. Find under Meta App Dashboard →
   *  App settings → Basic. The same id appears at the top of the Rate Limits
   *  page. Required for the OAuth callback to exchange short-lived user
   *  tokens for long-lived ones. */
  facebookAppId: process.env.FACEBOOK_APP_ID ?? "",
  /**
   * OpenRouter integration — when `OPENROUTER_API_KEY` is set, every Ollama
   * `/api/chat` call our services issue is transparently rerouted to the
   * matching OpenRouter chat-completion endpoint and the response is
   * rewritten back to Ollama shape. This lets us swap the inference
   * provider without touching dozens of caller sites.
   *
   * `apiKeys` is the parsed key list — comma-separated keys in the env are
   * split + trimmed. The adapter rotates through them on 429 / auth
   * failures so a tenant with two free-tier OpenRouter accounts effectively
   * doubles their daily budget.
   *
   * `openRouterModel` is the model id we send (e.g. `google/gemma-4-31b-it:free`).
   * Falls back to a Gemma-4 variant when unset so the default is sensible.
   */
  openRouter: {
    /** Newline / comma separated key list. First-key-wins; rotate on 429. */
    apiKeys: (process.env.OPENROUTER_API_KEY ?? "")
      .split(/[,\n]+/g)
      .map((s) => s.trim())
      .filter(Boolean),
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    model: process.env.OPENROUTER_MODEL ?? "google/gemma-4-31b-it:free",
    /** Optional referer the OpenRouter dashboard uses for analytics. */
    referer: process.env.OPENROUTER_REFERER ?? "https://dashboard.pipwarp.com",
    /** Optional X-Title used in the OpenRouter dashboard. */
    siteTitle: process.env.OPENROUTER_SITE_TITLE ?? "AutoMads",
    /** When true and ALL OpenRouter keys are exhausted, fall through to
     *  the local Ollama endpoint defined by `ollamaBaseUrl`. */
    fallbackToOllama: (process.env.OPENROUTER_FALLBACK_TO_OLLAMA ?? "true").toLowerCase() !== "false",
  },
  /**
   * When true, negative customer cues (ভুল/wrong/etc.) paired with your last bot turn
   * are embedded into KnowledgeExample (`metadata.kind="correction"`) and surfaced on future chats.
   */
  conversationLearningEnabled: (process.env.CONVERSATION_LEARNING_ENABLED ?? "true").toLowerCase() !== "false",
  /**
   * RAG loads recent KnowledgeExample rows per tenant. Each row carries a large embedding vector;
   * loading the whole table can hit Postgres `statement_timeout` on hosted databases. Cap rows here.
   */
  ragKnowledgeMaxRows: (() => {
    const n = Number(process.env.RAG_KNOWLEDGE_MAX_ROWS ?? 2000);
    if (!Number.isFinite(n) || n < 50) return 2000;
    return Math.min(Math.floor(n), 20_000);
  })(),
  /** Optional: Admin API pull for catalog thumbnails (`POST /product-mappings/sync-cloudinary-images`). */
  cloudinary: {
    cloudName: (process.env.CLOUDINARY_CLOUD_NAME ?? "").trim(),
    apiKey: (process.env.CLOUDINARY_API_KEY ?? "").trim(),
    apiSecret: (process.env.CLOUDINARY_API_SECRET ?? "").trim(),
    /** Default folder prefix for catalog assets (e.g. `jerseys/`). */
    catalogAssetPrefix: (process.env.CLOUDINARY_CATALOG_PREFIX ?? "").trim(),
  },
};
