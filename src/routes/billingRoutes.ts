import express, { Router } from "express";
import { sslcommerzSubscriptionWebhook } from "../controllers/billingController.js";

/**
 * Billing-plane HTTP surface.
 *
 * Mounted under `/api/v1/billing`. The SSLCommerz subscription IPN needs
 * the *untouched* request body for signature verification, so we apply
 * `express.raw()` only on that single route — every other billing endpoint
 * keeps the global JSON parser the rest of the app depends on.
 */
export const billingRoutes = Router();

billingRoutes.post(
  "/sslcommerz/webhook",
  express.raw({ type: "*/*", limit: "2mb" }),
  sslcommerzSubscriptionWebhook,
);
