import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { sendMessengerText } from "../../integrations/facebook/messengerService.js";
import { logger } from "../../utils/logger.js";
import { sanitizeCustomerReply } from "../replyFilter.js";
import type { ToolDef } from "../types.js";

const ReplyArgs = z.object({
  text: z.string().min(1).max(1500),
});

const EscalateArgs = z.object({
  reason: z.string().min(1).max(300),
  /** Optional one-liner the bot says to the customer while handing off. */
  customer_text: z.string().min(1).max(800).optional(),
});

async function logAssistantTurn(conversationId: string, text: string): Promise<void> {
  if (!conversationId || !text.trim()) return;
  await prisma.messengerMessage
    .create({ data: { conversationId, role: "assistant", text } })
    .catch(() => undefined);
  await prisma.messengerConversation
    .update({ where: { id: conversationId }, data: { lastBotMsgAt: new Date() } })
    .catch(() => undefined);
}

export const replyTools: ToolDef[] = [
  {
    name: "reply",
    description:
      "Send a final message to the customer. This ENDS your turn — call it only when you have enough information, or you need to ask the customer something specific. Keep it short, warm, in Banglish/Bangla matching the customer's style.",
    paramsSchema: ReplyArgs,
    paramsHint: '{ "text": string (max 1500 chars) }',
    terminal: true,
    handler: async (rawArgs, ctx) => {
      const args = ReplyArgs.parse(rawArgs);
      // Outbound short-circuit (Multi-Tenant Commerce OS task 3.3, R12.4 / R18.4).
      //
      // `runAgentTurn` already exits before the StateGraph runs when the
      // subscription is non-operational, so this branch is a defense in
      // depth — if a future caller bypasses the loop and invokes the
      // reply tool directly with a non-operational reasoning context, we
      // refuse to emit outbound text. The inbound is logged via the
      // structured-log pipeline upstream; we simply DO NOT call
      // `sendMessengerText` and surface a non-OK terminal result so the
      // caller can record the refused turn without any customer-visible
      // side-effect.
      if (
        ctx.reasoningContext &&
        ctx.reasoningContext.subscription.isOperational === false
      ) {
        logger.warn(
          {
            event: "reply_short_circuit_subscription_not_operational",
            tenantId: ctx.input.tenantId,
            conversationId: ctx.input.conversationId,
            subscriptionStatus:
              ctx.reasoningContext.subscription.status,
          },
          "agent.reply refused: subscription not operational",
        );
        return {
          ok: false,
          error: "subscription_not_operational",
          observation:
            "Reply suppressed: tenant subscription is not operational; outbound disabled.",
        };
      }
      const resolvedAddressStyle = ctx.reasoningContext?.audience?.address?.style;
      const safeText = sanitizeCustomerReply(args.text, resolvedAddressStyle);
      try {
        await sendMessengerText({
          pageAccessToken: ctx.input.pageAccessToken,
          psid: ctx.input.psid,
          text: safeText,
          within24hWindow: ctx.input.within24h,
        });
        await logAssistantTurn(ctx.input.conversationId, safeText);
        return {
          ok: true,
          terminal: true,
          reply: safeText,
          observation: `Replied to customer: "${safeText.slice(0, 200)}"`,
        };
      } catch (e) {
        logger.warn({ e: String(e), tenantId: ctx.input.tenantId }, "agent.reply send failed");
        return { ok: false, error: "send_failed", observation: `Reply send failed: ${String(e).slice(0, 160)}` };
      }
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation off to a human admin. Use for: complaints, refund requests, customer asks for a human, repeated bot failures, or when an order needs final checkout (phase 2 will add direct checkout).",
    paramsSchema: EscalateArgs,
    paramsHint: '{ "reason": string, "customer_text"?: string }',
    terminal: true,
    handler: async (rawArgs, ctx) => {
      const args = EscalateArgs.parse(rawArgs);
      const resolvedAddressStyleEsc = ctx.reasoningContext?.audience?.address?.style;
      const text = sanitizeCustomerReply(
        args.customer_text ?? "Ami akhon admin er sathe connect kore dichchi — kichu pore reply pabben 🙏",
        resolvedAddressStyleEsc,
      );
      try {
        await sendMessengerText({
          pageAccessToken: ctx.input.pageAccessToken,
          psid: ctx.input.psid,
          text,
          within24hWindow: ctx.input.within24h,
        });
        await logAssistantTurn(ctx.input.conversationId, text);
      } catch (e) {
        logger.warn(
          { e: String(e), tenantId: ctx.input.tenantId },
          "agent.escalate notify customer failed",
        );
      }
      logger.warn(
        {
          tenantId: ctx.input.tenantId,
          conversationId: ctx.input.conversationId,
          psid: ctx.input.psid,
          reason: args.reason,
        },
        "AGENT_ESCALATION human_handoff_requested",
      );
      // Phase 4 will set humanHandledUntil + Telegram alert. For phase 1 this just logs.
      return { ok: true, terminal: true, reply: text, observation: `Escalated: ${args.reason}` };
    },
  },
];
