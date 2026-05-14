export type ParsedCatalogRow = {
  clientSku: string;
  facebookLabel?: string;
  /** All non-SKU / non-label columns from the CSV (prices, stock, variants, etc.) */
  metadata?: Record<string, unknown>;
};

/** Split one CSV line respecting double-quoted fields */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur.trim().replace(/^"|"$/g, ""));
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur.trim().replace(/^"|"$/g, ""));
  return out;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

function columnIndex(header: string[], aliases: string[]): number {
  for (const a of aliases) {
    const i = header.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse a simple product catalog CSV.
 * Header row must include `client_sku` or `sku` (case-insensitive).
 * Optional: `facebook_label`, `label`, or `product_name`.
 */
export function parseProductCatalogCsv(text: string): ParsedCatalogRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error("CSV needs a header row and at least one data row.");
  }
  const header = splitCsvLine(lines[0]).map(normalizeHeader);
  const skuIdx = columnIndex(header, ["client_sku", "sku"]);
  const labelIdx = columnIndex(header, [
    "facebook_label",
    "label",
    "facebooklabel",
    "product_name",
    "productname",
    "name",
  ]);
  if (skuIdx < 0) {
    throw new Error('Missing SKU column. Use header "client_sku" or "sku".');
  }
  const rows: ParsedCatalogRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const sku = cells[skuIdx]?.trim();
    if (!sku) continue;
    const label = labelIdx >= 0 ? cells[labelIdx]?.trim() : undefined;
    const metadata: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c++) {
      if (c === skuIdx || c === labelIdx) continue;
      const key = header[c];
      if (!key) continue;
      const raw = cells[c]?.trim();
      if (raw === undefined || raw === "") continue;
      if (/^(true|false)$/i.test(raw)) {
        metadata[key] = raw.toLowerCase() === "true";
      } else if (raw !== "" && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) {
        metadata[key] = raw.includes(".") ? Number(raw) : Number.parseInt(raw, 10);
      } else {
        metadata[key] = raw;
      }
    }
    rows.push({
      clientSku: sku,
      facebookLabel: label || undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    });
  }
  if (rows.length === 0) {
    throw new Error("No data rows with a non-empty SKU were found.");
  }
  return rows;
}
