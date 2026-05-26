import { z } from "zod";

/**
 * Domain-agnostic image content classifier output.
 *
 * Used by `classifyImageContent()` in `src/llm/ollamaService.ts` to decide
 * whether a customer's photo is something the catalog matcher should even
 * look at. Replaces the old jersey-only "not_jersey" gate so the framework
 * works for any tenant catalog (jerseys today, shoes / electronics / sarees
 * tomorrow) without asserting jersey-specific assumptions up front.
 *
 * Categories:
 *   - "product"            — the photo clearly shows a saleable item
 *                             (clothing, accessory, electronics, footwear,
 *                             home good — anything a shop might list).
 *   - "payment_screenshot" — bKash/Nagad/SSLCommerz/bank receipt / SMS proof.
 *                             Caller should route to the manual-payment flow.
 *   - "chat_screenshot"    — screenshot of a Messenger / WhatsApp / SMS
 *                             conversation that ISN'T a payment proof. Often
 *                             a customer sharing a friend's order or a
 *                             previous conversation snippet.
 *   - "person_or_selfie"   — selfie / portrait / group photo with no garment
 *                             being modelled for sale. (A model wearing the
 *                             tenant's product still counts as "product".)
 *   - "document"           — ID card, NID, business doc, invoice, paper.
 *   - "random_object"      — pet, food, scenery, meme — clearly not a product.
 *   - "unclear"            — too dark / blurry / tiny crop to classify.
 *
 * `isProductLikely` is the single boolean the gate reads. Set to `true` only
 * when the image is plausibly a saleable item the catalog might know about.
 *
 * `shortDescription` is a 5-15 word neutral description of what's actually
 * in the photo. Useful both as logger context AND as caption enrichment for
 * the catalog matcher when the customer didn't send any text.
 */
export const imageContentSchema = z.object({
  contentType: z.enum([
    "product",
    "payment_screenshot",
    "chat_screenshot",
    "person_or_selfie",
    "document",
    "random_object",
    "unclear",
  ]),
  isProductLikely: z.boolean().default(false),
  confidence: z.enum(["high", "medium", "low"]).default("low"),
  shortDescription: z.string().max(160).default(""),
  /** Optional broad category hint: "clothing" / "footwear" / "accessory" / "electronics" / etc. */
  productCategory: z.string().max(40).optional(),
});

export type ImageContent = z.infer<typeof imageContentSchema>;
