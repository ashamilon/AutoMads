/**
 * Developer-only debug endpoint for inspecting an agent conversation's persisted state
 * (Requirements §15.6, task 11.1).
 *
 * Surfaces three things in one shot for fast triage:
 *
 *  - `snapshot`             — the current `AgentSnapshot` from
 *                             `MessengerConversation.pendingDraftJson` (FSM state, cart,
 *                             missing/confirmed slots, recent_references, etc.).
 *  - `recent_traces`        — the last 10 `AgentTrace` rows for the conversation,
 *                             newest first. Includes deterministic step rows
 *                             (`tool === "(step)"`), real tool calls, and override rows
 *                             (`tool === "(override)"`).
 *  - `last_verified_tools`  — the last (up to 5) successful real-tool rows from the
 *                             same trace stream, projected down to
 *                             `{ name, observation, args }`. "Real tool" means a row
 *                             whose `tool` is neither `"(step)"` nor `"(override)"`
 *                             nor `"(none)"` and whose `ok === true`. These are the
 *                             observations the reply filter (task 10.1) considers
 *                             ground truth, so seeing them next to the snapshot makes
 *                             "why did the agent say X" fast to answer.
 *
 * Authentication mirrors `tenantPortalRoutes.ts`: the route is gated by
 * `requireTenantApiKey`, so every query is automatically scoped to the caller's
 * `tenantId`. A request from tenant A asking for a conversation owned by tenant B
 * returns 404 (we never leak cross-tenant data).
 *
 * The handler logic is exported separately as `handleSnapshotRequest` so unit tests can
 * exercise it with mocked Prisma and `req`/`res` shims without standing up a full
 * Express app or pulling in a non-installed `supertest` dependency.
 */

import { Router, type Request, type Response } from "express";
import { prisma } from "../db/prisma.js";
import { loadSnapshot } from "../agent/state.js";
import { requireTenantApiKey } from "../middlewares/tenantApiAuth.js";
import { logger } from "../utils/logger.js";
import type { AgentSnapshot } from "../agent/types.js";

/** Maximum number of recent trace rows returned per request. */
const RECENT_TRACES_LIMIT = 10;
/** Maximum number of `last_verified_tools` entries returned per request. */
const VERIFIED_TOOLS_LIMIT = 5;

/**
 * Trace-row sentinel `tool` values that the snapshot endpoint filters out when
 * computing `last_verified_tools`. These are emitted by the deterministic pipeline
 * (`tool === "(step)"`), the override layer (`tool === "(override)"`), and the
 * empty-turn fallback in `persistTurnTrace` (`tool === "(none)"`). `last_verified_tools`
 * exists to surface real, ground-truthing tool observations (catalog rows, inventory
 * checks, cart mutations) to the developer, so we strip these synthetic rows before
 * projecting.
 */
const SYNTHETIC_TOOL_VALUES: ReadonlySet<string> = new Set([
  "(step)",
  "(override)",
  "(none)",
]);

/** Shape of one row in the `recent_traces` array returned by the endpoint. */
export type RecentTraceRow = {
  id: string;
  iter: number;
  tool: string;
  thought: string | null;
  args: unknown;
  ok: boolean;
  observation: string;
  errorCode: string | null;
  llmLatencyMs: number | null;
  toolLatencyMs: number | null;
  finalReason: string | null;
  turnId: string;
  createdAt: string;
};

/** Shape of one entry in the `last_verified_tools` array. */
export type VerifiedToolEntry = {
  name: string;
  observation: string;
  /** The `args` JSON the tool was called with (mirrors the trace's `args` column). */
  args: unknown;
};

/** Full JSON body returned by `GET /admin/snapshot/:conversationId`. */
export type SnapshotResponseBody = {
  conversationId: string;
  snapshot: AgentSnapshot;
  recent_traces: RecentTraceRow[];
  last_verified_tools: VerifiedToolEntry[];
};

/**
 * Express handler for `GET /admin/snapshot/:conversationId` (task 11.1).
 *
 * Exported on its own so unit tests can drive it with mocked `req` / `res` and
 * stubbed Prisma calls — no need for `supertest`. The handler is async; callers
 * should `await` it.
 *
 * Tenant-scoping: the handler reads `req.tenant.id` (set by `requireTenantApiKey`)
 * and filters BOTH the conversation existence check and the trace query by that
 * tenant. A conversation that exists but belongs to a different tenant is treated
 * the same as a missing conversation (404 with `"conversation_not_found"`), so the
 * endpoint never leaks the existence of cross-tenant rows.
 *
 * Error envelope: `{ error: <code>, detail?: <human-readable> }`. Codes used:
 *   - `"missing_conversation_id"` (400) — empty/whitespace-only path param.
 *   - `"conversation_not_found"`  (404) — no row, or row owned by a different tenant.
 *   - `"snapshot_failed"`          (500) — Prisma threw while loading state/traces.
 */
export async function handleSnapshotRequest(req: Request, res: Response): Promise<void> {
  const tenantId = req.tenant?.id;
  if (!tenantId) {
    // Defensive: this branch should be unreachable when `requireTenantApiKey` is
    // wired in front of the handler, but checking explicitly means a future
    // refactor that drops the middleware fails closed instead of leaking.
    res.status(401).json({ error: "missing_tenant", detail: "Tenant context required" });
    return;
  }

  const conversationId = String(req.params["conversationId"] ?? "").trim();
  if (!conversationId) {
    res.status(400).json({ error: "missing_conversation_id" });
    return;
  }

  try {
    // 1. Verify the conversation exists AND belongs to the caller's tenant. We use
    //    `findFirst` rather than `findUnique` so we can include the `tenantId` filter
    //    in a single query without round-tripping the row first.
    const convo = await prisma.messengerConversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true },
    });
    if (!convo) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }

    // 2. Load the snapshot via the same defensive reader the agent loop uses, so the
    //    response always has the documented defaults filled in for any legacy fields.
    const snapshot = await loadSnapshot(conversationId);

    // 3. Pull the most recent N trace rows for the conversation (newest first). Scoped
    //    by tenantId for defence-in-depth — even though the conversation check above
    //    already proved tenant ownership, we keep the filter so a stray conversationId
    //    collision across tenants (if it ever happened) wouldn't leak rows.
    const traceRows = await prisma.agentTrace.findMany({
      where: { tenantId, conversationId },
      orderBy: { createdAt: "desc" },
      take: RECENT_TRACES_LIMIT,
      select: {
        id: true,
        iter: true,
        tool: true,
        thought: true,
        args: true,
        ok: true,
        observation: true,
        errorCode: true,
        llmLatencyMs: true,
        toolLatencyMs: true,
        finalReason: true,
        turnId: true,
        createdAt: true,
      },
    });

    const recent_traces: RecentTraceRow[] = traceRows.map((r) => ({
      id: r.id,
      iter: r.iter,
      tool: r.tool,
      thought: r.thought,
      args: r.args,
      ok: r.ok,
      observation: r.observation,
      errorCode: r.errorCode,
      llmLatencyMs: r.llmLatencyMs,
      toolLatencyMs: r.toolLatencyMs,
      finalReason: r.finalReason,
      turnId: r.turnId,
      createdAt: r.createdAt.toISOString(),
    }));

    // 4. Project `last_verified_tools` from the (already newest-first) rows: take the
    //    most recent successful real-tool rows up to VERIFIED_TOOLS_LIMIT. We keep the
    //    newest-first order so the developer sees the freshest verified observation
    //    at index 0 — matches the order of the underlying `recent_traces` array.
    const last_verified_tools: VerifiedToolEntry[] = [];
    for (const r of recent_traces) {
      if (last_verified_tools.length >= VERIFIED_TOOLS_LIMIT) break;
      if (!r.ok) continue;
      if (SYNTHETIC_TOOL_VALUES.has(r.tool)) continue;
      if (!r.tool || r.tool.length === 0) continue;
      last_verified_tools.push({
        name: r.tool,
        observation: r.observation,
        args: r.args,
      });
    }

    const body: SnapshotResponseBody = {
      conversationId,
      snapshot,
      recent_traces,
      last_verified_tools,
    };
    res.json(body);
  } catch (err) {
    logger.warn(
      { err: String(err), tenantId, conversationId },
      "agentDebugRoutes.snapshot failed",
    );
    res.status(500).json({ error: "snapshot_failed", detail: String(err) });
  }
}

/**
 * Express router for the agent-debug endpoints. Mounted at `/admin/snapshot` from
 * `app.ts` (BEFORE the broader `/admin` admin-key router), which yields the public
 * path `GET /admin/snapshot/:conversationId`.
 *
 * Authentication mirrors `tenantPortalRoutes.ts`: every request must carry a valid
 * tenant API key (via `Authorization: Bearer ...` or `X-Api-Key`). The handler
 * additionally scopes all DB reads to `req.tenant.id` so tenants only ever see
 * their own conversations.
 */
export const agentDebugRoutes = Router();

agentDebugRoutes.use(requireTenantApiKey);
agentDebugRoutes.get("/:conversationId", handleSnapshotRequest);
