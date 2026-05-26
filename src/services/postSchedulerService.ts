import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { publishScheduledPost } from "./socialPostService.js";
import { processDueFollowUps } from "../agent/followUp.js";
import { runContentAgentForAllTenants } from "./contentAgentService.js";

const POLL_INTERVAL_MS = 60_000;
const CONTENT_AGENT_INTERVAL_MS = 60 * 60 * 1000; // hourly
let running = false;
let lastContentAgentRun = 0;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const duePosts = await prisma.scheduledPost.findMany({
      where: {
        status: "scheduled",
        scheduledAt: { lte: new Date() },
      },
      take: 10,
      orderBy: { scheduledAt: "asc" },
    });

    for (const post of duePosts) {
      try {
        await publishScheduledPost(post.id);
      } catch (e) {
        logger.error({ e: String(e), postId: post.id }, "Scheduler: publish failed");
        await prisma.scheduledPost
          .update({
            where: { id: post.id },
            data: { status: "failed", failureReason: String(e) },
          })
          .catch(() => undefined);
      }
    }

    // Phase 2: drain agent follow-ups.
    await processDueFollowUps().catch((e: unknown) =>
      logger.warn({ e: String(e) }, "Scheduler: agent follow-up drain failed"),
    );

    // Phase 3: drain the autonomous content agent. Hourly cadence so we don't
    // spam Ollama; the agent itself enforces the per-tenant daily quota.
    if (Date.now() - lastContentAgentRun >= CONTENT_AGENT_INTERVAL_MS) {
      lastContentAgentRun = Date.now();
      await runContentAgentForAllTenants().catch((e: unknown) =>
        logger.warn({ e: String(e) }, "Scheduler: content agent drain failed"),
      );
    }
  } catch (e) {
    logger.error({ e: String(e) }, "Post scheduler tick error");
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startPostScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, POLL_INTERVAL_MS);
  logger.info("Post scheduler started (60s interval)");
}

export function stopPostScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
