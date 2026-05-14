import { z } from "zod";

export const apiIntegrationConfigSchema = z.object({
  baseUrl: z.string().url(),
  headers: z.record(z.string()).optional(),
  paths: z.object({
    products: z.string().default("/products"),
    createOrder: z.string().default("/orders"),
    updateStock: z.string().optional(),
  }),
});

export const dbIntegrationConfigSchema = z.object({
  engine: z.enum(["postgres", "mysql"]),
  host: z.string(),
  port: z.number().int().positive(),
  user: z.string(),
  password: z.string(),
  database: z.string(),
  ssl: z.boolean().optional(),
  tables: z.object({
    products: z.string(),
    orders: z.string(),
    inventory: z.string().optional(),
  }),
  orderColumns: z
    .object({
      name: z.string().optional(),
      product: z.string().optional(),
      size: z.string().optional(),
      quantity: z.string().optional(),
      address: z.string().optional(),
      phone: z.string().optional(),
      saasRef: z.string().optional(),
    })
    .optional(),
  /** Column names in tables.products used to fill ProductMapping (SKU → label). Defaults: sku, name */
  productMappingColumns: z
    .object({
      sku: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
      facebookLabel: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    })
    .optional(),
});

export const webhookIntegrationConfigSchema = z.object({
  outboundUrl: z.string().url(),
  outboundSecret: z.string().optional(),
  inboundSecret: z.string().optional(),
});

export type ApiIntegrationConfig = z.infer<typeof apiIntegrationConfigSchema>;
export type DbIntegrationConfig = z.infer<typeof dbIntegrationConfigSchema>;
export type WebhookIntegrationConfig = z.infer<typeof webhookIntegrationConfigSchema>;
