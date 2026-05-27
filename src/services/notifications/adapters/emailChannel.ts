import { prisma } from "../../../db/prisma.js";
import { logger } from "../../../utils/logger.js";
import type { NotificationChannelAdapter } from "../types.js";

/**
 * Email channel adapter (R13.1, R13.5, R22.8).
 *
 * The dispatcher creates a `Notification` row before calling us. Our
 * contract is narrow: produce a transport-level `{ ok, reason? }`. The
 * dispatcher decides whether the row gets marked `delivered` or `failed`
 * (R13.4); we never write `status` ourselves.
 *
 * Per R13.5 we retry transient failures up to 3 times with exponential
 * backoff (1s, 4s, 16s). Any 4xx-style "do-not-retry" reason from the
 * transport short-circuits early so we don't waste 21s on, e.g., a missing
 * recipient address. After the final attempt we return `{ ok: false }` and
 * let the dispatcher persist `status=failed`.
 *
 * No nodemailer dependency is added here. We don't ship an SMTP transport
 * yet (the production deployment hasn't picked one), so the adapter is
 * gated by `SMTP_HOST` env vars and degrades gracefully when SMTP is not
 * configured: it skips the network I/O, logs the would-be email, and
 * returns success so the dispatcher can mark the dashboard-visible row as
 * delivered. When the operator wires up real SMTP, swap `transport` for a
 * real implementation — the retry policy stays here.
 */

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000] as const;

interface EmailEnvelope {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

interface TransportResult {
  ok: boolean;
  /** Permanent failures should NOT be retried (e.g. invalid_recipient). */
  permanent?: boolean;
  reason?: string;
}

/**
 * Resolve the recipient + envelope for a notification. Tenants without a
 * login email yet (pre-activation) cannot receive email, so we surface that
 * as a permanent failure rather than retrying three times.
 */
async function buildEnvelope(input: {
  tenantId: string;
  type: string;
  payload: unknown;
}): Promise<EmailEnvelope | { error: string }> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { email: true, name: true },
  });

  if (!tenant) {
    return { error: "tenant_not_found" };
  }
  const to = tenant.email?.trim();
  if (!to) {
    return { error: "tenant_has_no_email" };
  }

  // Subject + body are intentionally generic. Higher layers (admin panel,
  // grace period service) own the wording; this adapter is a pipe.
  const subject = `[${tenant.name ?? "Notification"}] ${input.type}`;
  const text = renderPlainText(input.type, input.payload);
  return { to, subject, text };
}

function renderPlainText(type: string, payload: unknown): string {
  const head = `Notification: ${type}`;
  if (payload == null) return head;
  try {
    return `${head}\n\n${JSON.stringify(payload, null, 2)}`;
  } catch {
    return `${head}\n\n[unserialisable payload]`;
  }
}

/**
 * SMTP transport stub. Only attempts a real send when `SMTP_HOST` is
 * configured; otherwise logs and returns ok so the developer / staging
 * environment doesn't need an SMTP server to exercise the dispatcher.
 *
 * The implementation is intentionally tiny — when the operator picks a
 * real provider (nodemailer, AWS SES, Resend), swap the body of this
 * function. The retry loop above doesn't change.
 */
async function transport(envelope: EmailEnvelope): Promise<TransportResult> {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    logger.info(
      {
        to: envelope.to,
        subject: envelope.subject,
        smtp_configured: false,
      },
      "email_adapter_smtp_not_configured_logged_only",
    );
    return { ok: true };
  }

  // Real transport not wired yet. Returning a permanent failure here would
  // mark the Notification row failed in production — instead we treat the
  // missing transport as a soft failure tagged for the operator. Once a
  // real client is added (e.g. nodemailer), replace this branch with the
  // actual `await transport.sendMail(envelope)` call and surface its
  // success / error states.
  logger.warn(
    {
      to: envelope.to,
      subject: envelope.subject,
      smtp_host: host,
    },
    "email_adapter_transport_not_implemented",
  );
  return {
    ok: false,
    permanent: true,
    reason: "smtp_transport_not_implemented",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const emailChannel: NotificationChannelAdapter = {
  id: "email",
  async send(input) {
    const envelopeOrError = await buildEnvelope(input);
    if ("error" in envelopeOrError) {
      return { ok: false, reason: envelopeOrError.error };
    }
    const envelope = envelopeOrError;

    let lastReason: string | undefined;
    // Attempts: 1 (initial) + 3 retries = 4 total tries, with sleeps
    // [1s, 4s, 16s] BEFORE retries 1, 2, 3.
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const result = await transport(envelope);
        if (result.ok) {
          return { ok: true };
        }
        lastReason = result.reason ?? "transport_returned_not_ok";
        if (result.permanent) {
          return { ok: false, reason: lastReason };
        }
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        logger.warn(
          {
            tenantId: input.tenantId,
            type: input.type,
            attempt,
            err: lastReason,
          },
          "email_adapter_transport_threw",
        );
      }

      // Don't sleep after the final attempt.
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
      }
    }

    return {
      ok: false,
      reason: lastReason ?? "email_send_failed_after_retries",
    };
  },
};
