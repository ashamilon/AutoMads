import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { z } from "zod";
import { generateTenantApiKey, hashApiKey } from "../utils/apiKey.js";
import { maskSecrets } from "../utils/maskSecrets.js";
import {
  activationExpiresAt,
  buildActivationUrl,
  generateUrlSafeToken,
} from "../utils/auth.js";
import { config } from "../config/index.js";

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

  // One-time activation link. Plaintext goes to the admin response (forward
  // to the client); only the hash is stored. Token expires in 7 days.
  const activation = generateUrlSafeToken();
  const activationExp = activationExpiresAt();

  const tenant = await prisma.tenant.create({
    data: {
      name: b.name,
      slug: b.slug,
      apiKeyHash,
      activationTokenHash: activation.hash,
      activationExpiresAt: activationExp,
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

  const portalBase = config.publicPortalUrl ?? config.publicBaseUrl;
  const activationUrl = buildActivationUrl(activation.plain, portalBase);

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
    activationUrl,
    activationExpiresAt: activationExp.toISOString(),
    message:
      "Save the api key (machine-to-machine) AND forward the activationUrl to the client (one-time, expires in 7 days). The client picks their email + password on the activation page; you cannot log into their dashboard.",
  });
}

/**
 * Issue a fresh activation link for a tenant. Used when the previous
 * activation token expired or the client lost the link before activating.
 * Refuses when the tenant has already set a password (in that case the
 * client should use the in-portal change-password flow or you can wipe
 * their password via a separate admin action).
 */
export async function issueTenantActivation(req: Request, res: Response): Promise<void> {
  const id = String(req.params.tenantId ?? "");
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (existing.passwordHash) {
    res.status(400).json({
      error: "already_activated",
      message:
        "This tenant has already set a password. Reset their password via /admin/tenants/:id/reset-password instead.",
    });
    return;
  }
  const activation = generateUrlSafeToken();
  const expiresAt = activationExpiresAt();
  await prisma.tenant.update({
    where: { id },
    data: {
      activationTokenHash: activation.hash,
      activationExpiresAt: expiresAt,
    },
  });
  const portalBase = config.publicPortalUrl ?? config.publicBaseUrl;
  res.json({
    activationUrl: buildActivationUrl(activation.plain, portalBase),
    activationExpiresAt: expiresAt.toISOString(),
  });
}

/**
 * Wipe a tenant's password and issue a new activation token. Used when a
 * client forgets their password and admin needs to bootstrap them again.
 * Burns all their existing sessions so the old browser cookies stop
 * working immediately.
 */
export async function adminResetTenantPassword(req: Request, res: Response): Promise<void> {
  const id = String(req.params.tenantId ?? "");
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const activation = generateUrlSafeToken();
  const expiresAt = activationExpiresAt();
  await prisma.$transaction([
    prisma.tenant.update({
      where: { id },
      data: {
        passwordHash: null,
        activationTokenHash: activation.hash,
        activationExpiresAt: expiresAt,
      },
    }),
    prisma.tenantSession.deleteMany({ where: { tenantId: id } }),
  ]);
  const portalBase = config.publicPortalUrl ?? config.publicBaseUrl;
  res.json({
    activationUrl: buildActivationUrl(activation.plain, portalBase),
    activationExpiresAt: expiresAt.toISOString(),
    message:
      "Old password and all sessions wiped. Forward the activationUrl to the client; they'll set a new email + password.",
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
      email: true,
      passwordHash: true,
      activationTokenHash: true,
      activationExpiresAt: true,
      createdAt: true,
      integration: { select: { type: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const tenants = rows.map(({ apiKeyHash, passwordHash, activationTokenHash, activationExpiresAt, ...t }) => ({
    ...t,
    hasApiKey: !!apiKeyHash,
    hasPassword: !!passwordHash,
    hasPendingActivation:
      !!activationTokenHash &&
      !!activationExpiresAt &&
      activationExpiresAt.getTime() > Date.now(),
    activationExpiresAt: activationExpiresAt ? activationExpiresAt.toISOString() : null,
  }));
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
      email: tenant.email,
      hasPassword: !!tenant.passwordHash,
      hasPendingActivation:
        !!tenant.activationTokenHash &&
        !!tenant.activationExpiresAt &&
        tenant.activationExpiresAt.getTime() > Date.now(),
      activationExpiresAt: tenant.activationExpiresAt ? tenant.activationExpiresAt.toISOString() : null,
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
