import { Router } from "express";
import {
  adminResetTenantPassword,
  createTenant,
  getTenant,
  issueTenantActivation,
  listTenantOrders,
  listTenants,
  patchTenant,
  regenerateTenantApiKey,
} from "../controllers/adminController.js";
import {
  cancelTenantSubscription,
  changeTenantPlan,
  getSubscription,
  getUsageReport,
  listPayments,
  listPlans,
  listSubscriptions,
  overrideLimits,
  patchPlan,
  reactivateTenantSubscription,
  suspendTenantSubscription,
} from "../controllers/adminBillingController.js";
import {
  getPlatformGatewayCreds,
  savePlatformGatewayCreds,
  testPlatformGatewayCreds,
} from "../controllers/adminPlatformGatewayController.js";
import { requireAdminApiKey } from "../middlewares/adminAuth.js";

export const adminRoutes = Router();
adminRoutes.use(requireAdminApiKey);

// Tenants
adminRoutes.post("/tenants", createTenant);
adminRoutes.get("/tenants", listTenants);
adminRoutes.get("/tenants/:tenantId/orders", listTenantOrders);
adminRoutes.get("/tenants/:tenantId", getTenant);
adminRoutes.patch("/tenants/:tenantId", patchTenant);
adminRoutes.post("/tenants/:tenantId/regenerate-api-key", regenerateTenantApiKey);
adminRoutes.post("/tenants/:tenantId/issue-activation", issueTenantActivation);
adminRoutes.post("/tenants/:tenantId/reset-password", adminResetTenantPassword);

// Plans
adminRoutes.get("/plans", listPlans);
adminRoutes.patch("/plans/:planId", patchPlan);

// Subscriptions
adminRoutes.get("/subscriptions", listSubscriptions);
adminRoutes.get("/subscriptions/:tenantId", getSubscription);
adminRoutes.post("/subscriptions/:tenantId/suspend", suspendTenantSubscription);
adminRoutes.post("/subscriptions/:tenantId/reactivate", reactivateTenantSubscription);
adminRoutes.post("/subscriptions/:tenantId/cancel", cancelTenantSubscription);
adminRoutes.post("/subscriptions/:tenantId/change-plan", changeTenantPlan);
adminRoutes.post("/subscriptions/:tenantId/override-limits", overrideLimits);

// Usage + payments
adminRoutes.get("/usage/:tenantId", getUsageReport);
adminRoutes.get("/payments", listPayments);

// Platform-billing gateway credentials (the SaaS operator's own SSLCommerz store).
adminRoutes.get("/platform/gateway", getPlatformGatewayCreds);
adminRoutes.post("/platform/gateway", savePlatformGatewayCreds);
adminRoutes.post("/platform/gateway/test", testPlatformGatewayCreds);
