import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { config } from "../../config/index.js";
import { initiatePaymentSession } from "../../integrations/sslcommerz/sslcommerzService.js";
import { initiateAamarPaySession } from "../../integrations/aamarpay/aamarpayService.js";
import { createBkashPayment } from "../../integrations/bkash/bkashCheckoutService.js";
import { sendMessengerText } from "../../integrations/facebook/messengerService.js";
import { logger } from "../../utils/logger.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { resolveProductAddons } from "../addonResolver.js";
import { computeAdvanceForCart } from "../advanceResolver.js";
import { recordOrderForProfile, setProfileFields } from "../customerProfile.js";
import { cancelPendingFollowUps, scheduleFollowUp } from "../followUp.js";
import { recomputeStructuredCart } from "../state.js";
import type { ToolDef } from "../types.js";
import { persistValidationResult, readLatestValidation, runValidation } from "./validate.js";


const Args = z.object({}).strict();

/** Loose Bangladesh mobile number check: 11 digits starting 01, optional +880/880 prefix. */
function isValidBdPhone(raw: string): boolean {
  const cleaned = raw.replace(/[\s-]/g, "");
  return /^(?:\+?880)?01[0-9]{9}$/.test(cleaned);
}

function asMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function buildTranId(orderId: string): string {
  return `TXN_${orderId.slice(0, 12)}_${Date.now()}`;
}


type Verified = {
  sku: string;
  product: string;
  size?: string;
  quantity: number;
  unitPriceBdt: number;
  /** Sum of add-on per-unit prices applied to this line. */
  addOnsPerUnitBdt: number;
  addOns: Array<{ id: string; label: string; priceBdt: number; value?: string }>;
  lineTotalBdt: number;
};

async function verifyCart(
  tenantId: string,
  cart: Array<{
    sku: string;
    product: string;
    quantity: number;
    size?: string;
    unitPriceBdt?: number;
    addOns?: Array<{ id: string; label: string; priceBdt: number; value?: string }>;
  }>,
): Promise<{ ok: true; verified: Verified[]; subtotal: number } | { ok: false; reason: string }> {
  if (cart.length === 0) return { ok: false, reason: "cart_empty" };
  // Tenant settings only fetched once for the whole verification run.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const settings = parseTenantSettings(tenant?.settings);
  const verified: Verified[] = [];
  let subtotal = 0;
  for (const line of cart) {
    const row = await prisma.productMapping.findUnique({
      where: { tenantId_clientSku: { tenantId, clientSku: line.sku } },
    });
    if (!row) return { ok: false, reason: `sku_missing:${line.sku}` };
    const meta = asMeta(row.metadata);
    if (meta["isActive"] === false || meta["is_active"] === false) {
      return { ok: false, reason: `sku_inactive:${line.sku}` };
    }
    const livePrice = coerceNumber(meta["price"] ?? meta["unitPriceBdt"]);
    if (livePrice == null) return { ok: false, reason: `price_unknown:${line.sku}` };
    if (line.unitPriceBdt != null && line.unitPriceBdt !== livePrice) {
      return {
        ok: false,
        reason: `price_drift:${line.sku} cart=${line.unitPriceBdt} live=${livePrice}`,
      };
    }
    const stock = coerceNumber(meta["stock"]);
    if (stock != null && stock < line.quantity) {
      return { ok: false, reason: `insufficient_stock:${line.sku} have=${stock} need=${line.quantity}` };
    }

    // Re-resolve allowed add-ons for THIS sku and re-validate cart-line add-ons against them.
    const allowed = resolveProductAddons({ productMetadata: row.metadata, tenantSettings: settings });
    const allowedById = new Map(allowed.map((a) => [a.id, a] as const));
    const resolvedAddOns: Array<{ id: string; label: string; priceBdt: number; value?: string }> = [];
    for (const a of line.addOns ?? []) {
      const def = allowedById.get(a.id);
      if (!def) {
        return { ok: false, reason: `addon_not_allowed:${line.sku}/${a.id}` };
      }
      // Honour live override price (per-product or tenant default) — refuse if cart price drifted.
      if (a.priceBdt !== def.priceBdt) {
        return {
          ok: false,
          reason: `addon_price_drift:${line.sku}/${a.id} cart=${a.priceBdt} live=${def.priceBdt}`,
        };
      }
      const ao: { id: string; label: string; priceBdt: number; value?: string } = {
        id: def.id,
        label: def.label,
        priceBdt: def.priceBdt,
      };
      if (a.value?.trim()) ao.value = a.value.trim();
      resolvedAddOns.push(ao);
    }
    const addOnsPerUnitBdt = resolvedAddOns.reduce((s, a) => s + a.priceBdt, 0);
    const lineTotal = (livePrice + addOnsPerUnitBdt) * line.quantity;

    const v: Verified = {
      sku: line.sku,
      product: row.facebookLabel ?? line.product,
      quantity: line.quantity,
      unitPriceBdt: livePrice,
      addOnsPerUnitBdt,
      addOns: resolvedAddOns,
      lineTotalBdt: lineTotal,
    };
    if (line.size) v.size = line.size;
    verified.push(v);
    subtotal += lineTotal;
  }
  return { ok: true, verified, subtotal };
}


function buildPaymentBlock(args: {
  orderId: string;
  tranId: string | null;
  gatewayUrl: string | null;
  payableNowBdt: number;
  advanceBreakdown?: Array<{ kind: "fixed" | "plain" | "customised"; qty: number; unitBdt: number; subtotalBdt: number }>;
  deliveryChargeBdt?: number;
  manual: ReturnType<typeof parseTenantSettings>["manualPayment"];
}): string {
  const sections: string[] = ["✅ Order Confirmed"];
  sections.push(`🆔 Order ID:\n${args.tranId ?? args.orderId.slice(0, 12)}`);
  const charges: string[] = [];
  const breakdown = args.advanceBreakdown ?? [];
  if (breakdown.length === 0 && args.payableNowBdt > 0) {
    charges.push(`💵 Advance Payment: ${args.payableNowBdt} BDT`);
  } else if (breakdown.length === 1 && breakdown[0]!.kind === "fixed") {
    charges.push(`💵 Advance Payment: ${breakdown[0]!.subtotalBdt} BDT`);
  } else if (breakdown.length > 0) {
    charges.push(`💵 Advance Payment: ${args.payableNowBdt} BDT`);
    for (const b of breakdown) {
      const label =
        b.kind === "plain"
          ? "Per product"
          : b.kind === "customised"
            ? "Per customised product"
            : "Fixed";
      charges.push(`  • ${label}: ${b.unitBdt} × ${b.qty} = ${b.subtotalBdt} BDT`);
    }
  }
  if (typeof args.deliveryChargeBdt === "number") {
    charges.push(`🚚 Delivery Charge: ${args.deliveryChargeBdt} BDT`);
  }
  if (charges.length) sections.push(charges.join("\n"));
  if (args.gatewayUrl) sections.push(`🔗 Payment Link:\n${args.gatewayUrl}`);

  const m = args.manual;
  if (m?.enabled) {
    const bits: string[] = ["📲 Manual Payment"];
    if (m.bkash?.number?.trim()) bits.push(`🟣 bKash:\nSend Money → ${m.bkash.number.trim()}`);
    if (m.nagad?.number?.trim()) bits.push(`🔵 Nagad:\nSend Money → ${m.nagad.number.trim()}`);
    if (m.bkash?.number || m.nagad?.number) {
      const reply: string[] = ["💬 After payment, reply with:"];
      if (m.bkash?.number) reply.push("bkash <TrxID>");
      if (m.bkash?.number && m.nagad?.number) reply.push("or");
      if (m.nagad?.number) reply.push("nagad <TrxID>");
      bits.push(reply.join("\n"));
      bits.push(`📌 Reference:\n${args.orderId.slice(0, 12)}`);
      bits.push("📷 Kindly send Transaction ID or Screenshot after payment.");
      sections.push("━━━━━━━━━━");
      sections.push(bits.join("\n\n"));
    }
  }
  return sections.join("\n\n");
}


export const confirmTools: ToolDef[] = [
  {
    name: "confirm_order",
    description:
      "Finalise the customer's cart into an Order. Re-reads every line from the catalog (price + stock + active flag) before committing. Refuses if profile is incomplete or any line drifted. On success, creates the Order, opens an SSL payment session if configured, sends the payment block to the customer, schedules a payment-reminder follow-up, and ENDS the turn. Only call when the customer has explicitly said order/checkout/confirm and a real cart exists.",
    paramsSchema: Args,
    paramsHint: "{}",
    terminal: true,
    examples: [
      {
        when: "Customer says 'order confirm' and cart has at least one item with size, and profile has name+phone+address",
        call: { tool: "confirm_order", args: {} },
      },
    ],
    handler: async (_rawArgs, ctx) => {
      const cart = ctx.snapshot.cart;
      const profile = ctx.snapshot.profile;
      if (cart.length === 0) {
        return { ok: false, error: "cart_empty", observation: "Cart is empty — cannot confirm." };
      }

      // Pre-confirm guard (Req 6.6 / task 7.2): refuse to confirm when the most recent
      // validate_order result said the cart is broken. If no validation has been recorded
      // yet, run one synchronously here so we always have an authoritative answer before
      // creating an Order. The result is persisted onto the snapshot so subsequent tools
      // (and the router prompt) can see it without re-running the catalog reads.
      let validation = readLatestValidation(ctx.snapshot);
      if (!validation) {
        validation = await runValidation(ctx.input.tenantId, cart);
        await persistValidationResult(ctx, validation);
      }
      if (!validation.ok) {
        const reasons = validation.failures
          .map((f) => `${f.code} (line=${f.line_id.slice(0, 8)}): ${f.detail}`)
          .join("; ");
        return {
          ok: false,
          error: "validation_failed",
          observation:
            `Cannot confirm — validate_order reported ${validation.failures.length} issue(s): ${reasons}. ` +
            `Surface this to the customer and resolve before retrying confirm_order.`,
        };
      }

      const missing: string[] = [];
      if (!profile.name) missing.push("name");
      if (!profile.phone) missing.push("phone");
      if (!profile.address) missing.push("address");
      if (cart.some((c) => !c.size)) missing.push("size");
      if (missing.length > 0) {
        return {
          ok: false,
          error: "missing_fields",
          observation: `Cannot confirm — missing: ${missing.join(", ")}. Ask the customer for these first.`,
        };
      }
      if (profile.phone && !isValidBdPhone(profile.phone)) {
        return {
          ok: false,
          error: "invalid_phone",
          observation: `Phone "${profile.phone}" doesn't look like a valid Bangladesh number. Ask for an 11-digit number starting with 01.`,
        };
      }

      const verify = await verifyCart(ctx.input.tenantId, cart);
      if (!verify.ok) {
        return {
          ok: false,
          error: "verification_failed",
          observation: `Cannot confirm — ${verify.reason}. Tell the customer this product/price/size is no longer available and ask how they want to proceed.`,
        };
      }


      const tenant = await prisma.tenant.findUnique({ where: { id: ctx.input.tenantId } });
      if (!tenant) {
        return { ok: false, error: "tenant_missing", observation: "Tenant not found." };
      }
      const settings = parseTenantSettings(tenant.settings);
      const hasSsl =
        Boolean(settings.sslcommerz?.storeId?.trim()) &&
        Boolean(settings.sslcommerz?.storePassword?.trim());
      const hasAamarPay =
        Boolean(settings.aamarpay?.storeId?.trim()) &&
        Boolean(settings.aamarpay?.signatureKey?.trim());
      const hasBkashCheckout =
        Boolean(settings.bkashCheckout?.appKey?.trim()) &&
        Boolean(settings.bkashCheckout?.appSecret?.trim()) &&
        Boolean(settings.bkashCheckout?.username?.trim()) &&
        Boolean(settings.bkashCheckout?.password?.trim());
      const manual = settings.manualPayment;
      const hasManualBkash = Boolean(manual?.enabled && manual.bkash?.number?.trim());

      // Priority: SSLCommerz → AamarPay → bKash Tokenized → manual bKash → manual Nagad.
      // The first configured gateway wins. Tenants with multiple configured
      // gateways can later expose a per-order picker; for now this matches the
      // spec ("agent uses whichever is configured").
      const chosenGateway: "SSLCOMMERZ" | "AAMARPAY" | "BKASH_TOKENIZED" | "BKASH_MANUAL" | "NAGAD_MANUAL" = hasSsl
        ? "SSLCOMMERZ"
        : hasAamarPay
          ? "AAMARPAY"
          : hasBkashCheckout
            ? "BKASH_TOKENIZED"
            : hasManualBkash
              ? "BKASH_MANUAL"
              : "NAGAD_MANUAL";

      const productSubtotalBdt = verify.subtotal;
      const advance = computeAdvanceForCart({
        tenantSettings: settings,
        cart: verify.verified.map((v) => ({
          quantity: v.quantity,
          addOns: v.addOns,
        })),
      });
      // When no policy at all is set, payable_now defaults to the full subtotal — same as before.
      const payableNowBdt = advance.totalBdt > 0 ? advance.totalBdt : productSubtotalBdt;

      // Persist customer info to long-term profile.
      await setProfileFields(ctx.input.tenantId, ctx.input.psid, {
        name: profile.name,
        phone: profile.phone,
        address: profile.address,
      });

      const structuredData = {
        name: profile.name,
        phone: profile.phone,
        address: profile.address,
        product: verify.verified[0]?.product,
        size: verify.verified[0]?.size,
        quantity: verify.verified[0]?.quantity ?? 1,
        items: verify.verified.map((v) => ({
          product: v.product,
          size: v.size,
          quantity: v.quantity,
          unitPriceBdt: v.unitPriceBdt,
          unitAddOnBdt: v.addOnsPerUnitBdt,
          addOns: v.addOns,
        })),
        advance: {
          policy: advance.policyDescription,
          breakdown: advance.breakdown,
          totalBdt: advance.totalBdt,
        },
      };

      const order = await prisma.order.create({
        data: {
          tenantId: ctx.input.tenantId,
          messengerPsid: ctx.input.psid,
          structuredData: structuredData as Prisma.InputJsonValue,
          status: "PENDING_CLIENT_SYNC",
          paymentStatus: "PENDING",
          totalAmount: new Prisma.Decimal(productSubtotalBdt),
          currency: "BDT",
          paymentMethod: chosenGateway,
        },
      });


      let gatewayUrl: string | null = null;
      let tranId: string | null = null;
      // bKash uses a paymentID rather than a merchant tran id — we stash it on
      // sslcommerzSessionKey (reused as the universal gateway-session-id store).
      let bkashPaymentId: string | null = null;

      if (chosenGateway === "SSLCOMMERZ") {
        try {
          tranId = buildTranId(order.id);
          const base = config.publicBaseUrl.replace(/\/$/, "");
          const successUrl = `${base}/webhooks/sslcommerz/return?status=success&tran_id=${encodeURIComponent(tranId)}`;
          const failUrl = `${base}/webhooks/sslcommerz/return?status=failure`;
          const cancelUrl = `${base}/webhooks/sslcommerz/return?status=cancel`;
          const ipnUrl = `${base}/webhooks/sslcommerz/ipn`;
          const sessionInput: Parameters<typeof initiatePaymentSession>[0] = {
            tranId,
            totalAmount: payableNowBdt.toFixed(2),
            currency: "BDT",
            successUrl,
            failUrl,
            cancelUrl,
            ipnUrl,
            customerName: profile.name ?? "Customer",
            customerPhone: profile.phone ?? "000",
            customerEmail: `fb-${ctx.input.psid}@customers.placeholder.local`,
            customerAddress: profile.address,
          };
          if (settings.sslcommerz?.storeId) sessionInput.storeId = settings.sslcommerz.storeId;
          if (settings.sslcommerz?.storePassword)
            sessionInput.storePassword = settings.sslcommerz.storePassword;
          if (settings.sslcommerz?.isLive != null) sessionInput.isLive = settings.sslcommerz.isLive;
          const session = await initiatePaymentSession(sessionInput);
          gatewayUrl = session.gatewayUrl;
        } catch (e) {
          logger.warn(
            { e: String(e), orderId: order.id },
            "agent.confirm_order: SSL session init failed",
          );
        }
      } else if (chosenGateway === "AAMARPAY") {
        try {
          tranId = buildTranId(order.id);
          const base = config.publicBaseUrl.replace(/\/$/, "");
          const successUrl = `${base}/webhooks/aamarpay/return?status=success&mer_txnid=${encodeURIComponent(tranId)}`;
          const failUrl = `${base}/webhooks/aamarpay/return?status=fail&mer_txnid=${encodeURIComponent(tranId)}`;
          const cancelUrl = `${base}/webhooks/aamarpay/return?status=cancel&mer_txnid=${encodeURIComponent(tranId)}`;
          const ipnUrl = `${base}/webhooks/aamarpay/ipn`;
          const apInput: Parameters<typeof initiateAamarPaySession>[0] = {
            tranId,
            totalAmount: payableNowBdt.toFixed(2),
            currency: "BDT",
            successUrl,
            failUrl,
            cancelUrl,
            ipnUrl,
            customerName: profile.name ?? "Customer",
            customerPhone: profile.phone ?? "01700000000",
            customerEmail: `fb-${ctx.input.psid}@customers.placeholder.local`,
            customerAddress: profile.address ?? "N/A",
            description: `Order ${order.id.slice(0, 12)}`,
            storeId: settings.aamarpay!.storeId,
            signatureKey: settings.aamarpay!.signatureKey,
          };
          if (settings.aamarpay?.isLive != null) apInput.isLive = settings.aamarpay.isLive;
          const session = await initiateAamarPaySession(apInput);
          gatewayUrl = session.gatewayUrl;
        } catch (e) {
          logger.warn(
            { e: String(e), orderId: order.id },
            "agent.confirm_order: AamarPay session init failed",
          );
        }
      } else if (chosenGateway === "BKASH_TOKENIZED") {
        try {
          tranId = buildTranId(order.id);
          const base = config.publicBaseUrl.replace(/\/$/, "");
          // bKash uses a single callbackURL with status query param; we add
          // the tran id so we can correlate even before the bKash paymentID is
          // back from the create call.
          const callbackUrl = `${base}/webhooks/bkash/callback`;
          const bk = settings.bkashCheckout!;
          const session = await createBkashPayment({
            tranId,
            amount: payableNowBdt.toFixed(2),
            currency: "BDT",
            callbackUrl,
            payerReference: profile.phone ?? "01700000000",
            reference: `Order ${order.id.slice(0, 12)}`,
            creds: {
              appKey: bk.appKey,
              appSecret: bk.appSecret,
              username: bk.username,
              password: bk.password,
              ...(bk.isLive != null ? { isLive: bk.isLive } : {}),
            },
          });
          gatewayUrl = session.redirectUrl;
          bkashPaymentId = session.paymentId;
        } catch (e) {
          logger.warn(
            { e: String(e), orderId: order.id },
            "agent.confirm_order: bKash Tokenized session init failed",
          );
        }
      }

      const updateData: {
        status: "AWAITING_PAYMENT";
        sslcommerzTranId?: string;
        sslcommerzSessionKey?: string;
      } = { status: "AWAITING_PAYMENT" };
      if (tranId) updateData.sslcommerzTranId = tranId;
      if (bkashPaymentId) updateData.sslcommerzSessionKey = bkashPaymentId;
      await prisma.order
        .update({ where: { id: order.id }, data: updateData })
        .catch(() => undefined);


      const replyText = buildPaymentBlock({
        orderId: order.id,
        tranId,
        gatewayUrl,
        payableNowBdt,
        advanceBreakdown: advance.breakdown,
        ...(typeof settings.deliveryChargeBdt === "number"
          ? { deliveryChargeBdt: settings.deliveryChargeBdt }
          : {}),
        manual: settings.manualPayment,
      });

      try {
        await sendMessengerText({
          pageAccessToken: ctx.input.pageAccessToken,
          psid: ctx.input.psid,
          text: replyText,
          within24hWindow: ctx.input.within24h,
        });
        await prisma.messengerMessage
          .create({
            data: { conversationId: ctx.input.conversationId, role: "assistant", text: replyText },
          })
          .catch(() => undefined);
        await prisma.messengerConversation
          .update({ where: { id: ctx.input.conversationId }, data: { lastBotMsgAt: new Date() } })
          .catch(() => undefined);
      } catch (e) {
        logger.warn({ e: String(e), orderId: order.id }, "agent.confirm_order: messenger send failed");
      }

      // Long-term bookkeeping.
      await recordOrderForProfile({
        tenantId: ctx.input.tenantId,
        psid: ctx.input.psid,
        amountBdt: productSubtotalBdt,
      });
      // Cart is finalised — clear it from the conversation snapshot.
      // Recompute structured cart so subtotal=0 and order_status reflects the FSM advance
      // (caller has already advanced to ORDER_COMPLETE elsewhere; the recompute reads
      // whatever state is current).
      await ctx.saveSnapshot(recomputeStructuredCart({ ...ctx.snapshot, cart: [] }));

      // Schedule a 2h payment reminder; cancel any prior abandoned-cart nudge.
      await cancelPendingFollowUps(ctx.input.tenantId, ctx.input.psid);
      await scheduleFollowUp({
        tenantId: ctx.input.tenantId,
        psid: ctx.input.psid,
        conversationId: ctx.input.conversationId,
        kind: "payment_reminder",
        runAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        payload: { orderId: order.id, tranId },
      });

      return {
        ok: true,
        terminal: true,
        reply: replyText,
        observation: `Order ${order.id.slice(0, 12)} created. Payment link=${gatewayUrl ?? "manual"}, total=${productSubtotalBdt} BDT, payable_now=${payableNowBdt} BDT.`,
      };
    },
  },
];
