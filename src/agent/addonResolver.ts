import { parseTenantSettings } from "../types/tenant-settings.js";

/** Authoritative shape of an add-on once resolved for a specific product. */
export type ResolvedAddon = {
  id: string;
  label: string;
  priceBdt: number;
  free: boolean;
  description?: string;
  aliases?: string[];
  category?: string;
  /** Optional gallery photos uploaded by the merchant (capped at 6). */
  imageUrls?: string[];
  /** True when this came from a per-product override rather than the tenant default. */
  overridden?: boolean;
};

type RawAddon = NonNullable<ReturnType<typeof parseTenantSettings>["addOns"]>[number];

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function readAddOnIds(meta: Record<string, unknown>): string[] | null {
  const raw = meta["addOnIds"] ?? meta["addonIds"] ?? meta["addons"];
  if (!Array.isArray(raw)) return null;
  const ids = raw.map((x) => String(x ?? "").trim()).filter(Boolean);
  return ids;
}

type Override = {
  priceBdt?: number;
  free?: boolean;
};

function readAddOnOverrides(meta: Record<string, unknown>): Record<string, Override> {
  const out: Record<string, Override> = {};
  const raw = asObject(meta["addOnOverrides"] ?? meta["addonOverrides"]);
  for (const [id, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const o: Override = {};
    const p = coerceNumber(v["priceBdt"] ?? v["price"]);
    if (p != null) o.priceBdt = p;
    if (v["free"] === true) o.free = true;
    out[id.trim()] = o;
  }
  return out;
}

function applyAddon(raw: RawAddon, override: Override | undefined): ResolvedAddon | null {
  if (!raw || raw.enabled === false) return null;
  const label = String(raw.label ?? "").trim();
  if (!label) return null;
  const id = String(raw.id ?? "").trim();
  if (!id) return null;
  const baseFree = raw.free === true;
  const basePrice = coerceNumber(raw.priceBdt) ?? 0;
  const free = override?.free ?? baseFree;
  const priceBdt = free ? 0 : (override?.priceBdt ?? basePrice);
  const out: ResolvedAddon = {
    id,
    label,
    priceBdt,
    free,
  };
  if (raw.description) out.description = raw.description;
  if (raw.aliases && raw.aliases.length > 0) out.aliases = raw.aliases.slice();
  if (raw.category) out.category = raw.category;
  if (raw.imageUrls && raw.imageUrls.length > 0) out.imageUrls = raw.imageUrls.slice();
  if (override) out.overridden = true;
  return out;
}

/**
 * Resolve which add-ons apply to a specific product.
 *
 * Resolution order:
 *   1. metadata.addOnIds is an array → only those tenant add-ons (in declared order), with optional
 *      per-product price overrides from metadata.addOnOverrides.
 *   2. metadata.addOnIds === [] → no add-ons offered for this SKU.
 *   3. metadata.addOnIds is missing → fall back to ALL enabled tenant add-ons (legacy behaviour).
 */
export function resolveProductAddons(args: {
  productMetadata: unknown;
  tenantSettings: ReturnType<typeof parseTenantSettings>;
}): ResolvedAddon[] {
  const meta = asObject(args.productMetadata);
  const tenantAddOns = args.tenantSettings.addOns ?? [];
  const ids = readAddOnIds(meta);
  const overrides = readAddOnOverrides(meta);

  if (ids === null) {
    // Legacy: no per-product config → all tenant-enabled add-ons.
    return tenantAddOns
      .map((a) => applyAddon(a, undefined))
      .filter((x): x is ResolvedAddon => x != null);
  }

  if (ids.length === 0) return [];

  const byId = new Map(tenantAddOns.map((a) => [String(a.id ?? "").trim(), a] as const));
  const out: ResolvedAddon[] = [];
  for (const id of ids) {
    const raw = byId.get(id);
    if (!raw) continue;
    const resolved = applyAddon(raw, overrides[id]);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** True when this product accepts AT LEAST ONE add-on. */
export function productHasAnyAddons(args: {
  productMetadata: unknown;
  tenantSettings: ReturnType<typeof parseTenantSettings>;
}): boolean {
  return resolveProductAddons(args).length > 0;
}
