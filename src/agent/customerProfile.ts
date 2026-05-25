import { Prisma, type CustomerProfile } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const NEW_LEAD_SCORE = 10;

/**
 * Read or create the long-term customer profile keyed by (tenantId, psid).
 * Always returns a row — first inbound from a new psid creates a fresh profile with leadScore=10.
 */
export async function ensureCustomerProfile(tenantId: string, psid: string): Promise<CustomerProfile> {
  const existing = await prisma.customerProfile
    .findUnique({ where: { tenantId_psid: { tenantId, psid } } })
    .catch(() => null);
  if (existing) {
    // Touch lastSeenAt — cheap upsert keeps recent-customer queries useful.
    await prisma.customerProfile
      .update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    return existing;
  }
  return prisma.customerProfile.create({
    data: {
      tenantId,
      psid,
      leadScore: NEW_LEAD_SCORE,
      tags: [],
      preferences: Prisma.JsonNull,
    },
  });
}

export async function getCustomerProfile(
  tenantId: string,
  psid: string,
): Promise<CustomerProfile | null> {
  return prisma.customerProfile
    .findUnique({ where: { tenantId_psid: { tenantId, psid } } })
    .catch(() => null);
}

/** Atomically nudge leadScore by `delta` clamped to [0, 100]. */
export async function bumpLeadScore(
  tenantId: string,
  psid: string,
  delta: number,
): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  const cp = await ensureCustomerProfile(tenantId, psid);
  const next = Math.max(MIN_SCORE, Math.min(MAX_SCORE, cp.leadScore + Math.trunc(delta)));
  if (next === cp.leadScore) return;
  await prisma.customerProfile
    .update({ where: { id: cp.id }, data: { leadScore: next } })
    .catch((e: unknown) => logger.warn({ e: String(e), tenantId, psid }, "bumpLeadScore failed"));
}

export async function setProfileFields(
  tenantId: string,
  psid: string,
  fields: { name?: string; phone?: string; address?: string },
): Promise<void> {
  const cp = await ensureCustomerProfile(tenantId, psid);
  const data: { name?: string; phone?: string; address?: string } = {};
  if (fields.name?.trim()) data.name = fields.name.trim();
  if (fields.phone?.trim()) data.phone = fields.phone.trim();
  if (fields.address?.trim()) data.address = fields.address.trim();
  if (Object.keys(data).length === 0) return;
  await prisma.customerProfile
    .update({ where: { id: cp.id }, data })
    .catch((e: unknown) => logger.warn({ e: String(e) }, "setProfileFields failed"));
}

export async function notePreference(
  tenantId: string,
  psid: string,
  key: string,
  value: unknown,
): Promise<void> {
  const cp = await ensureCustomerProfile(tenantId, psid);
  const prev =
    cp.preferences && typeof cp.preferences === "object" && !Array.isArray(cp.preferences)
      ? (cp.preferences as Record<string, unknown>)
      : {};
  const next = { ...prev, [key]: value };
  await prisma.customerProfile
    .update({ where: { id: cp.id }, data: { preferences: next as Prisma.InputJsonValue } })
    .catch((e: unknown) => logger.warn({ e: String(e) }, "notePreference failed"));
}

/**
 * Cap applied to bounded array preferences (`favorite_teams`, `recent_sizes`,
 * `last_5_orders`). The patch's items take priority (newest first), followed
 * by prior items, with duplicates removed via `String(...)` identity.
 */
const PREFERENCE_LIST_CAP = 5;
const BOUNDED_LIST_KEYS: ReadonlySet<string> = new Set([
  "favorite_teams",
  "recent_sizes",
  "last_5_orders",
]);

function unionBoundedList(prev: unknown, next: unknown): unknown[] {
  const prevArr = Array.isArray(prev) ? prev : [];
  const nextArr = Array.isArray(next) ? next : [];
  const seen = new Set<string>();
  const out: unknown[] = [];
  // Patch items first so the most recently added preferences win the cap.
  for (const v of [...nextArr, ...prevArr]) {
    const k = typeof v === "string" || typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : JSON.stringify(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= PREFERENCE_LIST_CAP) break;
  }
  return out;
}

/**
 * Merge a `patch` of long-term preferences into `CustomerProfile.preferences`
 * with one read + one write. Used by the AgentLoop's `saveMemory` step to
 * round-trip `snapshot.customer_preferences` back into the persistent profile
 * every turn (Requirements §1.5, §13.2, §13.5).
 *
 * Merge semantics:
 * - Bounded list keys (`favorite_teams`, `recent_sizes`, `last_5_orders`):
 *   union of the patch's array with the prior array, deduped, capped to 5
 *   with patch items taking priority (newest first).
 * - All other keys: the patch's value overwrites the prior value.
 *
 * No-op when `patch` is empty. Best-effort: errors are logged via `logger.warn`
 * and swallowed so saveMemory never fails on this write.
 */
export async function mergePreferences(
  tenantId: string,
  psid: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(patch ?? {});
  if (keys.length === 0) return;
  const cp = await ensureCustomerProfile(tenantId, psid);
  const prev =
    cp.preferences && typeof cp.preferences === "object" && !Array.isArray(cp.preferences)
      ? (cp.preferences as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...prev };
  let changed = false;
  for (const k of keys) {
    const incoming = patch[k];
    if (incoming === undefined) continue;
    if (BOUNDED_LIST_KEYS.has(k)) {
      const merged = unionBoundedList(prev[k], incoming);
      // Skip writes when the merge result is identical to the prior value.
      const before = Array.isArray(prev[k]) ? (prev[k] as unknown[]) : [];
      const same =
        before.length === merged.length &&
        before.every((v, i) => JSON.stringify(v) === JSON.stringify(merged[i]));
      if (!same) {
        next[k] = merged;
        changed = true;
      }
      continue;
    }
    if (JSON.stringify(prev[k]) !== JSON.stringify(incoming)) {
      next[k] = incoming;
      changed = true;
    }
  }
  if (!changed) return;
  await prisma.customerProfile
    .update({ where: { id: cp.id }, data: { preferences: next as Prisma.InputJsonValue } })
    .catch((e: unknown) => logger.warn({ e: String(e) }, "mergePreferences failed"));
}

export async function recordOrderForProfile(args: {
  tenantId: string;
  psid: string;
  amountBdt: number;
}): Promise<void> {
  const cp = await ensureCustomerProfile(args.tenantId, args.psid);
  await prisma.customerProfile
    .update({
      where: { id: cp.id },
      data: {
        totalOrders: cp.totalOrders + 1,
        totalSpentBdt: { increment: new Prisma.Decimal(args.amountBdt) },
        leadScore: Math.min(MAX_SCORE, cp.leadScore + 15),
      },
    })
    .catch((e: unknown) => logger.warn({ e: String(e) }, "recordOrderForProfile failed"));
}
