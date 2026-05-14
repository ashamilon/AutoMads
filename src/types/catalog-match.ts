import { z } from "zod";

/** LLM output: pick exactly one SKU from the provided catalog, or none. */
export const catalogProductMatchSchema = z.object({
  clientSku: z.string(),
});

export type CatalogProductMatch = z.infer<typeof catalogProductMatchSchema>;
