/**
 * Integration test for task 4.3 — Reference_Resolution wiring inside the
 * AgentLoop's `verify_pre_response` stage.
 *
 * Purpose:
 *
 *  When the router picks a cart-mutating tool (`update_cart` / `add_to_cart` /
 *  `modify_cart_item` / `remove_cart_item` / `set_line_addons`), the loop MUST
 *  run `resolveReference(snapshot, userText)` BEFORE the tool handler runs and
 *  overlay the resolved `line_id` / `sku` onto the LLM-proposed args. When the
 *  resolver's confidence falls below `CONFIDENCE_THRESHOLDS.high`, the loop
 *  MUST short-circuit to a clarification reply rather than mutate the cart.
 *
 *  This test exercises both branches end-to-end through `runIterPipeline`,
 *  using the same axios-stub pattern as `loop.pipeline.test.ts` (router stub
 *  installed BEFORE importing the loop, so the module-load-time imports stay
 *  stable):
 *
 *    Case A ("make the boot size 42")  — cart has a jersey + a boot, the
 *                                         router emits `modify_cart_item` with
 *                                         no/wrong line_id. The resolver must
 *                                         pin the boot line via priority-3
 *                                         attribute match (`boot` token →
 *                                         unique cart line), and the
 *                                         `verify_pre_response` row must carry
 *                                         `args.resolverOverlay.line_id ===
 *                                         "line-B"`. The downstream
 *                                         `generate_response` row must run the
 *                                         `modify_cart_item` tool with
 *                                         `args.line_id === "line-B"`.
 *
 *    Case B ("make it size 42")        — same cart, but the customer's phrase
 *                                         is ambiguous (no product token). The
 *                                         resolver returns `kind:"none"` with
 *                                         `confidence_score = 0`, well below
 *                                         the high threshold. The
 *                                         `verify_pre_response` row must carry
 *                                         `args.overrideToReply === true` and
 *                                         the chosen `tool` must flip from
 *                                         `modify_cart_item` to `reply`.
 *
 * Run via:
 *
 *     npx tsx src/agent/__tests__/loopReferenceResolver.test.ts
 *
 * Requirements covered: 9.2, 9.4, 9.5, 12.5.
 */

import assert from "node:assert/strict";

// --- Stub axios BEFORE importing the loop module --------------------------
// The loop's router calls `axios.post(... /api/chat ...)` lazily; we replace
// `axios.post` so it returns a canned `modify_cart_item` decision (with a
// deliberately wrong / missing line_id) so the `verify_pre_response` stage's
// resolver overlay is the thing under test. Messenger sends from the
// fallback `reply` path are intercepted with a fake 200 so the test never
// hits the network.
import axios from "axios";

const originalPost = axios.post.bind(axios);
type AnyAxios = typeof axios;
const axiosPatched = axios as AnyAxios & { post: typeof axios.post };

/**
 * Install an axios.post stub that returns the supplied router decision for
 * any `/api/chat` call and a fake 200 for everything else (Messenger sends).
 * The stub is intentionally re-installed per test so concurrent suites can't
 * leak fixtures between cases.
 */
function installRouterStub(decision: { tool: string; args: Record<string, unknown>; thought?: string }): void {
  axiosPatched.post = (async (url: string, body: unknown) => {
    void body;
    if (url.includes("/api/chat")) {
      return {
        data: {
          message: {
            content: JSON.stringify({
              thought: decision.thought ?? "stub",
              tool: decision.tool,
              args: decision.args,
            }),
          },
        },
      } as unknown as ReturnType<typeof axios.post>;
    }
    // Messenger / anything else → fake 200 so a fallback `reply` send doesn't
    // hit the network from the override-to-reply branch.
    return { data: { message_id: "mid_stub", recipient_id: "psid_stub" } } as unknown as ReturnType<
      typeof axios.post
    >;
  }) as unknown as typeof axios.post;
}

// Pre-install a no-op stub so the static imports below don't accidentally
// trigger a real call during module init.
installRouterStub({ tool: "reply", args: { text: "init" } });

// --- Static imports — module load happens AFTER the axios stub above ------
import { runIterPipeline } from "../loop.js";
import type { AgentCartItem, AgentSnapshot, AgentStepLog, AgentTurnInput } from "../types.js";

// Restore reminder for the suite tail (sibling tests run in the same process
// when invoked via the package test runner).
function restoreAxios(): void {
  axiosPatched.post = originalPost as unknown as typeof axios.post;
}

// --- Test fixtures --------------------------------------------------------

/**
 * Build a snapshot with two cart lines:
 *   - a jersey line (line_id=line-J, sku=ARG-HOME-24, size=L)
 *   - a boot line   (line_id=line-B, sku=NIKE-BOOT-7, no size yet)
 *
 * The boot line has NO size on purpose so "make the boot size 42" is a
 * realistic Phase-1 use case (set the missing size slot on the boot line).
 */
function makeTwoLineSnapshot(): AgentSnapshot {
  const jersey: AgentCartItem = {
    sku: "ARG-HOME-24",
    product: "Argentina Home Jersey",
    quantity: 1,
    line_id: "line-J",
    size: "L",
    unitPriceBdt: 1500,
  };
  const boot: AgentCartItem = {
    sku: "NIKE-BOOT-7",
    product: "Nike Football Boot",
    quantity: 1,
    line_id: "line-B",
    unitPriceBdt: 4500,
  };
  return {
    cart: [jersey, boot],
    profile: {},
    shownSkus: [],
    lastShown: [],
    active_goal: null,
    order_state: "CART_BUILDING",
    missing_information: [{ line_id: "line-B", slot: "size", attempts: 0 }],
    confirmed_information: {},
    customer_preferences: {},
    conversation_summary: "",
    confidence_level: 1.0,
    followup_needed: false,
    recent_references: [],
  };
}

function makeInput(userText: string): AgentTurnInput {
  return {
    tenantId: "t_ref_resolver",
    tenantSlug: "ref",
    // SIM_ prefix → `isSimulatorPsid` short-circuits Messenger sends so the
    // override-to-reply branch in case B doesn't try to hit Graph API.
    psid: "SIM_ref",
    conversationId: "", // empty so saveSnapshot is a no-op (no DB roundtrip)
    userText,
    imageUrls: [],
    pageAccessToken: "stub",
    within24h: true,
  };
}

// --- Tiny tsx-runnable harness --------------------------------------------

type TestCase = { name: string; run: () => Promise<void> };
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

function findStep(steps: AgentStepLog[], step: AgentStepLog["step"]): AgentStepLog {
  const row = steps.find((s) => s.step === step);
  assert.ok(row, `expected a ${step ?? "(none)"} step in the pipeline output`);
  return row;
}

// --- Tests ----------------------------------------------------------------

test(
  "case A: 'make the boot size 42' overlays the boot's line_id onto modify_cart_item",
  async () => {
    // The router picks `modify_cart_item` but with NO line_id (this is the
    // hallucination-class failure mode the resolver is meant to catch). The
    // verify_pre_response stage MUST overlay the boot's line_id from the
    // deterministic resolver before the tool handler runs.
    installRouterStub({
      tool: "modify_cart_item",
      args: { size: "42" },
      thought: "customer wants size 42 on the boot",
    });

    const result = await runIterPipeline({
      input: makeInput("make the boot size 42"),
      history: [],
      snapshot: makeTwoLineSnapshot(),
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_ref_resolver_caseA",
    });

    const verify = findStep(result.steps, "verify_pre_response");
    const verifyArgs = verify.args as Record<string, unknown>;
    const overlay = verifyArgs.resolverOverlay as Record<string, unknown> | undefined;
    assert.ok(
      overlay,
      `verify_pre_response.args.resolverOverlay must be set when resolver pinned a line; got ${JSON.stringify(
        verifyArgs,
      )}`,
    );
    assert.equal(
      overlay.line_id,
      "line-B",
      `resolver overlay must carry the BOOT's line_id, got ${JSON.stringify(overlay)}`,
    );
    assert.notEqual(
      verifyArgs.overrideToReply,
      true,
      "verify_pre_response must NOT override to reply when resolver confidence is high",
    );
    // The verify_pre_response row keeps `tool === modify_cart_item` (no flip
    // to reply) — the implied FSM target should reflect the cart-mutation tool.
    assert.equal(
      verify.tool,
      "modify_cart_item",
      `verify_pre_response.tool must remain modify_cart_item, got ${verify.tool}`,
    );

    // The downstream generate_response row carries the OVERLAID args, so
    // `line_id` is now the boot's id even though the router never supplied it.
    const gen = findStep(result.steps, "generate_response");
    assert.equal(
      gen.tool,
      "modify_cart_item",
      `generate_response should still run modify_cart_item, got ${gen.tool}`,
    );
    const genArgs = gen.args as Record<string, unknown>;
    assert.equal(
      genArgs.line_id,
      "line-B",
      `generate_response.args.line_id must be the boot's line_id after overlay, got ${JSON.stringify(genArgs)}`,
    );
    // The router's original size argument is preserved through the overlay.
    assert.equal(genArgs.size, "42", "size arg from the router must survive the overlay");
  },
);

test(
  "case B: 'make it size 42' is ambiguous — verify_pre_response overrides to reply",
  async () => {
    // The router proposes modify_cart_item but cannot determine which line.
    // The customer phrase has no product token and no ordinal, so the resolver
    // returns kind:"none" with confidence 0 — below the high threshold. The
    // loop MUST flip the chosen tool to `reply` and emit the disambiguation
    // prompt instead of mutating the cart.
    //
    // Note: we deliberately omit `line_id` from the router args. After the
    // resolver-scope fix (post-SIM_cmooz62gy0wer regression), the loop only
    // runs the resolver when the customer's message contains a reference
    // phrase AND the args don't already carry a grounded target. "make"
    // matches the reference-phrase regex (modification verb), and the missing
    // line_id forces the resolver to be the source of truth — which is the
    // exact path Req 9.5 covers.
    installRouterStub({
      tool: "modify_cart_item",
      args: { size: "42" },
      thought: "customer wants size 42 — but didn't say which line",
    });

    const result = await runIterPipeline({
      input: makeInput("make it size 42"),
      history: [],
      snapshot: makeTwoLineSnapshot(),
      steps: [],
      reply: null,
      done: false,
      reason: null,
      needsRetry: false,
      iter: 1,
      turnId: "t_ref_resolver_caseB",
    });

    const verify = findStep(result.steps, "verify_pre_response");
    const verifyArgs = verify.args as Record<string, unknown>;
    assert.equal(
      verifyArgs.overrideToReply,
      true,
      `verify_pre_response.args.overrideToReply must be true on ambiguous reference; got ${JSON.stringify(
        verifyArgs,
      )}`,
    );
    assert.equal(
      verify.tool,
      "reply",
      `verify_pre_response.tool must flip to reply on low-confidence resolution, got ${verify.tool}`,
    );

    // The actual tool that ran is `reply`, NOT modify_cart_item. The cart was
    // never touched, which is the whole point of Req 9.5 / 12.5.
    const gen = findStep(result.steps, "generate_response");
    assert.equal(
      gen.tool,
      "reply",
      `generate_response must run reply (not modify_cart_item), got ${gen.tool}`,
    );

    // The reply text is the disambiguation prompt — it should mention BOTH
    // candidate products by name so the customer can pick one. We don't pin
    // the exact wording (Banglish-friendly), just the structural property:
    // the reply text references both products in the cart.
    assert.equal(result.terminal, true, "the reply tool should terminate the iteration");
    assert.ok(result.reply, "a reply text must be produced");
    const replyText = result.reply ?? "";
    assert.ok(
      /jersey/i.test(replyText) && /boot/i.test(replyText),
      `disambiguation reply should list both candidate products, got: ${replyText}`,
    );
  },
);

// --- Runner ---------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  try {
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
  } finally {
    restoreAxios();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
