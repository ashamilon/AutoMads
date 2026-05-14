import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

/**
 * Hosted Postgres (Supabase pooled, etc.) sometimes exposes connection_limit=1 — parallel Prisma calls
 * in one request can then throw P2024 "Timed out fetching a new connection". Mitigations: serialize
 * hot paths (see speak()), append `?connection_limit=5&pool_timeout=30` to DATABASE_URL where allowed,
 * or use Supabase Session pooler mode + higher limits.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
