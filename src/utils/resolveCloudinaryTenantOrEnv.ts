import { config } from "../config/index.js";
import { parseTenantSettings } from "../types/tenant-settings.js";

export type CloudinaryConfigSource = "tenant" | "env";

function normalizePrefix(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  return t.length > 0 ? t : undefined;
}

/**
 * Admin API credentials: tenant `settings.cloudinary` wins when all three
 * strings are set; otherwise optional server `CLOUDINARY_*` env vars.
 */
export function resolveCloudinaryListArgs(
  tenantSettingsJson: unknown,
  requestPrefix?: string,
): {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  prefix?: string;
  source: CloudinaryConfigSource;
} | null {
  const reqPrefix = normalizePrefix(requestPrefix);

  const s = parseTenantSettings(tenantSettingsJson);
  const tc = s.cloudinary;
  if (tc) {
    const cloudName = String(tc.cloudName ?? "").trim();
    const apiKey = String(tc.apiKey ?? "").trim();
    const apiSecret = String(tc.apiSecret ?? "").trim();
    if (cloudName && apiKey && apiSecret) {
      const tenantDefault = normalizePrefix(tc.catalogAssetPrefix);
      return {
        cloudName,
        apiKey,
        apiSecret,
        prefix: reqPrefix ?? tenantDefault,
        source: "tenant",
      };
    }
  }

  const cloudName = config.cloudinary.cloudName;
  const apiKey = config.cloudinary.apiKey;
  const apiSecret = config.cloudinary.apiSecret;
  if (cloudName && apiKey && apiSecret) {
    const envDefault = normalizePrefix(config.cloudinary.catalogAssetPrefix);
    return {
      cloudName,
      apiKey,
      apiSecret,
      prefix: reqPrefix ?? envDefault,
      source: "env",
    };
  }

  return null;
}
