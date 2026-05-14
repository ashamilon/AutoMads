import { Prisma } from "@prisma/client";
import pg from "pg";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { prisma } from "../db/prisma.js";
import { dbIntegrationConfigSchema, type DbIntegrationConfig } from "../integrations/config-schemas.js";
import { logger } from "../utils/logger.js";

const MAX_ROWS = 2000;

function quotePgIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Invalid SQL identifier");
  return `"${name.replace(/"/g, "")}"`;
}

function quoteMysqlIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Invalid SQL identifier");
  return `\`${name.replace(/`/g, "")}\``;
}

function defaultProductCols(cfg: DbIntegrationConfig): { sku: string; facebookLabel: string } {
  return cfg.productMappingColumns ?? { sku: "sku", facebookLabel: "name" };
}

export async function syncProductMappingsFromClientDatabase(tenantId: string): Promise<{ upserted: number }> {
  const row = await prisma.tenantIntegration.findUnique({ where: { tenantId } });
  if (!row || row.type !== "DATABASE") {
    throw new Error("integration_not_database");
  }
  const cfg = dbIntegrationConfigSchema.parse(row.config);
  const cols = defaultProductCols(cfg);
  const table = cfg.tables.products;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error("invalid_products_table");
  }

  type Pair = { sku: string; label: string | null };
  let pairs: Pair[] = [];

  if (cfg.engine === "postgres") {
    const pool = new pg.Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      max: 2,
    });
    try {
      const t = quotePgIdent(table);
      const cSku = quotePgIdent(cols.sku);
      const cLabel = quotePgIdent(cols.facebookLabel);
      const q = `SELECT ${cSku} AS sku, ${cLabel} AS lbl FROM ${t} LIMIT $1`;
      const r = await pool.query<{ sku: unknown; lbl: unknown }>(q, [MAX_ROWS]);
      pairs = r.rows.map((x) => ({
        sku: String(x.sku ?? "").trim(),
        label: x.lbl == null ? null : String(x.lbl).trim() || null,
      }));
    } finally {
      await pool.end();
    }
  } else {
    const pool = await mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 2,
    });
    try {
      const t = quoteMysqlIdent(table);
      const cSku = quoteMysqlIdent(cols.sku);
      const cLabel = quoteMysqlIdent(cols.facebookLabel);
      const q = `SELECT ${cSku} AS sku, ${cLabel} AS lbl FROM ${t} LIMIT ?`;
      const [rows] = await pool.query<RowDataPacket[]>(q, [MAX_ROWS]);
      pairs = rows.map((x) => ({
        sku: String(x.sku ?? "").trim(),
        label: x.lbl == null ? null : String(x.lbl).trim() || null,
      }));
    } finally {
      await pool.end();
    }
  }

  const filtered = pairs.filter((p) => p.sku.length > 0);
  if (filtered.length === 0) {
    logger.warn({ tenantId }, "catalog DB sync: no rows returned");
    return { upserted: 0 };
  }

  let upserted = 0;
  const chunkSize = 80;
  for (let i = 0; i < filtered.length; i += chunkSize) {
    const chunk = filtered.slice(i, i + chunkSize);
    await prisma.$transaction(
      chunk.map((p) =>
        prisma.productMapping.upsert({
          where: { tenantId_clientSku: { tenantId, clientSku: p.sku } },
          create: {
            tenantId,
            clientSku: p.sku,
            facebookLabel: p.label ?? undefined,
            metadata: Prisma.JsonNull,
          },
          update: {
            facebookLabel: p.label === null ? null : p.label ?? undefined,
          },
        }),
      ),
    );
    upserted += chunk.length;
  }

  return { upserted };
}
