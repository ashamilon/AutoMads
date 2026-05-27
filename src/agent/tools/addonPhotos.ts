import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { resolveProductAddons } from "../addonResolver.js";
import { sendMessengerImage } from "../../integrations/facebook/messengerService.js";
import { logger } from "../../utils/logger.js";
import type { ToolDef } from "../types.js";

/**
 * Send the merchant-uploaded gallery for ONE add-on directly to the
 * customer's Messenger thread. Used when the customer asks "add-on er
 * chobi den" / "name number er sample dekhao" / "patches er photo
 * pathao". The agent identifies the add-on by id (preferred) or label,
 * scoped to the SKU when given (so per-product overrides apply).
 *
 * Resolution chain (matches `list_addons`):
 *   1. If `sku` is supplied, resolve via `resolveProductAddons` so we
 *      respect the product-level opt-in / per-product price overrides.
 *   2. Otherwise fall back to the tenant-level `settings.addOns` list
 *      and look up the add-on by id or label.
 *
 * Idempotency: the same per-conversation 6-minute window we use in
 * `send_product_photos` applies — refusing to re-send a photo we already
 * sent in the same thread within the last few minutes. This stops the
 * "spam the same image 15 times" loop the customer saw earlier.
 */

const Args = z.object({
  /** Stable add-on id from `list_addons` / `addOnIds`. Preferred over label. */
  addonId: z.string().min(1).max(64).optional(),
  /** Free-text label / alias the customer mentioned (e.g. "name number"). */
  label: z.string().min(1).max(120).optional(),
  /** Optional SKU to scope the lookup to per-product overrides. */
  sku: z.string().min(1).max(80).optional(),
  /** Cap how many images to send. Default 3, hard max 5. */
  max: z.number().int().min(1).max(5).optional().default(3),
});

function matchesQuery(label: string, aliases: string[] | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (label.toLowerCase().includes(q)) return true;
  for (const a of aliases ?? []) {
    if (a.toLowerCase().includes(q)) return true;
  }
  return false;
}

export const addonPhotoTools: ToolDef[] = [
  {
    name: "send_addon_photos",
    description:
      "Send the merchant-uploaded photos for ONE add-on (e.g. Name + Number sample sheet, Official Font preview, Patches photo). Use whenever the customer asks 'add-on er chobi', 'name number er sample', 'font ta dekhao', 'patches er photo pathan'. Requires either `addonId` (from list_addons) or `label`. When `sku` is provided, the add-on is resolved through the product's per-SKU opt-in list so per-product overrides are respected. Returns ok:false when the add-on has no photos uploaded — surface that honestly to the customer ('chobi ekhono catalog e add kora nai') instead of inventing.",
    paramsSchema: Args,
    paramsHint: '{ "addonId"?: string, "label"?: string, "sku"?: string, "max"?: int(1-5) }',
    examples: [
      {
        when: "Customer says 'name number er chobi den' for a jersey already in context",
        call: { tool: "send_addon_photos", args: { label: "name number", sku: "arg-away-full" } },
      },
      {
        when: "Customer asks 'official font er sample ache?'",
        call: { tool: "send_addon_photos", args: { label: "official font" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = Args.parse(rawArgs);
      if (!args.addonId && !args.label) {
        return {
          ok: false,
          error: "missing_target",
          observation:
            "Either `addonId` (from list_addons) or `label` is required. Call list_addons first if you don't have an id.",
        };
      }

      const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.input.tenantId },
        select: { settings: true },
      });
      const settings = parseTenantSettings(tenant?.settings);

      // Build the candidate pool: per-product opt-in when sku is given,
      // otherwise the tenant-level enabled list.
      type Candidate = {
        id: string;
        label: string;
        aliases?: string[];
        imageUrls?: string[];
      };
      let pool: Candidate[];
      if (args.sku) {
        const row = await prisma.productMapping.findUnique({
          where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: args.sku } },
        });
        if (!row) {
          return {
            ok: false,
            error: "sku_not_found",
            observation: `sku=${args.sku} not in catalog.`,
          };
        }
        const resolved = resolveProductAddons({ productMetadata: row.metadata, tenantSettings: settings });
        pool = resolved.map((a) => {
          const c: Candidate = { id: a.id, label: a.label };
          if (a.aliases) c.aliases = a.aliases;
          if (a.imageUrls) c.imageUrls = a.imageUrls;
          return c;
        });
      } else {
        pool = (settings.addOns ?? [])
          .filter((a) => a && a.enabled !== false && a.label?.trim())
          .map((a) => {
            const c: Candidate = { id: a.id, label: a.label };
            if (a.aliases) c.aliases = a.aliases;
            if (a.imageUrls) c.imageUrls = a.imageUrls;
            return c;
          });
      }

      if (pool.length === 0) {
        return {
          ok: false,
          error: "no_addons_available",
          observation: args.sku
            ? `sku=${args.sku} doesn't have any add-ons configured.`
            : "Shop doesn't have any add-ons enabled.",
        };
      }

      // Match priority: id exact → label exact → label/alias substring.
      let match: Candidate | undefined;
      if (args.addonId) {
        match = pool.find((c) => c.id === args.addonId);
      }
      if (!match && args.label) {
        const q = args.label.trim().toLowerCase();
        match =
          pool.find((c) => c.label.toLowerCase() === q) ??
          pool.find((c) => matchesQuery(c.label, c.aliases, q));
      }
      if (!match) {
        return {
          ok: false,
          error: "addon_not_found",
          observation:
            `No add-on matches ${args.addonId ? `id="${args.addonId}"` : `label="${args.label}"`}` +
            `${args.sku ? ` for sku=${args.sku}` : ""}. Available: ${pool.map((c) => c.label).join(", ") || "none"}.`,
        };
      }

      const urls = (match.imageUrls ?? []).filter((u) => u.startsWith("http://") || u.startsWith("https://"));
      if (urls.length === 0) {
        return {
          ok: false,
          error: "no_images",
          observation:
            `Add-on "${match.label}" doesn't have any photos uploaded. Tell the customer honestly ` +
            `'ei add-on er chobi ekhono catalog e add kora nai' — don't invent or send a different add-on's photos.`,
        };
      }

      // Idempotency: don't re-send the same URLs we already pushed in the
      // last 6 minutes of this conversation. Mirrors `send_product_photos`.
      const since = new Date(Date.now() - 6 * 60 * 1000);
      const recentSends = await prisma.messengerMessage
        .findMany({
          where: {
            conversationId: ctx.input.conversationId,
            role: "assistant",
            createdAt: { gte: since },
            text: "[sent addon photo]",
          },
          select: { imageUrls: true },
          orderBy: { createdAt: "desc" },
          take: 30,
        })
        .catch(() => []);
      const alreadySent = new Set<string>();
      for (const r of recentSends) {
        for (const u of r.imageUrls ?? []) alreadySent.add(u);
      }

      const toSend = urls.filter((u) => !alreadySent.has(u)).slice(0, args.max);
      if (toSend.length === 0) {
        return {
          ok: false,
          error: "already_sent_recently",
          observation:
            `Photos for add-on "${match.label}" were already sent in the last few minutes. Do NOT ` +
            `re-send — call \`reply\` instead with a short next-step prompt (e.g. ask if they want ` +
            `it added to the line, or whether they need a different angle).`,
        };
      }

      let sent = 0;
      const failures: string[] = [];
      for (const url of toSend) {
        try {
          await sendMessengerImage({
            pageAccessToken: ctx.input.pageAccessToken,
            psid: ctx.input.psid,
            imageUrl: url,
            within24hWindow: ctx.input.within24h,
          });
          await prisma.messengerMessage
            .create({
              data: {
                conversationId: ctx.input.conversationId,
                role: "assistant",
                text: "[sent addon photo]",
                imageUrls: [url],
              },
            })
            .catch(() => undefined);
          sent += 1;
        } catch (e) {
          const msg = String(e).slice(0, 160);
          logger.warn(
            { e: msg, addon: match.id, url },
            "agent.send_addon_photos failed",
          );
          failures.push(msg);
        }
      }

      if (sent === 0) {
        return {
          ok: false,
          error: "all_sends_failed",
          observation:
            `Could not send any photo for add-on "${match.label}". ${failures[0] ?? ""}`.trim(),
        };
      }

      return {
        ok: true,
        observation:
          `Sent ${sent} photo(s) for add-on "${match.label}". After this, call \`reply\` with a short ` +
          `Banglish line (e.g. "${match.label} er chobi pathiyechi 🙂 lagbe ki?") to invite the ` +
          `customer's next move.`,
        data: { sent, addonId: match.id, label: match.label, total: urls.length },
      };
    },
  },
];
