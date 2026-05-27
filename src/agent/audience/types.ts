/**
 * Audience profile types.
 *
 * Two layers exist:
 *
 *   1. **Tenant-level** profile — set during onboarding (and editable via
 *      Settings → Audience). Lives on `tenant.settings.audienceProfile`. Drives
 *      the AI's *default* address style and informs the prompt about who the
 *      shop sells to so recommendations land in the right register.
 *
 *   2. **Conversation-level** override — derived once per conversation from
 *      the customer's first messages. Persisted on
 *      `MessengerConversation.preferences.addressStyle` so subsequent turns
 *      stay consistent and the agent doesn't whiplash mid-chat.
 *
 * Both layers feed into `Reasoning_Context.audienceProfile`. The prompt
 * builder injects the resolved address style, and the reply filter has an
 * `address_style` pass that rewrites stale addresses if the model leaks one.
 *
 * Maps to: R5.1 (per-tenant Agent_Identity → audience extension), R7.1
 * (Reasoning_Context completeness), R18.7 (Banglish-only enforcement).
 */

/**
 * Target audience tags. Multi-select on the onboarding wizard so a tenant
 * that sells to "men + boys" or "women + girls" can capture both. The agent
 * uses this list to bias product recommendations (e.g. an undergarments
 * shop with `["women", "girls"]` won't volunteer men's products even if
 * the customer's text is ambiguous).
 *
 * `unisex` and `all` are escape hatches for shops that genuinely don't
 * differentiate (e.g. a stationery store).
 */
export type TargetAudience =
  | "men"
  | "women"
  | "boys"
  | "girls"
  | "kids"
  | "unisex"
  | "all";

/**
 * Address styles the agent can use to refer to the customer.
 *
 * `auto` is the default — the agent picks based on the customer's own cues
 * (the conversation-level override) and falls back to a sensible category-
 * specific default when no cue is present.
 */
export type AddressStyle =
  | "bhaiya"
  | "apu"
  | "sir"
  | "madam"
  | "bondhu"
  | "auto";

/**
 * Tenant-level audience profile stored on `tenant.settings.audienceProfile`.
 *
 * - `targetAudience`: who the shop primarily serves. Drives recommendation
 *   bias and the "shop is for X" line in the system prompt.
 * - `defaultAddress`: fallback when no customer cue is detected.
 *   `auto` lets the engine pick based on `targetAudience`.
 * - `allowedAddresses`: optional whitelist. When set, the agent will only
 *   use addresses from this list even if the customer cue suggests
 *   otherwise. Use case: an undergarments shop forces `["apu", "madam"]`.
 */
export interface AudienceProfile {
  targetAudience: TargetAudience[];
  defaultAddress: AddressStyle;
  allowedAddresses?: AddressStyle[];
}

/**
 * Resolved per-turn address style. Combines the tenant default, the
 * conversation override, and the customer's latest cue.
 *
 * - `style` is the final address the agent should use. Never `auto` —
 *   `auto` is resolved into a concrete style by `resolveAddressStyle`.
 * - `source` records why the agent picked this style (for debugging /
 *   audit log replay).
 * - `lockedFromConversation` is `true` when a prior turn already locked an
 *   address style on `MessengerConversation.preferences.addressStyle`.
 *   The reply filter only rewrites stale addresses when this flag is set.
 */
export type ResolvedAddress =
  | "bhaiya"
  | "apu"
  | "sir"
  | "madam"
  | "bondhu";

export interface ResolvedAudience {
  style: ResolvedAddress;
  source:
    | "conversation_override"
    | "customer_cue"
    | "tenant_default"
    | "category_default"
    | "platform_default";
  lockedFromConversation: boolean;
}

/**
 * Platform default — applied when no tenant config and no customer cue
 * lands on anything. Banglish, gender-neutral.
 */
export const PLATFORM_DEFAULT_ADDRESS: ResolvedAddress = "bhaiya";

/**
 * Banglish-friendly capitalised forms for each address. Used by the
 * prompt fragment and by the reply-filter's stale-address detector.
 *
 * Each entry lists the variants the agent might emit (or leak) so the
 * filter can detect & swap them. The `canonical` form is what the agent
 * is told to use in the prompt.
 */
export const ADDRESS_VARIANTS: Record<
  ResolvedAddress,
  { canonical: string; aliases: ReadonlyArray<string> }
> = {
  bhaiya: {
    canonical: "Vaiya",
    aliases: ["vai", "vaiya", "bhai", "bhaiya", "vaia", "bro", "brother"],
  },
  apu: {
    canonical: "Apu",
    aliases: ["apu", "apa", "apuni", "apa-mony", "apa moni", "didi"],
  },
  sir: {
    canonical: "Sir",
    aliases: ["sir", "boss", "stayer"],
  },
  madam: {
    canonical: "Madam",
    aliases: ["madam", "ma'am", "maam", "mam"],
  },
  bondhu: {
    canonical: "Bondhu",
    aliases: ["bondhu", "friend", "dost"],
  },
};
