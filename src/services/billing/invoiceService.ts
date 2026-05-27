/**
 * Subscription invoice PDF service — billing plane.
 *
 * The full PDFKit rendering (logo, line items, QR, brand colors) is
 * delivered in task 8.2. This module exposes the public surface task 8.1
 * depends on so the SSLCommerz subscription adapter can render and persist
 * a PDF immediately on `payment.success`.
 *
 * Contract:
 *   - `generateSubscriptionInvoicePdf(invoiceId)` writes a PDF to
 *     `public/invoices/subscription/<invoiceId>.pdf`, persists the public
 *     URL on `Invoice.pdfPath`, and returns that URL.
 *   - Wraps the existing PDF stack (`pdfkit`) — no new physical columns,
 *     no new gateway-specific code paths (R11.4, R14.6).
 *
 * Errors propagate to the caller. The webhook treats PDF generation as a
 * best-effort side effect, so any failure is logged but does NOT poison
 * the webhook response.
 */

import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { prisma } from "../../db/prisma.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

const SUBSCRIPTION_INVOICE_DIR = path.join(process.cwd(), "public", "invoices", "subscription");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function publicUrlFor(filename: string): string {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  return `${base}/invoices/subscription/${filename}`;
}

function formatBdt(amount: unknown): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  const fixed = n.toFixed(2);
  const [whole, decimal] = fixed.split(".");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimal}`;
}

/**
 * Render and persist a subscription invoice PDF for the given invoice id.
 *
 * Returns the public URL stored on `Invoice.pdfPath`. Idempotent — calling
 * twice for the same invoice overwrites the file and re-stores the path,
 * so notification replays remain consistent.
 */
export async function generateSubscriptionInvoicePdf(invoiceId: string): Promise<string> {
  if (!invoiceId) {
    throw new Error("invoiceId is required");
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { tenant: true, subscription: { include: { plan: true } } },
  });
  if (!invoice) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }

  ensureDir(SUBSCRIPTION_INVOICE_DIR);
  const filename = `${invoice.id}.pdf`;
  const filePath = path.join(SUBSCRIPTION_INVOICE_DIR, filename);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const stream = fs.createWriteStream(filePath);
    stream.on("finish", () => resolve());
    stream.on("error", (err) => reject(err));
    doc.on("error", (err) => reject(err));
    doc.pipe(stream);

    const planName = invoice.subscription?.plan?.displayName ?? "Subscription";
    const tenantName = invoice.tenant?.name ?? "Subscriber";
    const periodStart = invoice.periodStart.toISOString().slice(0, 10);
    const periodEnd = invoice.periodEnd.toISOString().slice(0, 10);

    doc.fontSize(20).text("Commerce_OS Subscription Invoice", { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#475569").text(`Invoice #${invoice.id}`);
    doc.text(`Issued: ${invoice.createdAt.toISOString().slice(0, 10)}`);
    doc.moveDown();
    doc.fillColor("#0f172a").fontSize(12).text(`Billed to: ${tenantName}`);
    if (invoice.tenant?.email) doc.text(invoice.tenant.email);
    doc.moveDown();
    doc.text(`Plan: ${planName}`);
    doc.text(`Period: ${periodStart} → ${periodEnd}`);
    doc.text(`Status: ${invoice.status}`);
    doc.moveDown();
    doc.fontSize(14).text(`Total: BDT ${formatBdt(invoice.amountBdt)}`, { align: "right" });

    if (invoice.sslcommerzTranId) {
      doc.moveDown(2);
      doc
        .fontSize(9)
        .fillColor("#64748b")
        .text(`Transaction: ${invoice.sslcommerzTranId}`);
    }

    doc.end();
  });

  const publicUrl = publicUrlFor(filename);

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { pdfPath: publicUrl },
  });

  logger.info(
    {
      event: "subscription_invoice_pdf_generated",
      invoiceId,
      pdfPath: publicUrl,
    },
    "subscription_invoice_pdf_generated",
  );

  return publicUrl;
}
