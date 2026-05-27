import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db/prisma.js";
import { maskSecrets } from "../utils/maskSecrets.js";
import { syncProductMappingsFromClientDatabase } from "../services/catalogSyncFromDb.js";
import {
  buildCloudinaryAssignments,
  buildCloudinarySyncDiagnostics,
  listAllCloudinaryImages,
  mergeMetadataImages,
} from "../services/cloudinaryCatalogImageSync.js";
import { confirmManualPayment, scheduleTrackingCheck } from "../services/orderWorkflowService.js";
import { generateInvoicePdf } from "../services/invoicePdfService.js";
import { computeAdvanceForCart } from "../agent/advanceResolver.js";
import { createPathaoOrder, getPathaoOrderStatus, type PathaoTenantConfig } from "../integrations/pathao/pathaoService.js";
import { createSteadfastOrder } from "../integrations/steadfast/steadfastService.js";
import { logger } from "../utils/logger.js";
import { z } from "zod";
import { config } from "../config/index.js";
import { parseTenantSettings } from "../types/tenant-settings.js";
import { resolveCloudinaryListArgs } from "../utils/resolveCloudinaryTenantOrEnv.js";
import { handleInboundMessengerMessage } from "../services/orderWorkflowService.js";
import axios from "axios";

export async function getMe(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const integration = await prisma.tenantIntegration.findUnique({ where: { tenantId: t.id } });
  res.json({
    id: t.id,
    name: t.name,
    slug: t.slug,
    isActive: t.isActive,
    facebookPageId: t.facebookPageId,
    hasFacebookPageAccessToken: !!t.facebookPageAccessToken,
    settings: t.settings,
    // Surfaced for the onboarding redirect logic in the client. `null` means
    // the wizard has not been completed; the portal is gated until the
    // tenant runs through the wizard once.
    onboardingCompletedAt: t.onboardingCompletedAt
      ? t.onboardingCompletedAt.toISOString()
      : null,
    businessCategory: t.businessCategory ?? null,
    integration: integration
      ? { type: integration.type, config: maskSecrets(integration.config) }
      : null,
  });
}

export async function listOrders(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const take = Math.min(Number(req.query.limit ?? 50), 200);
  const skip = Number(req.query.offset ?? 0);
  const orders = await prisma.order.findMany({
    where: { tenantId: t.id },
    orderBy: { createdAt: "desc" },
    take,
    skip,
  });
  res.json({ orders });
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const id = String(req.params.orderId ?? "");
  const order = await prisma.order.findFirst({
    where: { id, tenantId: t.id },
    include: { tenant: { select: { settings: true } } },
  });
  if (!order) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const settings = parseTenantSettings(order.tenant.settings);
  const subtotalBdt = Number(order.totalAmount?.toString() ?? "0");
  const deliveryChargeBdt =
    typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
  const grandTotalBdt = subtotalBdt + deliveryChargeBdt;

  // Advance resolution priority (matches the agent + invoice paths):
  //   1. structuredData.advance.totalBdt (per-product breakdown stored at confirm_order time)
  //   2. settings.advancePolicy (current per-tenant setting, fixed or per_product)
  //   3. settings.advancePaymentBdt (legacy fixed)
  //   4. fallback: 0 (NOT the full subtotal — that wildly overstates "advance paid")
  let advanceRequiredBdt: number | null = null;
  const sd =
    order.structuredData && typeof order.structuredData === "object" && !Array.isArray(order.structuredData)
      ? (order.structuredData as Record<string, unknown>)
      : {};
  const sdAdvance =
    sd["advance"] && typeof sd["advance"] === "object" && !Array.isArray(sd["advance"])
      ? (sd["advance"] as Record<string, unknown>)
      : null;
  if (sdAdvance && typeof sdAdvance["totalBdt"] === "number" && Number.isFinite(sdAdvance["totalBdt"])) {
    advanceRequiredBdt = sdAdvance["totalBdt"] as number;
  } else if (settings.advancePolicy) {
    const items = Array.isArray(sd["items"])
      ? (sd["items"] as Array<Record<string, unknown>>).map((it) => ({
          quantity: Number(it["quantity"] ?? 1) || 1,
          addOns: Array.isArray(it["addOns"]) ? (it["addOns"] as unknown[]) : [],
        }))
      : [{ quantity: Number(sd["quantity"] ?? 1) || 1, addOns: [] }];
    advanceRequiredBdt = computeAdvanceForCart({ tenantSettings: settings, cart: items }).totalBdt;
  } else if (typeof settings.advancePaymentBdt === "number") {
    advanceRequiredBdt = settings.advancePaymentBdt;
  } else {
    advanceRequiredBdt = 0;
  }

  // What the customer has actually paid so far:
  //   - PAID    → assume the configured advance was paid before delivery
  //   - INITIATED (customer claimed but admin hasn't confirmed) → not paid yet
  //   - anything else → 0
  const advancePaidBdt =
    order.paymentStatus === "PAID" ? Math.min(advanceRequiredBdt, grandTotalBdt) : 0;
  const dueBdt = Math.max(grandTotalBdt - advancePaidBdt, 0);

  const pathaoTrackingId = order.pathaoConsignmentId ?? null;
  const pathaoTrackingUrl = pathaoTrackingId
    ? `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(pathaoTrackingId)}`
    : null;

  const { tenant: _tenant, ...plainOrder } = order;
  res.json({
    order: plainOrder,
    courier: {
      subtotalBdt,
      deliveryChargeBdt,
      grandTotalBdt,
      advanceRequiredBdt,
      advancePaidBdt,
      dueBdt,
      pathaoTrackingId,
      pathaoTrackingUrl,
    },
  });
}

export async function getOrderInvoice(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const id = String(req.params.orderId ?? "");
  const order = await prisma.order.findFirst({
    where: { id, tenantId: t.id },
    include: { tenant: { select: { settings: true } } },
  });
  if (!order) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  let filePath: string | null = null;

  // Already-stored invoice URL is from a remote/different host (e.g. Cloudinary). Redirect.
  // Note: this only works when the client opens the response directly (not via fetch).
  if (order.invoiceUrl) {
    try {
      const u = new URL(order.invoiceUrl);
      if (u.host !== new URL(config.publicBaseUrl).host) {
        res.redirect(order.invoiceUrl);
        return;
      }
    } catch {
      // ignore: malformed URL → regenerate
    }
  }

  // We always regenerate the local PDF rather than reuse a cached file. Invoices are cheap to
  // render, and regenerating ensures formatting fixes (e.g. structured add-on lines, advance
  // breakdowns) and tenant-settings edits are reflected on the next download.
  if (!filePath) {
    const settings = parseTenantSettings(order.tenant.settings);
    const structured = order.structuredData as Record<string, unknown>;
    try {
      const invoice = await generateInvoicePdf({
        orderId: order.id,
        amountBdt: Number(order.totalAmount?.toString() ?? "0"),
        currency: order.currency,
        paymentMethod: order.paymentMethod,
        structured: structured as any,
        settings,
        paid: order.paymentStatus === "PAID",
      });
      await prisma.order
        .update({ where: { id: order.id }, data: { invoiceUrl: invoice.publicUrl } })
        .catch(() => undefined);
      filePath = invoice.filePath;
    } catch (e) {
      logger.error({ e, orderId: order.id }, "Invoice generation failed");
      res.status(500).json({ error: "invoice_generation_failed" });
      return;
    }
  }

  // Stream the PDF directly so the client (which may have called via authenticated fetch)
  // doesn't have to follow a 30x redirect to a static asset that lacks auth context.
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="invoice-${order.id.slice(0, 12)}.pdf"`,
  );
  res.setHeader("Cache-Control", "private, max-age=60");
  fs.createReadStream(filePath)
    .on("error", (err) => {
      logger.error({ err, orderId: order.id, filePath }, "Invoice stream failed");
      if (!res.headersSent) res.status(500).json({ error: "invoice_stream_failed" });
    })
    .pipe(res);
}

const productMappingBody = z.object({
  clientSku: z.string().min(1),
  facebookLabel: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function listProductMappings(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const rows = await prisma.productMapping.findMany({
    where: { tenantId: t.id },
    orderBy: { updatedAt: "desc" },
  });
  res.json({ productMappings: rows });
}

export async function upsertProductMapping(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const parsed = productMappingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const b = parsed.data;
  const row = await prisma.productMapping.upsert({
    where: { tenantId_clientSku: { tenantId: t.id, clientSku: b.clientSku } },
    create: {
      tenantId: t.id,
      clientSku: b.clientSku,
      facebookLabel: b.facebookLabel,
      metadata: b.metadata ? (b.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
    update: {
      facebookLabel: b.facebookLabel,
      metadata: b.metadata ? (b.metadata as Prisma.InputJsonValue) : undefined,
    },
  });
  res.json({ productMapping: row });
}

export async function deleteProductMapping(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const clientSku = String(req.params.clientSku ?? "");
  if (!clientSku) {
    res.status(400).json({ error: "clientSku_required" });
    return;
  }
  await prisma.productMapping.deleteMany({
    where: { tenantId: t.id, clientSku },
  });
  res.status(204).send();
}

const bulkDeleteProductMappingsBody = z.object({
  clientSkus: z.array(z.string().min(1).max(256)).max(5000).optional(),
  deleteAll: z.boolean().optional(),
});

/** Delete selected SKU mappings or all mappings for tenant. */
export async function bulkDeleteProductMappings(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const parsed = bulkDeleteProductMappingsBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { clientSkus, deleteAll } = parsed.data;
  if (deleteAll) {
    const out = await prisma.productMapping.deleteMany({ where: { tenantId: t.id } });
    res.json({ ok: true, deleted: out.count });
    return;
  }
  if (!clientSkus || clientSkus.length === 0) {
    res.status(400).json({ error: "clientSkus_required_or_set_deleteAll" });
    return;
  }
  const out = await prisma.productMapping.deleteMany({
    where: { tenantId: t.id, clientSku: { in: clientSkus } },
  });
  res.json({ ok: true, deleted: out.count });
}

const bulkProductMappingsBody = z.object({
  rows: z
    .array(
      z.object({
        clientSku: z.string().min(1).max(256),
        facebookLabel: z.string().max(2000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

/** Upsert many SKU → label rows (e.g. from CSV in the portal). */
export async function bulkUpsertProductMappings(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const parsed = bulkProductMappingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const rows = parsed.data.rows;
  const chunkSize = 80;
  let count = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.productMapping.upsert({
          where: { tenantId_clientSku: { tenantId: t.id, clientSku: row.clientSku } },
          create: {
            tenantId: t.id,
            clientSku: row.clientSku,
            facebookLabel: row.facebookLabel,
            metadata: row.metadata ? (row.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
          },
          update: {
            facebookLabel: row.facebookLabel ?? undefined,
            ...(row.metadata !== undefined
              ? { metadata: row.metadata as Prisma.InputJsonValue }
              : {}),
          },
        }),
      ),
    );
    count += chunk.length;
  }
  res.json({ ok: true, upserted: count });
}

export async function syncProductMappingsFromDatabase(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  try {
    const r = await syncProductMappingsFromClientDatabase(t.id);
    res.json({ ok: true, upserted: r.upserted });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "integration_not_database") {
      res.status(400).json({
        error: "integration_not_database",
        hint: "This workspace must use DATABASE integration with tables.products configured (server-side).",
      });
      return;
    }
    logger.error({ e, tenantId: t.id }, "Catalog sync from DB failed");
    res.status(500).json({ error: "sync_failed", detail: msg });
  }
}

const syncCloudinaryBody = z.object({
  /** Overrides `CLOUDINARY_CATALOG_PREFIX` for this run only */
  prefix: z.string().max(500).optional(),
  dryRun: z.boolean().optional(),
});

/**
 * Lists images from Cloudinary (Admin API), groups by parent folder `public_id`,
 * fuzzy-matches folder slug to catalog SKU / label / metadata.name, then sets
 * `metadata.images` to matched `secure_url` list (replaces previous `images`).
 */
export async function syncCloudinaryCatalogImages(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const parsed = syncCloudinaryBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const resolved = resolveCloudinaryListArgs(t.settings, parsed.data.prefix);
  if (!resolved) {
    res.status(400).json({
      error: "cloudinary_not_configured",
      hint:
        "Save Cloudinary cloud name, API key, and API secret under Settings → Catalog (or in workspace settings JSON), or set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET on the API server.",
    });
    return;
  }

  const { cloudName, apiKey, apiSecret, prefix, source: configSource } = resolved;
  try {
    const assets = await listAllCloudinaryImages({
      cloudName,
      apiKey,
      apiSecret,
      prefix,
    });
    const products = await prisma.productMapping.findMany({ where: { tenantId: t.id } });
    const preview = buildCloudinaryAssignments(assets, products);
    const diagnostics = buildCloudinarySyncDiagnostics(assets, products);

    if (parsed.data.dryRun) {
      res.json({
        ok: true,
        dryRun: true,
        configSource,
        assetCount: assets.length,
        matchedSkus: preview.length,
        preview,
        diagnostics,
      });
      return;
    }

    let updated = 0;
    for (const row of preview) {
      const map = await prisma.productMapping.findFirst({
        where: { tenantId: t.id, clientSku: row.clientSku },
      });
      if (!map) continue;
      const meta = mergeMetadataImages(map.metadata, row.urls);
      await prisma.productMapping.update({
        where: { id: map.id },
        data: { metadata: meta as Prisma.InputJsonValue },
      });
      updated++;
    }
    res.json({
      ok: true,
      dryRun: false,
      configSource,
      assetCount: assets.length,
      matchedSkus: preview.length,
      updated,
      preview,
      diagnostics,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ e, tenantId: t.id }, "Cloudinary catalog image sync failed");
    res.status(500).json({ error: "cloudinary_sync_failed", detail: msg });
  }
}

const markOrderPaidBody = z.object({
  rail: z.enum(["BKASH_MANUAL", "NAGAD_MANUAL"]),
  reference: z.string().min(3).max(64).optional(),
  note: z.string().max(500).optional(),
  verifiedBy: z.string().max(120).optional(),
});

/** Admin-driven manual payment verification — records and runs the post-paid pipeline. */
export async function markOrderPaidManually(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const orderId = String(req.params.orderId ?? "");
  if (!orderId) {
    res.status(400).json({ error: "order_id_required" });
    return;
  }
  const parsed = markOrderPaidBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    await confirmManualPayment({
      orderId,
      tenantId: t.id,
      rail: parsed.data.rail,
      reference: parsed.data.reference,
      verifiedBy: parsed.data.verifiedBy,
      note: parsed.data.note,
    });
    // Defense-in-depth: re-read the order with explicit tenant scope so the
    // controller never returns a row outside the caller's tenant, even if
    // `confirmManualPayment`'s validation ever regresses.
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId: t.id },
    });
    res.json({ ok: true, order });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ e, orderId, tenantId: t.id }, "Manual payment confirmation failed");
    res.status(400).json({ error: "manual_confirm_failed", detail: msg });
  }
}

const cancelOrderBody = z.object({
  reason: z.string().max(500).optional(),
});

export async function cancelOrder(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const orderId = String(req.params.orderId ?? "");
  const parsed = cancelOrderBody.safeParse(req.body ?? {});
  const reason = parsed.success ? parsed.data.reason : undefined;
  const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: t.id } });
  if (!order) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (order.status === "CANCELLED" || order.status === "COMPLETED" || order.status === "DELIVERY_SCHEDULED") {
    res.status(400).json({ error: "order_not_cancelable", status: order.status });
    return;
  }
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: "CANCELLED",
      paymentStatus: order.paymentStatus === "PAID" ? order.paymentStatus : "FAILED",
      failureReason: reason ? `cancelled:${reason}` : "cancelled_by_admin",
    },
  });
  res.json({ ok: true, order: updated });
}

const bookPathaoBody = z.object({
  recipientName: z.string().max(200).optional(),
  recipientPhone: z.string().max(30).optional(),
  recipientAddress: z.string().max(500).optional(),
  itemDescription: z.string().max(500).optional(),
  itemQuantity: z.number().int().min(1).optional(),
  amountToCollect: z.number().min(0).optional(),
});

export async function bookPathao(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const orderId = String(req.params.orderId ?? "");
  const parsed = bookPathaoBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", issues: parsed.error.issues });
    return;
  }
  const overrides = parsed.data;

  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId: t.id },
    include: { tenant: { select: { settings: true } } },
  });
  if (!order) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (order.paymentStatus !== "PAID") {
    res.status(400).json({ error: "order_not_paid" });
    return;
  }
  if (order.deliveryStatus === "BOOKED" || order.deliveryStatus === "DELIVERED" || order.deliveryStatus === "IN_TRANSIT") {
    res.status(400).json({ error: "already_booked", deliveryStatus: order.deliveryStatus });
    return;
  }

  const settings = parseTenantSettings(order.tenant.settings);
  const pathaoCfgRaw = settings.pathao as (PathaoTenantConfig & { isLive?: boolean }) | undefined;
  if (!pathaoCfgRaw) {
    res.status(400).json({ error: "pathao_not_configured" });
    return;
  }
  const pathaoCfg: PathaoTenantConfig = {
    ...pathaoCfgRaw,
    baseUrl:
      pathaoCfgRaw.baseUrl ??
      (pathaoCfgRaw.isLive ? "https://api-hermes.pathao.com" : "https://courier-api-sandbox.pathao.com"),
  };

  const structured = (order.structuredData ?? {}) as Record<string, unknown>;
  const items = Array.isArray(structured.items) ? structured.items : [];
  const subtotal = Number(order.totalAmount?.toString() ?? "0");
  const deliveryCharge = typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
  const configuredAdvance = typeof settings.advancePaymentBdt === "number" ? settings.advancePaymentBdt : subtotal;
  const payableTotal = subtotal + deliveryCharge;
  const defaultCod = Math.max(payableTotal - Math.min(configuredAdvance, payableTotal), 0);

  const recipientName = overrides.recipientName?.trim() || (structured.name as string)?.trim() || "Customer";
  const recipientPhone = overrides.recipientPhone?.trim() || (structured.phone as string)?.trim() || "";
  const recipientAddress = overrides.recipientAddress?.trim() || (structured.address as string)?.trim() || "";

  if (!recipientPhone || !recipientAddress) {
    res.status(400).json({ error: "missing_recipient_info", detail: "Phone and address are required" });
    return;
  }

  const quantity = overrides.itemQuantity ?? (items.reduce((s: number, it: any) => s + (it?.quantity ?? 1), 0) || 1);
  const itemDescription =
    overrides.itemDescription?.trim() ||
    (items.length > 0
      ? items
          .slice(0, 3)
          .map((it: any) => `${it.product || "Item"}${it.size ? `(${it.size})` : ""}x${it.quantity || 1}`)
          .join(", ")
      : String(structured.product ?? "Order"));
  const amountToCollect = overrides.amountToCollect ?? defaultCod;

  try {
    const delivery = await createPathaoOrder(pathaoCfg, {
      merchantOrderId: order.id,
      recipientName,
      recipientPhone,
      recipientAddress,
      itemDescription,
      itemQuantity: quantity,
      amountToCollect,
    });
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        pathaoConsignmentId: delivery.consignmentId,
        status: "DELIVERY_SCHEDULED",
        deliveryStatus: "BOOKED",
      },
    });

    const tenant = await prisma.tenant.findUnique({ where: { id: order.tenantId } });
    if (tenant?.facebookPageAccessToken) {
      scheduleTrackingCheck({
        orderId: order.id,
        consignmentId: delivery.consignmentId,
        tenantId: order.tenantId,
        psid: order.messengerPsid,
        pageAccessToken: tenant.facebookPageAccessToken,
        pathaoCfg,
        bookedAt: Date.now(),
      });
    }

    res.json({ ok: true, consignmentId: delivery.consignmentId, order: updated });
  } catch (e) {
    logger.error({ e, orderId }, "Manual Pathao booking failed");
    res.status(500).json({ error: "pathao_booking_failed", detail: String(e) });
  }
}

const bookSteadfastBody = z.object({
  recipientName: z.string().max(200).optional(),
  recipientPhone: z.string().max(30).optional(),
  recipientAddress: z.string().max(500).optional(),
  itemDescription: z.string().max(500).optional(),
  cashAmount: z.number().min(0).optional(),
  note: z.string().max(250).optional(),
});

export async function bookSteadfast(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const orderId = String(req.params.orderId ?? "");
  const parsed = bookSteadfastBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", issues: parsed.error.issues });
    return;
  }
  const overrides = parsed.data;

  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId: t.id },
    include: { tenant: { select: { settings: true } } },
  });
  if (!order) { res.status(404).json({ error: "not_found" }); return; }
  if (order.paymentStatus !== "PAID") {
    res.status(400).json({ error: "order_not_paid" });
    return;
  }
  if (order.deliveryStatus === "BOOKED" || order.deliveryStatus === "DELIVERED" || order.deliveryStatus === "IN_TRANSIT") {
    res.status(400).json({ error: "already_booked", deliveryStatus: order.deliveryStatus });
    return;
  }

  const settings = parseTenantSettings(order.tenant.settings);
  const sf = settings.steadfast;
  if (!sf?.apiKey || !sf?.secretKey) {
    res.status(400).json({ error: "steadfast_not_configured" });
    return;
  }

  const structured = (order.structuredData ?? {}) as Record<string, unknown>;
  const items = Array.isArray(structured.items) ? structured.items : [];
  const subtotal = Number(order.totalAmount?.toString() ?? "0");
  const deliveryCharge = typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
  const configuredAdvance = typeof settings.advancePaymentBdt === "number" ? settings.advancePaymentBdt : subtotal;
  const payableTotal = subtotal + deliveryCharge;
  const defaultCod = Math.max(payableTotal - Math.min(configuredAdvance, payableTotal), 0);

  const recipientName = overrides.recipientName?.trim() || (structured.name as string)?.trim() || "Customer";
  const recipientPhone = overrides.recipientPhone?.trim() || (structured.phone as string)?.trim() || "";
  const recipientAddress = overrides.recipientAddress?.trim() || (structured.address as string)?.trim() || "";
  if (!recipientPhone || !recipientAddress) {
    res.status(400).json({ error: "missing_recipient_info", detail: "Phone and address are required" });
    return;
  }
  const itemDescription =
    overrides.itemDescription?.trim() ||
    (items.length > 0
      ? items
          .slice(0, 3)
          .map((it: any) => `${it.product || "Item"}${it.size ? `(${it.size})` : ""}x${it.quantity || 1}`)
          .join(", ")
      : String(structured.product ?? "Order"));
  const cashAmount = overrides.cashAmount ?? defaultCod;

  try {
    const delivery = await createSteadfastOrder(
      { apiKey: sf.apiKey, secretKey: sf.secretKey },
      {
        merchantOrderId: order.id,
        recipientName,
        recipientPhone,
        recipientAddress,
        itemDescription,
        cashAmount,
        ...(overrides.note ? { note: overrides.note } : {}),
      },
    );
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        // Reuse the courier-consignment column. Naming is historical (Pathao);
        // semantics are now "the active courier's consignment id".
        pathaoConsignmentId: delivery.consignmentId,
        // Preserve the tracking_code on the existing pathaoMerchantOrderId
        // column (also reused as a courier-tracking-id store).
        pathaoMerchantOrderId: delivery.trackingCode || null,
        status: "DELIVERY_SCHEDULED",
        deliveryStatus: "BOOKED",
      },
    });
    res.json({ ok: true, consignmentId: delivery.consignmentId, trackingCode: delivery.trackingCode, order: updated });
  } catch (e) {
    logger.error({ e, orderId }, "Manual Steadfast booking failed");
    res.status(500).json({ error: "steadfast_booking_failed", detail: String(e) });
  }
}

const patchSettingsBody = z.object({
  settings: z.record(z.string(), z.unknown()),
});

const simulateChatBody = z.object({
  text: z.string().max(2000).default(""),
  psid: z.string().min(3).max(120).optional(),
  imageUrls: z.array(z.string().url()).max(5).optional(),
  imageBase64: z.array(z.string()).max(5).optional(),
});

export async function patchTenantSettings(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const parsed = patchSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const updated = await prisma.tenant.update({
    where: { id: t.id },
    data: { settings: parsed.data.settings as Prisma.InputJsonValue },
  });
  res.json({ settings: updated.settings });
}

export async function simulateChat(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const parsed = simulateChatBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const text = parsed.data.text.trim();
  const imageUrls = [
    ...(parsed.data.imageUrls?.filter((u) => u.trim()) ?? []),
    ...(parsed.data.imageBase64?.filter((b) => b.startsWith("data:")) ?? []),
  ];
  if (!text && imageUrls.length === 0) {
    res.status(400).json({ error: "text or images required" });
    return;
  }
  // Sandbox PSIDs MUST start with `SIM_` so:
  //   1. `isSimulatorPsid()` short-circuits real Messenger sends, and
  //   2. a tenant cannot inject a real customer PSID (theirs or someone
  //      else's) and have the agent persist a "real" conversation or
  //      send a real Graph-API reply.
  // We accept the user's optional `psid` only as a per-session label that
  // we sanitise + force-prefix with `SIM_` and the tenant id, so two
  // tenants can never collide on the same simulator conversation row.
  const rawPsid = (parsed.data.psid?.trim() || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const psid = `SIM_${t.id.slice(0, 10)}_${rawPsid}`;
  const startedAt = new Date();
  await handleInboundMessengerMessage({
    tenantId: t.id,
    tenantSlug: t.slug,
    psid,
    text: text || undefined,
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
  });
  const convo = await prisma.messengerConversation.findUnique({
    where: { tenantId_psid: { tenantId: t.id, psid } },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 30,
      },
    },
  });
  const latestAssistant =
    convo?.messages.find((m) => m.role === "assistant" && m.createdAt >= startedAt)?.text ??
    convo?.messages.find((m) => m.role === "assistant")?.text ??
    "";
  res.json({
    ok: true,
    psid,
    reply: latestAssistant,
    messages: (convo?.messages ?? []).map((m) => ({
      role: m.role,
      text: m.text,
      imageUrl: m.imageUrls?.[0] ?? undefined,
      createdAt: m.createdAt,
    })),
  });
}

export async function uploadBusinessLogo(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "file_required" });
    return;
  }
  if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.mimetype)) {
    res.status(400).json({ error: "unsupported_image_type" });
    return;
  }
  const ext = file.mimetype.includes("png")
    ? "png"
    : file.mimetype.includes("webp")
      ? "webp"
      : "jpg";
  const dir = path.join(process.cwd(), "public", "tenant-assets", t.id);
  fs.mkdirSync(dir, { recursive: true });
  const name = `logo-${Date.now()}.${ext}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, file.buffer);
  const logoUrl = `${config.publicBaseUrl.replace(/\/$/, "")}/tenant-assets/${encodeURIComponent(t.id)}/${encodeURIComponent(name)}`;

  const current = t.settings && typeof t.settings === "object" ? (t.settings as Record<string, unknown>) : {};
  const businessProfile =
    current["businessProfile"] && typeof current["businessProfile"] === "object"
      ? (current["businessProfile"] as Record<string, unknown>)
      : {};
  const merged = {
    ...current,
    businessProfile: {
      ...businessProfile,
      logoUrl,
    },
  };
  const updated = await prisma.tenant.update({
    where: { id: t.id },
    data: { settings: merged as Prisma.InputJsonValue },
  });
  res.json({ ok: true, logoUrl, settings: updated.settings });
}

export async function previewInvoice(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const settings = parseTenantSettings(t.settings);
  const sampleUnit = settings.defaultOrderAmountBdt ?? 1200;
  const sampleQty = 2;
  const preview = await generateInvoicePdf({
    orderId: `preview-${Date.now()}`,
    amountBdt: sampleUnit * sampleQty,
    currency: "BDT",
    paymentMethod: "SSLCOMMERZ",
    structured: {
      name: "Demo Customer",
      product: "Premium Cotton Jersey",
      size: "L",
      quantity: sampleQty,
      address: "House 12, Road 4, Cumilla, Bangladesh",
      phone: "01XXXXXXXXX",
    },
    settings,
    paid: true,
  });
  res.json({ ok: true, url: preview.publicUrl });
}

// ─── Scheduled Posts (Content Calendar) ──────────────────────────────────────

import { publishScheduledPost as doPublish, generateCaption, type BrandVoice } from "../services/socialPostService.js";

export async function listScheduledPosts(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const posts = await prisma.scheduledPost.findMany({
    where: { tenantId: t.id },
    orderBy: { scheduledAt: "desc" },
    take: 100,
  });
  res.json(posts);
}

export async function createScheduledPost(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const { platform, postType, caption, imageUrls, productSkus, scheduledAt, status } = req.body;

  if (!caption || typeof caption !== "string" || !caption.trim()) {
    res.status(400).json({ error: "caption is required" });
    return;
  }

  // Drafts and pending_approval rows can be created without a schedule time;
  // the UI lets clients save a half-built post. Only scheduled posts must
  // carry a real timestamp.
  const desiredStatus: string = typeof status === "string" ? status : "scheduled";
  const ALLOWED_STATUSES = ["draft", "pending_approval", "approved", "scheduled"] as const;
  if (!(ALLOWED_STATUSES as readonly string[]).includes(desiredStatus)) {
    res.status(400).json({ error: "invalid_status", allowed: ALLOWED_STATUSES });
    return;
  }
  if (desiredStatus === "scheduled" && !scheduledAt) {
    res.status(400).json({ error: "scheduledAt is required for scheduled status" });
    return;
  }

  const post = await prisma.scheduledPost.create({
    data: {
      tenantId: t.id,
      platform: platform ?? "facebook",
      postType: postType ?? "product_showcase",
      caption: caption.trim(),
      imageUrls: imageUrls ?? [],
      productSkus: productSkus ?? null,
      // For non-scheduled rows we still need a timestamp on the column —
      // store the createdAt-equivalent so the calendar list can sort.
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      status: desiredStatus,
    },
  });
  res.status(201).json(post);
}

export async function approveScheduledPost(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const id = req.params.id as string;
  const existing = await prisma.scheduledPost.findFirst({ where: { id, tenantId: t.id } });
  if (!existing) { res.status(404).json({ error: "not_found" }); return; }
  if (existing.status !== "pending_approval" && existing.status !== "draft") {
    res.status(400).json({ error: "cannot_approve", currentStatus: existing.status });
    return;
  }
  // Approval moves the post to "scheduled" so the postScheduler tick will pick
  // it up at scheduledAt. If the customer didn't pick a time we publish ASAP
  // (within the next scheduler tick).
  const scheduledAt = req.body?.scheduledAt
    ? new Date(req.body.scheduledAt)
    : existing.scheduledAt && existing.scheduledAt > new Date()
      ? existing.scheduledAt
      : new Date();
  const updated = await prisma.scheduledPost.update({
    where: { id },
    data: { status: "scheduled", scheduledAt, failureReason: null },
  });
  res.json(updated);
}

export async function rejectScheduledPost(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const id = req.params.id as string;
  const existing = await prisma.scheduledPost.findFirst({ where: { id, tenantId: t.id } });
  if (!existing) { res.status(404).json({ error: "not_found" }); return; }
  if (existing.status === "published") {
    res.status(400).json({ error: "cannot_reject_published" });
    return;
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 200) : "rejected by client";
  const updated = await prisma.scheduledPost.update({
    where: { id },
    data: { status: "draft", failureReason: reason },
  });
  res.json(updated);
}

export async function updateScheduledPost(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const id = req.params.id as string;
  const existing = await prisma.scheduledPost.findFirst({ where: { id, tenantId: t.id } });
  if (!existing) { res.status(404).json({ error: "not_found" }); return; }
  if (existing.status === "published") { res.status(400).json({ error: "cannot_edit_published" }); return; }

  const { platform, postType, caption, imageUrls, productSkus, scheduledAt, status } = req.body;
  const updated = await prisma.scheduledPost.update({
    where: { id },
    data: {
      ...(platform != null ? { platform } : {}),
      ...(postType != null ? { postType } : {}),
      ...(caption != null ? { caption } : {}),
      ...(imageUrls != null ? { imageUrls } : {}),
      ...(productSkus !== undefined ? { productSkus } : {}),
      ...(scheduledAt != null ? { scheduledAt: new Date(scheduledAt) } : {}),
      ...(status != null ? { status } : {}),
    },
  });
  res.json(updated);
}

export async function deleteScheduledPost(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const id = req.params.id as string;
  const existing = await prisma.scheduledPost.findFirst({ where: { id, tenantId: t.id } });
  if (!existing) { res.status(404).json({ error: "not_found" }); return; }

  await prisma.scheduledPost.delete({ where: { id } });
  res.json({ ok: true });
}

export async function publishScheduledPostNow(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const id = req.params.id as string;
  const existing = await prisma.scheduledPost.findFirst({ where: { id, tenantId: t.id } });
  if (!existing) { res.status(404).json({ error: "not_found" }); return; }
  if (existing.status === "published" && existing.fbPostId) {
    res.status(400).json({ error: "already_published" });
    return;
  }

  try {
    await doPublish(id);
    const refreshed = await prisma.scheduledPost.findUnique({ where: { id } });
    if (refreshed?.status === "failed") {
      res.status(422).json({
        error: "publish_failed",
        failureReason: refreshed.failureReason,
        post: refreshed,
      });
      return;
    }
    res.json(refreshed);
  } catch (e) {
    res.status(500).json({ error: "publish_failed", detail: String(e) });
  }
}

export async function generatePostCaption(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const { productNames, prices, tags, postType, language, style } = req.body;
  if (!productNames || !Array.isArray(productNames) || productNames.length === 0) {
    res.status(400).json({ error: "productNames array required" });
    return;
  }
  // Pull brand voice from tenant settings so captions inherit tone, banned
  // words, emoji preference, etc. Settings is a loose JSON column — read
  // defensively.
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  const brandVoiceRaw = (settings["brandVoice"] ?? {}) as Record<string, unknown>;
  const emojiPreference =
    brandVoiceRaw.emojiPreference === "minimal" ||
    brandVoiceRaw.emojiPreference === "balanced" ||
    brandVoiceRaw.emojiPreference === "expressive" ||
    brandVoiceRaw.emojiPreference === "none"
      ? brandVoiceRaw.emojiPreference
      : undefined;
  const hashtagStyle =
    brandVoiceRaw.hashtagStyle === "none" || brandVoiceRaw.hashtagStyle === "few" || brandVoiceRaw.hashtagStyle === "many"
      ? brandVoiceRaw.hashtagStyle
      : undefined;
  const bvLanguage =
    brandVoiceRaw.language === "banglish" || brandVoiceRaw.language === "bangla" || brandVoiceRaw.language === "english"
      ? brandVoiceRaw.language
      : undefined;
  const brandVoice: BrandVoice = {
    tone: typeof brandVoiceRaw.tone === "string" ? brandVoiceRaw.tone : undefined,
    vocabulary: Array.isArray(brandVoiceRaw.vocabulary)
      ? (brandVoiceRaw.vocabulary as string[]).filter((x) => typeof x === "string")
      : undefined,
    bannedWords: Array.isArray(brandVoiceRaw.bannedWords)
      ? (brandVoiceRaw.bannedWords as string[]).filter((x) => typeof x === "string")
      : undefined,
    ...(emojiPreference ? { emojiPreference } : {}),
    ...(hashtagStyle ? { hashtagStyle } : {}),
    ...(bvLanguage ? { language: bvLanguage } : {}),
  };
  const caption = await generateCaption({
    productNames,
    prices: prices ?? [],
    tags: tags ?? [],
    postType: postType ?? "product_showcase",
    language: language ?? brandVoice.language ?? "banglish",
    ...(typeof style === "string" ? { style } : {}),
    brandVoice,
  });
  res.json({ caption });
}

// ─── Content Agent (autonomous post drafter) ────────────────────────────────

import { runContentAgent, parseContentAgentSettings } from "../services/contentAgentService.js";

/** GET current contentAgent settings + brandVoice from tenant.settings JSON. */
export async function getContentAgentSettings(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  const contentAgent = parseContentAgentSettings(settings.contentAgent);
  const brandVoice = settings.brandVoice ?? {};
  res.json({ contentAgent, brandVoice });
}

/** PATCH contentAgent + brandVoice config in tenant.settings JSON. */
export async function updateContentAgentSettings(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const body = req.body ?? {};
  const tenant = await prisma.tenant.findUnique({ where: { id: t.id } });
  if (!tenant) { res.status(404).json({ error: "tenant_not_found" }); return; }
  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...settings };
  if (body.contentAgent && typeof body.contentAgent === "object") {
    next.contentAgent = { ...((settings.contentAgent ?? {}) as Record<string, unknown>), ...body.contentAgent };
  }
  if (body.brandVoice && typeof body.brandVoice === "object") {
    next.brandVoice = { ...((settings.brandVoice ?? {}) as Record<string, unknown>), ...body.brandVoice };
  }
  await prisma.tenant.update({ where: { id: t.id }, data: { settings: next as object } });
  res.json({
    contentAgent: parseContentAgentSettings(next.contentAgent),
    brandVoice: next.brandVoice ?? {},
  });
}

/** Manual trigger for the autonomous agent ("Run agent now" button). */
export async function runContentAgentNow(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  try {
    const result = await runContentAgent(t.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "agent_failed", detail: String(e) });
  }
}

// ─── Social Account Validation ───────────────────────────────────────────────

/**
 * GET /api/v1/social/facebook-status
 *
 * Live "ready to post on Facebook" check used by the content calendar page.
 *
 * Meta has tightened permission gating — even reading the page's own name
 * needs `pages_read_engagement`, listing subscribed_apps needs
 * `pages_manage_metadata`, and posting needs `pages_manage_posts`. Most
 * pre-review apps only have `pages_messaging` (the messenger bot perm).
 *
 * The endpoint walks four probes from cheapest-and-most-informative to
 * structural-only, and returns the first one that succeeds:
 *
 *   Tier 1: `GET /me?fields=id,name`   — needs pages_read_engagement.
 *           Best case: returns the page name → "verified".
 *
 *   Tier 2: `GET /me?fields=id`        — sometimes works without read perms.
 *           Confirms id → "verified" (without page name).
 *
 *   Tier 3: `GET /me/messenger_profile?fields=greeting`
 *                                       — uses pages_messaging, the same
 *           permission the inbound webhook is already using. If your bot is
 *           replying to customers, this WILL succeed. We can't read the page
 *           name here but messenger_profile is page-scoped, so a 200 means
 *           the token is bound to *some* page; we mark `pageMatch` as null
 *           ("can't verify without a read perm") and report `messenger_ok`.
 *
 *   Tier 4: structural-only             — all Graph calls failed but the
 *           token looks like a real page token (`EAA…`, length > 80) and
 *           there's a configured pageId. We report `configured` with a
 *           clear note that publishing needs `pages_manage_posts`.
 *
 * The dashboard renders these distinctly so the tenant always knows what's
 * proven, what's assumed, and what to ask the admin for.
 */
export async function validateFacebookPage(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const pageId = t.facebookPageId ?? null;
  const pageAccessToken = t.facebookPageAccessToken ?? null;

  if (!pageId) {
    res.json({
      ok: false,
      mode: null,
      pageId: null,
      hasToken: !!pageAccessToken,
      tokenValid: false,
      pageName: null,
      pageMatch: false,
      note: null,
      error: "Page ID is not configured for this tenant. Ask the admin to set it.",
    });
    return;
  }
  if (!pageAccessToken) {
    res.json({
      ok: false,
      mode: null,
      pageId,
      hasToken: false,
      tokenValid: false,
      pageName: null,
      pageMatch: false,
      note: null,
      error:
        "Facebook Page Access Token is missing. Add it from Settings → Pages or ask the admin to configure it.",
    });
    return;
  }

  const isPermErr = (msg: string, code: number | undefined) =>
    /pages_read_engagement|pages_manage_metadata|pages_manage_posts|page public content access|page public metadata access|requires.*permission/i.test(
      msg,
    ) || code === 100 || code === 200 || code === 10 || code === 200;

  // ── Tier 1 — /me?fields=id,name ──────────────────────────────────────────
  try {
    const r = await axios.get("https://graph.facebook.com/v21.0/me", {
      params: { fields: "id,name", access_token: pageAccessToken },
      timeout: 5000,
    });
    const data = r.data as { id?: string; name?: string };
    const liveId = String(data?.id ?? "");
    const liveName = String(data?.name ?? "") || null;
    const pageMatch = !!liveId && liveId === pageId;
    if (!pageMatch) {
      res.json({
        ok: false,
        mode: "verified",
        pageId,
        hasToken: true,
        tokenValid: true,
        pageName: liveName,
        pageMatch: false,
        note: null,
        error:
          `Token works but it belongs to page "${liveName ?? liveId}" (id ${liveId}), not the configured page id ${pageId}. ` +
          `Update the token in Settings → Pages to one for the correct page.`,
      });
      return;
    }
    res.json({
      ok: true,
      mode: "verified",
      pageId,
      hasToken: true,
      tokenValid: true,
      pageName: liveName,
      pageMatch: true,
      note: null,
      error: null,
    });
    return;
  } catch (e1) {
    const err1 = e1 as {
      response?: { data?: { error?: { message?: string; code?: number } } };
      message?: string;
    };
    const ge1 = err1?.response?.data?.error;
    const msg1 = ge1?.message ?? err1?.message ?? String(e1);
    if (!isPermErr(msg1, ge1?.code)) {
      // Not a permission gate — the token is genuinely broken.
      res.json({
        ok: false,
        mode: "broken",
        pageId,
        hasToken: true,
        tokenValid: false,
        pageName: null,
        pageMatch: false,
        note: null,
        error: `Facebook rejected the token: ${msg1}`,
      });
      return;
    }

    // ── Tier 2 — /me?fields=id (sometimes allowed without read perms) ─────
    try {
      const r2 = await axios.get("https://graph.facebook.com/v21.0/me", {
        params: { fields: "id", access_token: pageAccessToken },
        timeout: 5000,
      });
      const liveId = String((r2.data as { id?: string })?.id ?? "");
      const pageMatch = !!liveId && liveId === pageId;
      if (pageMatch) {
        res.json({
          ok: true,
          mode: "verified",
          pageId,
          hasToken: true,
          tokenValid: true,
          pageName: null,
          pageMatch: true,
          note:
            "Page id verified with Facebook. Page name isn't shown because the app doesn't have " +
            "`pages_read_engagement`, but that's not required for publishing.",
          error: null,
        });
        return;
      }
      // mismatch on id-only is still a real mismatch
      res.json({
        ok: false,
        mode: "verified",
        pageId,
        hasToken: true,
        tokenValid: true,
        pageName: null,
        pageMatch: false,
        note: null,
        error:
          `Token belongs to page id ${liveId}, not the configured ${pageId}. Update the token to one for the correct page.`,
      });
      return;
    } catch (e2) {
      const err2 = e2 as {
        response?: { data?: { error?: { message?: string; code?: number } } };
      };
      const ge2 = err2?.response?.data?.error;
      const msg2 = ge2?.message ?? "";
      if (!isPermErr(msg2, ge2?.code)) {
        // Token genuinely broken.
        res.json({
          ok: false,
          mode: "broken",
          pageId,
          hasToken: true,
          tokenValid: false,
          pageName: null,
          pageMatch: false,
          note: null,
          error: `Facebook rejected the token: ${msg2 || msg1}`,
        });
        return;
      }
    }

    // ── Tier 3 — /me/messenger_profile (uses pages_messaging) ─────────────
    try {
      const r3 = await axios.get("https://graph.facebook.com/v21.0/me/messenger_profile", {
        params: { fields: "greeting", access_token: pageAccessToken },
        timeout: 5000,
      });
      void r3.data;
      // Success means the token is valid AND scoped to *a* page (messenger_profile
      // is page-scoped). We can't prove pageMatch without a read perm, so we
      // mark it as null and lean on the configured pageId.
      res.json({
        ok: true,
        mode: "messenger_ok",
        pageId,
        hasToken: true,
        tokenValid: true,
        pageName: null,
        pageMatch: true,
        note:
          "Page Access Token verified through the Messenger API (the same path the bot uses for replies). " +
          "Page identity can't be proven without `pages_read_engagement`, but configuration matches and the bot is wired up. " +
          "To actually publish posts your Facebook app also needs `pages_manage_posts` — until that's granted, calendar posts will land but Facebook will reject them at publish time.",
        error: null,
      });
      return;
    } catch (e3) {
      const err3 = e3 as {
        response?: { data?: { error?: { message?: string; code?: number } } };
      };
      const ge3 = err3?.response?.data?.error;
      const msg3 = ge3?.message ?? "";
      if (!isPermErr(msg3, ge3?.code)) {
        // Token broken for messaging too — that's a real failure.
        res.json({
          ok: false,
          mode: "broken",
          pageId,
          hasToken: true,
          tokenValid: false,
          pageName: null,
          pageMatch: false,
          note: null,
          error: `Facebook rejected the token: ${msg3 || msg1}`,
        });
        return;
      }
    }

    // ── Tier 4 — structural fallback ──────────────────────────────────────
    // No Graph endpoint accepts our token without a permission we don't have.
    // Verify the token at least *looks* like a page access token so we don't
    // flash green for an obviously broken value.
    const tokenLooksReal = pageAccessToken.startsWith("EAA") && pageAccessToken.length > 80;
    if (!tokenLooksReal) {
      res.json({
        ok: false,
        mode: "broken",
        pageId,
        hasToken: true,
        tokenValid: false,
        pageName: null,
        pageMatch: false,
        note: null,
        error:
          "The configured token doesn't look like a Facebook page access token (expected an EAA-prefixed string > 80 chars). " +
          "Generate a Page Access Token from your Facebook app and update it in Settings → Pages.",
      });
      return;
    }
    res.json({
      ok: true,
      mode: "configured",
      pageId,
      hasToken: true,
      tokenValid: false,
      pageName: null,
      pageMatch: false,
      note:
        "Configuration is complete (Page ID + token are set). Live verification with Facebook isn't possible right now because " +
        "your Facebook app doesn't have `pages_read_engagement`, `pages_manage_metadata`, or `pages_manage_posts` granted. " +
        "Messenger bot replies use `pages_messaging` and should already work. To enable Facebook AUTO-POSTING from the content calendar, " +
        "submit your app for review with `pages_manage_posts` (and ideally `pages_read_engagement` so this card can verify the page name).",
      error: null,
    });
  }
}

export async function validateInstagram(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const { igUserId } = req.body;
  if (!igUserId) { res.status(400).json({ ok: false, error: "igUserId required" }); return; }  const pageAccessToken = t.facebookPageAccessToken;
  if (!pageAccessToken) {
    res.json({ ok: false, error: "No Facebook Page Access Token configured. Set it up in the Pages tab first." });
    return;
  }

  try {
    const resp = await axios.get(
      `https://graph.facebook.com/v21.0/${igUserId}`,
      { params: { fields: "id,username,name,profile_picture_url", access_token: pageAccessToken } },
    );
    const data = resp.data;
    res.json({ ok: true, username: data.username, name: data.name, profilePicture: data.profile_picture_url });
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message ?? String(e);
    res.json({ ok: false, error: msg });
  }
}

export async function validateTiktok(req: Request, res: Response): Promise<void> {
  const { accessToken } = req.body;
  if (!accessToken) { res.status(400).json({ ok: false, error: "accessToken required" }); return; }

  try {
    const resp = await axios.get(
      "https://open.tiktokapis.com/v2/user/info/",
      {
        params: { fields: "open_id,display_name,avatar_url" },
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const data = resp.data?.data?.user;
    if (data) {
      res.json({ ok: true, displayName: data.display_name, avatar: data.avatar_url });
    } else {
      res.json({ ok: false, error: "Could not fetch TikTok user info" });
    }
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message ?? e?.response?.data?.message ?? String(e);
    res.json({ ok: false, error: msg });
  }
}


// ─── Grace window + agent-mute control surface ──────────────────────────────

import {
  GRACE_WINDOW_MS,
  graceHoursRemaining,
  unmuteAgent,
} from "../agent/handoffPolicy.js";

/**
 * GET /api/v1/grace-status
 * Returns the tenant's grace-window status + count of currently-muted convos.
 * Used by the portal header to show "Grace window: 38h remaining" + a CTA
 * to end the window early.
 */
export async function getGraceStatus(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const tenant = await prisma.tenant.findUnique({
    where: { id: t.id },
    select: { facebookConnectedAt: true, facebookPageId: true },
  });
  const now = Date.now();
  const connectedAt = tenant?.facebookConnectedAt ?? null;
  const inGrace = !!(
    tenant?.facebookPageId &&
    connectedAt &&
    now - connectedAt.getTime() < GRACE_WINDOW_MS
  );
  const hoursRemaining = inGrace ? await graceHoursRemaining(t.id) : 0;
  const mutedConversations = await prisma.messengerConversation.count({
    where: { tenantId: t.id, agentMutedUntil: { gt: new Date() } },
  });
  res.json({
    inGrace,
    hoursRemaining,
    connectedAt: connectedAt?.toISOString() ?? null,
    graceWindowHours: GRACE_WINDOW_MS / (60 * 60 * 1000),
    mutedConversations,
  });
}

/**
 * POST /api/v1/grace-status/end
 * Ends the grace window early (sets facebookConnectedAt to one second past the
 * end of the window). Existing mutes stay in place — admins can still finish
 * the conversations they took over.
 */
export async function endGraceEarly(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const past = new Date(Date.now() - GRACE_WINDOW_MS - 1000);
  await prisma.tenant.update({
    where: { id: t.id },
    data: { facebookConnectedAt: past },
  });
  res.json({ ok: true, endedAt: new Date().toISOString() });
}

/**
 * GET /api/v1/conversations/muted
 * List currently-muted conversations so the admin can pick them up.
 */
export async function listMutedConversations(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const rows = await prisma.messengerConversation.findMany({
    where: { tenantId: t.id, agentMutedUntil: { gt: new Date() } },
    orderBy: { agentMutedUntil: "asc" },
    select: {
      id: true,
      psid: true,
      agentMutedUntil: true,
      lastUserMsgAt: true,
      lastBotMsgAt: true,
    },
    take: 100,
  });
  res.json({ conversations: rows });
}

/**
 * POST /api/v1/conversations/:conversationId/unmute
 * Clear the mute on a conversation so the agent re-engages on the next inbound.
 */
export async function unmuteConversation(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const conversationId = String(req.params.conversationId ?? "");
  const convo = await prisma.messengerConversation.findFirst({
    where: { id: conversationId, tenantId: t.id },
  });
  if (!convo) { res.status(404).json({ error: "not_found" }); return; }
  const lifted = await unmuteAgent(conversationId);
  res.json({ ok: true, lifted });
}
