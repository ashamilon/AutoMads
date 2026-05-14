import crypto from "node:crypto";

const PREFIX = "sk_live_";

export function generateTenantApiKey(): string {
  return PREFIX + crypto.randomBytes(24).toString("hex");
}

export function hashApiKey(fullKey: string): string {
  return crypto.createHash("sha256").update(fullKey, "utf8").digest("hex");
}

export function extractBearerToken(req: { header(name: string): string | undefined }): string | undefined {
  const apiKey = req.header("x-api-key");
  if (apiKey) return apiKey.trim();
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}
