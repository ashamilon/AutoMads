import { z } from "zod";

/** Models often return JSON null; Zod .optional() does not accept null — coerce first */
const optionalString = z.preprocess(
  (v) => (v === null ? undefined : v),
  z.string().optional(),
);

const optionalQuantity = z.preprocess(
  (v) => (v === null ? undefined : v),
  z.union([z.number(), z.string()]).optional(),
);

const structuredItemSchema = z.object({
  product: optionalString,
  size: optionalString,
  quantity: optionalQuantity,
  addOns: z.array(z.string()).optional(),
  unitPriceBdt: z.preprocess((v) => (v === null ? undefined : v), z.number().optional()),
  unitAddOnBdt: z.preprocess((v) => (v === null ? undefined : v), z.number().optional()),
});

/** LLM output shape — payment/delivery never decided by model */
export const structuredOrderSchema = z.object({
  name: optionalString,
  product: optionalString,
  size: optionalString,
  quantity: optionalQuantity,
  /** Optional multi-item cart support in one order. */
  items: z.array(structuredItemSchema).max(20).optional(),
  address: optionalString,
  phone: optionalString,
});

export type StructuredOrder = z.infer<typeof structuredOrderSchema>;

export function parseStructuredOrder(raw: unknown): StructuredOrder {
  return structuredOrderSchema.parse(raw);
}
