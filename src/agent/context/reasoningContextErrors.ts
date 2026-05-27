/**
 * Typed errors thrown by the Reasoning_Context builder
 * (Multi-Tenant Commerce OS, task 3.2).
 *
 * Both error classes carry a stable `code` field so structured-log pipelines
 * (`tenant_isolation_violation`, `reasoning_context_incomplete`) can group on
 * a machine identifier rather than the human-readable `name`/`message`.
 *
 * Why two distinct classes?
 *  - `MissingTenantScopeError` (R6.1, R6.3) signals an attempt to reach
 *    tenant-scoped data without a `tenantId` in scope, or with a `tenantId`
 *    that does not resolve to an existing `Tenant` row. It is the canonical
 *    error tools throw before issuing any Prisma read whose `where` clause
 *    would not be tenant-scoped.
 *  - `ReasoningContextIncompleteError` (R7.6) signals that the builder
 *    successfully loaded the tenant row but at least one of the required
 *    Reasoning_Context keys (`tenantId`, `businessCategory`, `categorySchema`)
 *    is still missing — typically because onboarding has not yet stamped
 *    `tenant.businessCategory`. The agent loop catches this BEFORE
 *    `observe_input` and short-circuits to the hand-off path instead of
 *    producing a reply (design.md, "Reasoning Context Incompleteness").
 *
 * Both classes preserve the original `Error` prototype chain so callers can
 * `err instanceof MissingTenantScopeError` after the value crosses an async
 * boundary (the prototype-restoration line is required for ES2015-target
 * `extends Error` to behave correctly in transpiled output).
 */

/**
 * Stable error code for {@link MissingTenantScopeError}. Mirrors the
 * `tenant_isolation_violation` log event the surrounding tooling emits on the
 * same condition (R6.3).
 */
export const MISSING_TENANT_SCOPE_CODE = "missing_tenant_scope" as const;

/**
 * Stable error code for {@link ReasoningContextIncompleteError}. Matches the
 * `reasoning_context_incomplete` reason the agent loop logs when aborting
 * before reply generation (R7.6).
 */
export const REASONING_CONTEXT_INCOMPLETE_CODE =
  "reasoning_context_incomplete" as const;

/**
 * Thrown when a tenant-scoped operation cannot resolve a tenant — either the
 * caller did not supply a `tenantId`, or the supplied id does not match any
 * existing `Tenant` row.
 *
 * Maps to: R6.1, R6.3.
 */
export class MissingTenantScopeError extends Error {
  /** Stable machine code, identical for every instance of this class. */
  public readonly code = MISSING_TENANT_SCOPE_CODE;
  /**
   * The `tenantId` the caller supplied (or `null` when no id was passed).
   * Used by structured logs so the audit trail can include the offending id
   * even when the throwing code path doesn't surface it directly.
   */
  public readonly tenantId: string | null;

  constructor(
    tenantId: string | null,
    message: string = tenantId
      ? `Tenant not found or out of scope: ${tenantId}`
      : "Missing tenant scope: tenantId is required",
  ) {
    super(message);
    this.name = "MissingTenantScopeError";
    this.tenantId = tenantId;
    // Preserve the prototype chain so `instanceof` still works after the
    // error crosses an async/await boundary (ES2015-target transpile gotcha).
    Object.setPrototypeOf(this, MissingTenantScopeError.prototype);
  }
}

/**
 * Thrown by `buildReasoningContext` when the tenant row exists but at least
 * one of the required Reasoning_Context keys (`tenantId`, `businessCategory`,
 * `categorySchema`) is still null. The agent loop catches this before
 * `observe_input` and short-circuits to the hand-off path; no reply is
 * produced for the inbound turn.
 *
 * Maps to: R7.6.
 */
export class ReasoningContextIncompleteError extends Error {
  /** Stable machine code, identical for every instance of this class. */
  public readonly code = REASONING_CONTEXT_INCOMPLETE_CODE;
  /** The tenant id the builder was working with, when known. */
  public readonly tenantId: string | null;
  /**
   * The Reasoning_Context keys that were null at the time of the check.
   * Surfaced on the error so the log line can name the missing field
   * without forcing the caller to re-derive it from the message string.
   */
  public readonly missingKeys: ReadonlyArray<
    "tenantId" | "businessCategory" | "categorySchema"
  >;

  constructor(
    tenantId: string | null,
    missingKeys: ReadonlyArray<
      "tenantId" | "businessCategory" | "categorySchema"
    >,
    message: string = `Reasoning_Context incomplete for tenant ${
      tenantId ?? "<null>"
    }: missing ${missingKeys.join(", ")}`,
  ) {
    super(message);
    this.name = "ReasoningContextIncompleteError";
    this.tenantId = tenantId;
    this.missingKeys = missingKeys;
    Object.setPrototypeOf(this, ReasoningContextIncompleteError.prototype);
  }
}
