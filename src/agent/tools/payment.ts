import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import {
  appendManualPaymentAdminLog,
  detectLooseTxnReference,
  detectManualPaymentReference,
  findLatestPendingPaymentOrder,
  sendManualPaymentTelegramAlert,
} from "../../services/orderWorkflowService.js";
import type { ToolDef } from "../types.js";

const RailEnum = z.enum(["bkash", "nagad", "unknown"]);

const ClaimArgs = z.object({
  /**
   * Optional rail. If the customer just said "payment done" without specifying, pass "unknown" —
   * the tool will try to infer from the open order's paymentMethod.
   */
  rail: RailEnum.optional().default("unknown"),
  /**
   * The transaction reference the customer gave. Can be a full TrxID or just the last
   * 4-6 digits ("766gjc"). When the customer hasn't provided one yet, pass `claim_only=true`.
   */
  reference: z.string().min(2).max(40).optional(),
  /** True when the customer said they paid but hasn't given a TrxID yet. The tool will respond by asking for one. */
  claim_only: z.boolean().optional().default(false),
  /** Optional verbatim message text — used for admin alert context. */
  customer_text: z.string().min(1).max(500).optional(),
});

const StatusArgs = z.object({}).strict();

function asObj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export const paymentTools: ToolDef[] = [
  {
    name: "record_payment_claim",
    description:
      "Record that the customer claims they paid for their open order. Updates the order's payment status to INITIATED and fires the admin Telegram alert so a human can verify. Use whenever the customer says 'payment done', 'kore diyechi', sends a TrxID, or just last digits. If the customer hasn't given a TrxID yet, pass claim_only=true and the tool will return a hint to ask for one.",
    paramsSchema: ClaimArgs,
    paramsHint:
      '{ "rail": "bkash"|"nagad"|"unknown", "reference"?: string, "claim_only"?: boolean, "customer_text"?: string }',
    examples: [
      {
        when: "Customer says 'bkash done, trx 8AB12CD'",
        call: { tool: "record_payment_claim", args: { rail: "bkash", reference: "8AB12CD" } },
      },
      {
        when: "Customer says 'payment done vai' with no id yet",
        call: { tool: "record_payment_claim", args: { claim_only: true, customer_text: "payment done vai" } },
      },
      {
        when: "Customer types only the last digits like '766gjc'",
        call: { tool: "record_payment_claim", args: { reference: "766gjc" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = ClaimArgs.parse(rawArgs);
      const order = await findLatestPendingPaymentOrder({
        tenantId: ctx.input.tenantId,
        psid: ctx.input.psid,
      });
      if (!order) {
        return {
          ok: false,
          error: "no_open_order",
          observation:
            "No open order awaiting payment for this customer. If they're a returning customer with a paid order, get_order_summary instead.",
        };
      }

      // Try to extract a reference if it wasn't passed explicitly.
      let rail: "BKASH_MANUAL" | "NAGAD_MANUAL" | "UNKNOWN" =
        args.rail === "bkash"
          ? "BKASH_MANUAL"
          : args.rail === "nagad"
            ? "NAGAD_MANUAL"
            : "UNKNOWN";
      let reference = args.reference?.trim() ?? "";
      if (!reference && args.customer_text?.trim()) {
        const strict = detectManualPaymentReference(args.customer_text);
        if (strict) {
          rail = strict.rail;
          reference = strict.reference;
        } else {
          const loose = detectLooseTxnReference(args.customer_text);
          if (loose) reference = loose;
        }
      }

      // Promote the rail to whatever the order was originally set up for, when we still don't know.
      if (rail === "UNKNOWN") {
        rail = order.paymentMethod === "NAGAD_MANUAL" ? "NAGAD_MANUAL" : "BKASH_MANUAL";
      }

      // Path A: customer claims payment but gave no usable reference → ask for one.
      if (!reference && args.claim_only) {
        await appendManualPaymentAdminLog({
          tenantId: ctx.input.tenantId,
          event: "trx_prompted_customer",
          level: "info",
          orderId: order.id,
          psid: ctx.input.psid,
          rail,
          message: `Agent acknowledged payment claim, asking for TrxID. Customer said: "${(args.customer_text ?? "").slice(0, 120)}"`,
        });
        return {
          ok: true,
          observation: [
            `Order ${order.id.slice(0, 12)} is awaiting payment proof.`,
            "Customer claimed payment but no TrxID/reference yet.",
            "Tell them politely: send the bkash/nagad TrxID OR last 4-6 digits OR a payment screenshot — admin needs it to verify.",
            'Example reply: "Dhonnobad vai 🙂 Verify korar jonno bkash/nagad TrxID ta din, ba payment screenshot pathiye din — sathe sathe confirm kore dibo."',
          ].join("\n"),
        };
      }

      if (!reference) {
        return {
          ok: false,
          error: "no_reference",
          observation:
            "Cannot record claim without a TrxID/reference. Either pass `reference` from the customer message, or call again with `claim_only=true` to prompt them.",
        };
      }

      // Persist claim on the order. Don't mark it PAID — that's still the admin's job after Telegram verify.
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentMethod: rail,
          paymentStatus: "INITIATED",
          manualTxnId: reference,
          manualPaymentNote: `Customer-supplied via Messenger (agent record_payment_claim)`,
        },
      });

      await appendManualPaymentAdminLog({
        tenantId: ctx.input.tenantId,
        event: "trx_detected_matched_order",
        level: "info",
        orderId: order.id,
        psid: ctx.input.psid,
        rail,
        reference,
      });

      // Fire admin Telegram alert with inline Confirm/Reject buttons.
      const tenant = await prisma.tenant
        .findUnique({ where: { id: ctx.input.tenantId }, select: { settings: true } })
        .catch(() => null);
      const settings = parseTenantSettings(tenant?.settings);
      const sd = asObj(order.structuredData);
      let telegramSent = false;
      try {
        telegramSent = await sendManualPaymentTelegramAlert({
          settings,
          tenantSlug: ctx.input.tenantSlug,
          psid: ctx.input.psid,
          orderId: order.id,
          rail,
          reference,
          details: {
            ...sd,
            amount: order.totalAmount?.toString(),
          },
          customerText: args.customer_text,
        });
      } catch (e) {
        logger.warn(
          { e: String(e), orderId: order.id, tenantId: ctx.input.tenantId },
          "agent.record_payment_claim: Telegram alert failed",
        );
      }
      await appendManualPaymentAdminLog({
        tenantId: ctx.input.tenantId,
        event: telegramSent ? "telegram_alert_sent" : "telegram_alert_failed",
        level: telegramSent ? "info" : "warn",
        orderId: order.id,
        psid: ctx.input.psid,
        rail,
        reference,
      });

      return {
        ok: true,
        observation: [
          `Order ${order.id.slice(0, 12)} payment claim recorded.`,
          `Rail=${rail} reference=${reference} status=INITIATED.`,
          telegramSent
            ? "Admin Telegram alert sent — admin will verify and confirm shortly."
            : "Admin Telegram alert NOT sent (channel not configured / send failed). Tell the customer admin will check soon.",
          "Reply to the customer thanking them and saying admin will verify — don't claim it's CONFIRMED yet.",
        ].join("\n"),
        data: {
          orderId: order.id,
          rail,
          reference,
          paymentStatus: "INITIATED",
          telegramSent,
        },
      };
    },
  },
  {
    name: "get_payment_status",
    description:
      "Check whether the customer's most recent order has been verified as PAID. Use when the customer asks 'payment confirm hoyeche?', 'received hoyeche?'. Returns paymentStatus + when admin verified (if applicable).",
    paramsSchema: StatusArgs,
    paramsHint: "{}",
    examples: [
      { when: "Customer asks 'payment confirm hoyeche?'", call: { tool: "get_payment_status", args: {} } },
    ],
    handler: async (_rawArgs, ctx) => {
      const order = await prisma.order.findFirst({
        where: { tenantId: ctx.input.tenantId, messengerPsid: ctx.input.psid },
        orderBy: { createdAt: "desc" },
      });
      if (!order) {
        return {
          ok: false,
          error: "no_order",
          observation: "No order on file for this customer yet.",
        };
      }
      const verifiedAt = order.manuallyVerifiedAt ? order.manuallyVerifiedAt.toISOString() : null;
      const lines = [
        `order_id=${order.id.slice(0, 12)}`,
        `paymentStatus=${order.paymentStatus}`,
        `paymentMethod=${order.paymentMethod}`,
        order.manualTxnId ? `manualTxnId=${order.manualTxnId}` : "",
        verifiedAt ? `verifiedAt=${verifiedAt}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      return {
        ok: true,
        observation: lines,
        data: {
          orderId: order.id,
          paymentStatus: order.paymentStatus,
          paymentMethod: order.paymentMethod,
          manualTxnId: order.manualTxnId ?? null,
          manuallyVerifiedAt: verifiedAt,
        },
      };
    },
  },
];
