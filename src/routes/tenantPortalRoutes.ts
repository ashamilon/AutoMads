import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { Router } from "express";
import multer from "multer";
import { requireTenantApiKey } from "../middlewares/tenantApiAuth.js";
import {
  bookPathao,
  bookSteadfast,
  bulkDeleteProductMappings,
  cancelOrder,
  deleteProductMapping,
  getMe,
  getOrder,
  getOrderInvoice,
  listOrders,
  listProductMappings,
  markOrderPaidManually,
  patchTenantSettings,
  simulateChat,
  previewInvoice,
  uploadBusinessLogo,
  bulkUpsertProductMappings,
  syncProductMappingsFromDatabase,
  syncCloudinaryCatalogImages,
  upsertProductMapping,
  listScheduledPosts,
  createScheduledPost,
  updateScheduledPost,
  deleteScheduledPost,
  publishScheduledPostNow,
  approveScheduledPost,
  rejectScheduledPost,
  generatePostCaption,
  getContentAgentSettings,
  updateContentAgentSettings,
  runContentAgentNow,
  getGraceStatus,
  endGraceEarly,
  listMutedConversations,
  unmuteConversation,
  validateFacebookPage,
  validateInstagram,
  validateTiktok,
} from "../controllers/tenantPortalController.js";
import { learnPersonaFromUploads } from "../controllers/personaLearnController.js";
import { getTenantCategorySchema } from "../controllers/tenantSchemaController.js";
import { getAnalyticsOverview } from "../controllers/tenantAnalyticsController.js";
import {
  cancelMySubscription,
  getMyBilling,
  initiateRenewal,
  listMyInvoices,
} from "../controllers/tenantBillingController.js";
import { testPathao, testSslcommerz, testTelegram, testSteadfast } from "../controllers/integrationTestController.js";
import {
  deleteTrainingJsonCorpus,
  getTrainingJsonCorpus,
  postTrainingJsonBatch,
} from "../controllers/trainingJsonUploadController.js";
import { fileSupportedForPersona } from "../services/personaLearnService.js";
import { trainingTempDir } from "../services/trainingJsonCorpusService.js";

export const tenantPortalRoutes = Router();

const personaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (fileSupportedForPersona(file)) cb(null, true);
    else cb(new Error("unsupported_file_type"));
  },
});

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
});

const trainingJsonUpload = multer({
  storage: multer.diskStorage({
    destination: (req: Request & { tenant?: { id: string } }, _file, cb) => {
      const id = req.tenant?.id;
      if (!id) {
        cb(new Error("tenant_missing"), "");
        return;
      }
      const dir = trainingTempDir(id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const base = path.basename(file.originalname || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}-${randomBytes(6).toString("hex")}-${base}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 120 },
});

tenantPortalRoutes.use(requireTenantApiKey);

tenantPortalRoutes.get("/me", getMe);
tenantPortalRoutes.get("/me/category-schema", getTenantCategorySchema);

// Analytics — single aggregating endpoint for the /portal/analytics page.
tenantPortalRoutes.get("/analytics/overview", getAnalyticsOverview);

// Billing — tenant self-serve subscription view + initiate-renewal + cancel.
// Mounted under /api/v1/billing/* via the parent /api/v1 namespace; the
// SSLCommerz IPN webhook continues to live on /api/v1/billing/sslcommerz/webhook
// in `billingRoutes.ts` and uses raw body for signature validation.
tenantPortalRoutes.get("/billing/me", getMyBilling);
tenantPortalRoutes.get("/billing/invoices", listMyInvoices);
tenantPortalRoutes.post("/billing/initiate-renewal", initiateRenewal);
tenantPortalRoutes.post("/billing/cancel", cancelMySubscription);
tenantPortalRoutes.get("/orders", listOrders);
tenantPortalRoutes.get("/orders/:orderId", getOrder);
tenantPortalRoutes.get("/orders/:orderId/invoice", getOrderInvoice);
tenantPortalRoutes.post("/orders/:orderId/mark-paid", markOrderPaidManually);
tenantPortalRoutes.post("/orders/:orderId/book-pathao", bookPathao);
tenantPortalRoutes.post("/orders/:orderId/book-steadfast", bookSteadfast);
tenantPortalRoutes.post("/orders/:orderId/cancel", cancelOrder);
tenantPortalRoutes.patch("/settings", patchTenantSettings);
tenantPortalRoutes.post("/chat/simulate", simulateChat);
tenantPortalRoutes.post("/settings/business-logo", logoUpload.single("logo"), uploadBusinessLogo);
tenantPortalRoutes.post("/settings/invoice-preview", previewInvoice);
tenantPortalRoutes.post("/integrations/sslcommerz/test", testSslcommerz);
tenantPortalRoutes.post("/integrations/pathao/test", testPathao);
tenantPortalRoutes.post("/integrations/steadfast/test", testSteadfast);
tenantPortalRoutes.post("/integrations/telegram/test", testTelegram);
tenantPortalRoutes.post(
  "/persona/learn",
  (req, res, next) => {
    personaUpload.array("files", 20)(req, res, (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : "upload_error";
        res.status(400).json({ error: "upload_error", detail: msg });
        return;
      }
      next();
    });
  },
  learnPersonaFromUploads,
);
tenantPortalRoutes.get("/product-mappings", listProductMappings);
tenantPortalRoutes.post("/product-mappings/bulk", bulkUpsertProductMappings);
tenantPortalRoutes.delete("/product-mappings/bulk", bulkDeleteProductMappings);
tenantPortalRoutes.post("/product-mappings/sync-from-db", syncProductMappingsFromDatabase);
tenantPortalRoutes.post("/product-mappings/sync-cloudinary-images", syncCloudinaryCatalogImages);
tenantPortalRoutes.post("/product-mappings", upsertProductMapping);
tenantPortalRoutes.delete("/product-mappings/:clientSku", deleteProductMapping);

// Scheduled posts (content calendar)
tenantPortalRoutes.get("/scheduled-posts", listScheduledPosts);
tenantPortalRoutes.post("/scheduled-posts", createScheduledPost);
tenantPortalRoutes.patch("/scheduled-posts/:id", updateScheduledPost);
tenantPortalRoutes.delete("/scheduled-posts/:id", deleteScheduledPost);
tenantPortalRoutes.post("/scheduled-posts/:id/publish-now", publishScheduledPostNow);
tenantPortalRoutes.post("/scheduled-posts/:id/approve", approveScheduledPost);
tenantPortalRoutes.post("/scheduled-posts/:id/reject", rejectScheduledPost);
tenantPortalRoutes.post("/generate-caption", generatePostCaption);

// Content agent (autonomous post drafter)
tenantPortalRoutes.get("/content-agent", getContentAgentSettings);
tenantPortalRoutes.patch("/content-agent", updateContentAgentSettings);
tenantPortalRoutes.post("/content-agent/run-now", runContentAgentNow);

// Grace-window + per-conversation agent mute control
tenantPortalRoutes.get("/grace-status", getGraceStatus);
tenantPortalRoutes.post("/grace-status/end", endGraceEarly);
tenantPortalRoutes.get("/conversations/muted", listMutedConversations);
tenantPortalRoutes.post("/conversations/:conversationId/unmute", unmuteConversation);

// Social account validation
tenantPortalRoutes.get("/social/facebook-status", validateFacebookPage);
tenantPortalRoutes.post("/social/validate-instagram", validateInstagram);
tenantPortalRoutes.post("/social/validate-tiktok", validateTiktok);

tenantPortalRoutes.get("/training-json", getTrainingJsonCorpus);
tenantPortalRoutes.delete("/training-json", deleteTrainingJsonCorpus);
tenantPortalRoutes.post(
  "/training-json/batch",
  (req, res, next) => {
    trainingJsonUpload.array("files", 120)(req, res, (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : "upload_error";
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res.status(400).json({ error: "file_too_large", detail: "Max 5 MB per file" });
          return;
        }
        if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") {
          res.status(400).json({ error: "too_many_files", detail: "Max 120 files per batch" });
          return;
        }
        res.status(400).json({ error: "upload_error", detail: msg });
        return;
      }
      next();
    });
  },
  postTrainingJsonBatch,
);
