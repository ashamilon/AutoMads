import type { Request, Response } from "express";
import { loadCategorySchema } from "../agent/categoryEngine/index.js";
import { logger } from "../utils/logger.js";

/**
 * Surface the active CategorySchema for the authenticated tenant so the
 * portal can render category-aware UI (catalog form, settings size charts,
 * variant editors). Reuses the engine's resolution chain (per-tenant clone
 * → built-in for businessCategory → jersey fallback) so the dashboard
 * always sees the same schema the AI agent reasons against.
 *
 * Returns the full schema shape — the portal pages prefer reading
 * `attributes`, `variantAttributes`, `orderAttributes`, `filterAttributes`,
 * and `dashboardModules` directly. Built-in schema fragments stay on the
 * server.
 *
 * Maps to: R2.1, R3.1, R8.1, R9.1.
 */
export async function getTenantCategorySchema(
  req: Request,
  res: Response,
): Promise<void> {
  const tenant = req.tenant;
  if (!tenant) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const schema = await loadCategorySchema(tenant.id);
    res.json({ schema });
  } catch (err) {
    logger.warn(
      {
        event: "tenant_category_schema_resolve_failed",
        tenantId: tenant.id,
        err: err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) },
      },
      "tenant category schema resolve failed",
    );
    res.status(500).json({ error: "schema_resolve_failed" });
  }
}
