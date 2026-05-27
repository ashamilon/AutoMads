import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { extractCatalogAssets } from "../../services/catalogReplyService.js";
import { sendMessengerImage } from "../../integrations/facebook/messengerService.js";
import { logger } from "../../utils/logger.js";
import type { ToolDef } from "../types.js";

const Args = z.object({
  sku: z.string().min(1).max(80),
  /** Optional cap on how many images to send. Defaults to 3, hard max 5. */
  max: z.number().int().min(1).max(5).optional().default(3),
});

export const photoTools: ToolDef[] = [
  {
    name: "send_product_photos",
    description:
      "Send the product photos (up to `max`) for one sku straight to the customer's Messenger thread. Pulls image URLs from the catalog metadata (images / imageUrls / photos fields). Use whenever the customer asks for chobi / picture / photo / image / 'kemon dekhte' / 'real photo'. After this tool, follow up with `reply` to invite next action (size, qty, etc.). The images are NOT visible to you — you cannot judge what's in them; just trust the catalog.",
    paramsSchema: Args,
    paramsHint: '{ "sku": string, "max"?: int(1-5) }',
    examples: [
      {
        when: "Customer says 'chobi den', 'picture deyen', 'real photo dekhte chai' for sku in context",
        call: { tool: "send_product_photos", args: { sku: "arg-away-full", max: 3 } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = Args.parse(rawArgs);
      const row = await prisma.productMapping.findUnique({
        where: { tenantId_clientSku: { tenantId: ctx.input.tenantId, clientSku: args.sku } },
      });
      if (!row) {
        return { ok: false, error: "sku_not_found", observation: `sku=${args.sku} not in catalog.` };
      }
      const assets = extractCatalogAssets(row);
      if (assets.imageUrls.length === 0) {
        return {
          ok: false,
          error: "no_images",
          observation: `No images recorded in catalog for sku=${args.sku}. Tell the customer that and ask if they want details instead.`,
        };
      }

      // Idempotency guard: refuse to re-send photos for a sku we already
      // sent in the LAST 6 MINUTES of this conversation. Without this the
      // model can request photos in turn N, the customer thanks, and the
      // model interprets "thanks" as a fresh photo request and sends them
      // again. Cap the lookback to a short window so a customer who really
      // wants a fresh look (e.g. an hour later) still gets one. The cap
      // also bounds the query.
      const since = new Date(Date.now() - 6 * 60 * 1000);
      const recentSends = await prisma.messengerMessage
        .findMany({
          where: {
            conversationId: ctx.input.conversationId,
            role: "assistant",
            createdAt: { gte: since },
            // Looking for our own "[sent product photo]" markers.
            text: "[sent product photo]",
          },
          select: { imageUrls: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 30,
        })
        .catch(() => []);
      const alreadySentUrls = new Set<string>();
      for (const r of recentSends) {
        for (const u of r.imageUrls ?? []) alreadySentUrls.add(u);
      }
      const skuUrlSet = new Set(assets.imageUrls);
      const overlap = [...alreadySentUrls].filter((u) => skuUrlSet.has(u));
      if (overlap.length >= Math.min(args.max, assets.imageUrls.length)) {
        // We've already sent at least as many of this SKU's photos as the
        // current request asks for, within the last 6 minutes. Don't spam.
        logger.info(
          { sku: args.sku, alreadySent: overlap.length, requested: args.max },
          "send_product_photos: idempotency skip — photos already sent recently",
        );
        return {
          ok: false,
          error: "already_sent_recently",
          observation:
            `Photos for sku=${args.sku} were already sent to this customer in the last few minutes ` +
            `(${overlap.length} image(s)). Do NOT send them again — instead call \`reply\` to ` +
            `progress the conversation: ask for size + qty, or for which specific photo they want a ` +
            `closer look at, or what else they'd like to know.`,
        };
      }

      const toSend = assets.imageUrls.slice(0, args.max);
      let sent = 0;
      const failures: string[] = [];
      for (const url of toSend) {
        // Per-URL dedup: skip individual URLs that were just sent so a
        // partial overlap (e.g. asked for 5, sent 3 last turn) only
        // dispatches the missing 2.
        if (alreadySentUrls.has(url)) continue;
        try {
          await sendMessengerImage({
            pageAccessToken: ctx.input.pageAccessToken,
            psid: ctx.input.psid,
            imageUrl: url,
            within24hWindow: ctx.input.within24h,
          });
          // Log the image-bearing assistant turn so future history shows what we already sent.
          await prisma.messengerMessage
            .create({
              data: {
                conversationId: ctx.input.conversationId,
                role: "assistant",
                text: "[sent product photo]",
                imageUrls: [url],
              },
            })
            .catch(() => undefined);
          sent += 1;
        } catch (e) {
          const msg = String(e).slice(0, 160);
          logger.warn({ e: msg, sku: args.sku, url }, "agent.send_product_photos failed");
          failures.push(msg);
        }
      }
      if (sent === 0) {
        return {
          ok: false,
          error: "all_sends_failed",
          observation: `Could not send any image for sku=${args.sku}. ${failures[0] ?? ""}`.trim(),
        };
      }
      return {
        ok: true,
        observation:
          `Sent ${sent} photo(s) for sku=${args.sku}. After this, call \`reply\` with a short Banglish line like ` +
          "\"chobi pathiyechi 🙂 size/qty bolen.\" to invite the customer's next move.",
        data: { sent, total: assets.imageUrls.length },
      };
    },
  },
];
