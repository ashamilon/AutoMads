/**
 * Long-term memory write-back test (task 9.1, Reqs 1.5 / 13.2 / 13.5).
 *
 * Asserts that the AgentLoop's `saveMemory` step diffs
 * `snapshot.customer_preferences` against the prior `CustomerProfile.preferences`
 * and writes the merged result back to Postgres via `mergePreferences` —
 * which under the hood does `customerProfile.findUnique` (or .create on a
 * fresh psid) followed by `customerProfile.update({ data: { preferences } })`.
 *
 * What's covered:
 *
 *  1. A turn with `customer_preferences = { favorite_teams: ["argentina"],
 *     recent_sizes: ["L", "M"] }` and an empty prior profile leaves an
 *     `update` call carrying exactly those preferences.
 *
 *  2. The merge UNIONs bounded list keys (favorite_teams, recent_sizes,
 *     last_5_orders) with whatever is already on the profile and caps to 5,
 *     with the patch winning the cap. We seed `recent_sizes: ["XL"]` on the
 *     stubbed prior profile and confirm the final write contains
 *     `["L", "M", "XL"]` (patch first, prior tail).
 *
 *  3. An EMPTY `customer_preferences` snapshot triggers ZERO update calls
 *     (the merge helper short-circuits on empty patches so we don't churn DB
 *     writes on turns that don't change preferences).
 *
 * Same `tsx`-runnable shape as the rest of `__tests__/`. Run via:
 *
 *     npx tsx src/agent/__tests__/customerPreferences.test.ts
 *
 * Prisma is stubbed at the module level with an in-memory recorder so the
 * test stays hermetic and doesn't need a database. Stubs are restored after
 * each suite so siblings stay clean.
 */

import assert from "node:assert/strict";

// --- Stub axios BEFORE importing the loop module ---------------------------
// The loop's router calls `axios.post(... /api/chat ...)` lazily. We stub
// `axios.post` with a fixture that:
//   - returns a canned router decision picking the terminal `reply` tool, AND
//   - intercepts the Messenger send the `reply` handler attempts inside the
//     same iteration so the test never hits the network.
import axios from "axios";

const originalPost = axios.post.bind(axios);
type AnyAxios = typeof axios;
const axiosPatched = axios as AnyAxios & { post: typeof axios.post };
axiosPatched.post = (async (url: string, body: unknown) => {
  void body;
  if (url.includes("/api/chat")) {
    return {
      data: {
        message: {
          content: JSON.stringify({
            thought: "memory test",
            tool: "reply",
            args: { text: "Argentina jersey ta confirm korlam 🇦🇷" },
          }),
        },
      },
    } as unknown as ReturnType<typeof axios.post>;
  }
  // Messenger send / anything else → stub a 200 so the reply tool's
  // best-effort send succeeds without hitting the network.
  return { data: { message_id: "mid_stub", recipient_id: "psid_pref" } } as unknown as ReturnType<
    typeof axios.post
  >;
}) as unknown as typeof axios.post;

// --- Static imports (after axios stub) ------------------------------------
import { prisma } from "../../db/prisma.js";
import { runIterPipeline } from "../loop.js";
import type {
  AgentCartItem,
  AgentSnapshot,
  AgentTurnInput,
} from "../types.js";

// ---------- in-memory CustomerProfile recorder ----------------------------
//
// `mergePreferences` performs:
//   1. ensureCustomerProfile → findUnique → if missing, create
//   2. update({ where: { id }, data: { preferences } })
//
// We stub the three accessors with a tiny in-memory store keyed by
// (tenantId, psid). Each `update` call records its `data.preferences` payload
// onto a recorder so the test can assert what got written.

type ProfileRow = {
  id: string;
  tenantId: string;
  psid: string;
  leadScore: number;
  tags: string[];
  preferences: Record<string, unknown> | null;
  totalOrders: number;
  totalSpentBdt: { toString: () => string } | null;
  lastSeenAt: Date;
};

type RecordedUpdate = {
  where: { id: string };
  data: { preferences?: Record<string, unknown> | null; leadScore?: number };
};

const profileStore = new Map<string, ProfileRow>();
let recordedUpdates: RecordedUpdate[] = [];
let nextProfileId = 1;

function profileKey(tenantId: string, psid: string): string {
  return `${tenantId}::${psid}`;
}

const originals = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findUnique: (prisma.customerProfile as any).findUnique,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create: (prisma.customerProfile as any).create,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: (prisma.customerProfile as any).update,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  followUpUpdateMany: (prisma.followUp as any).updateMany,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  followUpCreate: (prisma.followUp as any).create,
};

function installStubs(): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (prisma.customerProfile as any).findUnique = async (args: any) => {
    const where = args?.where?.tenantId_psid;
    if (!where) return null;
    const k = profileKey(where.tenantId, where.psid);
    return profileStore.get(k) ?? null;
  };
  (prisma.customerProfile as any).create = async (args: any) => {
    const data = args?.data ?? {};
    const row: ProfileRow = {
      id: `cp-${nextProfileId++}`,
      tenantId: data.tenantId,
      psid: data.psid,
      leadScore: data.leadScore ?? 10,
      tags: Array.isArray(data.tags) ? data.tags : [],
      preferences: null,
      totalOrders: 0,
      totalSpentBdt: { toString: () => "0" },
      lastSeenAt: new Date(),
    };
    profileStore.set(profileKey(row.tenantId, row.psid), row);
    return row;
  };
  (prisma.customerProfile as any).update = async (args: any) => {
    recordedUpdates.push({
      where: args?.where ?? {},
      data: args?.data ?? {},
    });
    // Apply the data to the in-memory row so subsequent reads see it (the
    // touch-lastSeenAt path in ensureCustomerProfile relies on this).
    const id = args?.where?.id;
    for (const row of profileStore.values()) {
      if (row.id !== id) continue;
      if (args?.data?.preferences !== undefined) {
        row.preferences =
          args.data.preferences && typeof args.data.preferences === "object"
            ? (args.data.preferences as Record<string, unknown>)
            : null;
      }
      if (args?.data?.leadScore !== undefined) row.leadScore = args.data.leadScore;
      row.lastSeenAt = new Date();
      return row;
    }
    return null;
  };

  // Inert stubs for `reconcileAbandonedCartFollowUp` (called from saveMemory).
  // We don't care about the FollowUp side-effects here; just keep them no-ops.
  (prisma.followUp as any).updateMany = async () => ({ count: 0 });
  (prisma.followUp as any).create = async (args: any) => ({
    id: "fu-stub",
    ...(args?.data ?? {}),
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function restoreStubs(): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (prisma.customerProfile as any).findUnique = originals.findUnique;
  (prisma.customerProfile as any).create = originals.create;
  (prisma.customerProfile as any).update = originals.update;
  (prisma.followUp as any).updateMany = originals.followUpUpdateMany;
  (prisma.followUp as any).create = originals.followUpCreate;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  profileStore.clear();
  recordedUpdates = [];
  nextProfileId = 1;
}

// ---------- snapshot fixtures ---------------------------------------------

const TENANT = "tenant-pref";
const PSID = "psid_pref";

function jersey(): AgentCartItem {
  return {
    line_id: "line-arg",
    sku: "ARG-HOME-24",
    product: "Argentina Home Jersey",
    quantity: 1,
    size: "L",
    unitPriceBdt: 1500,
  };
}

function makeSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    cart: [jersey()],
    profile: {},
    shownSkus: ["ARG-HOME-24"],
    lastShown: [{ sku: "ARG-HOME-24", label: "Argentina Home Jersey" }],
    active_goal: null,
    order_state: "BROWSING",
    missing_information: [],
    confirmed_information: {},
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
    ...overrides,
  };
}

function makeInput(): AgentTurnInput {
  return {
    tenantId: TENANT,
    tenantSlug: "pref",
    psid: PSID,
    // Empty conversationId so the saveSnapshot path inside the reply handler /
    // saveMemory step is a no-op — we want the test to focus on the
    // long-term-memory write, not on `pendingDraftJson` round-tripping.
    conversationId: "",
    userText: "ami argentina jersey nibo",
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
}

// ---------- tests ---------------------------------------------------------

type TestCase = { name: string; run: () => Promise<void> };
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

test(
  "saveMemory writes customer_preferences into CustomerProfile.preferences (fresh profile)",
  async () => {
    installStubs();
    try {
      const snap = makeSnapshot({
        customer_preferences: {
          favorite_teams: ["argentina"],
          recent_sizes: ["L", "M"],
        },
      });

      const result = await runIterPipeline({
        input: makeInput(),
        history: [],
        snapshot: snap,
        steps: [],
        reply: null,
        done: false,
        reason: null,
        needsRetry: false,
        iter: 1,
        turnId: "t_pref_fresh",
      });

      assert.equal(result.terminal, true, "reply tool is terminal");
      // mergePreferences performed: ensureCustomerProfile created a fresh row
      // and customerProfile.update was called with the merged preferences.
      const prefUpdates = recordedUpdates.filter((u) => u.data.preferences !== undefined);
      assert.ok(
        prefUpdates.length >= 1,
        `expected at least one preferences write, got ${prefUpdates.length}`,
      );
      const written = prefUpdates[prefUpdates.length - 1]!.data.preferences as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        written.favorite_teams,
        ["argentina"],
        `favorite_teams must round-trip from snapshot, got ${JSON.stringify(written.favorite_teams)}`,
      );
      assert.deepEqual(
        written.recent_sizes,
        ["L", "M"],
        `recent_sizes must round-trip from snapshot, got ${JSON.stringify(written.recent_sizes)}`,
      );
    } finally {
      restoreStubs();
    }
  },
);

test(
  "saveMemory unions bounded list keys with the prior CustomerProfile.preferences",
  async () => {
    installStubs();
    try {
      // Seed a prior profile that already carries a recent_sizes entry the
      // patch doesn't supply — the merge must keep it (deduped, capped).
      profileStore.set(profileKey(TENANT, PSID), {
        id: "cp-seed",
        tenantId: TENANT,
        psid: PSID,
        leadScore: 25,
        tags: [],
        preferences: { recent_sizes: ["XL"], language: "banglish" },
        totalOrders: 0,
        totalSpentBdt: { toString: () => "0" },
        lastSeenAt: new Date(),
      });
      nextProfileId = 99; // keep stub ids out of the way of the seeded one

      const snap = makeSnapshot({
        customer_preferences: {
          favorite_teams: ["argentina"],
          recent_sizes: ["L", "M"],
        },
      });

      await runIterPipeline({
        input: makeInput(),
        history: [],
        snapshot: snap,
        steps: [],
        reply: null,
        done: false,
        reason: null,
        needsRetry: false,
        iter: 1,
        turnId: "t_pref_merge",
      });

      const prefUpdates = recordedUpdates.filter((u) => u.data.preferences !== undefined);
      assert.ok(prefUpdates.length >= 1, "expected at least one preferences write");
      const written = prefUpdates[prefUpdates.length - 1]!.data.preferences as Record<
        string,
        unknown
      >;
      // favorite_teams was absent on the prior profile → patch wins.
      assert.deepEqual(written.favorite_teams, ["argentina"]);
      // recent_sizes: patch ["L","M"] unioned with prior ["XL"] → ["L","M","XL"]
      // (patch first, dedup, capped to 5).
      assert.deepEqual(
        written.recent_sizes,
        ["L", "M", "XL"],
        `recent_sizes union must put patch first, got ${JSON.stringify(written.recent_sizes)}`,
      );
      // Untouched non-bounded key must survive the merge.
      assert.equal(
        written.language,
        "banglish",
        "untouched prior preferences keys must be preserved",
      );
    } finally {
      restoreStubs();
    }
  },
);

test(
  "saveMemory issues no preferences write when customer_preferences is empty",
  async () => {
    installStubs();
    try {
      // Prior profile exists with some preferences — they must NOT be
      // overwritten by an empty-patch turn.
      profileStore.set(profileKey(TENANT, PSID), {
        id: "cp-noop",
        tenantId: TENANT,
        psid: PSID,
        leadScore: 30,
        tags: [],
        preferences: { favorite_teams: ["bangladesh"] },
        totalOrders: 0,
        totalSpentBdt: { toString: () => "0" },
        lastSeenAt: new Date(),
      });

      await runIterPipeline({
        input: makeInput(),
        history: [],
        snapshot: makeSnapshot({ customer_preferences: {} }),
        steps: [],
        reply: null,
        done: false,
        reason: null,
        needsRetry: false,
        iter: 1,
        turnId: "t_pref_noop",
      });

      const prefUpdates = recordedUpdates.filter((u) => u.data.preferences !== undefined);
      assert.equal(
        prefUpdates.length,
        0,
        `expected zero preferences writes for an empty patch, got ${prefUpdates.length}`,
      );
    } finally {
      restoreStubs();
    }
  },
);

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
