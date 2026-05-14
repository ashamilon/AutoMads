import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { Router } from "express";
import multer from "multer";
import { requireTenantApiKey } from "../middlewares/tenantApiAuth.js";
import {
  bookPathao,
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
} from "../controllers/tenantPortalController.js";
import { learnPersonaFromUploads } from "../controllers/personaLearnController.js";
import { testPathao, testSslcommerz, testTelegram } from "../controllers/integrationTestController.js";
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
tenantPortalRoutes.get("/orders", listOrders);
tenantPortalRoutes.get("/orders/:orderId", getOrder);
tenantPortalRoutes.get("/orders/:orderId/invoice", getOrderInvoice);
tenantPortalRoutes.post("/orders/:orderId/mark-paid", markOrderPaidManually);
tenantPortalRoutes.post("/orders/:orderId/book-pathao", bookPathao);
tenantPortalRoutes.post("/orders/:orderId/cancel", cancelOrder);
tenantPortalRoutes.patch("/settings", patchTenantSettings);
tenantPortalRoutes.post("/chat/simulate", simulateChat);
tenantPortalRoutes.post("/settings/business-logo", logoUpload.single("logo"), uploadBusinessLogo);
tenantPortalRoutes.post("/settings/invoice-preview", previewInvoice);
tenantPortalRoutes.post("/integrations/sslcommerz/test", testSslcommerz);
tenantPortalRoutes.post("/integrations/pathao/test", testPathao);
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
