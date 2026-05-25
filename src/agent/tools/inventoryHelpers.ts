/**
 * Shared inventory metadata helpers.
 *
 * `add_to_cart` (cart.ts) and `check_inventory` (inventory.ts) both need to read stock numbers
 * out of the `productMapping.metadata` JSON blob the same way — otherwise a customer could see
 * "in stock" from `check_inventory` and then get a "stock=0" rejection from `add_to_cart` for the
 * same sku/size. Lifting the readers here keeps them in lock-step.
 *
 * Two exports:
 *   - `coerceNumber(v)`   — accept number-or-string-or-anything and return a finite number or
 *                           `undefined`. Strips thousand separators on strings.
 *   - `sizeStockFromMeta(meta, size)`
 *                         — read variant-level (per-size) stock out of common metadata shapes
 *                           (`sizeStocks` map / `stockBySize` map / `variants` array). Returns
 *                           `undefined` when the catalog row carries no per-size data; callers
 *                           should fall back to the aggregate `meta.stock` field.
 */

export function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Read per-size stock from common metadata shapes (sizeStocks map, variants[] array,
 * stockBySize map). Returns undefined when the catalog row doesn't carry per-size data —
 * caller should fall back to aggregate `stock`.
 */
export function sizeStockFromMeta(
  meta: Record<string, unknown>,
  size: string,
): number | undefined {
  const upper = size.toUpperCase();
  for (const key of ["sizeStocks", "size_stocks", "stockBySize", "stock_by_size"]) {
    const map = meta[key];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      const v =
        (map as Record<string, unknown>)[upper] ??
        (map as Record<string, unknown>)[size] ??
        (map as Record<string, unknown>)[size.toLowerCase()];
      const n = coerceNumber(v);
      if (n != null) return n;
    }
  }
  const variants = meta["variants"];
  if (Array.isArray(variants)) {
    for (const v of variants) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const r = v as Record<string, unknown>;
      if (String(r["size"] ?? "").toUpperCase() === upper) {
        const n = coerceNumber(r["stock"]);
        if (n != null) return n;
      }
    }
  }
  return undefined;
}
/**
 * Narrow `productMapping.metadata` (Prisma `Json`) to a flat object so callers can index
 * keys like `meta["stock"]` without redoing the type guard. Returns an empty object on
 * `null` / arrays / scalars — the calling code then sees "no metadata" and falls back to
 * its catalog defaults rather than throwing.
 */
export function asMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}
