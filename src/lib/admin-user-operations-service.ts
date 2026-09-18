import { Prisma, type PrismaClient } from "@prisma/client";
import { getDb, getEntitlementDb } from "@/lib/db";

export type AdminUserOperationsErrorCode =
  | "ADMIN_USER_OPERATIONS_ADMIN_REQUIRED"
  | "ADMIN_USER_OPERATIONS_USER_NOT_FOUND";

export class AdminUserOperationsError extends Error {
  constructor(readonly code: AdminUserOperationsErrorCode) {
    super(code);
    this.name = "AdminUserOperationsError";
  }
}

type OperationsDb = PrismaClient;

function fail(code: AdminUserOperationsErrorCode): never {
  throw new AdminUserOperationsError(code);
}

type ActorSnapshot = Readonly<{
  id: string;
  role: string;
  disabledAt: Date | null;
  accountAccessVersion: number;
}>;

async function assertAdmin(
  actorId: string,
  expectedAccountAccessVersion: number,
  db: OperationsDb,
): Promise<ActorSnapshot> {
  const actor = await db.appUser.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, disabledAt: true, accountAccessVersion: true },
  });
  if (
    actor === null
    || actor.role !== "admin"
    || actor.disabledAt !== null
    || actor.accountAccessVersion !== expectedAccountAccessVersion
  ) return fail("ADMIN_USER_OPERATIONS_ADMIN_REQUIRED");
  return actor;
}

type GrantRow = Readonly<{
  id: string;
  kind: "signup" | "manual";
  amount: number;
  remainingTokens: number;
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
  allocations: ReadonlyArray<{
    reservedTokens: number;
    settledTokens: number;
    releasedTokens: number;
  }>;
}>;

type CreditSummary = Readonly<{
  grantCount: number;
  activeGrantCount: number;
  availableTokens: number;
  reservedTokens: number;
  difference: "disabled" | "missing" | "available" | "exhausted" | "expired" | "revoked";
}>;

type SafeUser = Readonly<{
  id: string;
  username: string;
  displayName: string | null;
  state: "enabled" | "disabled";
  disabledAt: Date | null;
  accountAccessVersion: number;
}>;

type SafeMembership = Readonly<{
  state: "none" | "active" | "expired" | "revoked";
  status: "active" | "revoked" | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  version: number;
}>;

const grantSelect: Prisma.PlatformTokenGrantSelect = {
  id: true,
  kind: true,
  amount: true,
  remainingTokens: true,
  expiresAt: true,
  revokedAt: true,
  version: true,
  allocations: {
    where: { reservation: { status: { in: ["reserved", "held"] } } },
    select: { reservedTokens: true, settledTokens: true, releasedTokens: true },
  },
};

function membershipState(
  membership: { status: "active" | "revoked"; startsAt: Date; expiresAt: Date } | null,
  now: Date,
): SafeMembership["state"] {
  if (membership === null) return "none";
  if (membership.status === "revoked") return "revoked";
  if (membership.startsAt > now) return "expired";
  return membership.expiresAt > now ? "active" : "expired";
}

function summarizeCredits(
  grants: ReadonlyArray<GrantRow>,
  disabled: boolean,
  now: Date,
): CreditSummary {
  const active = grants.filter((grant) => grant.revokedAt === null && grant.expiresAt > now);
  const availableTokens = active.reduce((sum, grant) => sum + grant.remainingTokens, 0);
  const reservedTokens = active.reduce(
    (sum, grant) => sum + grant.allocations.reduce(
      (allocationSum, allocation) => allocationSum + allocation.reservedTokens - allocation.settledTokens - allocation.releasedTokens,
      0,
    ),
    0,
  );
  const difference: CreditSummary["difference"] = disabled
    ? "disabled"
    : grants.length === 0
      ? "missing"
      : availableTokens > 0
        ? "available"
        : active.length > 0
          ? "exhausted"
          : grants.some((grant) => grant.revokedAt === null) ? "expired" : "revoked";
  return Object.freeze({
    grantCount: grants.length,
    activeGrantCount: active.length,
    availableTokens,
    reservedTokens,
    difference,
  });
}

function mapUser(
  row: Readonly<{
    id: string;
    username: string;
    displayName: string | null;
    disabledAt: Date | null;
    accountAccessVersion: number;
    membershipSubscription: { status: "active" | "revoked"; startsAt: Date; expiresAt: Date; version: number } | null;
  }>,
  grants: ReadonlyArray<GrantRow>,
  now: Date,
): AdminUserSummary {
  const disabled = row.disabledAt !== null;
  return Object.freeze({
    user: Object.freeze({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      state: disabled ? "disabled" : "enabled",
      disabledAt: row.disabledAt,
      accountAccessVersion: row.accountAccessVersion,
    }),
    membership: Object.freeze({
      state: membershipState(row.membershipSubscription, now),
      status: row.membershipSubscription?.status ?? null,
      startsAt: row.membershipSubscription?.startsAt ?? null,
      expiresAt: row.membershipSubscription?.expiresAt ?? null,
      version: row.membershipSubscription?.version ?? 0,
    }),
    credits: summarizeCredits(grants, disabled, now),
  });
}

export type AdminUserSummary = Readonly<{
  user: SafeUser;
  membership: SafeMembership;
  credits: CreditSummary;
}>;

export type AdminUserListResult = Readonly<{
  items: readonly AdminUserSummary[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export async function listAdminUsers(input: Readonly<{
  adminUserId: string;
  adminAccountAccessVersion: number;
  search?: string;
  page?: number;
  pageSize?: number;
}>, db: OperationsDb = getDb(), entitlementDb: OperationsDb = getEntitlementDb()): Promise<AdminUserListResult> {
  await assertAdmin(input.adminUserId, input.adminAccountAccessVersion, db);
  const page = Number.isSafeInteger(input.page) && (input.page ?? 1) >= 1 ? input.page ?? 1 : 1;
  const pageSize = Number.isSafeInteger(input.pageSize) && (input.pageSize ?? 20) >= 1 ? Math.min(input.pageSize ?? 20, 100) : 20;
  const search = input.search?.trim().slice(0, 160) ?? "";
  const where: Prisma.AppUserWhereInput = {
    role: "user",
    ...(search.length === 0 ? {} : {
      OR: [
        { username: { contains: search, mode: "insensitive" } },
        { displayName: { contains: search, mode: "insensitive" } },
      ],
    }),
  };
  const rows = await db.appUser.findMany({
    where,
    orderBy: [{ username: "asc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: {
      id: true,
      username: true,
      displayName: true,
      disabledAt: true,
      accountAccessVersion: true,
      membershipSubscription: { select: { status: true, startsAt: true, expiresAt: true, version: true } },
    },
  });
  const hasNextPage = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const grantRows = await entitlementDb.platformTokenGrant.findMany({
    where: { userId: { in: pageRows.map((row) => row.id) }, user: { role: "user" } },
    select: { ...grantSelect, userId: true },
  });
  const grantsByUser = new Map<string, GrantRow[]>();
  for (const grant of grantRows) {
    const current = grantsByUser.get(grant.userId) ?? [];
    current.push(grant);
    grantsByUser.set(grant.userId, current);
  }
  const now = new Date();
  return Object.freeze({
    items: Object.freeze(pageRows.map((row) => mapUser(row, grantsByUser.get(row.id) ?? [], now))),
    page,
    pageSize,
    hasNextPage,
  });
}

export type AdminUserOperationsDetail = Readonly<{
  summary: AdminUserSummary;
  membershipApplication: Readonly<{
    id: string;
    status: "pending" | "fulfilled" | "rejected" | "withdrawn";
    statusVersion: number;
    submittedAt: Date;
    fulfilledAt: Date | null;
    rejectedAt: Date | null;
    withdrawnAt: Date | null;
  }> | null;
  records: Readonly<{
    account: readonly Readonly<{ event: string; version: number; occurredAt: Date }>[];
    membership: readonly Readonly<{ event: string; status: string; version: number | null; occurredAt: Date }>[];
    credits: readonly Readonly<{ event: string; status: string; version: number; amount: number; remainingTokens: number; occurredAt: Date }>[];
  }>;
}>;

export async function getAdminUserOperationsDetail(input: Readonly<{
  adminUserId: string;
  adminAccountAccessVersion: number;
  userId: string;
}>, db: OperationsDb = getDb(), entitlementDb: OperationsDb = getEntitlementDb()): Promise<AdminUserOperationsDetail> {
  await assertAdmin(input.adminUserId, input.adminAccountAccessVersion, db);
  const target = await db.appUser.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      disabledAt: true,
      accountAccessVersion: true,
      role: true,
      membershipSubscription: { select: { status: true, startsAt: true, expiresAt: true, version: true } },
      _count: { select: { sessions: true } },
    },
  });
  if (target === null || target.role !== "user") return fail("ADMIN_USER_OPERATIONS_USER_NOT_FOUND");
  const [grants, accountRecords, membershipRecords, creditRecords, membershipApplication] = await Promise.all([
    entitlementDb.platformTokenGrant.findMany({ where: { userId: target.id, user: { role: "user" } }, select: grantSelect }),
    db.accountAccessAudit.findMany({ where: { userId: target.id }, orderBy: [{ transitionAt: "desc" }, { id: "desc" }], take: 8, select: { event: true, versionAfter: true, transitionAt: true } }),
    db.membershipSubscriptionAudit.findMany({ where: { userId: target.id }, orderBy: [{ transitionAt: "desc" }, { id: "desc" }], take: 8, select: { eventKind: true, statusAfter: true, versionAfter: true, transitionAt: true } }),
    entitlementDb.platformTokenGrantAudit.findMany({ where: { userId: target.id }, orderBy: [{ transitionAt: "desc" }, { id: "desc" }], take: 8, select: { event: true, statusAfter: true, versionAfter: true, amount: true, remainingAfter: true, transitionAt: true } }),
    db.membershipApplication.findFirst({
      where: { userId: target.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, status: true, statusVersion: true, submittedAt: true, fulfilledAt: true, rejectedAt: true, withdrawnAt: true },
    }),
  ]);
  const now = new Date();
  return Object.freeze({
    summary: mapUser(target, grants, now),
    membershipApplication: membershipApplication === null ? null : Object.freeze({
      id: membershipApplication.id,
      status: membershipApplication.status,
      statusVersion: membershipApplication.statusVersion,
      submittedAt: membershipApplication.submittedAt,
      fulfilledAt: membershipApplication.fulfilledAt,
      rejectedAt: membershipApplication.rejectedAt,
      withdrawnAt: membershipApplication.withdrawnAt,
    }),
    records: Object.freeze({
      account: Object.freeze(accountRecords.map((record) => ({ event: record.event, version: record.versionAfter, occurredAt: record.transitionAt }))),
      membership: Object.freeze(membershipRecords.map((record) => ({ event: record.eventKind, status: record.statusAfter ?? "unknown", version: record.versionAfter, occurredAt: record.transitionAt }))),
      credits: Object.freeze(creditRecords.map((record) => ({ event: record.event, status: record.statusAfter, version: record.versionAfter, amount: record.amount, remainingTokens: record.remainingAfter, occurredAt: record.transitionAt }))),
    }),
  });
}
