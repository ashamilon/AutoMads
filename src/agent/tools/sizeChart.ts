import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { parseTenantSettings } from "../../types/tenant-settings.js";
import { buildSizeChartReply } from "../../services/catalogReplyService.js";
import type { ToolDef } from "../types.js";

const Args = z.object({
  sku: z.string().min(1).max(80),
  /** Optional Banglish/English hint, e.g. "player version", "full sleeve", "kid". */
  hint: z.string().min(1).max(120).optional(),
});

export const sizeChartTools: ToolDef[] = [
  {
    name: "get_size_chart",
    description:
      "Fetch the size chart for a product. Combines: (1) per-product chart in metadata, (2) tenant-level sizeCharts library matched by hint+label, (3) built-in player/fan version fallback. Use whenever the customer asks for size chart, size details, measurements, chest/length, or 'kon size hobe amar'. Returns a ready-to-quote multi-line block.",
    paramsSchema: Args,
    paramsHint: '{ "sku": string, "hint"?: string }',
    examples: [
      {
        when: "Customer says 'size chart ta dekhan' for a sku just discussed",
        call: { tool: "get_size_chart", args: { sku: "arg-away-full" } },
      },
      {
        when: "Customer asks 'player version er size chart?'",
        call: { tool: "get_size_chart", args: { sku: "arg-away-full", hint: "player version" } },
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
      const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.input.tenantId },
        select: { settings: true, businessCategory: true },
      });
      const settings = parseTenantSettings(tenant?.settings);
      // Prefer the frozen reasoning_context (already loaded once per turn);
      // fall back to the freshly-read tenant row for legacy callers / tests.
      const businessCategory =
        ctx.reasoningContext?.businessCategory ?? tenant?.businessCategory ?? null;
      const chart = buildSizeChartReply(
        row,
        args.hint,
        settings.sizeCharts,
        businessCategory,
      );
      return {
        ok: true,
        observation:
          `Size chart for ${args.sku}:\n${chart}\n\n` +
          "Send this verbatim to the customer with `reply` (it is multi-line and already formatted).",
        data: { sku: args.sku, chart },
      };
    },
  },
];
