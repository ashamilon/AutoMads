const STORAGE_KEY = "tenant_api_key";
const SLUG_KEY = "tenant_slug_cache";

function storage(): Storage {
  if (typeof window === "undefined") return sessionStorage;
  /** Prefer localStorage so you stay signed in across tabs & restarts until Sign out (demo-friendly). */
  const preferSession =
    process.env.NEXT_PUBLIC_AUTH_PERSIST === "session";
  return preferSession ? sessionStorage : localStorage;
}

export function getApiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  return base.replace(/\/$/, "");
}

/** Public URL of the **API** (used for Meta / SSLCommerz webhooks — usually same host as API, not this Next app). */
export function getWebhookBase(): string {
  return (
    process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:4000"
  ).replace(/\/$/, "");
}

export function getStoredApiKey(): string | null {
  if (typeof window === "undefined") return null;
  return storage().getItem(STORAGE_KEY);
}

export function setStoredAuth(apiKey: string, slugHint?: string) {
  storage().setItem(STORAGE_KEY, apiKey);
  if (slugHint) storage().setItem(SLUG_KEY, slugHint);
}

export function clearStoredAuth() {
  storage().removeItem(STORAGE_KEY);
  storage().removeItem(SLUG_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getStoredApiKey();
  if (!key) throw new Error("Not signed in");
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("Network error — is the API running on " + getApiBase() + "?", 0, "");
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data
        ? JSON.stringify(data)
        : text || res.statusText;
    throw new ApiError(msg || `HTTP ${res.status}`, res.status, text);
  }
  return data as T;
}

/** Multipart (e.g. persona file upload). Do not set Content-Type — browser sets boundary. */
export async function apiFormPost<T>(path: string, form: FormData): Promise<T> {
  const key = getStoredApiKey();
  if (!key) throw new Error("Not signed in");
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      method: "POST",
      body: form,
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });
  } catch {
    throw new ApiError("Network error — is the API running on " + getApiBase() + "?", 0, "");
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data
        ? JSON.stringify(data)
        : text || res.statusText;
    throw new ApiError(msg || `HTTP ${res.status}`, res.status, text);
  }
  return data as T;
}
