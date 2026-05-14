/** Recursively redact obvious secret fields for tenant-facing API responses */
export function maskSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  if (typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/password|secret|token|passwd|authorization|apikey|api_key|access_token|private/i.test(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = maskSecrets(v);
    }
  }
  return out;
}
