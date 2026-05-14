import { z } from "zod";

/** Vision model output: what team/club/country (if any) the jersey photo shows. */
export const jerseyPhotoIdentifySchema = z.object({
  kind: z.enum(["national_team", "club", "ambiguous", "not_jersey", "unknown"]),
  /** English names — country (e.g. Spain) or club (e.g. Real Madrid); duplicates ok, max usefulness */
  primaryNames: z.array(z.string()).max(10).default([]),
  /** Short Banglish/English note for logs or future use */
  notes: z.string().max(400).optional(),
});

export type JerseyPhotoIdentify = z.infer<typeof jerseyPhotoIdentifySchema>;
