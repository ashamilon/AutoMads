import { Router } from "express";
import { telegramWebhook } from "../controllers/telegramWebhookController.js";

export const telegramRoutes = Router();

telegramRoutes.post("/:tenantSlug", telegramWebhook);

