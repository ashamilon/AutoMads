import type { TenantSettings } from "../types/tenant-settings.js";
import { pickTeamEmoji } from "./catalogReplyService.js";

export type BanglishCartLine = {
  sku: string;
  product: string;
  quantity: number;
  size?: string;
  unitPriceBdt?: number;
  addOns?: Array<{ id: string; label: string; priceBdt: number; value?: string }>;
};

function isNameNumberAddon(a: { id?: string; label?: string }): boolean {
  const id = String(a?.id ?? "")
    .toLowerCase()
    .trim()
    .replace(/^["']|["']$/g, "");
  if (id === "name-number") return true;
  const lbl = String(a?.label ?? "").trim();
  if (!lbl) return false;
  if (/\bofficial\s*font\b/i.test(lbl)) return true;
  return (
    /\bnam\s*[+＋\-]?\s*number\b|\bname\s*[+＋\-]?\s*number\b/i.test(lbl) ||
    (/name/i.test(lbl) && /number|num|nambar|namber/i.test(lbl))
  );
}

function isPatchStyleAddon(a: { label?: string }): boolean {
  if (isNameNumberAddon(a)) return false;
  const l = String(a.label ?? "").toLowerCase();
  return /patch|badge|emblem|logo\s*patch|sleeve/i.test(l);
}

function coercePrice(n: unknown): number {
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  if (typeof n === "string" && n.trim()) {
    const x = Number(n.replace(/,/g, ""));
    return Number.isFinite(x) && x >= 0 ? x : 0;
  }
  return 0;
}

function deliveryBdt(settings: TenantSettings): number {
  return typeof settings.deliveryChargeBdt === "number" ? settings.deliveryChargeBdt : 0;
}

function nameNumberAddonFromSettings(settings: TenantSettings): { label: string; priceBdt: number } | null {
  const active = (settings.addOns ?? []).filter((a) => a && a.enabled !== false);
  const row =
    active.find((x) =>
      isNameNumberAddon({ id: String(x?.id ?? ""), label: String(x?.label ?? "") }),
    ) ?? null;
  if (!row) return null;
  const priceBdt = coercePrice(row.priceBdt);
  return { label: row.label.trim(), priceBdt };
}

function patchAddonFromSettings(settings: TenantSettings): { label: string; priceBdt: number } | null {
  const active = (settings.addOns ?? []).filter((a) => a && a.enabled !== false);
  for (const row of active) {
    const label = String(row.label ?? "").trim();
    if (!label) continue;
    if (isPatchStyleAddon({ label })) return { label, priceBdt: coercePrice(row.priceBdt) };
  }
  return null;
}

function lineJerseySubtotal(it: BanglishCartLine): number {
  const unit = it.unitPriceBdt ?? 0;
  return unit * it.quantity;
}

function lineNameNumberSubtotal(it: BanglishCartLine): number {
  let s = 0;
  for (const a of it.addOns ?? []) {
    if (isNameNumberAddon(a) && String(a.value ?? "").trim()) s += coercePrice(a.priceBdt) * it.quantity;
  }
  return s;
}

function linePatchSubtotal(it: BanglishCartLine): number {
  let s = 0;
  for (const a of it.addOns ?? []) {
    if (isPatchStyleAddon(a)) s += coercePrice(a.priceBdt) * it.quantity;
  }
  return s;
}

function cartSubtotalAllLines(cart: BanglishCartLine[]): number {
  let t = 0;
  for (const it of cart) {
    t += lineJerseySubtotal(it) + lineNameNumberSubtotal(it) + linePatchSubtotal(it);
  }
  return t;
}

function hasFilledNameNumber(it: BanglishCartLine): boolean {
  return (it.addOns ?? []).some((a) => isNameNumberAddon(a) && String(a.value ?? "").trim());
}

function hasPatchAddonOnLine(it: BanglishCartLine): boolean {
  return (it.addOns ?? []).some((a) => isPatchStyleAddon(a));
}

function formatMoney(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(0);
}

function cartNeedsNameNumberUpsell(cart: BanglishCartLine[], settings: TenantSettings): boolean {
  const nn = nameNumberAddonFromSettings(settings);
  if (!nn || nn.priceBdt <= 0) return false;
  return cart.some((it) => !hasFilledNameNumber(it));
}

function cartNeedsPatchUpsell(cart: BanglishCartLine[], settings: TenantSettings): boolean {
  const p = patchAddonFromSettings(settings);
  if (!p) return false;
  return cart.some((it) => !hasPatchAddonOnLine(it));
}

function buildOrderOptionsBlock(
  cart: BanglishCartLine[],
  settings: TenantSettings,
  opts: { mode: "after_product" | "after_name_number" | "after_cart_update"; skipNameNumberBlock?: boolean },
): string {
  const sub: string[] = [];
  const showNn =
    !opts.skipNameNumberBlock &&
    (opts.mode === "after_product" || opts.mode === "after_cart_update") &&
    cartNeedsNameNumberUpsell(cart, settings);
  const nn = nameNumberAddonFromSettings(settings);
  if (showNn && nn) {
    sub.push(
      [
        "🏷️ Jersey e Name & Number niben official font e?",
        "✍️ Je kono Name/Number dewa jabe",
        `💰 Price: ${formatMoney(nn.priceBdt)} BDT`,
      ].join("\n"),
    );
  }
  const showPatch =
    cartNeedsPatchUpsell(cart, settings) &&
    (opts.mode === "after_name_number" || opts.mode === "after_product" || opts.mode === "after_cart_update");
  const patch = patchAddonFromSettings(settings);
  if (showPatch && patch) {
    sub.push(["🪡 Official Patch niben?", `💰 Price: ${formatMoney(patch.priceBdt)} BDT`].join("\n"));
  }
  if (sub.length === 0) return "";
  return ["📌 Order Options", ...sub].join("\n\n");
}

function buildCheckoutFooter(): string {
  return ["ba onno kuno jersey??", "", "📍 Noyto apnar:", "👤 Name", "📱 Mobile", "🚚 Courier Address din", "", "✔️ Order confirm hoye jabe"].join(
    "\n\n",
  );
}

function formatJerseyBlocks(cart: BanglishCartLine[], settings: TenantSettings): string {
  const blocks: string[] = [];
  for (const it of cart) {
    const flag = pickTeamEmoji(it.product);
    const size = String(it.size ?? "").trim() || "—";
    const nnAddon = (it.addOns ?? []).find((a) => isNameNumberAddon(a) && String(a.value ?? "").trim());
    const nnPrice = lineNameNumberSubtotal(it);
    const patchPrice = linePatchSubtotal(it);
    const lines: string[] = [`${flag} ${it.product}`, "", `📏 Size: ${size}`];
    if (nnAddon?.value?.trim()) {
      lines.push("", `👕 Name: ${nnAddon.value.trim()}`);
    }
    lines.push("", `💰 Jersey: ${formatMoney(lineJerseySubtotal(it))} BDT`);
    if (nnPrice > 0) {
      lines.push("", `💰 Name & number : ${formatMoney(nnPrice)} BDT`);
    }
    if (patchPrice > 0) {
      lines.push("", `💰 Official Patches: ${formatMoney(patchPrice)} BDT`);
    }
    blocks.push(lines.join("\n"));
  }
  const del = deliveryBdt(settings);
  const sub = cartSubtotalAllLines(cart);
  const tail: string[] = [];
  tail.push("", `🚚 Delivery: ${formatMoney(del)} BDT`, "", `মোট: ${formatMoney(sub + del)} BDT`);
  return [...blocks, tail.join("\n")].join("\n\n");
}

/** Prompt 1 — product added (single featured line; totals from full cart). */
export function buildBanglishProductAddedReply(args: {
  featured: BanglishCartLine;
  fullCart: BanglishCartLine[];
  settings: TenantSettings;
}): string {
  const { featured, fullCart, settings } = args;
  const flag = pickTeamEmoji(featured.product);
  const del = deliveryBdt(settings);
  const sub = cartSubtotalAllLines(fullCart);
  const total = sub + del;
  const head = ["ঠিক আছে 😊", "", `${flag} ${featured.product}  add kore diyechi`].join("\n\n");
  const body = [
    "",
    `💰 Jersey: ${formatMoney(lineJerseySubtotal(featured))} BDT`,
    "",
    `🚚 Delivery: ${formatMoney(del)} BDT`,
    "",
    `মোট: ${formatMoney(total)} BDT`,
  ].join("\n");
  const opts = buildOrderOptionsBlock(fullCart, settings, { mode: "after_product" });
  const foot = buildCheckoutFooter();
  return [head, body, opts, foot].filter((s) => String(s).trim()).join("\n\n");
}

/** Prompt 2 — name & number added. */
export function buildBanglishNameNumberAddedReply(args: {
  customNameNumber: string;
  line: BanglishCartLine;
  fullCart: BanglishCartLine[];
  settings: TenantSettings;
}): string {
  const { customNameNumber, line, fullCart, settings } = args;
  const flag = pickTeamEmoji(line.product);
  const del = deliveryBdt(settings);
  const sub = cartSubtotalAllLines(fullCart);
  const total = sub + del;
  const nnPrice = lineNameNumberSubtotal(line);
  const head = ["ঠিক আছে 👌", "", `👕 ${customNameNumber} নাম্বারটা add করে দিলাম 😊`, "", `${flag} ${line.product}`].join(
    "\n\n",
  );
  const body = [
    "",
    `💰 Jersey: ${formatMoney(lineJerseySubtotal(line))} BDT`,
    "",
    `💰 ${customNameNumber}: ${formatMoney(nnPrice)} BDT`,
    "",
    `🚚 Delivery: ${formatMoney(del)} BDT`,
    "",
    `মোট: ${formatMoney(total)} BDT`,
  ].join("\n");
  const opts = buildOrderOptionsBlock(fullCart, settings, { mode: "after_name_number", skipNameNumberBlock: true });
  const foot = buildCheckoutFooter();
  return [head, body, opts, foot].filter((s) => String(s).trim()).join("\n\n");
}

/** Prompt 3 — cart / size update (all lines). */
export function buildBanglishCartLinesUpdateReply(args: { fullCart: BanglishCartLine[]; settings: TenantSettings }): string {
  const { fullCart, settings } = args;
  if (fullCart.length === 0) return "Ekhono kono jersey select kora nai 🙂 Kon jersey lagbe bolun.";
  const opener = "Perfect 😊";
  const mid = formatJerseyBlocks(fullCart, settings);
  const opts = buildOrderOptionsBlock(fullCart, settings, { mode: "after_cart_update" });
  const foot = buildCheckoutFooter();
  return [opener, mid, opts, foot].filter((s) => String(s).trim()).join("\n\n");
}

/** Cart summary for "show cart" — same visual system as size update. */
export function buildBanglishCartShowReply(args: { fullCart: BanglishCartLine[]; settings: TenantSettings }): string {
  return buildBanglishCartLinesUpdateReply(args);
}
