import type { ErrorRequestHandler } from "express";
import { logger } from "../utils/logger.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, "Unhandled error");
  const status = typeof err?.status === "number" ? err.status : 500;
  res.status(status).json({
    error: process.env.NODE_ENV === "production" ? "internal_error" : String(err?.message ?? err),
  });
};
