import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { z } from "zod";
import { generateTenantApiKey, hashApiKey } from "../utils/apiKey.js";
import { maskSecrets } from "../utils/maskSecrets.js";

const createTenantBody = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  facebookPageAccessToken: z.string().optional(),
  facebookPageId: z.string().optional(),
  facebookVerifyToken: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  integration: z.object({
    type: z.enum(["API", "DATABASE", "WEBHOOK"]),
    config: z.record(z.string(), z.unknown()),
  }),
});

export async function createTenant(req: Request, res: Response): Promise<void> {
  const parsed = createTenantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const b = parsed.data;
  const apiKey = generateTenantApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  const tenant = await prisma.tenant.create({
    data: {
      name: b.name,
      slug: b.slug,
      apiKeyHash,
      facebookPageAccessToken: b.facebookPageAccessToken,
      facebookPageId: b.facebookPageId,
      facebookVerifyToken: b.facebookVerifyToken,
      ...(b.settings !== undefined ? { settings: b.settings as Prisma.InputJsonValue } : {}),
      integration: {
        create: {
          type: b.integration.type,
          config: b.integration.config as Prisma.InputJsonValue,
        },
      },
    },
    include: { integration: true },
  });

  res.status(201).json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      isActive: tenant.isActive,
      integration: tenant.integration
        ? { type: tenant.integration.type, config: maskSecrets(tenant.integration.config) }
        : null,
    },
    apiKey,
    message: "Save the api key now; it is only shown once. Use Header: Authorization: Bearer <apiKey> for /api/v1/...",
  });
}

export async function listTenants(_req: Request, res: Response): Promise<void> {
  const rows = await prisma.tenant.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      facebookPageId: true,
      apiKeyHash: true,
      createdAt: true,
      integration: { select: { type: true } },
    },
  });
  const tenants = rows.map(({ apiKeyHash, ...t }) => ({ ...t, hasApiKey: !!apiKeyHash }));
  res.json({ tenants });
}

export async function getTenant(req: Request, res: Response): Promise<void> {
  const id = String(req.params.tenantId ?? "");
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: { integration: true },
  });
  if (!tenant) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      isActive: tenant.isActive,
      facebookPageAccessToken: tenant.facebookPageAccessToken ? "[redacted]" : null,
      facebookPageId: tenant.facebookPageId,
      facebookVerifyToken: tenant.facebookVerifyToken ? "[redacted]" : null,
      settings: tenant.settings,
      hasApiKey: !!tenant.apiKeyHash,
      integration: tenant.integration
        ? {
            type: tenant.integration.type,
            config: maskSecrets(tenant.integration.config),
          }
        : null,
      createdAt: tenant.createdAt,
    },
  });
}

const patchTenantBody = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  facebookPageAccessToken: z.string().nullable().optional(),
  facebookPageId: z.string().nullable().optional(),
  facebookVerifyToken: z.string().nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  integration: z
    .object({
      type: z.enum(["API", "DATABASE", "WEBHOOK"]),
      config: z.record(z.string(), z.unknown()),
    })
    .optional(),
});

export async function patchTenant(req: Request, res: Response): Promise<void> {
  const id = String(req.params.tenantId ?? "");
  const parsed = patchTenantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const b = parsed.data;
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const data: Prisma.TenantUpdateInput = {};
  if (b.name !== undefined) data.name = b.name;
  if (b.isActive !== undefined) data.isActive = b.isActive;
  if (b.facebookPageAccessToken !== undefined) data.facebookPageAccessToken = b.facebookPageAccessToken;
  if (b.facebookPageId !== undefined) data.facebookPageId = b.facebookPageId;
  if (b.facebookVerifyToken !== undefined) data.facebookVerifyToken = b.facebookVerifyToken;
  if (b.settings !== undefined) data.settings = b.settings as Prisma.InputJsonValue;

  if (b.integration) {
    data.integration = {
      upsert: {
        where: { tenantId: id },
        create: {
          type: b.integration.type,
          config: b.integration.config as Prisma.InputJsonValue,
        },
        update: {
          type: b.integration.type,
          config: b.integration.config as Prisma.InputJsonValue,
        },
      },
    };
  }

  const tenant = await prisma.tenant.update({
    where: { id },
    data,
    include: { integration: true },
  });

  res.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      isActive: tenant.isActive,
      settings: tenant.settings,
      integration: tenant.integration
        ? { type: tenant.integration.type, config: maskSecrets(tenant.integration.config) }
        : null,
    },
  });
}

export async function regenerateTenantApiKey(req: Request, res: Response): Promise<void> {
  const id = String(req.params.tenantId ?? "");
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const apiKey = generateTenantApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  await prisma.tenant.update({ where: { id }, data: { apiKeyHash } });
  res.json({ apiKey, message: "Save the key now; it is only shown once. Old key is invalid." });
}

export async function listTenantOrders(req: Request, res: Response): Promise<void> {
  const id = String(req.params.tenantId ?? "");
  const exists = await prisma.tenant.findUnique({ where: { id } });
  if (!exists) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const take = Math.min(Number(req.query.limit ?? 100), 500);
  const orders = await prisma.order.findMany({
    where: { tenantId: id },
    orderBy: { createdAt: "desc" },
    take,
  });
  res.json({ orders });
}
