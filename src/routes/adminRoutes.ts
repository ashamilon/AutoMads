import { Router } from "express";
import {
  createTenant,
  getTenant,
  listTenantOrders,
  listTenants,
  patchTenant,
  regenerateTenantApiKey,
} from "../controllers/adminController.js";
import { requireAdminApiKey } from "../middlewares/adminAuth.js";

export const adminRoutes = Router();
adminRoutes.use(requireAdminApiKey);
adminRoutes.post("/tenants", createTenant);
adminRoutes.get("/tenants", listTenants);
adminRoutes.get("/tenants/:tenantId/orders", listTenantOrders);
adminRoutes.get("/tenants/:tenantId", getTenant);
adminRoutes.patch("/tenants/:tenantId", patchTenant);
adminRoutes.post("/tenants/:tenantId/regenerate-api-key", regenerateTenantApiKey);
