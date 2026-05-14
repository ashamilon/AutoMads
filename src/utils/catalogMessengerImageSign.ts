import crypto from "node:crypto";

/** HMAC for public catalog-image proxy URLs / Messenger attachments. */
export function signCatalogImageToken(secret: string, slug: string, sku: string, index: number): string {
  return crypto.createHmac("sha256", secret).update(`${slug}|${sku}|${index}`, "utf8").digest("base64url");
}

export function verifyCatalogImageToken(
  secret: string,
  slug: string,
  sku: string,
  index: number,
  token: string | undefined,
): boolean {
  if (!token || !secret) return false;
  try {
    const expected = signCatalogImageToken(secret, slug, sku, index);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(token, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function buildCatalogMessengerImageProxyUrl(opts: {
  publicBaseUrl: string;
  tenantSlug: string;
  clientSku: string;
  index: number;
  token: string;
}): string {
  const base = opts.publicBaseUrl.replace(/\/$/, "");
  const q = new URLSearchParams({
    slug: opts.tenantSlug,
    sku: opts.clientSku,
    i: String(opts.index),
    t: opts.token,
  });
  return `${base}/public/messenger-catalog-image?${q.toString()}`;
}
