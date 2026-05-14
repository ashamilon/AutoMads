import type { RequestHandler } from "express";
import { config } from "../config/index.js";

export const requireAdminApiKey: RequestHandler = (req, res, next) => {
  const key = config.adminApiKey;
  if (!key) {
    res.status(503).json({ error: "admin_api_disabled" });
    return;
  }
  const sent =
    req.header("x-admin-api-key") ??
    (req.header("authorization")?.startsWith("Bearer ")
      ? req.header("authorization")!.slice(7)
      : undefined);
  if (sent !== key) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
};
