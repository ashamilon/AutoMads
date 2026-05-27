import { z } from "zod";
import { loadSnapshot } from "../state.js";
import type { AgentSnapshot, ToolDef } from "../types.js";

/**
 * Explicit session-memory tools (Requirements §13.1, §13.6).
 *
 * Req 13.6 mandates that ToolRegistry be the *only* path to read/write session state.
 * The AgentLoop already auto-saves the in-memory `AgentSnapshot` on every turn, but
 * these two tools give the LLM the explicit save/load path required by the spec:
 *
 *  - `save_session_state` accepts a PARTIAL Snapshot patch (every top-level field
 *    optional). The patch is merged into `ctx.snapshot` (existing values preserved
 *    when not present in the patch) and the merged snapshot is flushed to
 *    `MessengerConversation.pendingDraftJson` via `ctx.saveSnapshot(merged)`. The
 *    LLM rarely needs to overwrite the whole snapshot — it just nudges a single
 *    field (e.g. set `active_goal: "buy_jersey"` or push the latest reference) and
 *    pins the result.
 *
 *  - `retrieve_session_state` re-reads `pendingDraftJson` for the current
 *    conversation via `loadSnapshot(...)` and returns the persisted snapshot as
 *    `data`. The optional `keys` arg filters the payload to the requested
 *    top-level fields (e.g. `["cart", "missing_information"]`). It does NOT
 *    mutate the in-flight `ctx.snapshot` — the loop's working copy stays the
 *    source of truth for the rest of the turn. Returning the persisted view as
 *    `data` lets the router compare on-disk vs in-memory state without losing
 *    the latest mutations made earlier in the same turn.
 *
 * Both tools are non-terminal and refuse when `conversationId` is empty or missing.
 */

const OrderFSMStateSchema = z.enum([
  "BROWSING",
  "PRODUCT_SELECTION",
  "CART_BUILDING",
  "MISSING_INFO_COLLECTION",
  "ADDRESS_COLLECTION",
  "PAYMENT_SELECTION",
  "ORDER_REVIEW",
  "FINAL_CONFIRMATION",
  "ORDER_COMPLETE",
]);

const CartAddOnSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  priceBdt: z.number().nonnegative(),
  value: z.string().optional(),
});

const CartItemSchema = z.object({
  sku: z.string().min(1),
  product: z.string().min(1),
  quantity: z.number().int().positive(),
  line_id: z.string().min(1),
  size: z.string().optional(),
  unitPriceBdt: z.number().nonnegative().optional(),
  addOns: z.array(CartAddOnSchema).optional(),
  line_total: z.number().nonnegative().optional(),
});

const ProfileSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
});

const LastShownSchema = z.object({
  sku: z.string().min(1),
  label: z.string(),
});

const MissingInfoSlotSchema = z.object({
  slot: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  line_id: z.string().optional(),
});

const RecentReferenceSchema = z.object({
  phrase: z.string().min(1),
  target_kind: z.enum(["line", "product"]),
  target_id: z.string().min(1),
  ts: z.string().min(1),
});

/**
 * Patch schema for `save_session_state`. Every top-level Snapshot field is optional
 * — the LLM supplies only what it wants to overwrite. `.strict()` rejects unknown
 * keys so a typo'd field name surfaces as a tool validation error rather than
 * silently no-op'ing.
 */
const SaveArgs = z
  .object({
    cart: z.array(CartItemSchema).max(30).optional(),
    profile: ProfileSchema.optional(),
    shownSkus: z.array(z.string().min(1)).max(20).optional(),
    lastShown: z.array(LastShownSchema).max(10).optional(),
    active_goal: z.string().nullable().optional(),
    order_state: OrderFSMStateSchema.optional(),
    missing_information: z.array(MissingInfoSlotSchema).max(50).optional(),
    confirmed_information: z.record(z.record(z.unknown())).optional(),
    customer_preferences: z.record(z.unknown()).optional(),
    conversation_summary: z.string().max(2000).optional(),
    confidence_level: z.number().min(0).max(1).optional(),
    followup_needed: z.boolean().optional(),
    recent_references: z.array(RecentReferenceSchema).max(5).optional(),
  })
  .strict();

const RetrieveArgs = z
  .object({
    keys: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();

/** All Snapshot fields that `retrieve_session_state` is allowed to project. */
const SNAPSHOT_KEYS: ReadonlyArray<keyof AgentSnapshot> = [
  "cart",
  "profile",
  "shownSkus",
  "lastShown",
  "active_goal",
  "order_state",
  "missing_information",
  "confirmed_information",
  "customer_preferences",
  "conversation_summary",
  "confidence_level",
  "followup_needed",
  "recent_references",
  "structured_cart",
];

function profileCompleteness(profile: { name?: string; phone?: string; address?: string }): {
  filled: number;
  total: number;
  missing: string[];
} {
  const fields: Array<["name" | "phone" | "address", string | undefined]> = [
    ["name", profile.name],
    ["phone", profile.phone],
    ["address", profile.address],
  ];
  const missing: string[] = [];
  let filled = 0;
  for (const [key, val] of fields) {
    if (typeof val === "string" && val.trim().length > 0) {
      filled += 1;
    } else {
      missing.push(key);
    }
  }
  return { filled, total: fields.length, missing };
}

/**
 * Merge a validated Save patch into the working snapshot. Field-by-field copy so
 * `false`/`null`/`""` overrides survive (a naive spread with `&&` would drop them).
 * Existing values are preserved whenever the patch omits the field.
 */
function applySnapshotPatch(
  base: AgentSnapshot,
  patch: z.infer<typeof SaveArgs>,
): AgentSnapshot {
  const next: AgentSnapshot = { ...base };
  if (patch.cart !== undefined) next.cart = patch.cart;
  if (patch.profile !== undefined) next.profile = patch.profile;
  if (patch.shownSkus !== undefined) next.shownSkus = patch.shownSkus;
  if (patch.lastShown !== undefined) next.lastShown = patch.lastShown;
  if (patch.active_goal !== undefined) next.active_goal = patch.active_goal;
  if (patch.order_state !== undefined) next.order_state = patch.order_state;
  if (patch.missing_information !== undefined) next.missing_information = patch.missing_information;
  if (patch.confirmed_information !== undefined)
    next.confirmed_information = patch.confirmed_information;
  if (patch.customer_preferences !== undefined)
    next.customer_preferences = patch.customer_preferences;
  if (patch.conversation_summary !== undefined)
    next.conversation_summary = patch.conversation_summary;
  if (patch.confidence_level !== undefined) next.confidence_level = patch.confidence_level;
  if (patch.followup_needed !== undefined) next.followup_needed = patch.followup_needed;
  if (patch.recent_references !== undefined) next.recent_references = patch.recent_references;
  return next;
}

export const sessionTools: ToolDef[] = [
  {
    name: "save_session_state",
    description:
      "Persist the AgentSnapshot to MessengerConversation.pendingDraftJson. Accepts a partial patch — only the fields you supply overwrite the in-memory snapshot, the rest are preserved. Pass {} to flush the current state without changes. Non-terminal.",
    paramsSchema: SaveArgs,
    paramsHint:
      '{ "cart"?: CartItem[], "profile"?: { "name"?, "phone"?, "address"? }, "shownSkus"?: string[], "lastShown"?: {sku,label}[], "active_goal"?: string|null, "order_state"?: OrderFSMState, "missing_information"?: {slot,attempts,line_id?}[], "confirmed_information"?: object, "customer_preferences"?: object, "conversation_summary"?: string, "confidence_level"?: number, "followup_needed"?: boolean, "recent_references"?: {phrase,target_kind,target_id,ts}[] }',
    examples: [
      {
        when: "After resolving the customer's goal, pin it so the next turn starts already on-task",
        call: { tool: "save_session_state", args: { active_goal: "buy_jersey" } },
      },
      {
        when: "Flush the current in-memory snapshot to disk verbatim before a risky downstream step",
        call: { tool: "save_session_state", args: {} },
      },
      {
        when: "Customer says 'bkash e pay korbo' — record the chosen payment rail before calling confirm_order",
        call: {
          tool: "save_session_state",
          args: { confirmed_information: { order: { payment_method: "bkash" } } },
        },
      },
      {
        when: "Customer chose Nagad",
        call: {
          tool: "save_session_state",
          args: { confirmed_information: { order: { payment_method: "nagad" } } },
        },
      },
      {
        when: "Customer chose SSLCommerz / Card / Net Banking",
        call: {
          tool: "save_session_state",
          args: { confirmed_information: { order: { payment_method: "sslcommerz" } } },
        },
      },
      {
        when: "Customer chose Cash on Delivery",
        call: {
          tool: "save_session_state",
          args: { confirmed_information: { order: { payment_method: "cod" } } },
        },
      },
      {
        when:
          "Customer wants to pay the FULL amount upfront (gift order, trusted customer): " +
          "'ami full payment dibo' / 'puro taka ekhoni dibo' / 'gift kintu, full advance' / 'no COD, full advance'",
        call: {
          tool: "save_session_state",
          args: {
            confirmed_information: {
              order: { payment_method: "sslcommerz", payment_full: true },
            },
          },
        },
      },
      {
        when:
          "Customer reverts to the normal partial-advance flow after previously choosing full",
        call: {
          tool: "save_session_state",
          args: { confirmed_information: { order: { payment_full: false } } },
        },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const conversationId = ctx.input.conversationId;
      if (!conversationId || conversationId.trim().length === 0) {
        return {
          ok: false,
          error: "missing_conversation_id",
          observation:
            "save_session_state refused — no conversationId on the turn input. Cannot persist.",
        };
      }
      const patch = SaveArgs.parse(rawArgs ?? {});
      const merged = applySnapshotPatch(ctx.snapshot, patch);
      const savedAt = new Date().toISOString();
      await ctx.saveSnapshot(merged);
      const writtenKeys = Object.keys(patch);
      const observation =
        writtenKeys.length === 0 ? "session saved" : `session saved (patched: ${writtenKeys.join(", ")})`;
      return {
        ok: true,
        observation,
        data: { conversationId, savedAt, patched_keys: writtenKeys },
      };
    },
  },
  {
    name: "retrieve_session_state",
    description:
      "Read the persisted AgentSnapshot for this conversation back out of MessengerConversation.pendingDraftJson. Pass `keys` to filter the payload to specific top-level fields (e.g. ['cart','missing_information']); omit it to receive the whole snapshot. Returns a compact summary as the observation and the (filtered) snapshot as `data`. Does NOT replace the in-flight ctx.snapshot. Non-terminal.",
    paramsSchema: RetrieveArgs,
    paramsHint: '{ "keys"?: string[] }',
    examples: [
      {
        when: "Customer returns mid-conversation and the router wants to confirm what was last persisted",
        call: { tool: "retrieve_session_state", args: {} },
      },
      {
        when: "Need only the cart and missing slots to render a recap",
        call: {
          tool: "retrieve_session_state",
          args: { keys: ["cart", "missing_information"] },
        },
      },
    ],
    handler: async (rawArgs, ctx) => {
      const conversationId = ctx.input.conversationId;
      if (!conversationId || conversationId.trim().length === 0) {
        return {
          ok: false,
          error: "missing_conversation_id",
          observation:
            "retrieve_session_state refused — no conversationId on the turn input. Cannot load.",
        };
      }
      const args = RetrieveArgs.parse(rawArgs ?? {});
      const persisted = await loadSnapshot(conversationId);

      // Project the persisted snapshot onto the requested keys when supplied.
      // Unknown keys are silently dropped (the strict() schema already validates
      // shape; this just gates which fields make it into `data`).
      let payload: Partial<AgentSnapshot> | AgentSnapshot;
      let returnedKeys: string[];
      if (args.keys && args.keys.length > 0) {
        const validKeys = new Set<string>(SNAPSHOT_KEYS as readonly string[]);
        const projected: Partial<AgentSnapshot> = {};
        for (const k of args.keys) {
          if (!validKeys.has(k)) continue;
          const key = k as keyof AgentSnapshot;
          // Type-narrow assignment: each branch copies a single typed field.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (projected as any)[key] = (persisted as any)[key];
        }
        payload = projected;
        returnedKeys = Object.keys(projected);
      } else {
        payload = persisted;
        returnedKeys = SNAPSHOT_KEYS.filter((k) => persisted[k] !== undefined) as string[];
      }

      const profile = profileCompleteness(persisted.profile);
      const summary = {
        order_state: persisted.order_state,
        cart_lines: persisted.cart.length,
        missing_information: persisted.missing_information.length,
        profile: `${profile.filled}/${profile.total}${
          profile.missing.length > 0 ? ` missing=${profile.missing.join(",")}` : ""
        }`,
        returned_keys: returnedKeys,
      };
      const observation = JSON.stringify(summary);
      return {
        ok: true,
        observation,
        data: payload,
      };
    },
  },
];
