"use client";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { useTenant } from "@/context/tenant-context";
import { apiFetch } from "@/lib/api";
import { useCategorySchema, getVariantEnumValues, findAttributeField } from "@/lib/useCategorySchema";
import { parseProductCatalogCsv } from "@/lib/parseProductCsv";
import { cn } from "@/lib/utils";
import type { ProductMappingRow, TenantMe } from "@/lib/types";
import {
  ChevronDown,
  Cloud,
  Database,
  Loader2,
  Package,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

type CatalogMode = "upload" | "database" | "manual" | "cloudinary";

type CloudinaryPreviewRow = {
  folderSlug: string;
  clientSku: string;
  facebookLabel: string | null;
  score: number;
  imageCount: number;
};

type CloudinaryDiagnostics = {
  samplePublicIds: string[];
  sampleAssetFolders?: string[];
  groupKeysFromCloudinary: string[];
  emptyTitleSkus: string[];
  productTitles: Array<{ clientSku: string; titleText: string; words: string }>;
  hint: string;
};

function readCloudinaryFromSettings(settings: TenantMe["settings"]) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const c = (settings as Record<string, unknown>).cloudinary;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  return c as Record<string, unknown>;
}

/** Keys we edit in the simple form; merged with advanced JSON on save. */
const MANUAL_SIMPLE_KEYS = new Set([
  "name",
  "price",
  "compareAtPrice",
  "saleStartsAt",
  "saleEndsAt",
  "stock",
  "images",
  "description",
  "image_url",
  "image_urls",
  "fabricMaterial",
  "fabric_type",
  "jerseyVersion",
  "jersey_version",
  "sizeStocks",
  "size_stocks",
  "variants",
  "tags",
  "addOnIds",
  "addonIds",
  "addons",
  "addOnOverrides",
  "addonOverrides",
]);

const SIZE_LABEL_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL"];

function sortSizeLabelsClient(sizes: string[]): string[] {
  const uniq = [...new Set(sizes.map((s) => s.trim()).filter(Boolean))];
  const rank = (s: string) => {
    const u = s.toUpperCase();
    const i = SIZE_LABEL_ORDER.indexOf(u);
    return i >= 0 ? i : 100;
  };
  return uniq.sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.toUpperCase().localeCompare(b.toUpperCase());
  });
}

type ManualSizeStockRow = { id: string; size: string; qty: string };

function newSizeRowId(): string {
  return `sz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptySizeStockRows(count: number): ManualSizeStockRow[] {
  return Array.from({ length: count }, () => ({ id: newSizeRowId(), size: "", qty: "" }));
}

function metaHasPerSizeStock(meta: Record<string, unknown>): boolean {
  const raw = meta.sizeStocks ?? meta.size_stocks;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.keys(raw as Record<string, unknown>).length > 0;
  }
  if (Array.isArray(raw)) return raw.length > 0;
  return false;
}

function readSizeStocksFromMetaForForm(meta: Record<string, unknown>): ManualSizeStockRow[] {
  const raw = meta.sizeStocks ?? meta.size_stocks;
  const rows: ManualSizeStockRow[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const sz = String(k).trim();
      if (!sz) continue;
      const n = typeof v === "number" && Number.isFinite(v) ? v : Number(String(v ?? "").trim());
      if (!Number.isFinite(n)) continue;
      rows.push({ id: newSizeRowId(), size: sz.toUpperCase(), qty: String(Math.trunc(n)) });
    }
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const o = entry as Record<string, unknown>;
      const sz = String(o.size ?? o.Size ?? "").trim();
      if (!sz) continue;
      const n =
        typeof o.stock === "number" && Number.isFinite(o.stock)
          ? o.stock
          : Number(String(o.stock ?? o.qty ?? "").trim());
      if (!Number.isFinite(n)) continue;
      rows.push({ id: newSizeRowId(), size: sz.toUpperCase(), qty: String(Math.trunc(n)) });
    }
  }
  if (rows.length === 0) return emptySizeStockRows(4);
  const order = sortSizeLabelsClient(rows.map((r) => r.size));
  rows.sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size));
  rows.push({ id: newSizeRowId(), size: "", qty: "" });
  return rows;
}

function parseSizeStockRows(
  rows: ManualSizeStockRow[],
): { ok: true; map: Record<string, number>; total: number } | { ok: false; error: string } {
  const map: Record<string, number> = {};
  for (const r of rows) {
    const sz = r.size.trim().toUpperCase();
    const q = r.qty.trim();
    if (!sz && !q) continue;
    if (!sz) return { ok: false, error: "Each row with a quantity needs a size (e.g. M, XL)." };
    if (!q) return { ok: false, error: `Enter how many pieces for size ${sz}, or clear that row.` };
    const n = Number(q);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return { ok: false, error: `Use a whole number (0, 1, 2, …) for size ${sz}.` };
    }
    if (map[sz] !== undefined) return { ok: false, error: `Size ${sz} is listed twice — keep one row per size.` };
    map[sz] = n;
  }
  const keys = Object.keys(map);
  const total = keys.reduce((s, k) => s + map[k], 0);
  return { ok: true, map, total };
}

function readProductMeta(row: ProductMappingRow): Record<string, unknown> {
  const m = row.metadata;
  if (m && typeof m === "object" && !Array.isArray(m)) return { ...(m as Record<string, unknown>) };
  return {};
}

type TenantAddOn = {
  id: string;
  label: string;
  priceBdt?: number;
  description?: string;
  enabled?: boolean;
  free?: boolean;
  aliases?: string[];
  category?: string;
};

/** Lines for the photo URLs box (primary + legacy keys). */
function photoUrlsTextFromMeta(meta: Record<string, unknown>): string {
  const lines: string[] = [];
  if (Array.isArray(meta.images)) {
    for (const x of meta.images) {
      if (typeof x === "string" && /^https?:\/\//i.test(x.trim())) lines.push(x.trim());
    }
  }
  const pipeOrComma = (s: string) =>
    s
      .split(/[|\n,]+/)
      .map((t) => t.trim())
      .filter((t) => /^https?:\/\//i.test(t));
  if (typeof meta.image_urls === "string") lines.push(...pipeOrComma(meta.image_urls));
  if (typeof meta.image_url === "string" && /^https?:\/\//i.test(meta.image_url.trim())) {
    lines.push(meta.image_url.trim());
  }
  return Array.from(new Set(lines)).join("\n");
}

function parsePhotoUrlLines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!/^https?:\/\//i.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseOptionalNumber(raw: string): number | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function formatMetaNumberForInput(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") return v.trim();
  return "";
}

/**
 * Convert an ISO timestamp into the `YYYY-MM-DDTHH:mm` shape required by an
 * `<input type="datetime-local">`. Local time, no offset suffix. Returns
 * empty string for missing or invalid values.
 */
function formatIsoForDatetimeLocal(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "";
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Extra metadata shown in Advanced JSON (everything except simple-form keys). */
function metaForAdvancedEditor(meta: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...meta };
  for (const k of MANUAL_SIMPLE_KEYS) delete rest[k];
  return rest;
}

function buildManualMetadata(args: {
  productName: string;
  priceStr: string;
  compareAtPriceStr: string;
  saleStartsAtStr: string;
  saleEndsAtStr: string;
  stockStr: string;
  photoUrlsText: string;
  description: string;
  fabricMaterial: string;
  jerseyVersion: "" | "player" | "fan";
  tagsText: string;
  sizeStockRows: ManualSizeStockRow[];
  advancedJson: string;
  /** Add-on selection for this product. When `useTenantDefault=true`, no addOnIds are written. */
  useTenantDefaultAddOns: boolean;
  selectedAddOnIds: string[];
  addOnPriceOverrides: Record<string, string>;
  addOnFreeOverrides: Record<string, boolean>;
}): { ok: true; metadata: Record<string, unknown> } | { ok: false; error: string } {
  let extra: Record<string, unknown> = {};
  const adv = args.advancedJson.trim();
  if (adv) {
    try {
      const parsed = JSON.parse(adv) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "Advanced metadata must be a JSON object { … }, not a list or string." };
      }
      extra = { ...(parsed as Record<string, unknown>) };
    } catch {
      return { ok: false, error: "Advanced metadata is not valid JSON. Fix or clear it." };
    }
  }

  const merged: Record<string, unknown> = { ...extra };
  for (const k of MANUAL_SIMPLE_KEYS) delete merged[k];

  const name = args.productName.trim();
  if (name) merged.name = name;

  if (args.priceStr.trim()) {
    const price = parseOptionalNumber(args.priceStr);
    if (price === undefined) {
      return { ok: false, error: "Price must be a valid number, or leave the field empty." };
    }
    merged.price = price;
  }

  // Compare price + sale window. The agent treats the offer as active only
  // when within the window AND compareAtPrice > price; otherwise it falls
  // back to the regular price.
  if (args.compareAtPriceStr.trim()) {
    const compare = parseOptionalNumber(args.compareAtPriceStr);
    if (compare === undefined) {
      return { ok: false, error: "Compare price must be a valid number, or leave the field empty." };
    }
    if (typeof merged.price === "number" && compare <= merged.price) {
      return {
        ok: false,
        error: "Compare price must be HIGHER than the sell price (it's the 'was' / regular amount).",
      };
    }
    merged.compareAtPrice = compare;
  } else {
    delete merged.compareAtPrice;
  }
  // datetime-local inputs come back as "YYYY-MM-DDTHH:mm" without a TZ; let
  // the browser parse that as local time and we serialise as ISO.
  const startsRaw = args.saleStartsAtStr.trim();
  if (startsRaw) {
    const d = new Date(startsRaw);
    if (!Number.isFinite(d.getTime())) {
      return { ok: false, error: "Sale start time isn't a valid date." };
    }
    merged.saleStartsAt = d.toISOString();
  } else {
    delete merged.saleStartsAt;
  }
  const endsRaw = args.saleEndsAtStr.trim();
  if (endsRaw) {
    const d = new Date(endsRaw);
    if (!Number.isFinite(d.getTime())) {
      return { ok: false, error: "Sale end time isn't a valid date." };
    }
    if (startsRaw) {
      const startD = new Date(startsRaw);
      if (Number.isFinite(startD.getTime()) && d.getTime() <= startD.getTime()) {
        return { ok: false, error: "Sale end time must be after the start time." };
      }
    }
    merged.saleEndsAt = d.toISOString();
  } else {
    delete merged.saleEndsAt;
  }

  const sizeParse = parseSizeStockRows(args.sizeStockRows);
  if (!sizeParse.ok) return sizeParse;

  if (Object.keys(sizeParse.map).length > 0) {
    merged.sizeStocks = sizeParse.map;
    merged.stock = sizeParse.total;
    const ordered = sortSizeLabelsClient(Object.keys(sizeParse.map));
    merged.variants = ordered.map((k) => `Size: ${k}`).join("; ");
  } else if (args.stockStr.trim()) {
    const stock = parseOptionalNumber(args.stockStr);
    if (stock === undefined) {
      return { ok: false, error: "Stock must be a valid number, or leave the field empty." };
    }
    merged.stock = stock;
  }

  const fab = args.fabricMaterial.trim();
  if (fab) merged.fabricMaterial = fab;

  const tagsList = args.tagsText.split(",").map((t) => t.trim()).filter(Boolean);
  if (tagsList.length > 0) merged.tags = tagsList;

  if (args.jerseyVersion === "player" || args.jerseyVersion === "fan") {
    merged.jerseyVersion = args.jerseyVersion;
  }

  // Add-on opt-in: when explicit, write `addOnIds` (possibly empty array → "no add-ons offered")
  // and `addOnOverrides` for any per-product price/free overrides. When the user picked "use shop
  // default", strip these keys so the resolver falls back to all enabled tenant add-ons.
  if (args.useTenantDefaultAddOns) {
    delete merged.addOnIds;
    delete merged.addonIds;
    delete merged.addons;
    delete merged.addOnOverrides;
    delete merged.addonOverrides;
  } else {
    merged.addOnIds = args.selectedAddOnIds.slice();
    delete merged.addonIds;
    delete merged.addons;
    const overrides: Record<string, { priceBdt?: number; free?: boolean }> = {};
    for (const id of args.selectedAddOnIds) {
      const isFree = !!args.addOnFreeOverrides[id];
      const priceStr = (args.addOnPriceOverrides[id] ?? "").trim();
      const entry: { priceBdt?: number; free?: boolean } = {};
      if (isFree) entry.free = true;
      if (!isFree && priceStr !== "") {
        const n = Number(priceStr);
        if (!Number.isFinite(n) || n < 0) {
          return { ok: false, error: `Add-on price override for "${id}" must be a non-negative number.` };
        }
        entry.priceBdt = n;
      }
      if (Object.keys(entry).length > 0) overrides[id] = entry;
    }
    if (Object.keys(overrides).length > 0) merged.addOnOverrides = overrides;
    else {
      delete merged.addOnOverrides;
      delete merged.addonOverrides;
    }
  }

  const urls = parsePhotoUrlLines(args.photoUrlsText);
  if (urls.length > 0) merged.images = urls;

  const desc = args.description.trim();
  if (desc) merged.description = desc;

  return { ok: true, metadata: merged };
}

export default function CatalogPage() {
  const { tenant, refresh } = useTenant();
  const { schema: categorySchema } = useCategorySchema();
  const businessCategory = tenant?.businessCategory ?? null;
  const isJerseyCategory = businessCategory === "jersey" || businessCategory === null;
  // Schema-driven size enum: jersey/clothing → 'size', shoes → 'shoe_size',
  // restaurant → 'portion_size'. Falls back to the legacy clothing list when
  // the schema doesn't declare any of those fields (e.g. an electronics
  // tenant whose products don't have variants).
  const variantSizeKey = categorySchema
    ? findAttributeField(categorySchema.variantAttributes, "size")
      ? "size"
      : findAttributeField(categorySchema.variantAttributes, "shoe_size")
        ? "shoe_size"
        : findAttributeField(categorySchema.variantAttributes, "portion_size")
          ? "portion_size"
          : "size"
    : "size";
  const variantSizeOptions: string[] = (() => {
    const fromSchema = getVariantEnumValues(categorySchema, variantSizeKey);
    if (fromSchema.length > 0) return fromSchema;
    return ["S", "M", "L", "XL", "XXL", "XS"];
  })();
  const variantSizeLabel = (() => {
    const field = findAttributeField(
      categorySchema?.variantAttributes,
      variantSizeKey,
    );
    return field?.label ?? "Size";
  })();
  const integrationType = tenant?.integration?.type as string | undefined;
  const isDatabaseMode = integrationType === "DATABASE";

  const [rows, setRows] = useState<ProductMappingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [sku, setSku] = useState("");
  const [productName, setProductName] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [compareAtPriceStr, setCompareAtPriceStr] = useState("");
  const [saleStartsAtStr, setSaleStartsAtStr] = useState("");
  const [saleEndsAtStr, setSaleEndsAtStr] = useState("");
  const [stockStr, setStockStr] = useState("");
  const [photoUrlsText, setPhotoUrlsText] = useState("");
  const [description, setDescription] = useState("");
  const [fabricMaterial, setFabricMaterial] = useState("");
  const [jerseyVersion, setJerseyVersion] = useState<"" | "player" | "fan">("");
  const [tagsText, setTagsText] = useState("");
  const [sizeStockRows, setSizeStockRows] = useState<ManualSizeStockRow[]>(() => emptySizeStockRows(4));
  const [advancedJson, setAdvancedJson] = useState("{}");
  const [manualAdvancedOpen, setManualAdvancedOpen] = useState(false);

  // Per-product add-on opt-in (phase 3.5): true = inherit shop-wide enabled add-ons, false = explicit list.
  const [useTenantDefaultAddOns, setUseTenantDefaultAddOns] = useState(true);
  const [selectedAddOnIds, setSelectedAddOnIds] = useState<string[]>([]);
  const [addOnPriceOverrides, setAddOnPriceOverrides] = useState<Record<string, string>>({});
  const [addOnFreeOverrides, setAddOnFreeOverrides] = useState<Record<string, boolean>>({});

  const tenantAddOns: TenantAddOn[] = (() => {
    const raw = tenant?.settings?.addOns;
    if (!Array.isArray(raw)) return [];
    return (raw as TenantAddOn[]).filter((a) => a && a.label && a.enabled !== false);
  })();
  const [feedback, setFeedback] = useState("");
  const [mode, setMode] = useState<CatalogMode>("upload");

  const [csvBusy, setCsvBusy] = useState(false);
  const [csvMsg, setCsvMsg] = useState("");
  const csvInputRef = useRef<HTMLInputElement>(null);

  const [dbSyncBusy, setDbSyncBusy] = useState(false);
  const [dbMsg, setDbMsg] = useState("");

  /** Optional: only for this Preview/Apply request (overrides saved default). */
  const [cloudRunOverride, setCloudRunOverride] = useState("");
  const [cloudCredName, setCloudCredName] = useState("");
  const [cloudCredKey, setCloudCredKey] = useState("");
  const [cloudCredSecret, setCloudCredSecret] = useState("");
  const [cloudSavedPrefix, setCloudSavedPrefix] = useState("");
  const [cloudCredsSaving, setCloudCredsSaving] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMsg, setCloudMsg] = useState("");
  const [cloudPreview, setCloudPreview] = useState<CloudinaryPreviewRow[]>([]);
  const [cloudDiag, setCloudDiag] = useState<CloudinaryDiagnostics | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const r = await apiFetch<{ productMappings: ProductMappingRow[] }>(
        "/api/v1/product-mappings",
      );
      setRows(r.productMappings);
    } catch (e) {
      setRows([]);
      setLoadError(
        e instanceof Error
          ? `Could not load catalog from API: ${e.message}`
          : "Could not load catalog from API.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const cu = readCloudinaryFromSettings(tenant?.settings ?? null);
    if (!cu) {
      setCloudCredName("");
      setCloudCredKey("");
      setCloudCredSecret("");
      setCloudSavedPrefix("");
      return;
    }
    setCloudCredName(String(cu.cloudName ?? ""));
    setCloudCredKey(String(cu.apiKey ?? ""));
    setCloudCredSecret(String(cu.apiSecret ?? ""));
    setCloudSavedPrefix(String(cu.catalogAssetPrefix ?? "").trim());
  }, [tenant]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.clientSku} ${r.facebookLabel || ""}`.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const sizeGridParsed = useMemo(() => parseSizeStockRows(sizeStockRows), [sizeStockRows]);
  const perSizeStockActive = sizeGridParsed.ok && Object.keys(sizeGridParsed.map).length > 0;

  async function addMapping(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFeedback("");
    try {
      const built = buildManualMetadata({
        productName,
        priceStr,
        compareAtPriceStr,
        saleStartsAtStr,
        saleEndsAtStr,
        stockStr,
        photoUrlsText,
        description,
        fabricMaterial,
        jerseyVersion,
        tagsText,
        sizeStockRows,
        advancedJson,
        useTenantDefaultAddOns,
        selectedAddOnIds,
        addOnPriceOverrides,
        addOnFreeOverrides,
      });
      if (!built.ok) {
        setFeedback(built.error);
        setSubmitting(false);
        return;
      }
      await apiFetch("/api/v1/product-mappings", {
        method: "POST",
        body: JSON.stringify({
          clientSku: sku.trim(),
          facebookLabel: productName.trim() || undefined,
          metadata: Object.keys(built.metadata).length > 0 ? built.metadata : undefined,
        }),
      });
      setSku("");
      setProductName("");
      setPriceStr("");
      setCompareAtPriceStr("");
      setSaleStartsAtStr("");
      setSaleEndsAtStr("");
      setStockStr("");
      setPhotoUrlsText("");
      setDescription("");
      setFabricMaterial("");
      setJerseyVersion("");
      setSizeStockRows(emptySizeStockRows(4));
      setAdvancedJson("{}");
      setUseTenantDefaultAddOns(true);
      setSelectedAddOnIds([]);
      setAddOnPriceOverrides({});
      setAddOnFreeOverrides({});
      setFeedback("Saved.");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function importCsvFile(file: File) {
    setCsvMsg("");
    setCsvBusy(true);
    try {
      const text = await file.text();
      const parsed = parseProductCatalogCsv(text);
      const r = await apiFetch<{ ok: boolean; upserted: number }>("/api/v1/product-mappings/bulk", {
        method: "POST",
        body: JSON.stringify({ rows: parsed }),
      });
      setCsvMsg(`Imported ${r.upserted} row(s).`);
      await load();
    } catch (e) {
      setCsvMsg(e instanceof Error ? e.message : "CSV import failed");
    } finally {
      setCsvBusy(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }

  async function syncFromDatabase() {
    setDbMsg("");
    setDbSyncBusy(true);
    try {
      const r = await apiFetch<{ upserted: number }>("/api/v1/product-mappings/sync-from-db", {
        method: "POST",
      });
      setDbMsg(`Synced ${r.upserted} row(s) from tables.products.`);
      await load();
    } catch (e) {
      setDbMsg(e instanceof Error ? e.message : "Database sync failed");
    } finally {
      setDbSyncBusy(false);
    }
  }

  async function saveCloudinaryCredentials() {
    setCloudCredsSaving(true);
    setCloudMsg("");
    try {
      const base =
        tenant?.settings && typeof tenant.settings === "object" && !Array.isArray(tenant.settings)
          ? { ...(tenant.settings as Record<string, unknown>) }
          : {};
      await apiFetch("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({
          settings: {
            ...base,
            cloudinary: {
              cloudName: cloudCredName.trim(),
              apiKey: cloudCredKey.trim(),
              apiSecret: cloudCredSecret.trim(),
              catalogAssetPrefix: cloudSavedPrefix.trim() || undefined,
            },
          },
        }),
      });
      setCloudMsg("Cloudinary credentials saved for this workspace.");
      await refresh();
    } catch (e) {
      setCloudMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setCloudCredsSaving(false);
    }
  }

  async function cloudinarySync(dryRun: boolean) {
    setCloudMsg("");
    setCloudBusy(true);
    if (dryRun) {
      setCloudPreview([]);
      setCloudDiag(null);
    }
    try {
      const r = await apiFetch<{
        ok: boolean;
        configSource?: "tenant" | "env";
        assetCount?: number;
        matchedSkus?: number;
        updated?: number;
        preview?: CloudinaryPreviewRow[];
        diagnostics?: CloudinaryDiagnostics;
      }>("/api/v1/product-mappings/sync-cloudinary-images", {
        method: "POST",
        body: JSON.stringify({
          prefix: cloudRunOverride.trim() || undefined,
          dryRun,
        }),
      });
      const prev = (r.preview ?? []).map((p) => ({
        folderSlug: p.folderSlug,
        clientSku: p.clientSku,
        facebookLabel: p.facebookLabel ?? null,
        score: p.score,
        imageCount: p.imageCount,
      }));
      setCloudPreview(prev);
      setCloudDiag(r.diagnostics ?? null);
      const src =
        r.configSource === "tenant"
          ? " (using workspace Cloudinary credentials)"
          : r.configSource === "env"
            ? " (using server default Cloudinary env)"
            : "";
      if (dryRun) {
        setCloudMsg(
          `Preview: ${r.assetCount ?? 0} asset(s) from Cloudinary, ${r.matchedSkus ?? prev.length} product match(es) (by title ↔ folder name).${src} Apply to write metadata.images.`,
        );
      } else {
        setCloudMsg(
          `Updated ${r.updated ?? 0} product row(s). ${r.assetCount ?? 0} asset(s) scanned.${src}`,
        );
        await load();
      }
    } catch (e) {
      setCloudMsg(e instanceof Error ? e.message : "Cloudinary sync failed");
      setCloudDiag(null);
    } finally {
      setCloudBusy(false);
    }
  }

  async function remove(targetSku: string) {
    if (!confirm(`Remove mapping for SKU "${targetSku}"?`)) return;
    await apiFetch(`/api/v1/product-mappings/${encodeURIComponent(targetSku)}`, {
      method: "DELETE",
    });
    await load();
  }

  function imageUrlsFromMeta(meta: Record<string, unknown> | null): string[] {
    if (!meta) return [];
    const candidates = [meta.images, meta.image_urls, meta.image_url, meta.photo, meta.thumbnail];
    const out: string[] = [];
    for (const c of candidates) {
      if (Array.isArray(c)) {
        c.forEach((v) => {
          if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) out.push(v.trim());
        });
      }
      if (typeof c === "string" && c.trim()) {
        const parts = c.split("|").map((s) => s.trim());
        parts.forEach((p) => {
          if (/^https?:\/\//i.test(p)) out.push(p);
        });
      }
    }
    return Array.from(new Set(out));
  }

  function updateSizeRow(id: string, field: "size" | "qty", value: string) {
    setSizeStockRows((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  function addSizeStockRow() {
    setSizeStockRows((prev) => [...prev, { id: newSizeRowId(), size: "", qty: "" }]);
  }

  function removeSizeStockRow(id: string) {
    setSizeStockRows((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.id !== id)));
  }

  function addPresetSize(label: string) {
    const u = label.toUpperCase();
    setSizeStockRows((prev) => {
      if (prev.some((row) => row.size.trim().toUpperCase() === u)) return prev;
      const empty = prev.find((row) => !row.size.trim() && !row.qty.trim());
      if (empty) {
        return prev.map((row) => (row.id === empty.id ? { ...row, size: u } : row));
      }
      return [...prev, { id: newSizeRowId(), size: u, qty: "" }];
    });
  }

  function hydrateManualFromRow(r: ProductMappingRow) {
    setMode("manual");
    setSku(r.clientSku);
    const meta = readProductMeta(r);
    const displayName = String(r.facebookLabel ?? meta.name ?? "").trim();
    setProductName(displayName);
    setPriceStr(formatMetaNumberForInput(meta.price));
    setCompareAtPriceStr(formatMetaNumberForInput(meta.compareAtPrice));
    setSaleStartsAtStr(formatIsoForDatetimeLocal(meta.saleStartsAt));
    setSaleEndsAtStr(formatIsoForDatetimeLocal(meta.saleEndsAt));
    if (metaHasPerSizeStock(meta)) setStockStr("");
    else setStockStr(formatMetaNumberForInput(meta.stock));
    setPhotoUrlsText(photoUrlsTextFromMeta(meta));
    setDescription(typeof meta.description === "string" ? meta.description : "");
    setFabricMaterial(String(meta.fabricMaterial ?? meta.fabric_type ?? "").trim());
    const existingTags = Array.isArray(meta.tags)
      ? (meta.tags as unknown[]).map((t) => String(t ?? "").trim()).filter(Boolean).join(", ")
      : typeof meta.tags === "string" ? meta.tags : "";
    setTagsText(existingTags);
    const jvRaw = String(meta.jerseyVersion ?? meta.jersey_version ?? "")
      .trim()
      .toLowerCase();
    setJerseyVersion(
      jvRaw === "player" || jvRaw === "player_version"
        ? "player"
        : jvRaw === "fan" || jvRaw === "fan_version"
          ? "fan"
          : "",
    );
    setSizeStockRows(readSizeStocksFromMetaForForm(meta));
    // Hydrate per-product add-on selection.
    const rawIds = meta.addOnIds ?? meta.addonIds ?? meta.addons;
    if (Array.isArray(rawIds)) {
      const ids = (rawIds as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean);
      setUseTenantDefaultAddOns(false);
      setSelectedAddOnIds(ids);
    } else {
      setUseTenantDefaultAddOns(true);
      setSelectedAddOnIds([]);
    }
    const rawOv = meta.addOnOverrides ?? meta.addonOverrides;
    const priceOv: Record<string, string> = {};
    const freeOv: Record<string, boolean> = {};
    if (rawOv && typeof rawOv === "object" && !Array.isArray(rawOv)) {
      for (const [id, val] of Object.entries(rawOv as Record<string, unknown>)) {
        if (!val || typeof val !== "object" || Array.isArray(val)) continue;
        const v = val as Record<string, unknown>;
        if (v.free === true) freeOv[id] = true;
        if (typeof v.priceBdt === "number") priceOv[id] = String(v.priceBdt);
        else if (typeof v.priceBdt === "string") priceOv[id] = v.priceBdt;
      }
    }
    setAddOnPriceOverrides(priceOv);
    setAddOnFreeOverrides(freeOv);
    const rest = metaForAdvancedEditor(meta);
    setAdvancedJson(Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : "{}");
    setManualAdvancedOpen(Object.keys(rest).length > 0);
    setFeedback("");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <>
            <Package className="h-3.5 w-3.5" /> {rows.length} mappings
          </>
        }
        title="Catalog"
        description="Load products via CSV, database sync, a simple manual form, or Cloudinary to fill photos (each workspace can use its own Cloudinary keys)."
        actions={
          <Button variant="ghost" onClick={() => load()} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OptionCard
          active={mode === "upload"}
          onSelect={() => setMode("upload")}
          icon={<Upload className="h-5 w-5 text-sky-300" />}
          title="Upload catalog file"
          subtitle="CSV with SKU and optional label columns. Up to 2000 rows per upload."
        />
        <OptionCard
          active={mode === "database"}
          onSelect={() => setMode("database")}
          icon={<Database className="h-5 w-5 text-emerald-300" />}
          title="Connect database"
          subtitle="When integration mode is DATABASE, sync rows from your products table into mappings."
        />
        <OptionCard
          active={mode === "manual"}
          onSelect={() => setMode("manual")}
          icon={<Pencil className="h-5 w-5 text-amber-300" />}
          title="Manual entry"
          subtitle="Fill in product name, price, and photo links — no JSON required."
        />
        <OptionCard
          active={mode === "cloudinary"}
          onSelect={() => setMode("cloudinary")}
          icon={<Cloud className="h-5 w-5 text-violet-300" />}
          title="Cloudinary photos"
          subtitle="Save your Cloudinary API keys here, then match folder names to titles and set metadata.images."
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_440px]">
        <Section
          title={`${filtered.length} of ${rows.length} mappings`}
          actions={
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search SKU or label…"
                  className="w-56 rounded-lg border border-white/[0.08] bg-white/[0.03] py-1.5 pl-9 pr-3 text-xs text-slate-200 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              </div>
            </div>
          }
        >
          {loadError && (
            <div className="mb-3 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {loadError}
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-7 w-7 animate-spin text-accent-bright" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/[0.04]">
                <Package className="h-5 w-5 text-slate-500" />
              </div>
              <p className="text-sm text-slate-500">
                {query ? "No mappings match your search." : "No mappings yet — use an option above."}
              </p>
            </div>
          ) : (
            <ul className="-mx-2 space-y-1.5">
              {filtered.slice(0, 100).map((r) => (
                <li
                  key={r.id}
                  className="group flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3 transition hover:border-white/[0.1] hover:bg-white/[0.04]"
                >
                  {imageUrlsFromMeta(r.metadata).length > 0 ? (
                    <CatalogThumb
                      imageUrls={imageUrlsFromMeta(r.metadata)}
                      alt={r.facebookLabel ?? r.clientSku}
                    />
                  ) : (
                    <div className="grid h-10 w-10 place-items-center rounded-md border border-white/10 text-slate-500">
                      <Package className="h-4 w-4" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => hydrateManualFromRow(r)}
                    className="min-w-0 flex-1 text-left"
                  >
                    {r.facebookLabel && (
                      <p className="truncate text-sm font-medium text-slate-200">{r.facebookLabel}</p>
                    )}
                    <div className="mt-0.5 flex items-center gap-2">
                      <p className="font-mono text-xs text-indigo-300/70">{r.clientSku}</p>
                      <SaleChip meta={r.metadata as Record<string, unknown> | null} />
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(r.clientSku)}
                    className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {filtered.length > 100 && (
                <li className="px-4 py-2 text-center text-xs text-slate-500">
                  Showing 100 of {filtered.length}. Use search to narrow down.
                </li>
              )}
            </ul>
          )}
        </Section>

        <Section
          title={
            mode === "upload"
              ? "Upload CSV"
              : mode === "database"
                ? "Database sync"
                : mode === "cloudinary"
                  ? "Cloudinary image sync"
                  : "Manual add / update"
          }
          description={
            mode === "upload"
              ? "Required column: client_sku or sku. Optional: facebook_label, label, or product_name."
              : mode === "database"
                ? "Reads up to 2000 rows from integration tables.products (columns sku & name by default — configurable server-side)."
                : mode === "cloudinary"
                  ? "Server env: CLOUDINARY_CLOUD_NAME, API key, secret. After Preview, read “What Cloudinary sent” — that path must include your product folder name; we match that to catalog title words (label + metadata name fields), not SKU."
                : "Existing SKUs are upserted."
          }
          className="self-start"
        >
          {mode === "upload" && (
            <div className="space-y-4">
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importCsvFile(f);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={csvBusy}
                className="gap-2"
                onClick={() => csvInputRef.current?.click()}
              >
                {csvBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Choose CSV file
              </Button>
              {csvMsg && (
                <p className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 text-xs text-slate-300">
                  {csvMsg}
                </p>
              )}
            </div>
          )}

          {mode === "cloudinary" && (
            <div className="space-y-4">
              <div className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-xs font-medium text-slate-300">Workspace Cloudinary (Admin API)</p>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  From the Cloudinary console: Dashboard shows cloud name; Settings → Access Keys for API key and
                  secret. Each client workspace stores its own keys (or your host can set global{" "}
                  <span className="font-mono text-slate-400">CLOUDINARY_*</span> env as fallback). Same fields live
                  under{" "}
                  <Link href="/portal/settings" className="font-medium text-accent underline underline-offset-4">
                    Settings
                  </Link>{" "}
                  → Catalog.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Cloud name">
                    <input
                      value={cloudCredName}
                      onChange={(e) => setCloudCredName(e.target.value)}
                      placeholder="your-cloud-name"
                      className={inputCls}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="API key">
                    <input
                      value={cloudCredKey}
                      onChange={(e) => setCloudCredKey(e.target.value)}
                      placeholder="123456789012345"
                      className={inputCls}
                      autoComplete="off"
                    />
                  </Field>
                </div>
                <Field label="API secret">
                  <input
                    type="password"
                    value={cloudCredSecret}
                    onChange={(e) => setCloudCredSecret(e.target.value)}
                    placeholder="••••••••"
                    className={inputCls}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="Default folder prefix (optional)">
                  <input
                    value={cloudSavedPrefix}
                    onChange={(e) => setCloudSavedPrefix(e.target.value)}
                    placeholder="e.g. catalog/jerseys/ — saved with credentials"
                    className={inputCls}
                  />
                </Field>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={cloudCredsSaving}
                  className="gap-2"
                  onClick={() => void saveCloudinaryCredentials()}
                >
                  {cloudCredsSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save credentials
                </Button>
              </div>
              <Field label="Prefix override for this run only (optional)">
                <input
                  value={cloudRunOverride}
                  onChange={(e) => setCloudRunOverride(e.target.value)}
                  placeholder="Leave empty to use the saved default above (or whole library if none)"
                  className={inputCls}
                />
              </Field>
              <p className="text-xs leading-relaxed text-slate-500">
                In Cloudinary, <strong className="text-slate-300">Public ID</strong> is the asset path (same as a file path — folders use{" "}
                <span className="font-mono">/</span>). Open an image and read that string. Your catalog title must share{" "}
                <strong className="text-slate-300">at least two words</strong> with one of the path segments (we skip generic
                bits like <span className="font-mono">Home</span> when matching). Example:{" "}
                <span className="font-mono text-slate-400">Home/Spain WC26 Away Kit/1</span> → words{" "}
                <span className="font-mono">spain, wc26, away, kit</span>.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={cloudBusy}
                  className="gap-2"
                  onClick={() => void cloudinarySync(true)}
                >
                  {cloudBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
                  Preview matches
                </Button>
                <Button type="button" disabled={cloudBusy} className="gap-2" onClick={() => void cloudinarySync(false)}>
                  {cloudBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Apply to catalog
                </Button>
              </div>
              {cloudMsg && (
                <p className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 text-xs text-slate-300">
                  {cloudMsg}
                </p>
              )}
              {cloudDiag && (
                <div className="space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-3 text-xs text-slate-300">
                  <p className="font-medium text-amber-100/95">What Cloudinary sent vs what we match</p>
                  <p className="leading-relaxed text-slate-400">{cloudDiag.hint}</p>
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Sample Public IDs (may be random ids in Dynamic folder mode)
                    </p>
                    <ul className="max-h-28 space-y-0.5 overflow-auto font-mono text-[11px] text-slate-400">
                      {cloudDiag.samplePublicIds.length === 0 ? (
                        <li>(none)</li>
                      ) : (
                        cloudDiag.samplePublicIds.map((id) => <li key={id}>{id}</li>)
                      )}
                    </ul>
                  </div>
                  {(cloudDiag.sampleAssetFolders?.length ?? 0) > 0 && (
                    <div>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        Sample asset_folder (Media Library folder from API)
                      </p>
                      <p className="font-mono text-[11px] text-emerald-200/90">
                        {(cloudDiag.sampleAssetFolders ?? []).join(" · ")}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Folder keys used for grouping
                    </p>
                    <p className="font-mono text-[11px] text-slate-400">
                      {cloudDiag.groupKeysFromCloudinary.length === 0
                        ? "(none)"
                        : cloudDiag.groupKeysFromCloudinary.join(", ")}
                    </p>
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Title words we use from your catalog (first rows)
                    </p>
                    <div className="max-h-36 overflow-auto rounded border border-white/[0.06] bg-black/20">
                      <table className="w-full text-left text-[11px] text-slate-400">
                        <thead>
                          <tr className="text-[10px] uppercase text-slate-500">
                            <th className="p-1.5">SKU</th>
                            <th className="p-1.5">Title text</th>
                            <th className="p-1.5">Words</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cloudDiag.productTitles.map((p) => (
                            <tr key={p.clientSku} className="border-t border-white/[0.04]">
                              <td className="p-1.5 font-mono text-indigo-200/90">{p.clientSku}</td>
                              <td className={`p-1.5 ${!p.titleText ? "text-rose-300/90" : ""}`}>
                                {p.titleText || "(empty — add label or metadata name)"}
                              </td>
                              <td className="p-1.5 font-mono text-slate-500">{p.words || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
              {cloudPreview.length > 0 && (
                <div className="max-h-56 overflow-auto rounded-lg border border-white/[0.06] bg-black/20 p-2 text-xs">
                  <table className="w-full text-left text-slate-300">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                        <th className="p-1.5">SKU</th>
                        <th className="p-1.5">Folder</th>
                        <th className="p-1.5">Images</th>
                        <th className="p-1.5">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cloudPreview.map((p) => (
                        <tr key={p.clientSku} className="border-t border-white/[0.04]">
                          <td className="p-1.5 font-mono text-indigo-200">{p.clientSku}</td>
                          <td className="p-1.5 text-slate-400">{p.folderSlug}</td>
                          <td className="p-1.5">{p.imageCount}</td>
                          <td className="p-1.5">{p.score.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {mode === "database" && (
            <div className="space-y-4">
              {!isDatabaseMode ? (
                <div className="space-y-3 text-sm text-slate-400">
                  <p>
                    This workspace is not on{" "}
                    <span className="font-medium text-slate-200">DATABASE</span> integration mode yet
                    (current: {integrationType ?? "none"}).
                  </p>
                  <p className="text-xs leading-relaxed text-slate-500">
                    Your operator configures Postgres/MySQL connection and{" "}
                    <span className="font-mono text-slate-400">tables.products</span> on the server. Then
                    you can sync SKUs here.
                  </p>
                  <Link
                    href="/portal/integration"
                    className="inline-flex text-sm font-medium text-accent underline underline-offset-4"
                  >
                    View integration status
                  </Link>
                </div>
              ) : (
                <>
                  <p className="text-xs leading-relaxed text-slate-500">
                    Runs <span className="font-mono text-slate-400">SELECT sku, name FROM products</span>{" "}
                    (or columns set in <span className="font-mono">productMappingColumns</span>) and upserts
                    into catalog mappings.
                  </p>
                  <Button
                    type="button"
                    disabled={dbSyncBusy}
                    className="gap-2"
                    onClick={() => void syncFromDatabase()}
                  >
                    {dbSyncBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Database className="h-4 w-4" />
                    )}
                    Sync from database
                  </Button>
                  {dbMsg && (
                    <p className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 text-xs text-slate-300">
                      {dbMsg}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {mode === "manual" && (
            <form onSubmit={addMapping} className="space-y-5">
              <p className="text-sm leading-relaxed text-slate-400">
                Enter the stock code and what customers should see. Optional fields power price, stock, and photos in
                chat and the table — use{" "}
                <span className="font-medium text-slate-300">Edit</span> on a row to change an existing product.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="SKU (stock code)" required>
                  <input
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    required
                    placeholder={
                      isJerseyCategory
                        ? "e.g. JERSEY-BR-01"
                        : businessCategory === "shoes"
                          ? "e.g. SHOE-RUN-01"
                          : businessCategory === "restaurant"
                            ? "e.g. MENU-BIRYANI-01"
                            : businessCategory === "cosmetics"
                              ? "e.g. LIP-MATTE-01"
                              : "e.g. PROD-001"
                    }
                    className={inputCls}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Product name"
                  hint="Shown to customers and used to match Cloudinary folders — same idea as the product title."
                >
                  <input
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder={
                      isJerseyCategory
                        ? "e.g. Brazil away jersey 2026"
                        : businessCategory === "shoes"
                          ? "e.g. Mens running shoes 42"
                          : businessCategory === "restaurant"
                            ? "e.g. Chicken biryani full"
                            : businessCategory === "cosmetics"
                              ? "e.g. Matte lipstick coral"
                              : "Product name shown to customers"
                    }
                    className={inputCls}
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Price (BDT)" hint="Numbers only; leave empty if not set.">
                  <input
                    inputMode="decimal"
                    value={priceStr}
                    onChange={(e) => setPriceStr(e.target.value)}
                    placeholder="2499"
                    className={inputCls}
                  />
                </Field>
                <Field
                  label="Fabric / material"
                  hint="e.g. Aeroready mesh, cotton blend — shown to customers when they ask about fabric."
                >
                  <input
                    value={fabricMaterial}
                    onChange={(e) => setFabricMaterial(e.target.value)}
                    placeholder="German polyester, double mesh…"
                    className={inputCls}
                  />
                </Field>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  Sale &amp; countdown
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  Set a higher &quot;regular&quot; compare-at price and a sale window. Inside the window the
                  agent quotes the sale price with the regular price crossed out and a live countdown.
                  Leave compare price empty to disable the offer entirely.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Field label="Compare price (BDT)" hint="The higher 'was' price.">
                    <input
                      inputMode="decimal"
                      value={compareAtPriceStr}
                      onChange={(e) => setCompareAtPriceStr(e.target.value)}
                      placeholder="3499"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Sale starts" hint="Optional. Empty = starts immediately.">
                    <input
                      type="datetime-local"
                      value={saleStartsAtStr}
                      onChange={(e) => setSaleStartsAtStr(e.target.value)}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Sale ends" hint="Optional. Empty = no expiry.">
                    <input
                      type="datetime-local"
                      value={saleEndsAtStr}
                      onChange={(e) => setSaleEndsAtStr(e.target.value)}
                      className={inputCls}
                    />
                  </Field>
                </div>
              </div>
              {isJerseyCategory && (
                <Field
                  label="Kit type"
                  hint="Used for size-chart hints (player = tighter authentic fit, fan = replica) when you do not attach a custom size chart."
                >
                  <select
                    value={jerseyVersion}
                    onChange={(e) => setJerseyVersion(e.target.value as "" | "player" | "fan")}
                    className={inputCls}
                  >
                    <option value="">Not specified</option>
                    <option value="fan">Fan version (replica / standard)</option>
                    <option value="player">Player version (authentic / on-field)</option>
                  </select>
                </Field>
              )}
              <Field
                label="Tags"
                hint="Comma-separated keywords to help customers find this product (e.g. yellow, retro, full sleeve, 2026). These are used for search matching."
              >
                <input
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="yellow, retro, world cup, full sleeve…"
                  className={inputCls}
                />
              </Field>
              <div className="space-y-2">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <span className="label-caps text-slate-400">Stock by {variantSizeLabel.toLowerCase()}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {variantSizeOptions.map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() => addPresetSize(sz)}
                        className="rounded-lg border border-white/[0.1] bg-black/25 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-accent/35 hover:text-white"
                      >
                        + {sz}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  Add a row per size with how many pieces you have. Leave rows empty if you only use total stock below.
                </p>
                <div className="overflow-x-auto rounded-xl border border-white/[0.08] bg-black/20">
                  <table className="w-full min-w-[280px] text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06] text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-2">Size</th>
                        <th className="px-3 py-2">Pieces</th>
                        <th className="w-10 px-1 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {sizeStockRows.map((row) => (
                        <tr key={row.id} className="border-t border-white/[0.04]">
                          <td className="px-2 py-1.5">
                            <input
                              value={row.size}
                              onChange={(e) => updateSizeRow(row.id, "size", e.target.value)}
                              placeholder="M"
                              className={`${inputCls} py-2 text-center font-mono uppercase`}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              inputMode="numeric"
                              value={row.qty}
                              onChange={(e) => updateSizeRow(row.id, "qty", e.target.value)}
                              placeholder="0"
                              className={inputCls}
                            />
                          </td>
                          <td className="px-1 py-1.5 align-middle">
                            <button
                              type="button"
                              onClick={() => removeSizeStockRow(row.id)}
                              className="rounded-lg p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                              aria-label="Remove row"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button type="button" variant="ghost" className="h-8 px-2 text-xs" onClick={addSizeStockRow}>
                  + Add size row
                </Button>
              </div>
              <Field
                label={perSizeStockActive ? "Total stock (sum of sizes)" : "Total stock (pieces)"}
                hint={
                  perSizeStockActive
                    ? "This number is saved as the sum of your size rows for search and checkout."
                    : "Use this when you do not break stock down by size, or leave empty."
                }
              >
                <input
                  inputMode="numeric"
                  value={perSizeStockActive ? String(sizeGridParsed.total) : stockStr}
                  onChange={(e) => setStockStr(e.target.value)}
                  placeholder={perSizeStockActive ? String(sizeGridParsed.total) : "12"}
                  disabled={perSizeStockActive}
                  readOnly={perSizeStockActive}
                  className={`${inputCls} ${perSizeStockActive ? "cursor-not-allowed opacity-80" : ""}`}
                />
              </Field>
              <Field
                label="Photo links"
                hint="Paste one image URL per line (must start with http:// or https://). Your bot and thumbnails use these."
              >
                <textarea
                  value={photoUrlsText}
                  onChange={(e) => setPhotoUrlsText(e.target.value)}
                  rows={4}
                  placeholder={`https://cdn.example.com/photo1.jpg\nhttps://cdn.example.com/photo2.jpg`}
                  className={`${inputCls} font-mono text-xs leading-relaxed`}
                />
              </Field>
              <Field label="Short description" hint="Optional — a sentence shown in catalog replies when configured.">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Premium fabric, official patch…"
                  className={`${inputCls} text-sm leading-relaxed`}
                />
              </Field>

              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-200">Add-ons available for this product</p>
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">
                    {tenantAddOns.length} configured shop-wide
                  </span>
                </div>
                {tenantAddOns.length === 0 ? (
                  <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-slate-400">
                    No shop-wide add-ons yet. Configure them in{" "}
                    <span className="font-medium text-slate-200">Settings → Add-ons</span> first.
                  </p>
                ) : (
                  <>
                    <label className="mb-2 flex items-center gap-2 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        checked={useTenantDefaultAddOns}
                        onChange={(e) => setUseTenantDefaultAddOns(e.target.checked)}
                      />
                      Use shop-wide defaults (all enabled add-ons apply to this product)
                    </label>
                    {!useTenantDefaultAddOns && (
                      <div className="space-y-2">
                        <p className="text-[11px] text-slate-500">
                          Pick which add-ons this specific product accepts. Optionally override the price or mark
                          it FREE just for this SKU.
                        </p>
                        {tenantAddOns.map((a) => {
                          const checked = selectedAddOnIds.includes(a.id);
                          const overridePrice = addOnPriceOverrides[a.id] ?? "";
                          const overrideFree = !!addOnFreeOverrides[a.id];
                          return (
                            <div
                              key={a.id}
                              className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.02] px-2 py-1.5"
                            >
                              <label className="flex flex-1 min-w-0 items-center gap-2 text-xs text-slate-200">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) =>
                                    setSelectedAddOnIds((prev) =>
                                      e.target.checked
                                        ? [...new Set([...prev, a.id])]
                                        : prev.filter((x) => x !== a.id),
                                    )
                                  }
                                />
                                <span className="truncate">{a.label}</span>
                                <span className="shrink-0 text-[10px] text-slate-500">
                                  default: {a.free ? "FREE" : a.priceBdt != null ? `${a.priceBdt} BDT` : "—"}
                                </span>
                              </label>
                              <input
                                type="number"
                                min={0}
                                placeholder="override price"
                                disabled={!checked || overrideFree}
                                value={overrideFree ? "" : overridePrice}
                                onChange={(e) =>
                                  setAddOnPriceOverrides((prev) => ({ ...prev, [a.id]: e.target.value }))
                                }
                                className={`${inputCls} h-8 w-28 text-xs disabled:opacity-50`}
                              />
                              <label className="flex items-center gap-1 text-[10px] text-slate-300">
                                <input
                                  type="checkbox"
                                  disabled={!checked}
                                  checked={overrideFree}
                                  onChange={(e) =>
                                    setAddOnFreeOverrides((prev) => ({ ...prev, [a.id]: e.target.checked }))
                                  }
                                />
                                FREE for this product
                              </label>
                            </div>
                          );
                        })}
                        {selectedAddOnIds.length === 0 && (
                          <p className="text-[11px] text-amber-300/80">
                            None selected — this product will offer NO add-ons.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <button
                  type="button"
                  onClick={() => setManualAdvancedOpen((o) => !o)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium text-slate-300 hover:bg-white/[0.03]"
                >
                  <span>Advanced — extra metadata (JSON)</span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 text-slate-500 transition-transform",
                      manualAdvancedOpen && "rotate-180",
                    )}
                  />
                </button>
                {manualAdvancedOpen && (
                  <div className="border-t border-white/[0.06] px-3 pb-3 pt-1">
                    <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
                      Only if your integration needs extra fields (e.g. <span className="font-mono">variants</span>). This
                      merges with the fields above; simple fields win when both set the same key.
                    </p>
                    <textarea
                      value={advancedJson}
                      onChange={(e) => setAdvancedJson(e.target.value)}
                      rows={8}
                      spellCheck={false}
                      className={`${inputCls} font-mono text-xs leading-relaxed`}
                    />
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={submitting} className="gap-2">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Save product
                </Button>
                {feedback && (
                  <span className={`text-xs ${feedback.startsWith("Saved") ? "text-emerald-400/90" : "text-slate-400"}`}>
                    {feedback}
                  </span>
                )}
              </div>
            </form>
          )}
        </Section>
      </div>
    </div>
  );
}

function OptionCard({
  active,
  onSelect,
  icon,
  title,
  subtitle,
}: {
  active: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "rounded-2xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        active
          ? "border-accent/45 bg-accent/[0.07] shadow-[0_0_0_1px_rgba(99,102,241,0.2)]"
          : "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]",
      )}
    >
      <div className="mb-2">{icon}</div>
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{subtitle}</p>
    </button>
  );
}

const inputCls =
  "w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm font-medium text-slate-100 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30";

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label-caps mb-1.5 block">
        {label}
        {required && <span className="ml-1 text-rose-400">*</span>}
      </span>
      {children}
      {hint ? <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{hint}</p> : null}
    </label>
  );
}

/**
 * Live "On sale — ends in 02:14:33" chip for catalog rows. Reads
 * `compareAtPrice` + `saleStartsAt` + `saleEndsAt` from product metadata.
 * Re-renders every second when there's an active end timestamp so the
 * countdown stays accurate; renders nothing for products without an
 * active offer.
 */
function SaleChip({ meta }: { meta: Record<string, unknown> | null }) {
  const [now, setNow] = useState(() => Date.now());
  // Tick every second when there's an end timestamp; otherwise no interval.
  const endsAtRaw = meta && typeof meta === "object" && !Array.isArray(meta) ? meta.saleEndsAt : null;
  useEffect(() => {
    if (typeof endsAtRaw !== "string" || !endsAtRaw) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endsAtRaw]);

  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const price = typeof m.price === "number" ? m.price : Number(m.price);
  const compare = typeof m.compareAtPrice === "number" ? m.compareAtPrice : Number(m.compareAtPrice);
  if (!Number.isFinite(price) || !Number.isFinite(compare) || compare <= price) return null;

  const startsAt = typeof m.saleStartsAt === "string" ? new Date(m.saleStartsAt) : null;
  const endsAt = typeof m.saleEndsAt === "string" ? new Date(m.saleEndsAt) : null;
  const inWindow =
    (!startsAt || (Number.isFinite(startsAt.getTime()) && startsAt.getTime() <= now)) &&
    (!endsAt || (Number.isFinite(endsAt.getTime()) && endsAt.getTime() > now));
  if (!inWindow) return null;

  let countdown = "";
  if (endsAt && Number.isFinite(endsAt.getTime())) {
    const diff = Math.max(0, endsAt.getTime() - now);
    const sec = Math.floor(diff / 1000);
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = sec % 60;
    if (days >= 1) countdown = `${days}d ${String(hours).padStart(2, "0")}h`;
    else countdown = `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  const savePct = Math.round(((compare - price) / compare) * 100);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
      <span>−{savePct}%</span>
      {countdown && <span className="font-mono text-amber-100/80">{countdown}</span>}
    </span>
  );
}

function CatalogThumb({ imageUrls, alt }: { imageUrls: string[]; alt: string }) {
  const [idx, setIdx] = useState(0);
  const src = imageUrls[idx];
  return (
    <img
      src={src}
      alt={alt}
      className="h-10 w-10 rounded-md border border-white/10 object-cover"
      loading="lazy"
      onError={() => {
        if (idx < imageUrls.length - 1) setIdx((p) => p + 1);
      }}
    />
  );
}
