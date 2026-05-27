import { MissingTenantScopeError } from "../context/reasoningContextErrors.js";
import { logger } from "../../utils/logger.js";
import type { ToolDef, ToolHandlerCtx, ToolResult } from "../types.js";
import { aliasTools } from "./aliases.js";
import { catalogTools } from "./catalog.js";
import { cartTools } from "./cart.js";
import { confirmTools } from "./confirm.js";
import { customerTools } from "./customer.js";
import { deliveryTools } from "./delivery.js";
import { inventoryTools } from "./inventory.js";
import { lineAddonTools } from "./lineAddons.js";
import { memoryTools } from "./memory.js";
import { orderTools } from "./orders.js";
import { paymentTools } from "./payment.js";
import { paymentLinkTools } from "./paymentLink.js";
import { photoTools } from "./photos.js";
import { addonPhotoTools } from "./addonPhotos.js";
import { policyTools } from "./policy.js";
import { replyTools } from "./reply.js";
import { resolveTools } from "./resolve.js";
import { sessionTools } from "./session.js";
import { sizeChartTools } from "./sizeChart.js";
import { validateOrderTools } from "./validate.js";
import { verifyTools } from "./verify.js";

/**
 * Resolve the tenant id off a `ToolHandlerCtx` (Multi-Tenant Commerce OS
 * task 3.3, R6.2). The id may travel either on `ctx.tenantId` (set by the
 * loop's wrapper) or on `ctx.input.tenantId` (legacy field, also set by the
 * loop). Returning the first non-empty value keeps both paths working
 * without forcing every tool to read from a specific seam.
 *
 * A non-empty `ctx.reasoningContext.tenantId` is treated as authoritative
 * because the Reasoning_Context builder verified the tenant exists in the
 * DB before producing it; a present `reasoningContext` therefore implies a
 * grounded tenant scope even if the wrapper-provided fields were lost in a
 * test fixture that constructed the ctx by hand.
 */
function resolveTenantIdFromCtx(ctx: ToolHandlerCtx): string {
  const fromRc = ctx.reasoningContext?.tenantId?.trim() ?? "";
  if (fromRc.length > 0) return fromRc;
  const fromCtx = (ctx.tenantId ?? "").trim();
  if (fromCtx.length > 0) return fromCtx;
  const fromInput = (ctx.input?.tenantId ?? "").trim();
  return fromInput;
}

/**
 * Wrap a tool handler with the tenant-scope guard required by R6.1, R6.2,
 * R6.3 (Multi-Tenant Commerce OS task 3.3).
 *
 * Behaviour:
 *   - Resolves the effective tenant id from `ctx` (see
 *     {@link resolveTenantIdFromCtx}).
 *   - When the id is empty, emits a structured `tenant_isolation_violation`
 *     log event and throws {@link MissingTenantScopeError}. The error is
 *     thrown — not returned as `{ ok: false, ... }` — so the loop's
 *     `generate_response` catch surfaces it as a router-error path and the
 *     reply pipeline can fail safely instead of confusing the LLM with a
 *     fake tool error.
 *   - Otherwise delegates to the original handler unchanged.
 *
 * The wrapper is applied per-`ToolDef` at registration time (this module).
 * It does NOT read or mutate the registry array elsewhere; every entry that
 * goes through {@link wrapToolHandlersWithTenantGuard} comes back with a
 * fresh shallow copy whose `handler` field is the wrapped function.
 */
function withTenantScopeGuard(
  tool: ToolDef,
): ToolDef {
  const original = tool.handler;
  const wrapped: ToolDef["handler"] = async (
    args: unknown,
    ctx: ToolHandlerCtx,
  ): Promise<ToolResult> => {
    const tenantId = resolveTenantIdFromCtx(ctx);
    if (tenantId.length === 0) {
      logger.warn(
        {
          event: "tenant_isolation_violation",
          tool: tool.name,
          // Surface the conversation/psid on the audit row so an operator can
          // trace which inbound triggered the violation. We deliberately do
          // NOT log `args` to avoid leaking customer-supplied content into a
          // security-sensitive log line.
          conversationId: ctx.input?.conversationId,
          psid: ctx.input?.psid,
        },
        "tool invocation refused: missing tenant scope",
      );
      throw new MissingTenantScopeError(null);
    }
    return original(args, ctx);
  };
  return { ...tool, handler: wrapped };
}

/**
 * Apply {@link withTenantScopeGuard} to every entry in `tools`. Used at
 * registry construction so all tool modules pick up the guard automatically
 * — individual tool authors don't have to remember to add it.
 *
 * Identity preservation for aliases: alias entries (task 7.1) share their
 * canonical tool's `handler` reference verbatim (`aliases.ts` does
 * `handler: canonical.handler`). The `toolAliases.test.ts` suite pins
 * `findTool(alias).handler === findTool(canonical).handler` as a load-
 * bearing invariant — both names must hit the same code path. To preserve
 * that after wrapping, we MEMOIZE the wrapped handler keyed by the original
 * handler reference, so both the canonical entry and its alias get the SAME
 * wrapper closure. The order in `tools` is canonical-before-alias (the
 * alias module imports the canonical and clones it), so by the time we
 * encounter the alias, the canonical's wrapper is already memoized.
 */
function wrapToolHandlersWithTenantGuard(tools: ToolDef[]): ToolDef[] {
  const wrapperByOriginal = new Map<ToolDef["handler"], ToolDef["handler"]>();
  return tools.map((tool) => {
    let wrappedHandler = wrapperByOriginal.get(tool.handler);
    if (wrappedHandler === undefined) {
      const wrapped = withTenantScopeGuard(tool);
      wrappedHandler = wrapped.handler;
      wrapperByOriginal.set(tool.handler, wrappedHandler);
      return wrapped;
    }
    return { ...tool, handler: wrappedHandler };
  });
}

export const TOOLS: ToolDef[] = wrapToolHandlersWithTenantGuard([
  ...memoryTools,
  ...sessionTools,
  ...catalogTools,
  ...resolveTools,
  ...sizeChartTools,
  ...photoTools,
  ...addonPhotoTools,
  ...policyTools,
  ...verifyTools,
  ...cartTools,
  ...inventoryTools,
  ...lineAddonTools,
  ...customerTools,
  ...validateOrderTools,
  ...confirmTools,
  ...orderTools,
  ...paymentTools,
  ...paymentLinkTools,
  ...deliveryTools,
  ...replyTools,
  // Canonical-name aliases (task 7.1 — Reqs 6.1–6.5). Registered LAST so the
  // primary entries are what `renderToolCatalog` lists first when alias filtering
  // is bypassed for any reason.
  ...aliasTools,
]);

export function findTool(name: string): ToolDef | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}
