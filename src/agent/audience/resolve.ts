/**
 * Audience profile resolver — combines tenant config, conversation
 * override, and customer cue into a single concrete address style.
 *
 * Resolution chain (highest priority first):
 *
 *   1. **Conversation override** — when a previous turn already locked an
 *      address on `MessengerConversation.preferences.addressStyle`, that
 *      wins so the agent stays consistent across turns. Exception:
 *      when the latest customer message contains an unambiguous *new*
 *      cue (e.g. they switched from no-cue to "Vaiya"), we accept the
 *      switch — but only if the tenant's `allowedAddresses` permits it.
 *
 *   2. **Customer cue** — `detectAddressFromMessage` on the inbound text.
 *      Filtered through `tenant.allowedAddresses` if set.
 *
 *   3. **Tenant default** — `tenant.settings.audienceProfile.defaultAddress`.
 *      `auto` falls through to the next layer.
 *
 *   4. **Category default** — derived from the tenant's `targetAudience`:
 *        - `["women", ...]` → `apu`
 *        - `["men", ...]`   → `bhaiya`
 *        - `["girls"]`      → `apu`
 *        - `["boys"]`       → `bhaiya`
 *        - everything else  → platform default
 *
 *   5. **Platform default** — `bhaiya` (Banglish, gender-neutral in
 *      common usage; safe for unknown demographics).
 *
 * Pure: no DB, no logger. Caller is responsible for persisting the
 * resolved style to the conversation row when `lockedFromConversation`
 * was previously `false`.
 *
 * Maps to: R5.1, R5.4, R7.1.
 */

import { detectAddressFromMessage } from "./detectAddress.js";
import {
  PLATFORM_DEFAULT_ADDRESS,
  type AddressStyle,
  type AudienceProfile,
  type ResolvedAddress,
  type ResolvedAudience,
  type TargetAudience,
} from "./types.js";

/**
 * Map a `targetAudience` list to a sensible default address.
 *
 * The first matching audience wins — tenants with mixed audiences (e.g.
 * "women + men") get the *first* listed audience's address. This
 * matches what tenant admins typically expect: they set the primary
 * audience first.
 */
function categoryDefaultFromAudience(
  audience: TargetAudience[] | undefined,
): ResolvedAddress | null {
  if (!Array.isArray(audience) || audience.length === 0) return null;
  for (const a of audience) {
    switch (a) {
      case "women":
      case "girls":
        return "apu";
      case "men":
      case "boys":
        return "bhaiya";
      case "kids":
      case "unisex":
      case "all":
        // No strong default — fall through.
        break;
    }
  }
  return null;
}

/**
 * Filter an address through the tenant's `allowedAddresses` whitelist.
 * Returns the address if allowed (or whitelist absent), or `null` to
 * indicate the caller should try the next layer.
 */
function passesWhitelist(
  candidate: ResolvedAddress,
  allowed: AddressStyle[] | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (allowed.includes("auto")) return true; // wildcard
  return (allowed as ReadonlyArray<string>).includes(candidate);
}

/**
 * Concretise a tenant `defaultAddress` into a `ResolvedAddress`.
 * `auto` resolves to `null` so the caller falls through to the
 * category-default layer.
 */
function concretiseDefault(
  defaultAddress: AddressStyle | undefined,
): ResolvedAddress | null {
  if (!defaultAddress) return null;
  if (defaultAddress === "auto") return null;
  return defaultAddress;
}

/**
 * Resolution input. The agent loop populates this once per turn from
 * `tenant.settings`, the inbound message, and the conversation row.
 */
export interface ResolveAddressInput {
  /** Tenant-level audience profile. May be `null` for tenants who skipped onboarding (e.g. legacy demo tenant). */
  tenantProfile: AudienceProfile | null;
  /** Address style locked on the conversation by a prior turn, if any. */
  conversationOverride: ResolvedAddress | null;
  /** The customer's latest inbound text. */
  latestCustomerMessage: string | null;
}

/**
 * Run the full resolution chain. Returns a concrete `ResolvedAudience`
 * with the chosen style and the audit `source` so the trace can record
 * why the agent picked this address.
 */
export function resolveAddressStyle(
  input: ResolveAddressInput,
): ResolvedAudience {
  const allowed = input.tenantProfile?.allowedAddresses;

  // Layer 2 — fresh customer cue. Always check first because a new cue
  // may legitimately switch the conversation address (customer started
  // with no cue, then later wrote "vaiya, ei ta nibo").
  const cue = detectAddressFromMessage(input.latestCustomerMessage);
  if (cue && passesWhitelist(cue, allowed)) {
    return {
      style: cue,
      source: "customer_cue",
      lockedFromConversation: input.conversationOverride !== null,
    };
  }

  // Layer 1 — conversation override (no fresh cue, but a previous turn locked).
  if (
    input.conversationOverride &&
    passesWhitelist(input.conversationOverride, allowed)
  ) {
    return {
      style: input.conversationOverride,
      source: "conversation_override",
      lockedFromConversation: true,
    };
  }

  // Layer 3 — tenant default.
  const tenantDefault = concretiseDefault(input.tenantProfile?.defaultAddress);
  if (tenantDefault && passesWhitelist(tenantDefault, allowed)) {
    return {
      style: tenantDefault,
      source: "tenant_default",
      lockedFromConversation: false,
    };
  }

  // Layer 4 — category default from target audience.
  const categoryDefault = categoryDefaultFromAudience(
    input.tenantProfile?.targetAudience,
  );
  if (categoryDefault && passesWhitelist(categoryDefault, allowed)) {
    return {
      style: categoryDefault,
      source: "category_default",
      lockedFromConversation: false,
    };
  }

  // Layer 5 — platform default. Filter through whitelist if set; in the
  // pathological case where the whitelist excludes the platform default,
  // fall back to the first allowed entry.
  if (passesWhitelist(PLATFORM_DEFAULT_ADDRESS, allowed)) {
    return {
      style: PLATFORM_DEFAULT_ADDRESS,
      source: "platform_default",
      lockedFromConversation: false,
    };
  }

  // The whitelist excludes the platform default. Pick the first concrete
  // entry from the whitelist (skip `auto`).
  const firstAllowed = (allowed ?? [])
    .find((a) => a !== "auto") as ResolvedAddress | undefined;
  return {
    style: firstAllowed ?? PLATFORM_DEFAULT_ADDRESS,
    source: "platform_default",
    lockedFromConversation: false,
  };
}

/**
 * Defensive parser for the JSON column. Reads `tenant.settings.audienceProfile`
 * and coerces it into a typed shape. Anything malformed returns `null` so
 * the resolver falls through to category/platform defaults.
 */
export function parseAudienceProfile(
  settings: unknown,
): AudienceProfile | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return null;
  }
  const root = settings as Record<string, unknown>;
  const raw = root["audienceProfile"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const targetAudience = Array.isArray(obj.targetAudience)
    ? (obj.targetAudience.filter(
        (x): x is TargetAudience =>
          typeof x === "string" &&
          ["men", "women", "boys", "girls", "kids", "unisex", "all"].includes(x),
      ) as TargetAudience[])
    : [];

  const defaultAddressRaw = obj.defaultAddress;
  const defaultAddress: AddressStyle =
    typeof defaultAddressRaw === "string" &&
    ["bhaiya", "apu", "sir", "madam", "bondhu", "auto"].includes(defaultAddressRaw)
      ? (defaultAddressRaw as AddressStyle)
      : "auto";

  const allowedRaw = obj.allowedAddresses;
  const allowedAddresses: AddressStyle[] | undefined = Array.isArray(allowedRaw)
    ? (allowedRaw.filter(
        (x): x is AddressStyle =>
          typeof x === "string" &&
          ["bhaiya", "apu", "sir", "madam", "bondhu", "auto"].includes(x),
      ) as AddressStyle[])
    : undefined;

  return {
    targetAudience,
    defaultAddress,
    ...(allowedAddresses ? { allowedAddresses } : {}),
  };
}
