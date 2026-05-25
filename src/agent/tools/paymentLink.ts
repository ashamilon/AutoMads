import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { config } from "../../config/index.js";
import { initiatePaymentSession } from "../../integrations/sslcommerz/sslcommerzService.js";
import { logger } from "../../utils/logger.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import type { ToolDef } from "../types.js";

const Args = z.object({
  /** Optional. Without it, regenerates for this customer's latest unpaid SSL order. */
  orderId: z.string().min(3).max(120).optional(),
});

function buildTranId(orderId: string): string {
  return `TXN_${orderId.slice(0, 12)}_${Date.now()}_${randomBytes(2).toString("hex")}`;
}

export const paymentLinkTools: ToolDef[] = [
  {
    name: "regenerate_payment_link",
    description:
      "Generate a FRESH SSLCommerz payment link for an order whose old link has expired or stopped working. SSLCommerz gateway sessions expire ~30 minutes after creation, so 'link kaj korche na' / 'open hocche na' / '404 dekhachhe' usually means the session timed out. This tool creates a new session against the live gateway, updates the order's tran_id, and returns the new URL. Refuses if the order is already PAID or INITIATED (admin verification in progress) — those need admin attention, not a new link.",
    paramsSchema: Args,
    paramsHint: '{ "orderId"?: string }',
    examples: [
      {
        when: "Customer says 'payment link open hocche na' / '404 dekhachhe' / 'link expire hoye gechhe'",
        call: { tool: "regenerate_payment_link", args: {} },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = Args.parse(rawArgs);
      const order = args.orderId
        ? await prisma.order
            .findFirst({
              where: { tenantId: ctx.input.tenantId, OR: [{ id: args.orderId }, { sslcommerzTranId: args.orderId }] },
              orderBy: { createdAt: "desc" },
              include: { tenant: { select: { settings: true } } },
            })
            .catch(() => null)
        : await prisma.order
            .findFirst({
              where: {
                tenantId: ctx.input.tenantId,
                messengerPsid: ctx.input.psid,
                paymentStatus: { in: ["PENDING"] },
                paymentMethod: "SSLCOMMERZ",
              },
              orderBy: { createdAt: "desc" },
              include: { tenant: { select: { settings: true } } },
            })
            .catch(() => null);

      if (!order) {
        return {
          ok: false,
          error: "no_order",
          observation:
            "No unpaid SSLCommerz order to regenerate a link for. Use get_payment_status to see the customer's latest order state.",
        };
      }

      // Don't churn the tran_id once admin verification is in motion or payment is done.
      if (order.paymentStatus === "PAID") {
        return {
          ok: false,
          error: "already_paid",
          observation: `Order ${order.id.slice(0, 12)} is already PAID. Tell the customer payment is verified — no new link needed.`,
        };
      }
      if (order.paymentStatus === "INITIATED") {
        return {
          ok: false,
          error: "admin_verifying",
          observation: `Order ${order.id.slice(0, 12)} has a payment claim under admin review (paymentStatus=INITIATED). Tell the customer admin is verifying the existing payment — generating a new link would create a duplicate. Suggest opekkha korte.`,
        };
      }
      if (order.paymentMethod !== "SSLCOMMERZ") {
        return {
          ok: false,
          error: "not_ssl_order",
          observation: `Order ${order.id.slice(0, 12)} is on rail=${order.paymentMethod}, not SSLCommerz. Regenerate-link only works for SSL orders.`,
        };
      }

      const settings = parseTenantSettings(order.tenant.settings);
      const hasSsl =
        Boolean(settings.sslcommerz?.storeId?.trim()) && Boolean(settings.sslcommerz?.storePassword?.trim());
      if (!hasSsl) {
        return {
          ok: false,
          error: "ssl_not_configured",
          observation:
            "This tenant doesn't have SSLCommerz credentials configured. Tell the customer to use manual bKash/Nagad instead.",
        };
      }

      const subtotal = Number(order.totalAmount?.toString() ?? "0");
      const sd =
        order.structuredData && typeof order.structuredData === "object" && !Array.isArray(order.structuredData)
          ? (order.structuredData as Record<string, unknown>)
          : {};
      const advanceFromOrder =
        sd["advance"] && typeof sd["advance"] === "object" && !Array.isArray(sd["advance"])
          ? Number((sd["advance"] as Record<string, unknown>)["totalBdt"] ?? 0)
          : null;
      const payableNowBdt =
        advanceFromOrder != null && advanceFromOrder > 0
          ? advanceFromOrder
          : typeof settings.advancePaymentBdt === "number"
            ? settings.advancePaymentBdt
            : subtotal;

      const tranId = buildTranId(order.id);
      const base = config.publicBaseUrl.replace(/\/$/, "");
      const successUrl = `${base}/webhooks/sslcommerz/return?status=success&tran_id=${encodeURIComponent(tranId)}`;
      const failUrl = `${base}/webhooks/sslcommerz/return?status=failure`;
      const cancelUrl = `${base}/webhooks/sslcommerz/return?status=cancel`;
      const ipnUrl = `${base}/webhooks/sslcommerz/ipn`;

      const sessionInput: Parameters<typeof initiatePaymentSession>[0] = {
        tranId,
        totalAmount: payableNowBdt.toFixed(2),
        currency: order.currency || "BDT",
        successUrl,
        failUrl,
        cancelUrl,
        ipnUrl,
        customerName: String(sd["name"] ?? "Customer"),
        customerPhone: String(sd["phone"] ?? "000"),
        customerEmail: `fb-${ctx.input.psid}@customers.placeholder.local`,
        customerAddress: String(sd["address"] ?? ""),
      };
      if (settings.sslcommerz?.storeId) sessionInput.storeId = settings.sslcommerz.storeId;
      if (settings.sslcommerz?.storePassword) sessionInput.storePassword = settings.sslcommerz.storePassword;
      if (settings.sslcommerz?.isLive != null) sessionInput.isLive = settings.sslcommerz.isLive;

      let gatewayUrl: string;
      try {
        const session = await initiatePaymentSession(sessionInput);
        gatewayUrl = session.gatewayUrl;
      } catch (e) {
        logger.error(
          { e: String(e), orderId: order.id, tenantId: ctx.input.tenantId },
          "agent.regenerate_payment_link: SSL init failed",
        );
        return {
          ok: false,
          error: "ssl_init_failed",
          observation: `SSLCommerz init failed: ${String(e).slice(0, 200)}. Tell the customer admin will share a fresh link shortly, or offer manual bKash/Nagad.`,
        };
      }

      await prisma.order
        .update({ where: { id: order.id }, data: { sslcommerzTranId: tranId } })
        .catch(() => undefined);

      return {
        ok: true,
        observation: [
          `Fresh SSL session created for order ${order.id.slice(0, 12)}.`,
          `tran_id=${tranId}`,
          `payment_link=${gatewayUrl}`,
          `payable=${payableNowBdt} BDT`,
          "Reply: share the new link with a short note that link kichu khone valid thakbe — if it expires again, customer can ask for another.",
        ].join("\n"),
        data: {
          orderId: order.id,
          tranId,
          gatewayUrl,
          payableNowBdt,
        },
      };
    },
  },
];
