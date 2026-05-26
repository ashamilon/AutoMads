import { z } from "zod";

/** Vision model output: what team/club/country (if any) the jersey photo shows. */
export const jerseyPhotoIdentifySchema = z.object({
  kind: z.enum(["national_team", "club", "ambiguous", "not_jersey", "unknown"]),
  /** English names — country (e.g. Spain) or club (e.g. Real Madrid); duplicates ok, max usefulness */
  primaryNames: z.array(z.string()).max(10).default([]),
  /** Short Banglish/English note for logs or future use */
  notes: z.string().max(400).optional(),
  /**
   * How sure the vision pass is. Used by the catalog matcher: only `high` lets
   * the agent auto-add a SKU to the cart; `medium` is shown as a clarifying
   * prompt; `low` falls back to "please send a clearer photo".
   *
   * Defaulted to `low` when the model omits it, so callers never see undefined.
   */
  confidence: z.enum(["high", "medium", "low"]).default("low"),
  /** What the vision pass actually saw on the shirt — used to debug mistakes. */
  detectedFeatures: z
    .object({
      hasCrest: z.boolean().optional(),
      crestDescription: z.string().max(120).optional(),
      dominantColors: z.array(z.string()).max(6).optional(),
      sponsor: z.string().max(80).optional(),
      kitVariant: z.enum(["home", "away", "third", "retro", "goalkeeper", "unknown"]).optional(),
    })
    .optional(),
});

export type JerseyPhotoIdentify = z.infer<typeof jerseyPhotoIdentifySchema>;
