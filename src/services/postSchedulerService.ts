import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { publishScheduledPost } from "./socialPostService.js";

const POLL_INTERVAL_MS = 60_000;
let running = false;

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
        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: { status: "failed", failureReason: String(e) },
        }).catch(() => undefined);
      }
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
