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
import { createPathaoOrder, getPathaoOrderStatus, type PathaoTenantConfig } from "../integrations/pathao/pathaoService.js";
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
    settings: t.settings,
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
  const deliveryChargeBdt = typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
  const grandTotalBdt = subtotalBdt + deliveryChargeBdt;
  const advancePolicyBdt =
    typeof settings.advancePaymentBdt === "number" ? settings.advancePaymentBdt : subtotalBdt;
  const advancePaidBdt =
    order.paymentStatus === "PAID" ? Math.min(advancePolicyBdt, grandTotalBdt) : 0;
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
  if (order.invoiceUrl) {
    res.redirect(order.invoiceUrl);
    return;
  }
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
    await prisma.order.update({ where: { id: order.id }, data: { invoiceUrl: invoice.publicUrl } });
    res.redirect(invoice.publicUrl);
  } catch (e) {
    logger.error({ e, orderId: order.id }, "Invoice generation failed");
    res.status(500).json({ error: "invoice_generation_failed" });
  }
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
    const order = await prisma.order.findUnique({ where: { id: orderId } });
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
  const psid = (parsed.data.psid?.trim() || `SIM_${t.id.slice(0, 10)}`).replace(/\s+/g, "_");
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

import { publishScheduledPost as doPublish, generateCaption } from "../services/socialPostService.js";

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

  if (!caption || !scheduledAt) {
    res.status(400).json({ error: "caption and scheduledAt are required" });
    return;
  }

  const post = await prisma.scheduledPost.create({
    data: {
      tenantId: t.id,
      platform: platform ?? "facebook",
      postType: postType ?? "product_showcase",
      caption,
      imageUrls: imageUrls ?? [],
      productSkus: productSkus ?? null,
      scheduledAt: new Date(scheduledAt),
      status: status ?? "scheduled",
    },
  });
  res.status(201).json(post);
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
  if (existing.status === "published") { res.status(400).json({ error: "already_published" }); return; }

  try {
    await doPublish(id);
    const refreshed = await prisma.scheduledPost.findUnique({ where: { id } });
    res.json(refreshed);
  } catch (e) {
    res.status(500).json({ error: "publish_failed", detail: String(e) });
  }
}

export async function generatePostCaption(req: Request, res: Response): Promise<void> {
  const { productNames, prices, tags, postType, language } = req.body;
  if (!productNames || !Array.isArray(productNames) || productNames.length === 0) {
    res.status(400).json({ error: "productNames array required" });
    return;
  }
  const caption = await generateCaption({
    productNames,
    prices: prices ?? [],
    tags: tags ?? [],
    postType: postType ?? "product_showcase",
    language: language ?? "banglish",
  });
  res.json({ caption });
}

// ─── Social Account Validation ───────────────────────────────────────────────

export async function validateInstagram(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const { igUserId } = req.body;
  if (!igUserId) { res.status(400).json({ ok: false, error: "igUserId required" }); return; }

  const pageAccessToken = t.facebookPageAccessToken;
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
