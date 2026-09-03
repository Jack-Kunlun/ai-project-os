import type { PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";
import { APP_VERSION } from "@/lib/version";
import { readWorkerHealth, type WorkerHealthSummary } from "@/lib/worker-health";

export type SystemOverview = Readonly<{
  service: Readonly<{
    application: "up";
    version: string;
    database: "up";
    worker: WorkerHealthSummary;
    measuredAt: string;
  }>;
  counts: Readonly<{
    users: number;
    activeMemberships: number;
    verifiedPlatformModels: number;
  }>;
  tokens: Readonly<{
    issuedTokens: number;
    availableTokens: number;
    reservedTokens: number;
    consumedTokens: number;
  }>;
}>;

function aggregateValue(value: number | null | undefined): number {
  return value ?? 0;
}

export async function getSystemOverview(db: PrismaClient = getDb(), now = new Date()): Promise<SystemOverview> {
  await db.$queryRaw`SELECT 1`;
  const [users, activeMemberships, verifiedPlatformModels, issued, available, reserved, consumed, worker] = await Promise.all([
    db.appUser.count(),
    db.membershipSubscription.count({ where: { status: "active", startsAt: { lte: now }, expiresAt: { gt: now } } }),
    db.aiProviderConnection.count({ where: { scope: "platform", status: "verified", disabledAt: null } }),
    db.platformTokenGrant.aggregate({ _sum: { amount: true } }),
    db.platformTokenGrant.aggregate({ where: { revokedAt: null, expiresAt: { gt: now } }, _sum: { remainingTokens: true } }),
    db.platformTokenReservation.aggregate({ where: { status: { in: ["reserved", "held"] } }, _sum: { reservedTokens: true } }),
    db.platformTokenReservation.aggregate({ where: { status: "settled", settledTokens: { not: null } }, _sum: { settledTokens: true } }),
    readWorkerHealth(db, { now }),
  ]);

  return Object.freeze({
    service: { application: "up", version: APP_VERSION, database: "up", worker, measuredAt: now.toISOString() },
    counts: { users, activeMemberships, verifiedPlatformModels },
    tokens: {
      issuedTokens: aggregateValue(issued._sum.amount),
      availableTokens: aggregateValue(available._sum.remainingTokens),
      reservedTokens: aggregateValue(reserved._sum.reservedTokens),
      consumedTokens: aggregateValue(consumed._sum.settledTokens),
    },
  });
}
