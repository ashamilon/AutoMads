/**
 * Browser-side API client.
 *
 * Auth: prefers the session cookie issued by /auth/login (HttpOnly, set by
 * the backend). On older deploys an `sk_live_` API key in localStorage is
 * still accepted as a fallback so the developer-login tab keeps working.
 *
 * The session cookie travels automatically when we set `credentials:
 * "include"` on fetch. We also send a SECONDARY copy of the session token
 * in the `Authorization: Bearer <token>` header for environments where the
 * portal runs on a different origin than the API and third-party cookies
 * are blocked. The login response carries the plaintext token for that
 * exact purpose.
 */

const SESSION_KEY = "tenant_session_token";
const STORAGE_KEY = "tenant_api_key";
const SLUG_KEY = "tenant_slug_cache";

function storage(): Storage {
  if (typeof window === "undefined") return sessionStorage;
  /** Prefer localStorage so you stay signed in across tabs & restarts until Sign out. */
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

// ─── Stored credentials ─────────────────────────────────────────────────────

export function getStoredApiKey(): string | null {
  if (typeof window === "undefined") return null;
  return storage().getItem(STORAGE_KEY);
}

export function getStoredSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return storage().getItem(SESSION_KEY);
}

/** Returns whichever credential the browser currently holds — session preferred. */
export function getStoredCredential(): string | null {
  return getStoredSessionToken() ?? getStoredApiKey();
}

export function setStoredAuth(apiKey: string, slugHint?: string) {
  storage().setItem(STORAGE_KEY, apiKey);
  if (slugHint) storage().setItem(SLUG_KEY, slugHint);
}

export function setStoredSessionToken(token: string, slugHint?: string) {
  storage().setItem(SESSION_KEY, token);
  if (slugHint) storage().setItem(SLUG_KEY, slugHint);
}

export function clearStoredAuth() {
  storage().removeItem(STORAGE_KEY);
  storage().removeItem(SESSION_KEY);
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

// ─── Fetch wrappers ─────────────────────────────────────────────────────────

function buildAuthHeader(): Record<string, string> {
  const cred = getStoredCredential();
  if (!cred) return {};
  return { Authorization: `Bearer ${cred}` };
}

/**
 * `requireAuth: false` is used for the public auth endpoints (login,
 * activate). Defaults to true; throws "Not signed in" when no credential is
 * stored, mirroring legacy behavior.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { requireAuth?: boolean },
): Promise<T> {
  const requireAuth = init?.requireAuth !== false;
  if (requireAuth && !getStoredCredential()) {
    throw new Error("Not signed in");
  }
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeader(),
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
  if (!getStoredCredential()) throw new Error("Not signed in");
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      method: "POST",
      body: form,
      credentials: "include",
      headers: buildAuthHeader(),
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


/**
 * Authenticated GET that opens the response (e.g. a PDF) in a new tab via a blob URL.
 */
export async function apiOpenBlob(path: string): Promise<void> {
  if (!getStoredCredential()) throw new Error("Not signed in");
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      credentials: "include",
      headers: buildAuthHeader(),
    });
  } catch {
    throw new ApiError(
      "Network error — is the API running on " + getApiBase() + "?",
      0,
      "",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(text || `HTTP ${res.status}`, res.status, text);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  // Open in a new tab; revoke after a beat so the new tab has time to load.
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) {
    // Popup blocked — fall back to a download link.
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
