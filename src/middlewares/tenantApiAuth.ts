import type { RequestHandler } from "express";
import { prisma } from "../db/prisma.js";
import { extractBearerToken, hashApiKey } from "../utils/apiKey.js";

export const requireTenantApiKey: RequestHandler = async (req, res, next) => {
  const raw = extractBearerToken(req);
  if (!raw) {
    res.status(401).json({ error: "missing_api_key", hint: "Use Authorization: Bearer sk_live_... or X-Api-Key" });
    return;
  }
  const hash = hashApiKey(raw);
  const tenant = await prisma.tenant.findFirst({
    where: { apiKeyHash: hash, isActive: true },
  });
  if (!tenant) {
    res.status(401).json({ error: "invalid_api_key" });
    return;
  }
  req.tenant = tenant;
  next();
};
