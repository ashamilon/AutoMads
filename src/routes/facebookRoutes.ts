import { Router } from "express";
import { receiveFacebookWebhook, verifyFacebookWebhook } from "../controllers/facebookWebhookController.js";

export const facebookRoutes = Router({ mergeParams: true });

facebookRoutes.get("/:tenantSlug", verifyFacebookWebhook);
facebookRoutes.post("/:tenantSlug", receiveFacebookWebhook);
