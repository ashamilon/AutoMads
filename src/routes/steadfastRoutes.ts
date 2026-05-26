import { Router } from "express";
import { steadfastStatus } from "../controllers/steadfastWebhookController.js";

export const steadfastRoutes = Router();

steadfastRoutes.post("/status", steadfastStatus);
// Convenience: GET works for manual probing during setup.
steadfastRoutes.get("/status", steadfastStatus);
