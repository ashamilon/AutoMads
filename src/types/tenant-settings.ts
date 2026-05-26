import { z } from "zod";

export const tenantSettingsSchema = z
  .object({
    defaultOrderAmountBdt: z.number().positive().optional(),
    /** Delivery charge shown to customers during checkout/order confirmation. */
    deliveryChargeBdt: z.number().min(0).optional(),
    /**
     * Delivery time presets the agent quotes when a customer asks "kobe pabo?"
     * / "delivery koto din?". Two presets:
     *   - `normal`     — plain orders with no add-ons (e.g. 1-3 days).
     *   - `customised` — orders containing at least one add-on (name+number,
     *     custom font, etc.). Typically slower (e.g. 5-7 days).
     *
     * The agent picks `customised` when ANY cart line has add-ons (matches
     * the same `hasCustomizedItems` signal the courier auto-booking uses);
     * otherwise it picks `normal`.
     *
     * `minDays` and `maxDays` are integers in DAYS. Either can be omitted to
     * quote a single number ("3 din").
     */
    deliveryTimes: z
      .object({
        normal: z
          .object({
            minDays: z.number().int().min(0).max(120).optional(),
            maxDays: z.number().int().min(0).max(120).optional(),
          })
          .optional(),
        customised: z
          .object({
            minDays: z.number().int().min(0).max(120).optional(),
            maxDays: z.number().int().min(0).max(120).optional(),
          })
          .optional(),
      })
      .optional(),
    /**
     * Legacy fixed advance amount. Treated as `advancePolicy: { mode: "fixed", fixedAmountBdt }`
     * when `advancePolicy` is not set. Kept for backward compatibility — new tenants should set
     * `advancePolicy` instead.
     */
    advancePaymentBdt: z.number().min(0).optional(),
    /**
     * Structured advance policy. When present, takes precedence over `advancePaymentBdt`.
     *
     * - mode="fixed": one amount per order, regardless of cart size.
     * - mode="per_product":
     *   - perProductBdt          → multiplied by quantity for plain (no-add-on) cart lines
     *   - perCustomisedProductBdt → multiplied by quantity for lines that have any add-ons
     *   Both can be set simultaneously; a mixed cart pays both.
     */
    advancePolicy: z
      .union([
        z.object({
          mode: z.literal("fixed"),
          fixedAmountBdt: z.number().min(0),
        }),
        z
          .object({
            mode: z.literal("per_product"),
            perProductBdt: z.number().min(0).optional(),
            perCustomisedProductBdt: z.number().min(0).optional(),
          })
          .refine(
            (v) => v.perProductBdt != null || v.perCustomisedProductBdt != null,
            { message: "Set at least one of perProductBdt / perCustomisedProductBdt." },
          ),
      ])
      .optional(),
    sslcommerz: z
      .object({
        storeId: z.string(),
        storePassword: z.string(),
        /** true = securepay.sslcommerz.com, false/undefined = sandbox. */
        isLive: z.boolean().optional(),
      })
      .optional(),
    /**
     * AamarPay gateway. Single API, IPN webhook, no OAuth. Credentials come
     * from the tenant's AamarPay merchant dashboard.
     */
    aamarpay: z
      .object({
        storeId: z.string().min(1),
        signatureKey: z.string().min(1),
        /** true = secure.aamarpay.com, false/undefined = sandbox.aamarpay.com. */
        isLive: z.boolean().optional(),
      })
      .optional(),
    /**
     * bKash Tokenized Checkout (merchant gateway). Credentials issued by bKash
     * after the merchant agreement + KYC. Distinct sandbox/live credentials.
     * The integration polls `query-payment` after the customer redirects back —
     * bKash does NOT push an IPN automatically.
     */
    bkashCheckout: z
      .object({
        appKey: z.string().min(1),
        appSecret: z.string().min(1),
        username: z.string().min(1),
        password: z.string().min(1),
        /** true = tokenized.pay.bka.sh, false/undefined = tokenized.sandbox.bka.sh. */
        isLive: z.boolean().optional(),
      })
      .optional(),
    pathao: z
      .object({
        baseUrl: z.string().url().optional(),
        clientId: z.string(),
        clientSecret: z.string(),
        username: z.string(),
        password: z.string(),
        storeId: z.number().int(),
        /** true = api-hermes.pathao.com, false/undefined = courier-api-sandbox.pathao.com. Ignored if baseUrl set. */
        isLive: z.boolean().optional(),
        /** "automatic" = book immediately after payment, "manual" = admin books from dashboard, "smart" = auto for plain orders, manual for customized */
        bookingMode: z.enum(["automatic", "manual", "smart"]).optional(),
      })
      .optional(),
    /**
     * Steadfast (Packzy) courier integration. Single base URL for sandbox + live —
     * the tenant uses different credentials per env. No OAuth: every request
     * carries `Api-Key` + `Secret-Key` headers. The tenant's status webhook
     * (configured during onboarding with Steadfast support) posts to
     * `/webhooks/steadfast/status`. We also fall back to polling
     * `/api/v1/status_by_cid/<consignmentId>` for tracking.
     */
    steadfast: z
      .object({
        apiKey: z.string().min(1),
        secretKey: z.string().min(1),
        /** "automatic" = book immediately after payment, "manual" = admin books from dashboard, "smart" = auto for plain, manual for customized. Same shape as pathao.bookingMode. */
        bookingMode: z.enum(["automatic", "manual", "smart"]).optional(),
      })
      .optional(),
    /**
     * Selects which courier is the "primary" for this tenant. Both can be
     * configured; the agent uses this when auto-booking.
     */
    courierProvider: z.enum(["pathao", "steadfast"]).optional(),
    /**
     * Tenant-managed library of size charts. Gemma / the deterministic responder picks
     * one by matching the customer's message against `label` + `aliases`. First chart
     * with `isDefault: true` is used when nothing matches.
     */
    sizeCharts: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().min(1).max(120),
          aliases: z.array(z.string().min(1).max(60)).max(20).optional(),
          notes: z.string().max(500).optional(),
          isDefault: z.boolean().optional(),
          rows: z
            .array(
              z.object({
                size: z.string().min(1).max(20),
                chest: z.union([z.string(), z.number()]).optional(),
                length: z.union([z.string(), z.number()]).optional(),
                sleeve: z.union([z.string(), z.number()]).optional(),
                shoulder: z.union([z.string(), z.number()]).optional(),
                waist: z.union([z.string(), z.number()]).optional(),
                hip: z.union([z.string(), z.number()]).optional(),
                extra: z.string().max(120).optional(),
              }),
            )
            .min(1)
            .max(20),
        }),
      )
      .max(40)
      .optional(),
    /** Manual mobile-financial-service payment alternatives (personal send-money, admin-verified). */
    manualPayment: z
      .object({
        enabled: z.boolean().optional(),
        bkash: z
          .object({
            number: z.string().optional(),
            /** "personal" | "agent" | "merchant" — purely informational for the customer. */
            accountType: z.string().optional(),
          })
          .optional(),
        nagad: z
          .object({
            number: z.string().optional(),
            accountType: z.string().optional(),
          })
          .optional(),
        /** Optional extra instructions (e.g. "use reference: order id"). */
        instructions: z.string().optional(),
      })
      .optional(),
    /** Generic product add-ons (name/number/font/logo/etc) with optional pricing. */
    addOns: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().min(1).max(120),
          priceBdt: z.number().min(0).optional(),
          description: z.string().max(300).optional(),
          enabled: z.boolean().optional(),
          free: z.boolean().optional(),
          /**
           * Match aliases the AI agent uses to find this add-on.
           * Example: ["official font", "premium font", "heat press"] for an "Official Font" add-on.
           * Comma- or pipe-separated entries are also tolerated; the portal UI splits on commas.
           */
          aliases: z.array(z.string().min(1).max(60)).max(20).optional(),
          /** Optional grouping like "customization", "premium", "shipping". Used for filtering by the agent. */
          category: z.string().max(40).optional(),
        }),
      )
      .max(80)
      .optional(),
    /** Telegram admin alert channel for manual payment verification workflow. */
    telegram: z
      .object({
        enabled: z.boolean().optional(),
        /** Bot token from BotFather */
        botToken: z.string().optional(),
        /** Private chat id or group/supergroup id */
        chatId: z.string().optional(),
      })
      .optional(),
    /** Recent manual payment workflow logs for admin panel visibility. */
    manualPaymentAdminLogs: z
      .array(
        z.object({
          at: z.string(),
          level: z.enum(["info", "warn", "error"]).optional(),
          event: z.string().max(80),
          message: z.string().max(500).optional(),
          orderId: z.string().optional(),
          psid: z.string().optional(),
          rail: z.string().optional(),
          reference: z.string().optional(),
        }),
      )
      .max(200)
      .optional(),
    /**
     * Phase 1 agent loop opt-in. When enabled=true, inbound text turns are routed
     * through the LangGraph agent (src/agent) instead of the legacy switchboard.
     * Image turns and tenants without this flag continue on the legacy path.
     */
    agent: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    /** Tenant business profile used for invoice branding. */
    businessProfile: z
      .object({
        name: z.string().max(200).optional(),
        logoUrl: z.string().url().optional(),
        phone: z.string().max(60).optional(),
        email: z.string().max(120).optional(),
        address: z.string().max(500).optional(),
        invoiceFooter: z.string().max(500).optional(),
        /** Hex color (e.g. "#0f766e") used as accent on the invoice. */
        brandColor: z
          .string()
          .regex(/^#?[0-9a-fA-F]{6}$/, "brandColor must be a 6 digit hex color")
          .optional(),
        /** Optional website / social handle shown under business name. */
        website: z.string().max(120).optional(),
        /** Optional invoice number prefix, e.g. "INV", "ORD". */
        invoicePrefix: z.string().max(8).optional(),
      })
      .optional(),
    /** Persona / voice the bot uses when replying. See BotPersona. */
    botPersona: z
      .object({
        name: z.string().optional(),
        /**
         * Job title / role the bot uses when introducing itself ("Moderator of
         * this Page", "Customer support", etc.). Defaults to "Moderator of this
         * Page" when undefined — see `resolvePersonaIdentity`.
         */
        role: z.string().optional(),
        tone: z.string().optional(),
        examples: z
          .array(z.object({ user: z.string(), assistant: z.string() }))
          .optional(),
      })
      .optional(),
    /**
     * Per-tenant Cloudinary Admin API credentials for catalog image sync
     * (`POST /product-mappings/sync-cloudinary-images`). When cloudName, apiKey,
     * and apiSecret are all non-empty, these override server `CLOUDINARY_*` env.
     */
    cloudinary: z
      .object({
        cloudName: z.string().max(200).optional(),
        apiKey: z.string().max(200).optional(),
        apiSecret: z.string().max(200).optional(),
        /** Default folder prefix for this tenant (optional). */
        catalogAssetPrefix: z.string().max(500).optional(),
      })
      .optional(),
  })
  .passthrough();

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

function sanitizeTenantSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const source = raw as Record<string, unknown>;
  const next: Record<string, unknown> = { ...source };
  const charts = source["sizeCharts"];
  if (!Array.isArray(charts)) return next;

  const cleanedCharts = charts
    .map((c) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) return null;
      const chart = c as Record<string, unknown>;
      const rows = Array.isArray(chart["rows"]) ? chart["rows"] : [];
      const cleanedRows = rows
        .filter((r) => r && typeof r === "object" && !Array.isArray(r))
        .filter((r) => {
          const size = String((r as Record<string, unknown>)["size"] ?? "").trim();
          return size.length > 0;
        })
        .map((r) => {
          const row = r as Record<string, unknown>;
          return { ...row, size: String(row["size"]).trim() };
        });
      if (cleanedRows.length === 0) return null;
      return { ...chart, rows: cleanedRows };
    })
    .filter(Boolean);

  next["sizeCharts"] = cleanedCharts;
  return next;
}

export function parseTenantSettings(raw: unknown): TenantSettings {
  if (raw == null) return {};
  const parsed = tenantSettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const sanitized = sanitizeTenantSettings(raw);
  const parsedSanitized = tenantSettingsSchema.safeParse(sanitized);
  if (parsedSanitized.success) return parsedSanitized.data;
  return {};
}
