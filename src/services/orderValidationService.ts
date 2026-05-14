import type { StructuredOrder } from "../types/order-extraction.js";

/** Validation layer before any client DB/API write — AI output alone never touches clients */
export function validateOrderForClientSync(data: StructuredOrder): { ok: true } | { ok: false; reason: string } {
  const hasSingle = Boolean(data.product?.trim());
  const items = Array.isArray(data.items) ? data.items : [];
  const hasItems = items.some((x) => String(x.product ?? "").trim());
  if (!hasSingle && !hasItems) return { ok: false, reason: "product_required" };
  if (!data.phone?.trim()) return { ok: false, reason: "phone_required" };
  if (!data.address?.trim()) return { ok: false, reason: "address_required" };
  if (!data.name?.trim()) return { ok: false, reason: "name_required" };

  if (hasItems) {
    for (const it of items) {
      if (String(it.product ?? "").trim() && !String(it.size ?? "").trim()) {
        return { ok: false, reason: "size_required" };
      }
    }
  } else if (hasSingle && !String(data.size ?? "").trim()) {
    return { ok: false, reason: "size_required" };
  }

  return { ok: true };
}
