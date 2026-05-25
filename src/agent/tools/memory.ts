import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  bumpLeadScore,
  getCustomerProfile,
  notePreference,
} from "../customerProfile.js";
import { prisma } from "../../db/prisma.js";
import type { ToolDef } from "../types.js";

const RecallArgs = z.object({}).strict();

const NoteArgs = z.object({
  key: z.string().min(1).max(40),
  value: z.union([z.string().max(200), z.number(), z.boolean()]),
});

const ReadLongTermArgs = z.object({
  keys: z.array(z.string()).max(20).optional(),
});

const WriteLongTermArgs = z.object({
  patch: z.record(z.unknown()),
});

export const memoryTools: ToolDef[] = [
  {
    name: "recall_customer",
    description:
      "Look up everything we know about THIS customer (long-term profile + their last few orders). Use at the start of a turn to personalise replies — never invent facts; only use what this returns.",
    paramsSchema: RecallArgs,
    paramsHint: "{}",
    examples: [
      {
        when: "Customer says 'kemon achen?' or 'remember me?'",
        call: { tool: "recall_customer", args: {} },
      },
    ],
    handler: async (_rawArgs, ctx) => {
      const cp = await getCustomerProfile(ctx.input.tenantId, ctx.input.psid);
      const recentOrders = await prisma.order
        .findMany({
          where: { tenantId: ctx.input.tenantId, messengerPsid: ctx.input.psid },
          orderBy: { createdAt: "desc" },
          take: 3,
          select: { id: true, status: true, paymentStatus: true, totalAmount: true, createdAt: true },
        })
        .catch(() => []);
      const lines: string[] = [];
      if (cp) {
        const bits = [
          cp.name && `name=${cp.name}`,
          cp.phone && `phone=${cp.phone}`,
          cp.address && `address=${cp.address}`,
          `leadScore=${cp.leadScore}`,
          `totalOrders=${cp.totalOrders}`,
          `totalSpentBdt=${cp.totalSpentBdt.toString()}`,
          cp.tags.length ? `tags=${cp.tags.join(",")}` : null,
        ].filter(Boolean);
        lines.push(`profile: ${bits.join(", ")}`);
        if (cp.preferences && typeof cp.preferences === "object" && !Array.isArray(cp.preferences)) {
          const prefs = Object.entries(cp.preferences as Record<string, unknown>)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(", ");
          if (prefs) lines.push(`preferences: ${prefs}`);
        }
      } else {
        lines.push("profile: (no record yet — first turn)");
      }
      if (recentOrders.length > 0) {
        lines.push(
          "recent_orders: " +
            recentOrders
              .map(
                (o) =>
                  `#${o.id.slice(0, 8)} ${o.status}/${o.paymentStatus}${
                    o.totalAmount != null ? ` ${o.totalAmount.toString()}BDT` : ""
                  }`,
              )
              .join(" | "),
        );
      }
      return { ok: true, observation: lines.join("\n") };
    },
  },
  {
    name: "note_preference",
    description:
      "Save a single durable preference about this customer (e.g. favourite_size=L, language=banglish). Bumps lead score by +2.",
    paramsSchema: NoteArgs,
    paramsHint: '{ "key": string, "value": string|number|boolean }',
    examples: [
      {
        when: "Customer mentions they always wear M",
        call: { tool: "note_preference", args: { key: "favourite_size", value: "M" } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = NoteArgs.parse(rawArgs);
      await notePreference(ctx.input.tenantId, ctx.input.psid, args.key, args.value);
      await bumpLeadScore(ctx.input.tenantId, ctx.input.psid, 2);
      return { ok: true, observation: `Noted ${args.key}=${String(args.value)}.` };
    },
  },
  {
    name: "read_long_term_memory",
    description:
      "Read the customer's long-term preferences (favorite teams, recent sizes, last 5 orders, etc.) from CustomerProfile.preferences. Returns the merged blob, optionally filtered to specific keys.",
    paramsSchema: ReadLongTermArgs,
    paramsHint: '{ "keys"?: string[] }',
    examples: [
      {
        when: "Need to personalise a reply with the customer's saved sizes / favourite teams",
        call: { tool: "read_long_term_memory", args: { keys: ["favorite_teams", "recent_sizes"] } },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = ReadLongTermArgs.parse(rawArgs ?? {});
      const profile = await getCustomerProfile(ctx.input.tenantId, ctx.input.psid);
      if (!profile) {
        return {
          ok: false,
          error: "customer_not_found",
          observation: "No long-term profile yet for this customer.",
        };
      }
      const allPrefs =
        profile.preferences && typeof profile.preferences === "object" && !Array.isArray(profile.preferences)
          ? (profile.preferences as Record<string, unknown>)
          : {};
      let prefs: Record<string, unknown> = allPrefs;
      if (args.keys && args.keys.length > 0) {
        const filtered: Record<string, unknown> = {};
        for (const k of args.keys) {
          if (k in allPrefs) filtered[k] = allPrefs[k];
        }
        prefs = filtered;
      }
      const keyNames = Object.keys(prefs);
      const summary =
        keyNames.length === 0
          ? args.keys && args.keys.length > 0
            ? `No long-term memory entries for: ${args.keys.join(", ")}.`
            : "Long-term memory is empty."
          : `Long-term memory keys: ${keyNames
              .map((k) => {
                const v = prefs[k];
                if (Array.isArray(v)) return `${k} (${v.length} entries)`;
                return k;
              })
              .join(", ")}`;
      return { ok: true, observation: summary, data: prefs };
    },
  },
  {
    name: "write_long_term_memory",
    description:
      "Merge a patch into the customer's long-term preferences (CustomerProfile.preferences). Use for capturing favorite teams, sizes, brand preferences, etc.",
    paramsSchema: WriteLongTermArgs,
    paramsHint: '{ "patch": object }',
    examples: [
      {
        when: "Customer mentions they support Argentina and recently bought size L",
        call: {
          tool: "write_long_term_memory",
          args: { patch: { favorite_teams: ["argentina"], recent_sizes: ["L"] } },
        },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const args = WriteLongTermArgs.parse(rawArgs);
      const profile = await getCustomerProfile(ctx.input.tenantId, ctx.input.psid);
      if (!profile) {
        return {
          ok: false,
          error: "customer_not_found",
          observation: "No long-term profile yet for this customer; cannot write preferences.",
        };
      }
      const prevPrefs =
        profile.preferences && typeof profile.preferences === "object" && !Array.isArray(profile.preferences)
          ? (profile.preferences as Record<string, unknown>)
          : {};
      const next = { ...prevPrefs, ...args.patch };
      await prisma.customerProfile.update({
        where: { id: profile.id },
        data: { preferences: next as Prisma.InputJsonValue },
      });
      await bumpLeadScore(ctx.input.tenantId, ctx.input.psid, 1);
      const writtenKeys = Object.keys(args.patch);
      const summary =
        writtenKeys.length === 0
          ? "No keys written (empty patch)."
          : `Wrote long-term memory keys: ${writtenKeys.join(", ")}.`;
      return { ok: true, observation: summary };
    },
  },
];
