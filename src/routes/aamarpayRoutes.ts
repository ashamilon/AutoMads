import { Router } from "express";
import { aamarpayIpn, aamarpayReturn } from "../controllers/aamarpayWebhookController.js";

export const aamarpayRoutes = Router();

aamarpayRoutes.post("/ipn", aamarpayIpn);
aamarpayRoutes.get("/return", aamarpayReturn);
aamarpayRoutes.post("/return", aamarpayReturn);
