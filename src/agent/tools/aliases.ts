/**
 * Canonical-name aliases for tools whose primary handler is registered under a
 * different name in this codebase (task 7.1, Reqs 6.1–6.5).
 *
 * Decision: alias rather than rename. The codebase has a long tail of references
 * to the existing names — `prompts.ts` mentions `add_to_cart` / `confirm_order` /
 * `search_catalog`, the runner fallback path references them, the addon flow
 * (`set_line_addons`) is documented in terms of `add_to_cart`, and a handful of
 * tests pin those names. Renaming would bleed into 20+ files. Instead we keep the
 * existing primary handlers and register a SECOND `ToolDef` entry for each
 * canonical name from Req 6.1, sharing the SAME `handler` and `paramsSchema`
 * references so `findTool("update_cart") === findTool("add_to_cart")` (by handler
 * identity).
 *
 * The mapping below is exactly the four names from Req 6.1 that the codebase does
 * not already use as primary names:
 *
 *   • update_cart        → add_to_cart      (cart mutation: append/merge a line)
 *   • remove_cart_item   → remove_from_cart (cart mutation: drop a line)
 *   • search_products    → search_catalog   (catalog search)
 *   • create_order       → confirm_order    (terminal: persist order, send payment)
 *
 * Tools whose canonical name already matches the codebase name (`resolve_product_name`,
 * `check_inventory`, `modify_cart_item`, `save_session_state`, `retrieve_session_state`,
 * `validate_order`) need no alias — they are registered by their primary modules.
 *
 * Each alias entry carries `aliasOf: <canonical>` so `renderToolCatalog` (in
 * `router.ts`) can filter aliases out of the LLM-facing tool list, keeping the
 * prompt budget tight while still letting `findTool` resolve either name.
 */

import type { ToolDef } from "../types.js";
import { cartTools } from "./cart.js";
import { catalogTools } from "./catalog.js";
import { confirmTools } from "./confirm.js";

/** Find a tool definition in a `ToolDef[]` by name; throws if absent so a refactor that removes the canonical handler trips at module load instead of at runtime. */
function findCanonical(pool: ToolDef[], name: string): ToolDef {
  const found = pool.find((t) => t.name === name);
  if (!found) {
    throw new Error(
      `aliases.ts: canonical tool "${name}" missing from its module — alias setup is broken.`,
    );
  }
  return found;
}

/**
 * Build an alias `ToolDef` that delegates to a canonical tool. We deliberately
 * reuse the SAME `handler` reference (not a wrapper) so consumers can verify
 * alias→primary identity via `findTool(alias).handler === findTool(primary).handler`.
 * Description is annotated so debug output (e.g. the `unknown_tool` error in
 * `loop.ts`) makes it obvious the entry is an alias.
 */
function aliasFor(canonicalName: string, aliasName: string, pool: ToolDef[]): ToolDef {
  const canonical = findCanonical(pool, canonicalName);
  const def: ToolDef = {
    name: aliasName,
    description: `[alias for ${canonicalName}] ${canonical.description}`,
    paramsSchema: canonical.paramsSchema,
    paramsHint: canonical.paramsHint,
    handler: canonical.handler,
    aliasOf: canonicalName,
  };
  if (canonical.examples) def.examples = canonical.examples;
  if (canonical.terminal !== undefined) def.terminal = canonical.terminal;
  return def;
}

export const aliasTools: ToolDef[] = [
  aliasFor("add_to_cart", "update_cart", cartTools),
  aliasFor("remove_from_cart", "remove_cart_item", cartTools),
  aliasFor("search_catalog", "search_products", catalogTools),
  aliasFor("confirm_order", "create_order", confirmTools),
];
