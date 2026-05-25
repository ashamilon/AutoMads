/**
 * Tests for the structured-log helpers used by the AgentLoop (task 11.2).
 *
 * Run via:
 *
 *     npx tsx src/agent/__tests__/structuredLogs.test.ts
 *
 * The redaction logic is the only piece worth exercising in isolation — the
 * `logToolCall` / `logOverride` emitters are thin wrappers around `pino` and
 * the smoke test in `loop.pipeline.test.ts` already exercises the call sites
 * end-to-end. These tests focus on the pure transforms.
 */

import assert from "node:assert/strict";
import { extractResultId, redactArgs, __test } from "../structuredLogs.js";

const { isSensitiveKey, redactValue, clampString, MAX_REDACTED_STRING_LEN } = __test;

type TestCase = { name: string; run: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, run: () => void | Promise<void>): void {
  tests.push({ name, run });
}

// ─── isSensitiveKey ─────────────────────────────────────────────────────────

test("isSensitiveKey flags PII / secret key fragments (case-insensitive)", () => {
  assert.equal(isSensitiveKey("phone"), true);
  assert.equal(isSensitiveKey("Phone"), true);
  assert.equal(isSensitiveKey("phoneNumber"), true);
  assert.equal(isSensitiveKey("address"), true);
  assert.equal(isSensitiveKey("customerAddress"), true);
  assert.equal(isSensitiveKey("email"), true);
  assert.equal(isSensitiveKey("api_key"), true);
  assert.equal(isSensitiveKey("API_KEY"), true);
  assert.equal(isSensitiveKey("pageAccessToken"), true);
  assert.equal(isSensitiveKey("session_token"), true);
  assert.equal(isSensitiveKey("password"), true);
  assert.equal(isSensitiveKey("creditCard"), true);
});

test("isSensitiveKey leaves benign keys alone", () => {
  assert.equal(isSensitiveKey("sku"), false);
  assert.equal(isSensitiveKey("line_id"), false);
  assert.equal(isSensitiveKey("quantity"), false);
  assert.equal(isSensitiveKey("size"), false);
  assert.equal(isSensitiveKey("query"), false);
  assert.equal(isSensitiveKey("limit"), false);
  assert.equal(isSensitiveKey("orderId"), false);
});

// ─── redactArgs / redactValue ────────────────────────────────────────────────

test("redactArgs replaces sensitive keys with [REDACTED]", () => {
  const out = redactArgs({
    sku: "WC26-RM",
    quantity: 2,
    phone: "01711223344",
    customerAddress: "House 12, Road 5, Dhanmondi",
    email: "buyer@example.com",
  }) as Record<string, unknown>;
  assert.equal(out.sku, "WC26-RM");
  assert.equal(out.quantity, 2);
  assert.equal(out.phone, "[REDACTED]");
  assert.equal(out.customerAddress, "[REDACTED]");
  assert.equal(out.email, "[REDACTED]");
});

test("redactArgs handles `collect_customer_field` PII-by-field shape", () => {
  // { field: "phone", value: "01711223344" } — `value` itself is benign as a key
  // but the sibling `field` says the value is PII. The redactor should redact `value`.
  const out = redactArgs({ field: "phone", value: "01711223344" }) as Record<
    string,
    unknown
  >;
  assert.equal(out.field, "phone");
  assert.equal(out.value, "[REDACTED]");

  // Benign field => value is preserved.
  const benign = redactArgs({ field: "name", value: "Limon" }) as Record<string, unknown>;
  assert.equal(benign.field, "name");
  assert.equal(benign.value, "Limon");
});

test("redactArgs walks nested objects and arrays", () => {
  const out = redactArgs({
    cart: [
      { sku: "A", phone: "01711" },
      { sku: "B", customer: { email: "x@y.z", line_id: "ln_1" } },
    ],
  }) as { cart: Array<Record<string, unknown>> };

  assert.equal(out.cart[0].sku, "A");
  assert.equal(out.cart[0].phone, "[REDACTED]");
  assert.equal(out.cart[1].sku, "B");
  const inner = out.cart[1].customer as Record<string, unknown>;
  assert.equal(inner.email, "[REDACTED]");
  assert.equal(inner.line_id, "ln_1");
});

test("redactArgs clamps very long strings", () => {
  const long = "x".repeat(MAX_REDACTED_STRING_LEN + 50);
  const out = redactArgs({ note: long }) as Record<string, unknown>;
  const clamped = out.note as string;
  assert.equal(typeof clamped, "string");
  assert.ok(clamped.length < long.length, "string should be clamped");
  assert.ok(clamped.includes("…"), "clamped string should mark the truncation");
});

test("redactArgs handles null / undefined / primitive top-level inputs", () => {
  assert.deepEqual(redactArgs(null), {});
  assert.deepEqual(redactArgs(undefined), {});
  assert.deepEqual(redactArgs("hello"), { value: "hello" });
  assert.deepEqual(redactArgs(42), { value: 42 });
  assert.deepEqual(redactArgs(true), { value: true });
});

test("redactValue caps array length to keep the log line bounded", () => {
  const big = Array.from({ length: 50 }, (_, i) => i);
  const out = redactValue(big) as unknown[];
  assert.ok(out.length <= 33, `expected at most 33 entries (32 + truncation marker), got ${out.length}`);
  // Last element is the truncation marker.
  assert.equal(typeof out[out.length - 1], "string");
  assert.match(String(out[out.length - 1]), /\(\+\d+ more\)/);
});

test("redactValue caps recursion depth defensively", () => {
  // Build a 12-deep nested object — depth limit is 8.
  let nested: Record<string, unknown> = { leaf: "ok" };
  for (let i = 0; i < 12; i += 1) {
    nested = { next: nested };
  }
  const out = redactValue(nested);
  // The output should serialise without throwing (no cycles); somewhere down
  // the chain we should see the depth-truncation marker.
  const json = JSON.stringify(out);
  assert.ok(json.includes("[REDACTED]"), `expected depth truncation marker, got ${json}`);
});

test("clampString is a no-op below the cap", () => {
  assert.equal(clampString("short"), "short");
  assert.equal(clampString(""), "");
});

// ─── extractResultId ────────────────────────────────────────────────────────

test("extractResultId returns null for non-objects and missing ids", () => {
  assert.equal(extractResultId(null), null);
  assert.equal(extractResultId(undefined), null);
  assert.equal(extractResultId("hello"), null);
  assert.equal(extractResultId(42), null);
  assert.equal(extractResultId({ unrelated: "x" }), null);
});

test("extractResultId pulls the first matching id-like field", () => {
  // Priority order: orderId, tranId, id, line_id, sku, conversationId.
  assert.equal(extractResultId({ orderId: "ord_1", sku: "WC26" }), "ord_1");
  assert.equal(extractResultId({ tranId: "tx_99" }), "tx_99");
  assert.equal(extractResultId({ id: 42 }), "42");
  assert.equal(extractResultId({ line_id: "ln_a" }), "ln_a");
  assert.equal(extractResultId({ sku: "WC26-RM" }), "WC26-RM");
  assert.equal(extractResultId({ conversationId: "conv_1" }), "conv_1");
});

// ─── logToolCall / logOverride emitters (logger stub) ───────────────────────

import { logger } from "../../utils/logger.js";
import { logToolCall, logOverride } from "../structuredLogs.js";

type CapturedRecord = { level: "info" | "warn"; obj: Record<string, unknown>; msg: string };

function withCapturedLogger<T>(run: (records: CapturedRecord[]) => T): T {
  const records: CapturedRecord[] = [];
  const origInfo = logger.info.bind(logger);
  const origWarn = logger.warn.bind(logger);
  // pino exposes `info(obj, msg)` — capture both args.
  (logger as unknown as { info: (...a: unknown[]) => void }).info = (
    obj: unknown,
    msg?: unknown,
  ): void => {
    records.push({
      level: "info",
      obj: (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>,
      msg: typeof msg === "string" ? msg : "",
    });
  };
  (logger as unknown as { warn: (...a: unknown[]) => void }).warn = (
    obj: unknown,
    msg?: unknown,
  ): void => {
    records.push({
      level: "warn",
      obj: (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>,
      msg: typeof msg === "string" ? msg : "",
    });
  };
  try {
    return run(records);
  } finally {
    (logger as unknown as { info: typeof origInfo }).info = origInfo;
    (logger as unknown as { warn: typeof origWarn }).warn = origWarn;
  }
}

const baseCtx = {
  tenantId: "tenant_1",
  conversationId: "conv_1",
  turnId: "turn_1",
  iter: 0,
};

test("logToolCall emits agent.tool_call with redacted args (password masked)", () => {
  withCapturedLogger((records) => {
    logToolCall({
      ctx: baseCtx,
      tool: "do_something",
      args: { sku: "WC26-RM", password: "hunter2", token: "secret-tok" },
      ok: true,
      data: { orderId: "ord_42" },
      latencyMs: 12,
    });
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.level, "info");
    assert.equal(rec.obj.event, "agent.tool_call");
    assert.equal(rec.obj.tenantId, "tenant_1");
    assert.equal(rec.obj.conversationId, "conv_1");
    assert.equal(rec.obj.turnId, "turn_1");
    assert.equal(rec.obj.iter, 0);
    assert.equal(rec.obj.tool, "do_something");
    assert.equal(rec.obj.latency_ms, 12);
    assert.equal(rec.obj.result_id, "ord_42");
    const redacted = rec.obj.args_redacted as Record<string, unknown>;
    assert.equal(redacted.sku, "WC26-RM");
    assert.equal(redacted.password, "[REDACTED]");
    assert.equal(redacted.token, "[REDACTED]");
  });
});

test("logToolCall redacts cookie / pageAccessToken / creditCard / cardNumber keys", () => {
  withCapturedLogger((records) => {
    logToolCall({
      ctx: baseCtx,
      tool: "checkout",
      args: {
        cookie: "sess=abc",
        pageAccessToken: "EAAG…",
        creditCard: "4111-1111-1111-1111",
        cardNumber: "4242424242424242",
        apiKey: "ak_live_x",
        sku: "WC26",
      },
      ok: true,
      latencyMs: 3,
    });
    const redacted = records[0].obj.args_redacted as Record<string, unknown>;
    assert.equal(redacted.cookie, "[REDACTED]");
    assert.equal(redacted.pageAccessToken, "[REDACTED]");
    assert.equal(redacted.creditCard, "[REDACTED]");
    assert.equal(redacted.cardNumber, "[REDACTED]");
    assert.equal(redacted.apiKey, "[REDACTED]");
    assert.equal(redacted.sku, "WC26");
  });
});

test("logOverride emits agent.override with kind populated", () => {
  withCapturedLogger((records) => {
    logOverride({
      ctx: baseCtx,
      kind: "anti_loop",
      tool: "search_catalog",
      args: { query: "shari", phone: "01711" },
      reason: "same args twice in a row",
    });
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.level, "warn");
    assert.equal(rec.obj.event, "agent.override");
    assert.equal(rec.obj.kind, "anti_loop");
    assert.equal(rec.obj.tool, "search_catalog");
    assert.equal(rec.obj.tenantId, "tenant_1");
    assert.equal(rec.obj.conversationId, "conv_1");
    assert.equal(rec.obj.turnId, "turn_1");
    assert.equal(rec.obj.iter, 0);
    assert.equal(rec.obj.reason, "same args twice in a row");
    const redacted = rec.obj.args_redacted as Record<string, unknown>;
    assert.equal(redacted.query, "shari");
    assert.equal(redacted.phone, "[REDACTED]");
  });
});

test("every emitted record has the canonical correlation fields populated", () => {
  withCapturedLogger((records) => {
    logToolCall({
      ctx: { tenantId: "T", conversationId: "C", turnId: "U", iter: 3 },
      tool: "show_cart",
      args: {},
      ok: true,
      latencyMs: 1,
    });
    logOverride({
      ctx: { tenantId: "T", conversationId: "C", turnId: "U", iter: 3 },
      kind: "anti_hallucination",
      tool: "(none)",
      reason: "low resolver confidence",
    });
    assert.equal(records.length, 2);
    for (const rec of records) {
      assert.ok(typeof rec.obj.event === "string" && rec.obj.event.length > 0, "event populated");
      assert.equal(rec.obj.tenantId, "T");
      assert.equal(rec.obj.conversationId, "C");
      assert.equal(rec.obj.turnId, "U");
      assert.equal(rec.obj.iter, 3);
      assert.ok(typeof rec.obj.tool === "string" && (rec.obj.tool as string).length > 0, "tool populated");
    }
  });
});

// ─── runner ─────────────────────────────────────────────────────────────────

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
