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
      const toSend = assets.imageUrls.slice(0, args.max);
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
