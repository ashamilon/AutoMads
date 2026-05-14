import pg from "pg";
import mysql from "mysql2/promise";
import type { IntegrationType } from "@prisma/client";
import type { ClientIntegrationAdapter, PushOrderInput, StockDeductionInput } from "../integration.types.js";
import { dbIntegrationConfigSchema, type DbIntegrationConfig } from "../config-schemas.js";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";

const poolCache = new Map<string, pg.Pool | mysql.Pool>();

function cacheKey(tenantId: string, cfg: DbIntegrationConfig): string {
  return `${tenantId}:${cfg.engine}:${cfg.host}:${cfg.port}:${cfg.database}:${cfg.user}`;
}

async function getPgPool(tenantId: string, cfg: DbIntegrationConfig): Promise<pg.Pool> {
  const key = cacheKey(tenantId, cfg);
  let p = poolCache.get(key) as pg.Pool | undefined;
  if (!p) {
    p = new pg.Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    poolCache.set(key, p);
  }
  return p;
}

async function getMysqlPool(tenantId: string, cfg: DbIntegrationConfig): Promise<mysql.Pool> {
  const key = cacheKey(tenantId, cfg);
  let p = poolCache.get(key) as mysql.Pool | undefined;
  if (!p) {
    p = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 5,
    });
    poolCache.set(key, p);
  }
  return p;
}

const defaultOrderCols = {
  name: "customer_name",
  product: "product_name",
  size: "size",
  quantity: "quantity",
  address: "address",
  phone: "phone",
  saasRef: "saas_order_id",
};

function quotePgIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Invalid SQL identifier");
  return `"${name}"`;
}

function quoteMysqlIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Invalid SQL identifier");
  return `\`${name.replace(/`/g, "")}\``;
}

export class DbClientAdapter implements ClientIntegrationAdapter {
  readonly mode: IntegrationType = "DATABASE";

  async pushOrder(tenantId: string, input: PushOrderInput): Promise<{ externalOrderId: string }> {
    const row = await prisma.tenantIntegration.findUnique({ where: { tenantId } });
    if (!row || row.type !== "DATABASE") throw new Error("Tenant DB integration not configured");
    const cfg = dbIntegrationConfigSchema.parse(row.config);
    const table = cfg.tables.orders;
    const cols = { ...defaultOrderCols, ...(cfg.orderColumns ?? {}) };

    const items = Array.isArray(input.structuredData.items) ? input.structuredData.items : [];
    const firstItem = items.length > 0 ? (items[0] as Record<string, unknown> | undefined) : undefined;
    const name = String(input.structuredData.name ?? "");
    const product = String(input.structuredData.product ?? firstItem?.product ?? "");
    const size = String(input.structuredData.size ?? firstItem?.size ?? "");
    const qty = input.structuredData.quantity ?? firstItem?.quantity ?? 1;
    const address = String(input.structuredData.address ?? "");
    const phone = String(input.structuredData.phone ?? "");

    if (cfg.engine === "postgres") {
      const pool = await getPgPool(tenantId, cfg);
      const t = quotePgIdent(table);
      const c = {
        name: quotePgIdent(cols.name),
        product: quotePgIdent(cols.product),
        size: quotePgIdent(cols.size),
        quantity: quotePgIdent(cols.quantity),
        address: quotePgIdent(cols.address),
        phone: quotePgIdent(cols.phone),
        saasRef: quotePgIdent(cols.saasRef),
      };
      const q = `
        INSERT INTO ${t} (${c.name}, ${c.product}, ${c.size}, ${c.quantity}, ${c.address}, ${c.phone}, ${c.saasRef})
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`;
      try {
        const r = await pool.query(q, [name, product, size, qty, address, phone, input.internalOrderId]);
        const id = String((r.rows[0] as { id: string | number }).id);
        return { externalOrderId: id };
      } catch (e) {
        logger.error({ e, tenantId }, "Postgres order insert failed");
        throw e;
      }
    }

    const pool = await getMysqlPool(tenantId, cfg);
    const t = quoteMysqlIdent(table);
    const c = {
      name: quoteMysqlIdent(cols.name),
      product: quoteMysqlIdent(cols.product),
      size: quoteMysqlIdent(cols.size),
      quantity: quoteMysqlIdent(cols.quantity),
      address: quoteMysqlIdent(cols.address),
      phone: quoteMysqlIdent(cols.phone),
      saasRef: quoteMysqlIdent(cols.saasRef),
    };
    const q = `
      INSERT INTO ${t} (${c.name}, ${c.product}, ${c.size}, ${c.quantity}, ${c.address}, ${c.phone}, ${c.saasRef})
      VALUES (?, ?, ?, ?, ?, ?, ?)`;
    const [result] = await pool.query<mysql.ResultSetHeader>(q, [
      name,
      product,
      size,
      qty,
      address,
      phone,
      input.internalOrderId,
    ]);
    return { externalOrderId: String(result.insertId) };
  }

  async deductStock(tenantId: string, input: StockDeductionInput): Promise<void> {
    const row = await prisma.tenantIntegration.findUnique({ where: { tenantId } });
    if (!row || row.type !== "DATABASE") throw new Error("Tenant DB integration not configured");
    const cfg = dbIntegrationConfigSchema.parse(row.config);
    const qty = Math.max(1, Number(input.quantity || 1));
    const productsTable = cfg.tables.products;
    const skuCol = cfg.productMappingColumns?.sku ?? "sku";
    const nameCol = cfg.productMappingColumns?.facebookLabel ?? "name";
    const sku = input.clientSku?.trim();
    const productName = input.productName?.trim();
    if (!sku && !productName) return;

    if (cfg.engine === "postgres") {
      const pool = await getPgPool(tenantId, cfg);
      const t = quotePgIdent(productsTable);
      const stock = quotePgIdent("stock");
      const skuQ = quotePgIdent(skuCol);
      const nameQ = quotePgIdent(nameCol);

      let affected = 0;
      if (sku) {
        const r = await pool.query(
          `UPDATE ${t} SET ${stock} = GREATEST(COALESCE(${stock},0) - $1, 0) WHERE ${skuQ} = $2`,
          [qty, sku],
        );
        affected = r.rowCount ?? 0;
      }
      if (affected === 0 && productName) {
        const r = await pool.query(
          `UPDATE ${t} SET ${stock} = GREATEST(COALESCE(${stock},0) - $1, 0) WHERE ${nameQ} ILIKE $2`,
          [qty, `%${productName}%`],
        );
        affected = r.rowCount ?? 0;
      }

      // Best effort: for the common Sports Nation schema, also decrement size-level JSON stock in ProductVariant.
      if (affected > 0 && sku && input.size?.trim() && productsTable === "Product") {
        const size = input.size.trim().toUpperCase();
        await pool
          .query(
            `
            UPDATE "ProductVariant" pv
            SET sizes = (
              SELECT COALESCE(jsonb_agg(
                CASE
                  WHEN UPPER(COALESCE(elem->>'size','')) = $3
                  THEN jsonb_set(
                    elem,
                    '{stock}',
                    to_jsonb(GREATEST(COALESCE((elem->>'stock')::int,0) - $1, 0))
                  )
                  ELSE elem
                END
              ), '[]'::jsonb)::text
              FROM jsonb_array_elements(
                CASE WHEN pv.sizes IS NULL OR pv.sizes = '' THEN '[]'::jsonb ELSE pv.sizes::jsonb END
              ) elem
            )
            FROM "Product" p
            WHERE p.id = pv."productId" AND p.sku = $2
            `,
            [qty, sku, size],
          )
          .catch((e) => logger.warn({ e, tenantId, sku, size }, "Variant stock JSON update skipped"));
      }
      return;
    }

    const pool = await getMysqlPool(tenantId, cfg);
    const t = quoteMysqlIdent(productsTable);
    const stock = quoteMysqlIdent("stock");
    const skuQ = quoteMysqlIdent(skuCol);
    const nameQ = quoteMysqlIdent(nameCol);
    let affected = 0;
    if (sku) {
      const [r] = await pool.query<mysql.ResultSetHeader>(
        `UPDATE ${t} SET ${stock} = GREATEST(COALESCE(${stock},0) - ?, 0) WHERE ${skuQ} = ?`,
        [qty, sku],
      );
      affected = r.affectedRows;
    }
    if (affected === 0 && productName) {
      await pool.query<mysql.ResultSetHeader>(
        `UPDATE ${t} SET ${stock} = GREATEST(COALESCE(${stock},0) - ?, 0) WHERE ${nameQ} LIKE ?`,
        [qty, `%${productName}%`],
      );
    }
  }
}
