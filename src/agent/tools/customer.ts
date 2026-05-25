import { z } from "zod";
import { setProfileFields } from "../customerProfile.js";
import type { ToolDef } from "../types.js";

const Args = z.object({
  field: z.enum(["name", "phone", "address"]),
  value: z.string().min(2).max(300),
});

export const customerTools: ToolDef[] = [
  {
    name: "collect_customer_field",
    description:
      "Save a single piece of customer info (name / phone / address) the customer just provided. Use the value verbatim — do not paraphrase.",
    paramsSchema: Args,
    paramsHint: '{ "field": "name" | "phone" | "address", "value": string }',
    examples: [
      {
        when: "Customer wrote 'phone 01711223344'",
        call: { tool: "collect_customer_field", args: { field: "phone", value: "01711223344" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = Args.parse(rawArgs);
      const trimmed = args.value.trim();
      const next = { ...ctx.snapshot.profile, [args.field]: trimmed };
      await ctx.saveSnapshot({ ...ctx.snapshot, profile: next });
      // Mirror to long-term CustomerProfile so cross-conversation memory accumulates.
      await setProfileFields(ctx.input.tenantId, ctx.input.psid, { [args.field]: trimmed });
      return { ok: true, observation: `Saved ${args.field}=${trimmed}.` };
    },
  },
];
