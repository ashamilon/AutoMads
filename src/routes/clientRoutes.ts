import { Router } from "express";
import { receiveClientInbound } from "../controllers/clientInboundWebhookController.js";

export const clientRoutes = Router({ mergeParams: true });

clientRoutes.post("/:tenantSlug/inbound", receiveClientInbound);
