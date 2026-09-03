import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockMembershipUser } from "@/lib/ai-entitlements";
import { getDb } from "@/lib/db";

export type MembershipServiceErrorCode =
  | "MEMBERSHIP_INVALID_INPUT"
  | "MEMBERSHIP_USER_NOT_FOUND"
  | "MEMBERSHIP_NOT_FOUND"
  | "MEMBERSHIP_CONFLICT"
  | "MEMBERSHIP_ADMIN_REQUIRED";

export class MembershipServiceError extends Error {
  constructor(readonly code: MembershipServiceErrorCode) {
    super(code);
    this.name = "MembershipServiceError";
  }
}

const userIdSchema = z.string().uuid();
const daysSchema = z.number().int().min(1).max(3650);
/**
 * Membership mutations may wait for the bounded 55-second workspace
 * provider probe while it holds the same owner advisory lock. Keep a finite
 * margin for the waiting transaction rather than relying on Prisma's 5s
 * interactive-transaction default.
 */
const MEMBERSHIP_MUTATION_TRANSACTION_TIMEOUT_MS = 65_000;

function fail(code: MembershipServiceErrorCode): never {
  throw new MembershipServiceError(code);
}

async function assertAdmin(adminUserId: string, db: PrismaClient): Promise<void> {
  const admin = await db.appUser.findUnique({ where: { id: adminUserId }, select: { role: true, disabledAt: true } });
  if (admin === null || admin.disabledAt !== null || admin.role !== "admin") return fail("MEMBERSHIP_ADMIN_REQUIRED");
}

const publicSubscription = {
  id: true,
  userId: true,
  status: true,
  startsAt: true,
  expiresAt: true,
  revokedAt: true,
  note: true,
  version: true,
  grantedById: true,
  revokedById: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listMemberships(input: Readonly<{
  adminUserId: string;
  search?: string;
  page?: number;
  pageSize?: number;
}>, db: PrismaClient = getDb()) {
  await assertAdmin(input.adminUserId, db);
  const page = Number.isSafeInteger(input.page) && (input.page ?? 1) >= 1 ? input.page ?? 1 : 1;
  const pageSize = Number.isSafeInteger(input.pageSize) && (input.pageSize ?? 20) >= 1 ? Math.min(input.pageSize ?? 20, 100) : 20;
  const search = input.search?.trim().slice(0, 160) ?? "";
  const where: Prisma.AppUserWhereInput = search.length === 0 ? {} : {
    OR: [
      { username: { contains: search, mode: "insensitive" } },
      { displayName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ],
  };
  const users = await db.appUser.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      role: true,
      disabledAt: true,
      membershipSubscription: { select: publicSubscription },
    },
  });
  const hasNextPage = users.length > pageSize;
  return Object.freeze({ items: users.slice(0, pageSize), page, pageSize, hasNextPage });
}

export async function grantOrExtendMembership(input: Readonly<{
  adminUserId: string;
  userId: string;
  days: number;
  note?: string | null;
  expectedVersion?: number | null;
}>, db: PrismaClient = getDb()) {
  const userId = userIdSchema.safeParse(input.userId);
  if (!userId.success || !Number.isSafeInteger(input.days) || !daysSchema.safeParse(input.days).success) return fail("MEMBERSHIP_INVALID_INPUT");
  const note = input.note === undefined || input.note === null || input.note === "" ? null : input.note.trim();
  if (note !== null && (note.length > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(note))) return fail("MEMBERSHIP_INVALID_INPUT");
  await assertAdmin(input.adminUserId, db);
  try {
    return await db.$transaction(async (tx) => {
      await lockMembershipUser(tx, input.userId);
      const target = await tx.appUser.findUnique({ where: { id: input.userId }, select: { id: true, disabledAt: true } });
      if (target === null) return fail("MEMBERSHIP_USER_NOT_FOUND");
      const existing = await tx.membershipSubscription.findUnique({ where: { userId: input.userId } });
      if (input.expectedVersion !== undefined && (existing?.version ?? 0) !== input.expectedVersion) return fail("MEMBERSHIP_CONFLICT");
      const now = new Date();
      const base = existing !== null && existing.status === "active" && existing.expiresAt > now ? existing.expiresAt : now;
      const expiresAt = new Date(base.getTime() + input.days * 24 * 60 * 60 * 1_000);
      const subscription = existing === null
        ? await tx.membershipSubscription.create({ data: { userId: input.userId, status: "active", startsAt: now, expiresAt, grantedById: input.adminUserId, note }, select: publicSubscription })
        : await tx.membershipSubscription.update({
            where: { userId: input.userId },
            data: { status: "active", startsAt: existing.startsAt > now ? now : existing.startsAt, expiresAt, grantedById: input.adminUserId, revokedById: null, revokedAt: null, note, version: { increment: 1 } },
            select: publicSubscription,
          });
      await tx.membershipSubscriptionAudit.create({
        data: {
          id: randomUUID(),
          subscriptionId: subscription.id,
          userId: input.userId,
          actorId: input.adminUserId,
          eventKind: existing === null ? "grant" : "extend",
          startsAt: subscription.startsAt,
          expiresAt: subscription.expiresAt,
          note,
        },
      });
      return Object.freeze(subscription);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: MEMBERSHIP_MUTATION_TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) return fail("MEMBERSHIP_CONFLICT");
    throw error;
  }
}

export async function revokeMembership(input: Readonly<{
  adminUserId: string;
  userId: string;
  expectedVersion?: number | null;
}>, db: PrismaClient = getDb()) {
  const parsed = userIdSchema.safeParse(input.userId);
  if (!parsed.success) return fail("MEMBERSHIP_INVALID_INPUT");
  await assertAdmin(input.adminUserId, db);
  try {
    return await db.$transaction(async (tx) => {
      await lockMembershipUser(tx, input.userId);
      const existing = await tx.membershipSubscription.findUnique({ where: { userId: input.userId } });
      if (existing === null) return fail("MEMBERSHIP_NOT_FOUND");
      if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) return fail("MEMBERSHIP_CONFLICT");
      const now = new Date();
      const revoked = await tx.membershipSubscription.updateMany({
        where: { userId: input.userId, version: existing.version },
        data: { status: "revoked", revokedById: input.adminUserId, revokedAt: now, version: { increment: 1 } },
      });
      if (revoked.count !== 1) return fail("MEMBERSHIP_CONFLICT");
      const subscription = await tx.membershipSubscription.findUniqueOrThrow({ where: { userId: input.userId }, select: publicSubscription });
      await tx.membershipSubscriptionAudit.create({
        data: {
          id: randomUUID(),
          subscriptionId: subscription.id,
          userId: input.userId,
          actorId: input.adminUserId,
          eventKind: "revoke",
          startsAt: subscription.startsAt,
          expiresAt: subscription.expiresAt,
          note: subscription.note,
        },
      });
      return Object.freeze(subscription);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: MEMBERSHIP_MUTATION_TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) return fail("MEMBERSHIP_CONFLICT");
    throw error;
  }
}
