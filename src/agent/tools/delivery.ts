import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { getPathaoOrderStatus, type PathaoTenantConfig } from "../../integrations/pathao/pathaoService.js";
import type { ToolDef } from "../types.js";

const Args = z.object({
  /** Optional. Without it, returns the latest order's delivery status. */
  orderId: z.string().min(3).max(120).optional(),
});

/**
 * Map a raw Pathao status string to a short customer-friendly Banglish phrase.
 * Pathao's API uses snake_case strings like "Pickup_Requested", "On_Transit", "Delivered".
 */
function describePathaoStatus(raw: string): string {
  const s = raw.toLowerCase().replace(/[\s_-]+/g, "_");
  switch (s) {
    case "pending":
    case "pickup_requested":
    case "pickup_assigned":
      return "Pathao pickup request kora hoyeche, courier soon collect korbe.";
    case "picked":
    case "picked_up":
    case "pickup_done":
      return "Courier parcel pickup kore felechen, hub e jache.";
    case "in_hub":
    case "at_the_sorting_hub":
    case "at_sorting_hub":
      return "Parcel sorting hub e ache, ektu por delivery hub e pathano hobe.";
    case "on_transit":
    case "in_transit":
    case "on_the_way":
      return "Parcel delivery hub e pouchechi, customer er kache delivery te jache.";
    case "out_for_delivery":
    case "out_for_delivery_to_customer":
      return "Rider rastay ache, kichu khone delivery kore felben.";
    case "delivered":
      return "Parcel delivered hoye gechhe ✅";
    case "partial_delivered":
      return "Parcel partial delivered hoyeche.";
    case "returned":
    case "return_to_merchant":
      return "Parcel return kora hoye gechhe, admin contact koren.";
    case "cancelled":
      return "Delivery cancel kora hoyeche.";
    default:
      return raw;
  }
}

export const deliveryTools: ToolDef[] = [
  {
    name: "get_delivery_status",
    description:
      "Get the customer-facing delivery progress (tracking id, current courier status, tracking link). Reads our DB first, then calls Pathao's live API for the latest status. Use whenever the customer asks 'tracking id koi?', 'parcel ki ekhon kothay?', 'kobe pabo?', 'delivery status?'. Without `orderId` returns the latest order for this customer.",
    paramsSchema: Args,
    paramsHint: '{ "orderId"?: string }',
    examples: [
      {
        when: "Customer asks 'tracking id den' / 'parcel kothay?'",
        call: { tool: "get_delivery_status", args: {} },
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
              where: { tenantId: ctx.input.tenantId, messengerPsid: ctx.input.psid },
              orderBy: { createdAt: "desc" },
              include: { tenant: { select: { settings: true } } },
            })
            .catch(() => null);

      if (!order) {
        return {
          ok: false,
          error: "no_order",
          observation: "No order on file for this customer yet — nothing to track.",
        };
      }

      // Pre-payment / pre-booking states.
      if (order.paymentStatus !== "PAID") {
        return {
          ok: true,
          observation: [
            `order_id=${order.id.slice(0, 12)}`,
            `paymentStatus=${order.paymentStatus}`,
            `deliveryStatus=${order.deliveryStatus}`,
            "Tracking id will be available AFTER payment is verified and Pathao parcel is booked.",
            "Reply: tell the customer payment verify holei tracking id share kore dibo, ektu opekkha korte bolen.",
          ].join("\n"),
          data: {
            orderId: order.id,
            paymentStatus: order.paymentStatus,
            deliveryStatus: order.deliveryStatus,
            consignmentId: null,
            trackingId: null,
            trackingUrl: null,
          },
        };
      }

      if (!order.pathaoConsignmentId) {
        return {
          ok: true,
          observation: [
            `order_id=${order.id.slice(0, 12)} paymentStatus=PAID deliveryStatus=${order.deliveryStatus}`,
            order.deliveryStatus === "PENDING"
              ? "Order is paid but Pathao booking is queued / pending admin (manual mode or customised line)."
              : "Order is paid but no Pathao parcel has been booked yet.",
            "Reply: payment received, parcel booking under process — tracking id 1-2 hour er bhetore share kore dibo.",
          ].join("\n"),
          data: {
            orderId: order.id,
            paymentStatus: order.paymentStatus,
            deliveryStatus: order.deliveryStatus,
            consignmentId: null,
            trackingId: null,
            trackingUrl: null,
          },
        };
      }

      // Resolve Pathao config and ask the live API.
      const settings = parseTenantSettings(order.tenant.settings);
      const pathaoCfgRaw = settings.pathao as
        | (PathaoTenantConfig & { isLive?: boolean; bookingMode?: "automatic" | "manual" | "smart" })
        | undefined;
      const pathaoCfg: PathaoTenantConfig | undefined = pathaoCfgRaw
        ? {
            ...pathaoCfgRaw,
            baseUrl:
              pathaoCfgRaw.baseUrl ??
              (pathaoCfgRaw.isLive ? "https://api-hermes.pathao.com" : "https://courier-api-sandbox.pathao.com"),
          }
        : undefined;

      let liveStatus: string | null = null;
      let liveTrackingId: string | null = null;
      if (pathaoCfg) {
        try {
          const r = await getPathaoOrderStatus(pathaoCfg, order.pathaoConsignmentId);
          liveStatus = r.status ?? null;
          liveTrackingId = r.trackingId ?? null;
        } catch (e) {
          logger.warn(
            { e: String(e), tenantId: ctx.input.tenantId, orderId: order.id },
            "agent.get_delivery_status: Pathao status fetch failed",
          );
        }
      }

      const trackingId = liveTrackingId ?? order.pathaoConsignmentId;
      const trackingUrl = trackingId
        ? `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(trackingId)}`
        : null;
      const friendly = liveStatus
        ? describePathaoStatus(liveStatus)
        : describePathaoStatus(order.deliveryStatus);

      return {
        ok: true,
        observation: [
          `order_id=${order.id.slice(0, 12)} paymentStatus=PAID deliveryStatus=${order.deliveryStatus}`,
          liveStatus ? `pathao_live_status=${liveStatus}` : `pathao_live_status=unavailable (using stored deliveryStatus)`,
          `tracking_id=${trackingId}`,
          trackingUrl ? `tracking_url=${trackingUrl}` : "",
          `customer_friendly_progress=${friendly}`,
          "Reply: share the tracking id, the friendly progress note, and the tracking link in one short Banglish message.",
        ]
          .filter(Boolean)
          .join("\n"),
        data: {
          orderId: order.id,
          paymentStatus: order.paymentStatus,
          deliveryStatus: order.deliveryStatus,
          consignmentId: order.pathaoConsignmentId,
          trackingId,
          trackingUrl,
          pathaoLiveStatus: liveStatus,
          friendlyProgress: friendly,
        },
      };
    },
  },
];
