/**
 * Legacy admin endpoints for platform-billing gateway credentials.
 *
 * Routes (mounted by `routes/adminRoutes.ts`):
 *   - GET  /admin/platform/gateway        → redacted current creds + source
 *   - POST /admin/platform/gateway        → save store id / secret / sandbox flag
 *   - POST /admin/platform/gateway/test   → live probe against SSLCommerz init endpoint
 *
 * `secrets.storePassword` is never returned. The form on the legacy admin
 * sends `null` to mean "keep existing"; only when a non-empty string is
 * provided do we update the secret.
 */

import axios from "axios";
import type { Request, Response } from "express";
import { logger } from "../utils/logger.js";
import {
  getRedactedPlatformBillingCreds,
  resolvePlatformBillingCreds,
  savePlatformBillingCreds,
} from "../services/billing/platformBillingCreds.js";

const SANDBOX_INIT = "https://sandbox.sslcommerz.com/gwprocess/v4/api.php";
const LIVE_INIT = "https://securepay.sslcommerz.com/gwprocess/v4/api.php";

const ADMIN_ACTOR = "legacy-admin-key";

export async function getPlatformGatewayCreds(_req: Request, res: Response): Promise<void> {
  try {
    const creds = await getRedactedPlatformBillingCreds();
    res.json({ creds });
  } catch (err) {
    logger.error(
      { event: "admin_platform_gateway_get_failed", err: errMsg(err) },
      "admin_platform_gateway_get_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

export async function savePlatformGatewayCreds(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    storeId?: string;
    storePassword?: string | null;
    isSandbox?: boolean;
  };
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "body_required" });
    return;
  }
  const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
  if (!storeId) {
    res.status(400).json({ error: "storeId_required" });
    return;
  }
  const isSandbox = body.isSandbox === true;

  // If the operator left the password field blank, keep the existing secret.
  // Otherwise replace it.
  let storePassword = "";
  if (typeof body.storePassword === "string" && body.storePassword.length > 0) {
    storePassword = body.storePassword;
  } else {
    const existing = await resolvePlatformBillingCreds();
    if (!existing) {
      res
        .status(400)
        .json({ error: "storePassword_required", detail: "no existing secret to keep" });
      return;
    }
    storePassword = existing.storePassword;
  }

  try {
    await savePlatformBillingCreds(
      { storeId, storePassword, isSandbox },
      ADMIN_ACTOR,
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error(
      { event: "admin_platform_gateway_save_failed", err: errMsg(err) },
      "admin_platform_gateway_save_failed",
    );
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * Live probe — issues a tiny init request against SSLCommerz with the
 * resolved creds. Success means the store id + secret authenticate. We
 * intentionally don't complete the session; we just check the response
 * status field.
 *
 * If the operator just saved new creds, this is the immediate-feedback
 * loop they'd run before pointing real tenants at the gateway.
 */
export async function testPlatformGatewayCreds(_req: Request, res: Response): Promise<void> {
  let creds;
  try {
    creds = await resolvePlatformBillingCreds();
  } catch (err) {
    res.status(500).json({ ok: false, error: errMsg(err) });
    return;
  }
  if (!creds) {
    res.status(400).json({ ok: false, error: "creds_not_configured" });
    return;
  }

  const url = creds.isSandbox ? SANDBOX_INIT : LIVE_INIT;
  // Minimal valid payload — SSLCommerz returns FAILED with a useful reason
  // when the store_id / store_passwd are wrong; if they're right, we get
  // VALIDATED with a session_key. We don't actually use the session.
  const params = new URLSearchParams();
  params.set("store_id", creds.storeId);
  params.set("store_passwd", creds.storePassword);
  params.set("total_amount", "10.00");
  params.set("currency", "BDT");
  params.set("tran_id", `TEST-${Date.now()}`);
  params.set("success_url", "https://example.com/success");
  params.set("fail_url", "https://example.com/fail");
  params.set("cancel_url", "https://example.com/cancel");
  params.set("emi_option", "0");
  params.set("cus_name", "Test");
  params.set("cus_email", "test@example.com");
  params.set("cus_add1", "Dhaka");
  params.set("cus_city", "Dhaka");
  params.set("cus_country", "Bangladesh");
  params.set("cus_phone", "01700000000");
  params.set("shipping_method", "NO");
  params.set("num_of_item", "1");
  params.set("product_name", "Subscription test");
  params.set("product_category", "subscription");
  params.set("product_profile", "non-physical-goods");

  try {
    const r = await axios.post(url, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 12_000,
      validateStatus: () => true,
    });
    const status = typeof r.data?.status === "string" ? r.data.status : "UNKNOWN";
    if (r.status >= 200 && r.status < 300 && (status === "SUCCESS" || status === "VALIDATED")) {
      res.json({
        ok: true,
        status,
        message: "Credentials accepted by SSLCommerz",
        environment: creds.isSandbox ? "sandbox" : "live",
      });
      return;
    }
    res.status(400).json({
      ok: false,
      status,
      error: r.data?.failedreason ?? r.data?.error ?? "unknown_failure",
      environment: creds.isSandbox ? "sandbox" : "live",
    });
  } catch (err) {
    logger.warn(
      { event: "admin_platform_gateway_test_failed", err: errMsg(err) },
      "admin_platform_gateway_test_failed",
    );
    res.status(500).json({ ok: false, error: errMsg(err) });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
