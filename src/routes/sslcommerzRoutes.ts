import { Router } from "express";
import { sslcommerzIpn, sslcommerzReturn } from "../controllers/sslcommerzWebhookController.js";

export const sslcommerzRoutes = Router();

sslcommerzRoutes.post("/ipn", sslcommerzIpn);
sslcommerzRoutes.get("/return", sslcommerzReturn);
sslcommerzRoutes.post("/return", sslcommerzReturn);
