import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

/**
 * Local PostgreSQL gives you plenty of connections by default. If you ever swap in a hosted/pooled
 * Postgres that caps connection_limit (e.g. 1), parallel Prisma calls in one request can throw
 * P2024 "Timed out fetching a new connection". Mitigations then: serialize hot paths (see speak())
 * or append `?connection_limit=5&pool_timeout=30` to DATABASE_URL.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
