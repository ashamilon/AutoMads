"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  ApiError,
  apiFetch,
  clearStoredAuth,
  getStoredCredential,
  setStoredAuth,
  setStoredSessionToken,
} from "@/lib/api";
import type { TenantMe } from "@/lib/types";

type LoginInput =
  | { mode: "password"; email: string; password: string }
  | { mode: "apiKey"; apiKey: string; slugHint?: string };

type TenantContextValue = {
  tenant: TenantMe | null;
  loading: boolean;
  authError: string | null;
  refresh: () => Promise<void>;
  /**
   * Email + password is the canonical sign-in for tenants. The legacy api-key
   * mode is retained for the developer-login tab and for tooling that hits
   * the dashboard with the same key it uses for webhooks.
   */
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
};

const Ctx = createContext<TenantContextValue | null>(null);

/**
 * Set / clear the `onboarding_completed` probe cookie consumed by
 * `client/src/middleware.ts`. Stores `1` when the wizard has finished and
 * deletes the cookie otherwise so the middleware redirects unfinished
 * tenants to `/onboarding`. We keep the cookie short-lived (1 day) and
 * scoped to the current path so it's evicted automatically on logout
 * even if `clearStoredAuth` doesn't run for some reason (e.g. tab crash).
 *
 * Note: the source of truth for onboarding completion stays on the API.
 * This cookie is only a fast-path hint the edge middleware reads to
 * avoid an extra cross-origin `/me` round-trip on every navigation.
 */
function syncOnboardingCookie(completedAt: string | null): void {
  if (typeof document === "undefined") return;
  if (completedAt) {
    document.cookie = `onboarding_completed=1; Path=/; Max-Age=86400; SameSite=Lax`;
  } else {
    document.cookie = `onboarding_completed=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenant] = useState<TenantMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setAuthError(null);
    if (!getStoredCredential()) {
      setTenant(null);
      setLoading(false);
      return;
    }
    try {
      const data = await apiFetch<TenantMe>("/api/v1/me");
      setTenant(data);
      // Sync the onboarding-flag probe cookie used by `client/src/middleware.ts`
      // to gate access to the portal until the wizard finishes. Setting it
      // here keeps the source of truth on the API while letting the edge
      // middleware avoid a cross-origin /me round-trip on every navigation.
      syncOnboardingCookie(data.onboardingCompletedAt);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      /** Only drop credential when the server rejects credentials — not on network/500 */
      if (status === 401 || status === 403) {
        clearStoredAuth();
        setTenant(null);
      } else {
        setTenant(null);
        setAuthError(
          status === 0
            ? "Cannot reach API. Start the backend (npm run dev in the project root, port 4000)."
            : "Could not load workspace. API error.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (input: LoginInput) => {
    setAuthError(null);
    setLoading(true);
    try {
      if (input.mode === "password") {
        // Email + password → /auth/login. Server sets HttpOnly cookie AND
        // returns the plaintext token so cross-origin deployments work.
        const res = await apiFetch<{
          tenant: { id: string; name: string; slug: string };
          sessionToken: string;
        }>("/api/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: input.email, password: input.password }),
          requireAuth: false,
        });
        setStoredSessionToken(res.sessionToken, res.tenant.slug);
      } else {
        // Legacy api-key login.
        setStoredAuth(input.apiKey, input.slugHint);
      }
      const me = await apiFetch<TenantMe>("/api/v1/me");
      setTenant(me);
      syncOnboardingCookie(me.onboardingCompletedAt);
    } catch (e) {
      clearStoredAuth();
      setTenant(null);
      if (e instanceof ApiError && e.status === 401) {
        throw new Error(
          input.mode === "password"
            ? "Email or password is incorrect."
            : "Invalid API key. Copy sk_live_… from admin exactly.",
        );
      }
      throw e instanceof Error ? e : new Error("Sign-in failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // Burn the server-side session if we have one; ignore errors so logout
    // always succeeds locally.
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST", requireAuth: false });
    } catch {
      /* ignore */
    }
    clearStoredAuth();
    syncOnboardingCookie(null);
    setTenant(null);
    setAuthError(null);
  }, []);

  return (
    <Ctx.Provider value={{ tenant, loading, authError, refresh, login, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTenant() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTenant outside TenantProvider");
  return v;
}
