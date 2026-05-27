/**
 * Admin Super Control Panel HTTP routes (Multi-Tenant Commerce OS, task 12.2).
 *
 * Mounted at `/api/v1/admin/*` in `src/app.ts`. Every endpoint is gated by
 * `requireSuperAdmin` from `src/services/admin/superAdminAuth.ts`, which
 * authenticates against `SuperAdminSession` (distinct from `TenantSession`,
 * R20.7) and populates `req.superAdmin = { superAdminId, email }`.
 *
 * Path convention for tenant-scoped subscription operations:
 *   `POST /api/v1/admin/subscriptions/:id/...`
 * `:id` is the **tenantId** (not the Subscription row id). Subscriptions
 * are 1:1 with tenants via `Subscription.tenantId @unique`, so tenant id
 * is the natural address for these operations and lines up with
 * `subscriptionService.applyTransition(tenantId, ...)`. Documented here so
 * the Admin_Panel UI knows which id to send.
 *
 * Per R6.5 / R20.7 every super-admin operation that touches tenant data
 * requires an explicit `tenantId` (route param or body). The handlers
 * reject missing/invalid ids with 400. Auth failures are handled inside
 * `requireSuperAdmin` and surface as 401.
 *
 * Maps to: R6.5, R20.1, R20.2, R20.3, R20.4, R20.5, R20.6, R20.7.
 */

import { Router, type Request, type Response } from "express";

import { logger } from "../utils/logger.js";
import { requireSuperAdmin } from "../services/admin/superAdminAuth.js";
import * as adminPanelService from "../services/admin/adminPanelService.js";

export const adminPanelRoutes = Router();

// All admin-panel routes require a valid SuperAdminSession.
adminPanelRoutes.use(requireSuperAdmin);

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Read `req.superAdmin.superAdminId`; throws if the middleware was bypassed. */
function actorIdFromReq(req: Request): string {
  const id = req.superAdmin?.superAdminId;
  if (!id) {
    // `requireSuperAdmin` always sets this on success; getting here means
    // a wiring bug. Surface as 500 via a thrown error rather than emitting
    // a misleading 400.
    throw new Error("super_admin_context_missing");
  }
  return id;
}

/**
 * Lift a string-or-Date query param into a `Date` if possible. Returns
 * `undefined` for missing/empty/invalid values so the service layer treats
 * them as "no filter".
 */
function parseDateParam(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Stable JSON shape for error responses surfaced by these handlers. */
interface AdminErrorBody {
  error: string;
  detail?: string;
}

function sendError(res: Response, status: number, body: AdminErrorBody): void {
  res.status(status).json(body);
}

// ─── GET /admin/tenants ───────────────────────────────────────────────────

adminPanelRoutes.get("/tenants", async (_req: Request, res: Response) => {
  try {
    const tenants = await adminPanelService.listTenants();
    res.json({ tenants });
  } catch (err) {
    logger.error(
      { event: "admin_list_tenants_failed", err: serializeError(err) },
      "admin_list_tenants_failed",
    );
    sendError(res, 500, { error: "internal_error" });
  }
});

// ─── GET /admin/tenants/:id ───────────────────────────────────────────────

adminPanelRoutes.get("/tenants/:id", async (req: Request, res: Response) => {
  const tenantId = String(req.params.id ?? "");
  if (!tenantId) {
    sendError(res, 400, { error: "tenant_id_required" });
    return;
  }
  try {
    const detail = await adminPanelService.getTenantDetail(tenantId);
    if (!detail) {
      sendError(res, 404, { error: "tenant_not_found" });
      return;
    }
    res.json(detail);
  } catch (err) {
    logger.error(
      { event: "admin_get_tenant_detail_failed", tenantId, err: serializeError(err) },
      "admin_get_tenant_detail_failed",
    );
    sendError(res, 500, { error: "internal_error" });
  }
});

// ─── POST /admin/subscriptions/:id/suspend ────────────────────────────────

adminPanelRoutes.post(
  "/subscriptions/:id/suspend",
  async (req: Request, res: Response) => {
    const tenantId = String(req.params.id ?? "");
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!tenantId) {
      sendError(res, 400, { error: "tenant_id_required" });
      return;
    }
    if (!reason) {
      sendError(res, 400, { error: "reason_required" });
      return;
    }
    try {
      const actorId = actorIdFromReq(req);
      await adminPanelService.suspendTenant(tenantId, actorId, reason);
      res.json({ ok: true });
    } catch (err) {
      handleSubscriptionMutationError(res, err, "admin_suspend_failed", { tenantId });
    }
  },
);

// ─── POST /admin/subscriptions/:id/reactivate ─────────────────────────────

adminPanelRoutes.post(
  "/subscriptions/:id/reactivate",
  async (req: Request, res: Response) => {
    const tenantId = String(req.params.id ?? "");
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!tenantId) {
      sendError(res, 400, { error: "tenant_id_required" });
      return;
    }
    if (!reason) {
      sendError(res, 400, { error: "reason_required" });
      return;
    }
    try {
      const actorId = actorIdFromReq(req);
      await adminPanelService.reactivateTenant(tenantId, actorId, reason);
      res.json({ ok: true });
    } catch (err) {
      handleSubscriptionMutationError(res, err, "admin_reactivate_failed", { tenantId });
    }
  },
);

// ─── POST /admin/subscriptions/:id/cancel ─────────────────────────────────

adminPanelRoutes.post(
  "/subscriptions/:id/cancel",
  async (req: Request, res: Response) => {
    const tenantId = String(req.params.id ?? "");
    if (!tenantId) {
      sendError(res, 400, { error: "tenant_id_required" });
      return;
    }
    try {
      const actorId = actorIdFromReq(req);
      await adminPanelService.cancelTenantSubscription(tenantId, actorId);
      res.json({ ok: true });
    } catch (err) {
      handleSubscriptionMutationError(res, err, "admin_cancel_failed", { tenantId });
    }
  },
);

// ─── POST /admin/subscriptions/:id/override-limits ────────────────────────

adminPanelRoutes.post(
  "/subscriptions/:id/override-limits",
  async (req: Request, res: Response) => {
    const tenantId = String(req.params.id ?? "");
    const overrides = req.body?.overrides;
    if (!tenantId) {
      sendError(res, 400, { error: "tenant_id_required" });
      return;
    }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      sendError(res, 400, { error: "overrides_required" });
      return;
    }
    try {
      const actorId = actorIdFromReq(req);
      await adminPanelService.overrideLimits(
        tenantId,
        overrides as Record<string, unknown>,
        actorId,
      );
      res.json({ ok: true });
    } catch (err) {
      handleSubscriptionMutationError(res, err, "admin_override_limits_failed", { tenantId });
    }
  },
);

// ─── GET /admin/payments ──────────────────────────────────────────────────

adminPanelRoutes.get("/payments", async (req: Request, res: Response) => {
  try {
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
    const gateway = typeof req.query.gateway === "string" ? req.query.gateway : undefined;
    const since = parseDateParam(req.query.since);
    const until = parseDateParam(req.query.until);

    const payments = await adminPanelService.listPayments({
      tenantId,
      gateway,
      since,
      until,
    });
    res.json({ payments });
  } catch (err) {
    logger.error(
      { event: "admin_list_payments_failed", err: serializeError(err) },
      "admin_list_payments_failed",
    );
    sendError(res, 500, { error: "internal_error" });
  }
});

// ─── GET /admin/usage/:tenantId ───────────────────────────────────────────

adminPanelRoutes.get("/usage/:tenantId", async (req: Request, res: Response) => {
  const tenantId = String(req.params.tenantId ?? "");
  if (!tenantId) {
    sendError(res, 400, { error: "tenant_id_required" });
    return;
  }
  try {
    const report = await adminPanelService.getUsage(tenantId);
    res.json(report);
  } catch (err) {
    logger.error(
      { event: "admin_get_usage_failed", tenantId, err: serializeError(err) },
      "admin_get_usage_failed",
    );
    sendError(res, 500, { error: "internal_error" });
  }
});

// ─── GET /admin/categories ────────────────────────────────────────────────

adminPanelRoutes.get("/categories", async (_req: Request, res: Response) => {
  try {
    const schemas = await adminPanelService.listCategorySchemas();
    res.json({ schemas });
  } catch (err) {
    logger.error(
      { event: "admin_list_categories_failed", err: serializeError(err) },
      "admin_list_categories_failed",
    );
    sendError(res, 500, { error: "internal_error" });
  }
});

// ─── POST /admin/categories ───────────────────────────────────────────────

adminPanelRoutes.post("/categories", async (req: Request, res: Response) => {
  try {
    const actorId = actorIdFromReq(req);
    const created = await adminPanelService.createCategorySchema(
      req.body as adminPanelService.CategorySchemaInput,
      actorId,
    );
    res.status(201).json({ schema: created });
  } catch (err) {
    handleCategoryMutationError(res, err, "admin_create_category_failed");
  }
});

// ─── PATCH /admin/categories/:id ──────────────────────────────────────────

adminPanelRoutes.patch("/categories/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  if (!id) {
    sendError(res, 400, { error: "category_id_required" });
    return;
  }
  try {
    const actorId = actorIdFromReq(req);
    const updated = await adminPanelService.updateCategorySchema(
      id,
      req.body as Partial<adminPanelService.CategorySchemaInput>,
      actorId,
    );
    res.json({ schema: updated });
  } catch (err) {
    handleCategoryMutationError(res, err, "admin_update_category_failed");
  }
});

// ─── POST /admin/tenants/:id/category ─────────────────────────────────────

adminPanelRoutes.post(
  "/tenants/:id/category",
  async (req: Request, res: Response) => {
    const tenantId = String(req.params.id ?? "");
    const categorySchemaId =
      typeof req.body?.categorySchemaId === "string" ? req.body.categorySchemaId : "";
    if (!tenantId) {
      sendError(res, 400, { error: "tenant_id_required" });
      return;
    }
    if (!categorySchemaId) {
      sendError(res, 400, { error: "category_schema_id_required" });
      return;
    }
    try {
      const actorId = actorIdFromReq(req);
      await adminPanelService.assignSchemaToTenant(
        tenantId,
        categorySchemaId,
        actorId,
      );
      res.json({ ok: true });
    } catch (err) {
      handleCategoryMutationError(res, err, "admin_assign_category_failed", {
        tenantId,
        categorySchemaId,
      });
    }
  },
);

// ─── Error mapping ────────────────────────────────────────────────────────

/**
 * Map known Error messages from the subscription-touching service calls
 * to stable HTTP status codes. Anything we don't recognize lands as a 500
 * with a logged stack so operators can diagnose it.
 */
function handleSubscriptionMutationError(
  res: Response,
  err: unknown,
  event: string,
  context: Record<string, unknown>,
): void {
  const message = err instanceof Error ? err.message : String(err);

  // From IllegalTransitionError ("Illegal subscription transition: ...").
  if (message.startsWith("Illegal subscription transition")) {
    sendError(res, 409, { error: "illegal_transition", detail: message });
    return;
  }
  if (message.startsWith("Subscription not found")) {
    sendError(res, 404, { error: "subscription_not_found" });
    return;
  }
  if (message === "tenantId is required") {
    sendError(res, 400, { error: "tenant_id_required" });
    return;
  }
  if (message === "actorSuperAdminId is required") {
    sendError(res, 401, { error: "super_admin_required" });
    return;
  }
  if (message === "overrides must be an object") {
    sendError(res, 400, { error: "overrides_required" });
    return;
  }

  logger.error(
    { event, err: { message, name: err instanceof Error ? err.name : undefined }, ...context },
    event,
  );
  sendError(res, 500, { error: "internal_error" });
}

/**
 * Map known Error messages from the category-schema service calls to
 * stable HTTP status codes.
 */
function handleCategoryMutationError(
  res: Response,
  err: unknown,
  event: string,
  context: Record<string, unknown> = {},
): void {
  const message = err instanceof Error ? err.message : String(err);

  if (message.startsWith("schema_invalid_")) {
    sendError(res, 400, { error: message });
    return;
  }
  if (message === "schema_not_found") {
    sendError(res, 404, { error: "schema_not_found" });
    return;
  }
  if (message === "tenant_not_found") {
    sendError(res, 404, { error: "tenant_not_found" });
    return;
  }
  if (message === "schema_not_assignable_to_tenant") {
    sendError(res, 409, { error: "schema_not_assignable_to_tenant" });
    return;
  }
  if (message === "id is required") {
    sendError(res, 400, { error: "category_id_required" });
    return;
  }
  if (message === "tenantId is required") {
    sendError(res, 400, { error: "tenant_id_required" });
    return;
  }
  if (message === "categorySchemaId is required") {
    sendError(res, 400, { error: "category_schema_id_required" });
    return;
  }
  if (message === "actorSuperAdminId is required") {
    sendError(res, 401, { error: "super_admin_required" });
    return;
  }

  logger.error(
    { event, err: { message, name: err instanceof Error ? err.name : undefined }, ...context },
    event,
  );
  sendError(res, 500, { error: "internal_error" });
}

function serializeError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
