/**
 * Admin-side API client. Distinct from the tenant `apiFetch` because:
 *
 *   - It hits `/admin/...` (not `/api/v1/...`).
 *   - It authenticates with `X-Admin-Api-Key` (the static key set in the
 *     server's `ADMIN_API_KEY` env var). No password, no session — this is
 *     a single-user platform-admin role.
 *   - Storage is a separate localStorage key so logging out of admin
 *     doesn't sign you out of any tenant dashboards open in other tabs.
 */

import { ApiError, getApiBase } from "./api";

const ADMIN_KEY = "admin_api_key";

export function getStoredAdminKey(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ADMIN_KEY);
}

export function setStoredAdminKey(key: string): void {
  localStorage.setItem(ADMIN_KEY, key);
}

export function clearStoredAdminKey(): void {
  localStorage.removeItem(ADMIN_KEY);
}

export async function adminFetch<T>(
  path: string,
  init?: RequestInit & { requireAuth?: boolean },
): Promise<T> {
  const requireAuth = init?.requireAuth !== false;
  const key = getStoredAdminKey();
  if (requireAuth && !key) throw new Error("Admin not signed in");
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "X-Admin-Api-Key": key } : {}),
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

/** Ping a cheap admin endpoint to verify the key is correct. */
export async function adminPing(): Promise<boolean> {
  try {
    await adminFetch<{ tenants: unknown[] }>("/admin/tenants");
    return true;
  } catch {
    return false;
  }
}
