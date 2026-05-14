/** True for messages that are only a greeting — no product/order content. */
export function isGreetingOnlyMessage(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return /^(hi|hello|hey|salam|assalam|assalamualaikum|namaste|thanks|thank you|dhonnobad|কি খবর)\.?$/i.test(
    lower,
  );
}

/** Avoid calling the LLM for pure greetings / ultra-short noise */
export function shouldInvokeLlm(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  if (isGreetingOnlyMessage(t)) return false;
  if (t.length >= 12) return true;
  const orderSignals =
    /\d/.test(t) ||
    /order|buy|price|tk|bdt|delivery|ship|address|phone|মাল|ডেলিভারি|অর্ডার|কিন|দাম/i.test(t);
  return orderSignals;
}

/**
 * When a tenant has a product catalog, allow shorter messages through for
 * SKU/name ↔ catalog matching (e.g. "Real Madrid jersey") without order keywords.
 */
export function shouldRunCatalogMatcher(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  if (isGreetingOnlyMessage(t)) return false;
  return t.length >= 6;
}
