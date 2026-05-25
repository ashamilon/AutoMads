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
