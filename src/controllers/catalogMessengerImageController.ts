import type { Request, Response } from "express";
import axios from "axios";
import { prisma } from "../db/prisma.js";
import { extractCatalogAssets } from "../services/catalogReplyService.js";
import { verifyCatalogImageToken } from "../utils/catalogMessengerImageSign.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const SECRET = (config.catalogImageProxySecret || config.encryptionKey || "").trim();

/**
 * Signed, read-only relay of a product catalog image row for Messenger attachments.
 * Facebook fetches attachment URLs server-side — some CDNs block Meta; relaying avoids that.
 */
export async function serveMessengerCatalogImage(req: Request, res: Response): Promise<void> {
  if (!SECRET) {
    res.status(503).json({ error: "proxy_not_configured" });
    return;
  }

  const slug = String(req.query.slug ?? "").trim();
  const sku = String(req.query.sku ?? "").trim();
  const idx = Number(req.query.i ?? 0);
  const tok = typeof req.query.t === "string" ? req.query.t : undefined;

  if (!slug || !sku || !Number.isFinite(idx) || idx < 0 || idx > 10) {
    res.status(400).json({ error: "bad_query" });
    return;
  }

  if (!verifyCatalogImageToken(SECRET, slug, sku, idx, tok)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug } }).catch(() => null);
  if (!tenant?.isActive) {
    res.status(404).end();
    return;
  }

  const row = await prisma.productMapping
    .findFirst({
      where: { tenantId: tenant.id, clientSku: sku },
    })
    .catch(() => null);
  if (!row) {
    res.status(404).end();
    return;
  }

  const urls = extractCatalogAssets(row).imageUrls;
  const upstreamUrl = urls[idx];
  if (!upstreamUrl) {
    res.status(404).end();
    return;
  }

  try {
    const r = await axios.get<ArrayBuffer>(upstreamUrl, {
      responseType: "arraybuffer",
      timeout: 25_000,
      maxContentLength: 6 * 1024 * 1024,
      maxBodyLength: 6 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { Accept: "image/*,*/*" },
    });
    const buf = Buffer.from(r.data);
    if (buf.length < 64) {
      res.status(502).end();
      return;
    }
    const ct = r.headers["content-type"];
    const safeCt =
      typeof ct === "string" && /^image\/(webp|jpeg|jpg|png|gif)$/i.test(ct) ? ct : "image/jpeg";
    res.setHeader("Content-Type", safeCt);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (e) {
    logger.warn({ e: String(e), sku: sku.slice(0, 40) }, "catalog image relay failed");
    res.status(502).end();
  }
}
