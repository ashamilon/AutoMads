import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type { TenantSettings } from "../types/tenant-settings.js";
import type { StructuredOrder } from "../types/order-extraction.js";
import { config } from "../config/index.js";

type InvoiceInput = {
  orderId: string;
  amountBdt: number;
  currency: string;
  paymentMethod: string;
  structured: StructuredOrder;
  settings: TenantSettings;
  /** Set to true once the advance/total has actually been received. */
  paid?: boolean;
};

type RGB = { r: number; g: number; b: number };

const DEFAULT_BRAND = "#0f766e";

function resolveLocalAssetPath(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const u = new URL(publicUrl);
    const base = new URL(config.publicBaseUrl.replace(/\/$/, ""));
    if (u.host !== base.host) return null;
    const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const full = path.join(process.cwd(), "public", rel);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

function normalizeHex(hex: string | undefined): string {
  if (!hex) return DEFAULT_BRAND;
  const trimmed = hex.trim();
  const value = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return DEFAULT_BRAND;
  return value.toLowerCase();
}

function hexToRgb(hex: string): RGB {
  const v = normalizeHex(hex).slice(1);
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

function mixWithWhite(hex: string, weight: number): string {
  const { r, g, b } = hexToRgb(hex);
  const w = Math.max(0, Math.min(1, weight));
  const mr = Math.round(r + (255 - r) * w);
  const mg = Math.round(g + (255 - g) * w);
  const mb = Math.round(b + (255 - b) * w);
  return `#${[mr, mg, mb].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function readableOnDark(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.65 ? "#0f172a" : "#ffffff";
}

function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  const fixed = value.toFixed(2);
  const [whole, decimal] = fixed.split(".");
  const withSep = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withSep}.${decimal}`;
}

function buildInvoiceNumber(orderId: string, prefix?: string): string {
  const cleanPrefix = (prefix ?? "INV").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6) || "INV";
  const tail = orderId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-8);
  return `${cleanPrefix}-${tail}`;
}

async function buildQrPng(payload: string, brand: string): Promise<Buffer | null> {
  try {
    return await QRCode.toBuffer(payload, {
      errorCorrectionLevel: "M",
      type: "png",
      margin: 1,
      width: 220,
      color: { dark: normalizeHex(brand), light: "#ffffff" },
    });
  } catch {
    return null;
  }
}

export async function generateInvoicePdf(
  input: InvoiceInput,
): Promise<{ filePath: string; publicUrl: string }> {
  const outDir = path.join(process.cwd(), "public", "invoices");
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `invoice-${input.orderId.slice(0, 12)}-${Date.now()}.pdf`;
  const filePath = path.join(outDir, fileName);

  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const bp = input.settings.businessProfile ?? {};
  const businessName = bp.name?.trim() || "Your Business";
  const logoPath = resolveLocalAssetPath(bp.logoUrl);
  const brand = normalizeHex(bp.brandColor);
  const brandSoft = mixWithWhite(brand, 0.86);
  const brandHair = mixWithWhite(brand, 0.55);
  const brandText = readableOnDark(brand);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 40;
  const left = margin;
  const right = pageWidth - margin;
  const contentWidth = right - left;

  const invoiceNumber = buildInvoiceNumber(input.orderId, bp.invoicePrefix);
  const issuedAt = new Date();

  // ---------- Watermark (very faint, diagonal business name) ----------
  doc.save();
  doc.fillColor(brand).opacity(0.05);
  doc.font("Helvetica-Bold").fontSize(120);
  doc.rotate(-28, { origin: [pageWidth / 2, pageHeight / 2] });
  doc.text(businessName.toUpperCase().slice(0, 14), 0, pageHeight / 2 - 60, {
    width: pageWidth,
    align: "center",
  });
  doc.restore();

  // ---------- Top header band ----------
  const headerHeight = 130;
  doc.save();
  doc.rect(0, 0, pageWidth, headerHeight).fill(brand);
  doc.restore();
  // accent stripe
  doc.save();
  doc.rect(0, headerHeight, pageWidth, 6).fill(mixWithWhite(brand, 0.35));
  doc.restore();

  // Logo
  if (logoPath) {
    try {
      doc.image(logoPath, left, 28, { fit: [74, 74] });
    } catch {
      /* ignore bad image */
    }
  }

  const brandX = logoPath ? left + 92 : left;
  doc
    .fillColor(brandText)
    .font("Helvetica-Bold")
    .fontSize(22)
    .text(businessName, brandX, 32, { width: 320 });

  doc.font("Helvetica").fontSize(9.5).fillColor(brandText).opacity(0.92);
  let metaY = 60;
  if (bp.website?.trim()) {
    doc.text(bp.website.trim(), brandX, metaY, { width: 320 });
    metaY += 13;
  }
  if (bp.address?.trim()) {
    doc.text(bp.address.trim(), brandX, metaY, { width: 320 });
    metaY += 13;
  }
  const contactBits: string[] = [];
  if (bp.phone?.trim()) contactBits.push(bp.phone.trim());
  if (bp.email?.trim()) contactBits.push(bp.email.trim());
  if (contactBits.length > 0) {
    doc.text(contactBits.join("  •  "), brandX, metaY, { width: 320 });
  }
  doc.opacity(1);

  // INVOICE block (right)
  const invBlockX = right - 200;
  doc
    .fillColor(brandText)
    .font("Helvetica-Bold")
    .fontSize(30)
    .text("INVOICE", invBlockX, 30, { width: 200, align: "right" });
  doc.font("Helvetica").fontSize(10).text(`No. ${invoiceNumber}`, invBlockX, 68, {
    width: 200,
    align: "right",
  });
  doc.text(`Date: ${issuedAt.toLocaleDateString()}`, invBlockX, 82, {
    width: 200,
    align: "right",
  });
  doc.text(`Time: ${issuedAt.toLocaleTimeString()}`, invBlockX, 96, {
    width: 200,
    align: "right",
  });

  // ---------- Bill To & Invoice Details cards ----------
  const cardsY = headerHeight + 28;
  const cardHeight = 110;
  const cardGap = 16;
  const cardWidth = (contentWidth - cardGap) / 2;

  // Bill To card
  const billCardX = left;
  doc.save();
  doc.roundedRect(billCardX, cardsY, cardWidth, cardHeight, 8).fill(brandSoft);
  doc.restore();
  doc.save();
  doc.roundedRect(billCardX, cardsY, 4, cardHeight, 2).fill(brand);
  doc.restore();

  doc
    .fillColor(brand)
    .font("Helvetica-Bold")
    .fontSize(9)
    .text("BILL TO", billCardX + 16, cardsY + 12, { characterSpacing: 1.5 });

  const s = input.structured;
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13);
  doc.text(String(s.name ?? "Customer"), billCardX + 16, cardsY + 28, {
    width: cardWidth - 32,
  });
  doc.font("Helvetica").fontSize(10).fillColor("#1f2937");
  doc.text(`Phone: ${String(s.phone ?? "-")}`, billCardX + 16, cardsY + 50, {
    width: cardWidth - 32,
  });
  doc.text(`Address: ${String(s.address ?? "-")}`, billCardX + 16, cardsY + 66, {
    width: cardWidth - 32,
  });

  // Invoice Details card
  const infoCardX = left + cardWidth + cardGap;
  doc.save();
  doc.roundedRect(infoCardX, cardsY, cardWidth, cardHeight, 8).fill(brandSoft);
  doc.restore();
  doc.save();
  doc.roundedRect(infoCardX, cardsY, 4, cardHeight, 2).fill(brand);
  doc.restore();

  doc
    .fillColor(brand)
    .font("Helvetica-Bold")
    .fontSize(9)
    .text("INVOICE DETAILS", infoCardX + 16, cardsY + 12, { characterSpacing: 1.5 });

  const detailRows: Array<[string, string]> = [
    ["Order ID", input.orderId],
    ["Invoice", invoiceNumber],
    ["Payment", input.paymentMethod || "-"],
    ["Status", input.paid ? "PAID" : "PENDING"],
  ];
  doc.font("Helvetica").fontSize(10).fillColor("#1f2937");
  detailRows.forEach(([k, v], idx) => {
    const rowY = cardsY + 30 + idx * 16;
    doc.font("Helvetica").fillColor("#475569").text(k, infoCardX + 16, rowY, {
      width: 90,
      lineBreak: false,
    });
    // Truncate long values (e.g. cuid order ids) so they never wrap into the next detail row.
    const displayValue = String(v);
    const valueWidth = cardWidth - 124;
    doc
      .font("Helvetica-Bold")
      .fillColor(k === "Status" ? (input.paid ? "#15803d" : "#b45309") : "#0f172a")
      .text(displayValue, infoCardX + 110, rowY, {
        width: valueWidth,
        align: "right",
        lineBreak: false,
        ellipsis: true,
      });
  });

  // ---------- Itemized table ----------
  const tableTop = cardsY + cardHeight + 26;
  const tableHeaderH = 30;
  // Right-anchored column geometry so AMOUNT/UNIT never collide regardless of page width.
  // Layout: ITEM (flex) | SIZE 56 | QTY 44 | UNIT 84 | AMOUNT 100  (totals match contentWidth)
  const colPad = 14;
  const sizeColW = 56;
  const qtyColW = 44;
  const unitColW = 84;
  const amountColW = 100;
  const colAmountRight = right - colPad;
  const colUnitRight = colAmountRight - amountColW - 8;
  const colQtyRight = colUnitRight - unitColW - 6;
  const colSizeRight = colQtyRight - qtyColW - 6;
  const colItem = left + colPad;
  const itemColW = colSizeRight - sizeColW - colItem - 6;
  // x-positions where each right-aligned column STARTS:
  const colSizeX = colSizeRight - sizeColW;
  const colQtyX = colQtyRight - qtyColW;
  const colUnitX = colUnitRight - unitColW;
  const colTotalX = colAmountRight - amountColW;

  doc.save();
  doc.roundedRect(left, tableTop, contentWidth, tableHeaderH, 6).fill(brand);
  doc.restore();
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(10)
    .text("ITEM", colItem, tableTop + 10, { width: itemColW, lineBreak: false });
  doc.text("SIZE", colSizeX, tableTop + 10, { width: sizeColW, align: "center", lineBreak: false });
  doc.text("QTY", colQtyX, tableTop + 10, { width: qtyColW, align: "center", lineBreak: false });
  doc.text("UNIT", colUnitX, tableTop + 10, { width: unitColW, align: "right", lineBreak: false });
  doc.text("AMOUNT", colTotalX, tableTop + 10, {
    width: amountColW,
    align: "right",
    lineBreak: false,
  });

  const itemsArr = Array.isArray(s.items) ? s.items.filter((x) => String(x?.product ?? "").trim()) : [];
  type Row = {
    product: string;
    addOnLines: string[];
    size: string;
    qty: number;
    unit: number;
    total: number;
  };
  const rows: Row[] = [];

  if (itemsArr.length > 0) {
    let allocated = 0;
    for (let i = 0; i < itemsArr.length; i++) {
      const it = itemsArr[i]!;
      const qty = Math.max(1, Number(it.quantity ?? 1) || 1);
      const unitBase = typeof it.unitPriceBdt === "number" ? it.unitPriceBdt : 0;
      const unitAddon = typeof it.unitAddOnBdt === "number" ? it.unitAddOnBdt : 0;
      const unitTotal = unitBase + unitAddon;
      const lineTotal = unitTotal > 0 ? unitTotal * qty : 0;
      allocated += lineTotal;
      const addOnLines = formatAddOnLines(it.addOns);
      rows.push({
        product: String(it.product ?? "Product"),
        addOnLines,
        size: String(it.size ?? s.size ?? "-"),
        qty,
        // UNIT column shows the base product price; add-ons are listed separately so the customer
        // can see what they actually paid for each option.
        unit:
          unitBase > 0
            ? unitBase
            : input.amountBdt / Math.max(1, itemsArr.reduce((n, x) => n + Math.max(1, Number(x?.quantity ?? 1) || 1), 0)),
        total: lineTotal > 0 ? lineTotal : 0,
      });
    }
    if (allocated === 0) {
      const totalQty = rows.reduce((n, r) => n + r.qty, 0) || 1;
      const perUnit = input.amountBdt / totalQty;
      for (const r of rows) {
        r.unit = perUnit;
        r.total = perUnit * r.qty;
      }
    }
  } else {
    const quantity = Number(s.quantity ?? 1) > 0 ? Number(s.quantity ?? 1) : 1;
    const subtotalVal = input.amountBdt;
    const unitAmount = subtotalVal / quantity;
    rows.push({
      product: String(s.product ?? "Product"),
      addOnLines: [],
      size: String(s.size ?? "-"),
      qty: quantity,
      unit: unitAmount,
      total: subtotalVal,
    });
  }
  const subtotal = input.amountBdt;

  let cursorY = tableTop + tableHeaderH;
  const baseRowH = 36;
  const addonLineH = 13;
  rows.forEach((row, i) => {
    const rowH = baseRowH + (row.addOnLines.length > 0 ? row.addOnLines.length * addonLineH + 4 : 0);
    const zebra = i % 2 === 0 ? "#ffffff" : "#f8fafc";
    doc.save();
    doc.rect(left, cursorY, contentWidth, rowH).fill(zebra);
    doc.restore();

    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(10.5);
    doc.text(row.product, colItem, cursorY + 9, { width: itemColW, lineBreak: false, ellipsis: true });
    doc.font("Helvetica").fontSize(9.5).fillColor("#64748b");
    doc.text("Sold by " + businessName, colItem, cursorY + 22, {
      width: itemColW,
      lineBreak: false,
      ellipsis: true,
    });

    if (row.addOnLines.length > 0) {
      let lineY = cursorY + baseRowH;
      doc.font("Helvetica").fontSize(9).fillColor("#475569");
      for (const addOn of row.addOnLines) {
        doc.text(addOn, colItem + 6, lineY, { width: itemColW - 6, lineBreak: false, ellipsis: true });
        lineY += addonLineH;
      }
    }

    doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
    doc.text(row.size, colSizeX, cursorY + 13, { width: sizeColW, align: "center", lineBreak: false });
    doc.text(String(row.qty), colQtyX, cursorY + 13, { width: qtyColW, align: "center", lineBreak: false });
    doc.text(formatCurrency(row.unit), colUnitX, cursorY + 13, {
      width: unitColW,
      align: "right",
      lineBreak: false,
    });
    doc
      .font("Helvetica-Bold")
      .text(formatCurrency(row.total), colTotalX, cursorY + 13, {
        width: amountColW,
        align: "right",
        lineBreak: false,
      });

    cursorY += rowH;
  });

  // table outline
  doc.save();
  doc
    .roundedRect(left, tableTop, contentWidth, cursorY - tableTop, 6)
    .lineWidth(0.8)
    .stroke(brandHair);
  doc.restore();

  // ---------- Totals & QR side-by-side ----------
  const totalsY = cursorY + 22;
  const totalsW = 260;
  const totalsX = right - totalsW;

  const deliveryCharge =
    typeof input.settings.deliveryChargeBdt === "number" ? input.settings.deliveryChargeBdt : 0;
  const grandTotal = subtotal + deliveryCharge;

  // Advance is honoured in this priority order:
  //   1. structuredData.advance.totalBdt (per-product breakdown stored at confirm time)
  //   2. settings.advancePaymentBdt (legacy fixed)
  //   3. structuredData.advancePaymentBdt (one-shot override)
  // When `paid=true` (post-payment-pipeline), we treat the whole grand total as paid.
  const sdAdvanceObj =
    s && (s as Record<string, unknown>)["advance"] && typeof (s as Record<string, unknown>)["advance"] === "object"
      ? ((s as Record<string, unknown>)["advance"] as Record<string, unknown>)
      : null;
  const sdAdvanceTotal =
    sdAdvanceObj && typeof sdAdvanceObj["totalBdt"] === "number"
      ? (sdAdvanceObj["totalBdt"] as number)
      : null;
  const legacyOverride =
    s && typeof (s as Record<string, unknown>)["advancePaymentBdt"] === "number"
      ? ((s as Record<string, unknown>)["advancePaymentBdt"] as number)
      : null;
  const advanceFromTenant =
    typeof input.settings.advancePaymentBdt === "number" ? input.settings.advancePaymentBdt : null;

  const baseAdvance =
    sdAdvanceTotal ?? legacyOverride ?? advanceFromTenant ?? null;

  const advancePaid =
    baseAdvance != null
      ? Math.min(baseAdvance, grandTotal)
      : input.paid
        ? grandTotal
        : 0;
  const due = Math.max(grandTotal - advancePaid, 0);

  // QR code (left of totals)
  const qrPayload = JSON.stringify({
    invoice: invoiceNumber,
    orderId: input.orderId,
    amount: grandTotal,
    currency: input.currency,
    business: businessName,
  });
  const qrBuffer = await buildQrPng(qrPayload, brand);
  if (qrBuffer) {
    doc.save();
    doc.roundedRect(left, totalsY, 110, 130, 8).lineWidth(0.8).stroke(brandHair);
    doc.restore();
    try {
      doc.image(qrBuffer, left + 10, totalsY + 10, { fit: [90, 90] });
    } catch {
      /* ignore */
    }
    doc.fillColor("#475569").font("Helvetica").fontSize(8);
    doc.text("Scan to verify", left + 10, totalsY + 104, {
      width: 90,
      align: "center",
    });
  }

  // Totals card
  const totalsRowH = 22;
  const totalsCardH = totalsRowH * 4 + 28;
  doc.save();
  doc.roundedRect(totalsX, totalsY, totalsW, totalsCardH, 8).fill(brandSoft);
  doc.restore();

  const writeTotal = (
    label: string,
    value: number,
    rowIndex: number,
    options: { emphasis?: boolean; positiveColor?: string } = {},
  ) => {
    const rowY = totalsY + 14 + rowIndex * totalsRowH;
    doc.font(options.emphasis ? "Helvetica-Bold" : "Helvetica").fontSize(10.5);
    doc.fillColor(options.emphasis ? brand : "#475569");
    doc.text(label, totalsX + 16, rowY, { width: 130 });
    doc.fillColor(options.emphasis ? brand : options.positiveColor ?? "#0f172a");
    doc.text(`${formatCurrency(value)} ${input.currency.toUpperCase()}`, totalsX + 16, rowY, {
      width: totalsW - 32,
      align: "right",
    });
  };

  writeTotal("Subtotal", subtotal, 0);
  writeTotal("Delivery", deliveryCharge, 1);
  writeTotal("Advance Paid", advancePaid, 2, { positiveColor: "#15803d" });
  // separator
  doc.save();
  doc
    .moveTo(totalsX + 16, totalsY + 14 + 3 * totalsRowH - 4)
    .lineTo(totalsX + totalsW - 16, totalsY + 14 + 3 * totalsRowH - 4)
    .lineWidth(0.6)
    .dash(2, { space: 2 })
    .stroke(brandHair);
  doc.restore();
  doc.undash();
  writeTotal(due > 0 ? "Balance Due" : "Total", due > 0 ? due : grandTotal, 3, { emphasis: true });

  // ---------- PAID stamp ----------
  // Place under the QR code (left margin) so it never overlaps the totals column on the right.
  if (input.paid) {
    const stampW = 140;
    const stampH = 60;
    doc.save();
    const stampX = left + 14;
    const stampY = totalsY + 138; // below the QR card (which ends ~138 pt below totalsY)
    doc.translate(stampX, stampY).rotate(-14);
    doc.lineWidth(2.5).strokeColor("#15803d").roundedRect(0, 0, stampW, stampH, 6).stroke();
    doc.lineWidth(1.2).strokeColor("#15803d").roundedRect(4, 4, stampW - 8, stampH - 8, 4).stroke();
    doc
      .fillColor("#15803d")
      .font("Helvetica-Bold")
      .fontSize(28)
      .text("PAID", 0, 14, { width: stampW, align: "center", lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("#15803d").text(
      issuedAt.toLocaleDateString(),
      0,
      44,
      { width: stampW, align: "center", lineBreak: false },
    );
    doc.restore();
  }

  // ---------- Footer ----------
  const footerY = pageHeight - 78;
  doc.save();
  doc
    .moveTo(left, footerY)
    .lineTo(right, footerY)
    .lineWidth(0.6)
    .strokeColor(brandHair)
    .stroke();
  doc.restore();

  doc.fillColor("#475569").font("Helvetica-Bold").fontSize(10);
  doc.text("Thank you for your purchase!", left, footerY + 12, {
    width: contentWidth,
    align: "center",
  });

  doc.font("Helvetica").fontSize(9).fillColor("#64748b");
  if (bp.invoiceFooter?.trim()) {
    doc.text(bp.invoiceFooter.trim(), left, footerY + 28, {
      width: contentWidth,
      align: "center",
    });
  } else {
    doc.text("This is a system generated invoice and does not require a signature.", left, footerY + 28, {
      width: contentWidth,
      align: "center",
    });
  }

  // brand badge bottom-left, page indicator bottom-right
  doc.fillColor(brand).font("Helvetica-Bold").fontSize(8);
  doc.text(businessName.toUpperCase(), left, pageHeight - 24, {
    width: contentWidth / 2,
    align: "left",
  });
  doc.fillColor("#94a3b8").font("Helvetica").fontSize(8);
  doc.text(`Invoice ${invoiceNumber}  •  Page 1 of 1`, left + contentWidth / 2, pageHeight - 24, {
    width: contentWidth / 2,
    align: "right",
  });

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });

  const publicBase = config.publicBaseUrl.replace(/\/$/, "");
  return {
    filePath,
    publicUrl: `${publicBase}/invoices/${encodeURIComponent(fileName)}`,
  };
}


/**
 * Map a previously-generated invoice publicUrl back to its local file path on disk.
 * Returns null when the URL is from a different host (e.g. Cloudinary) or the file is missing.
 */
export function resolveInvoiceFilePathFromUrl(publicUrl: string | null | undefined): string | null {
  return resolveLocalAssetPath(publicUrl ?? undefined);
}


/**
 * Render add-ons on a cart line as separate text lines below the product name.
 * Accepts the rich shape (object with id/label/priceBdt/value) used by the agent loop, and
 * also tolerates legacy strings.
 */
function formatAddOnLines(addOns: unknown): string[] {
  if (!Array.isArray(addOns)) return [];
  const out: string[] = [];
  for (const a of addOns) {
    if (!a) continue;
    if (typeof a === "string") {
      const t = a.trim();
      if (t) out.push(`+ ${t}`);
      continue;
    }
    if (typeof a !== "object" || Array.isArray(a)) continue;
    const r = a as Record<string, unknown>;
    const label = String(r["label"] ?? r["id"] ?? "Add-on").trim();
    if (!label) continue;
    const value = String(r["value"] ?? "").trim();
    const priceRaw = r["priceBdt"];
    const isFreeFlag = r["free"] === true;
    let pricePart = "";
    if (typeof priceRaw === "number" && Number.isFinite(priceRaw)) {
      pricePart = priceRaw === 0 || isFreeFlag ? " — FREE" : ` (+${priceRaw} BDT)`;
    } else if (typeof priceRaw === "string" && priceRaw.trim() !== "") {
      const n = Number(priceRaw.replace(/,/g, ""));
      if (Number.isFinite(n)) pricePart = n === 0 ? " — FREE" : ` (+${n} BDT)`;
    } else if (isFreeFlag) {
      pricePart = " — FREE";
    }
    const valuePart = value ? `: "${value}"` : "";
    out.push(`+ ${label}${valuePart}${pricePart}`);
  }
  return out;
}
