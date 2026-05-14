"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ApiError, apiFetch, clearStoredAuth, getStoredApiKey, setStoredAuth } from "@/lib/api";
import type { TenantMe } from "@/lib/types";

type TenantContextValue = {
  tenant: TenantMe | null;
  loading: boolean;
  authError: string | null;
  refresh: () => Promise<void>;
  login: (apiKey: string, slugHint?: string) => Promise<void>;
  logout: () => void;
};

const Ctx = createContext<TenantContextValue | null>(null);

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenant] = useState<TenantMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setAuthError(null);
    if (!getStoredApiKey()) {
      setTenant(null);
      setLoading(false);
      return;
    }
    try {
      const data = await apiFetch<TenantMe>("/api/v1/me");
      setTenant(data);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      /** Only drop key when the server rejects credentials — not on network/500 */
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

  const login = useCallback(async (apiKey: string, slugHint?: string) => {
    setStoredAuth(apiKey, slugHint);
    setAuthError(null);
    setLoading(true);
    try {
      const data = await apiFetch<TenantMe>("/api/v1/me");
      setTenant(data);
    } catch (e) {
      clearStoredAuth();
      setTenant(null);
      if (e instanceof ApiError && e.status === 401) {
        throw new Error("Invalid API key. Copy sk_live_… from admin exactly.");
      }
      throw e instanceof Error ? e : new Error("Sign-in failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearStoredAuth();
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
