import { Router } from "express";
import { bkashReturn } from "../controllers/bkashWebhookController.js";

export const bkashRoutes = Router();

// bKash uses a single callbackURL for success/fail/cancel with status query param.
bkashRoutes.get("/callback", bkashReturn);
bkashRoutes.post("/callback", bkashReturn);
