import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * PostgreSQL gates must seed memberships through the same v2 lifecycle
 * contract as production.  This helper is intentionally test-only: it
 * creates a complete preview/subscription/audit tuple while retaining the
 * database guards, so fixtures can use deterministic timestamps without
 * adding a production-only trigger escape hatch.
 */
type MembershipTransaction = Prisma.TransactionClient;

type ControlledMembershipInput = Readonly<{
  adminId: string;
  userId: string;
  startsAt: Date;
  expiresAt: Date;
  grantedById?: string | null;
  note?: string | null;
}>;

type ControlledMembershipRow = Readonly<{
  id: string;
  userId: string;
  status: "active" | "revoked";
  startsAt: Date;
  expiresAt: Date;
  grantedById: string | null;
  revokedById: string | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  note: string | null;
  version: number;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function setPreviewContext(
  tx: MembershipTransaction,
  input: Readonly<{ previewId: string; actorId: string; userId: string }>,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_context', '1', true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_id', ${input.previewId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_actor_id', ${input.actorId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_user_id', ${input.userId}, true)`);
}

async function setLifecycleContext(
  tx: MembershipTransaction,
  input: Readonly<{
    actorId: string;
    userId: string;
    action: "grant" | "extend" | "revoke";
    requestKey: string;
    requestFingerprint: string;
    impactFingerprint: string;
    previewId: string;
  }>,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_context', '1', true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_actor_id', ${input.actorId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_user_id', ${input.userId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_action', ${input.action}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_request_key', ${input.requestKey}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_request_fingerprint', ${input.requestFingerprint}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_impact_fingerprint', ${input.impactFingerprint}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_preview_id', ${input.previewId}, true)`);
}

async function insertGrantAudit(
  tx: MembershipTransaction,
  input: Readonly<{
    subscription: ControlledMembershipRow;
    adminId: string;
    previewId: string;
    requestKey: string;
    requestFingerprint: string;
    impactFingerprint: string;
    transitionAt: Date;
    reason: string;
  }>,
): Promise<void> {
  await tx.membershipSubscriptionAudit.create({
    data: {
      id: randomUUID(),
      subscriptionId: input.subscription.id,
      userId: input.subscription.userId,
      actorId: input.adminId,
      eventKind: "grant",
      startsAt: input.subscription.startsAt,
      expiresAt: input.subscription.expiresAt,
      note: input.subscription.note,
      versionBefore: null,
      versionAfter: input.subscription.version,
      statusBefore: null,
      statusAfter: input.subscription.status,
      startsAtBefore: null,
      startsAtAfter: input.subscription.startsAt,
      expiresAtBefore: null,
      expiresAtAfter: input.subscription.expiresAt,
      revokedAtBefore: null,
      revokedAtAfter: input.subscription.revokedAt,
      revocationReasonBefore: null,
      revocationReasonAfter: input.subscription.revocationReason,
      noteBefore: null,
      noteAfter: input.subscription.note,
      grantedByIdBefore: null,
      grantedByIdAfter: input.subscription.grantedById,
      revokedByIdBefore: null,
      revokedByIdAfter: input.subscription.revokedById,
      reason: input.reason,
      requestKey: input.requestKey,
      requestFingerprint: input.requestFingerprint,
      impactFingerprint: input.impactFingerprint,
      previewId: input.previewId,
      transitionAt: input.transitionAt,
      createdAt: input.transitionAt,
      contractVersion: 2,
    },
  });
}

export async function createControlledMembershipInTransaction(
  tx: MembershipTransaction,
  input: ControlledMembershipInput,
): Promise<ControlledMembershipRow> {
  const previewId = randomUUID();
  const transitionAt = new Date();
  const requestKey = `membership-fixture-grant-${randomUUID().slice(0, 8)}`;
  const impactFingerprint = digest(`membership-fixture-impact:${previewId}`);
  const requestFingerprint = digest(`membership-fixture-request:${previewId}`);
  await setPreviewContext(tx, { previewId, actorId: input.adminId, userId: input.userId });
  await tx.membershipMutationPreview.create({
    data: {
      id: previewId,
      actorId: input.adminId,
      userId: input.userId,
      action: "grant",
      expectedVersion: 0,
      impactFingerprint,
      requestFingerprint,
      issuedAt: new Date(transitionAt.getTime() - 1_000),
      expiresAt: new Date(transitionAt.getTime() + 5 * 60 * 1_000),
      consumedAt: transitionAt,
      createdAt: transitionAt,
    },
  });
  await setLifecycleContext(tx, {
    actorId: input.adminId,
    userId: input.userId,
    action: "grant",
    requestKey,
    requestFingerprint,
    impactFingerprint,
    previewId,
  });
  const subscription = await tx.membershipSubscription.create({
    data: {
      id: randomUUID(),
      userId: input.userId,
      status: "active",
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      grantedById: input.grantedById ?? input.adminId,
      note: input.note ?? null,
      version: 1,
    },
  });
  await insertGrantAudit(tx, {
    subscription,
    adminId: input.adminId,
    previewId,
    requestKey,
    requestFingerprint,
    impactFingerprint,
    transitionAt,
    reason: "membership_fixture_grant",
  });
  return subscription;
}

export async function createControlledMembership(
  db: PrismaClient,
  input: ControlledMembershipInput,
): Promise<ControlledMembershipRow> {
  return db.$transaction((tx) => createControlledMembershipInTransaction(tx, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

export async function revokeControlledMembershipInTransaction(
  tx: MembershipTransaction,
  input: Readonly<{ subscriptionId: string; adminId: string; reason: string; transitionAt?: Date }>,
): Promise<ControlledMembershipRow> {
  const before = await tx.membershipSubscription.findUniqueOrThrow({ where: { id: input.subscriptionId } });
  const previewId = randomUUID();
  const transitionAt = input.transitionAt ?? new Date();
  const requestKey = `membership-fixture-revoke-${randomUUID().slice(0, 8)}`;
  const impactFingerprint = digest(`membership-fixture-impact:${previewId}`);
  const requestFingerprint = digest(`membership-fixture-request:${previewId}`);
  await setPreviewContext(tx, { previewId, actorId: input.adminId, userId: before.userId });
  await tx.membershipMutationPreview.create({
    data: {
      id: previewId,
      actorId: input.adminId,
      userId: before.userId,
      action: "revoke",
      expectedVersion: before.version,
      impactFingerprint,
      requestFingerprint,
      issuedAt: new Date(transitionAt.getTime() - 1_000),
      expiresAt: new Date(transitionAt.getTime() + 5 * 60 * 1_000),
      createdAt: transitionAt,
    },
  });
  await setLifecycleContext(tx, {
    actorId: input.adminId,
    userId: before.userId,
    action: "revoke",
    requestKey,
    requestFingerprint,
    impactFingerprint,
    previewId,
  });
  const subscription = await tx.membershipSubscription.update({
    where: { id: before.id },
    data: {
      status: "revoked",
      revokedAt: transitionAt,
      revokedById: input.adminId,
      revocationReason: input.reason,
      version: { increment: 1 },
    },
  });
  await tx.membershipSubscriptionAudit.create({
    data: {
      id: randomUUID(),
      subscriptionId: subscription.id,
      userId: subscription.userId,
      actorId: input.adminId,
      eventKind: "revoke",
      startsAt: subscription.startsAt,
      expiresAt: subscription.expiresAt,
      note: subscription.note,
      versionBefore: before.version,
      versionAfter: subscription.version,
      statusBefore: before.status,
      statusAfter: subscription.status,
      startsAtBefore: before.startsAt,
      startsAtAfter: subscription.startsAt,
      expiresAtBefore: before.expiresAt,
      expiresAtAfter: subscription.expiresAt,
      revokedAtBefore: before.revokedAt,
      revokedAtAfter: subscription.revokedAt,
      revocationReasonBefore: before.revocationReason,
      revocationReasonAfter: subscription.revocationReason,
      noteBefore: before.note,
      noteAfter: subscription.note,
      grantedByIdBefore: before.grantedById,
      grantedByIdAfter: subscription.grantedById,
      revokedByIdBefore: before.revokedById,
      revokedByIdAfter: subscription.revokedById,
      reason: input.reason,
      requestKey,
      requestFingerprint,
      impactFingerprint,
      previewId,
      transitionAt,
      createdAt: transitionAt,
      contractVersion: 2,
    },
  });
  await tx.membershipMutationPreview.update({ where: { id: previewId }, data: { consumedAt: transitionAt } });
  return subscription;
}

export async function grantControlledMembershipInTransaction(
  tx: MembershipTransaction,
  input: Readonly<{
    subscriptionId: string;
    adminId: string;
    startsAt: Date;
    expiresAt: Date;
    grantedById?: string | null;
    note?: string | null;
    transitionAt?: Date;
  }>,
): Promise<ControlledMembershipRow> {
  const before = await tx.membershipSubscription.findUniqueOrThrow({ where: { id: input.subscriptionId } });
  const previewId = randomUUID();
  const transitionAt = input.transitionAt ?? new Date();
  const requestKey = `membership-fixture-grant-${randomUUID().slice(0, 8)}`;
  const impactFingerprint = digest(`membership-fixture-impact:${previewId}`);
  const requestFingerprint = digest(`membership-fixture-request:${previewId}`);
  await setPreviewContext(tx, { previewId, actorId: input.adminId, userId: before.userId });
  await tx.membershipMutationPreview.create({
    data: {
      id: previewId,
      actorId: input.adminId,
      userId: before.userId,
      action: "grant",
      expectedVersion: before.version,
      impactFingerprint,
      requestFingerprint,
      issuedAt: new Date(transitionAt.getTime() - 1_000),
      expiresAt: new Date(transitionAt.getTime() + 5 * 60 * 1_000),
      createdAt: transitionAt,
    },
  });
  await setLifecycleContext(tx, {
    actorId: input.adminId,
    userId: before.userId,
    action: "grant",
    requestKey,
    requestFingerprint,
    impactFingerprint,
    previewId,
  });
  const subscription = await tx.membershipSubscription.update({
    where: { id: before.id },
    data: {
      status: "active",
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      grantedById: input.grantedById ?? input.adminId,
      revokedById: null,
      revokedAt: null,
      revocationReason: null,
      note: input.note ?? null,
      version: { increment: 1 },
    },
  });
  await tx.membershipSubscriptionAudit.create({
    data: {
      id: randomUUID(),
      subscriptionId: subscription.id,
      userId: subscription.userId,
      actorId: input.adminId,
      eventKind: "grant",
      startsAt: subscription.startsAt,
      expiresAt: subscription.expiresAt,
      note: subscription.note,
      versionBefore: before.version,
      versionAfter: subscription.version,
      statusBefore: before.status,
      statusAfter: subscription.status,
      startsAtBefore: before.startsAt,
      startsAtAfter: subscription.startsAt,
      expiresAtBefore: before.expiresAt,
      expiresAtAfter: subscription.expiresAt,
      revokedAtBefore: before.revokedAt,
      revokedAtAfter: subscription.revokedAt,
      revocationReasonBefore: before.revocationReason,
      revocationReasonAfter: subscription.revocationReason,
      noteBefore: before.note,
      noteAfter: subscription.note,
      grantedByIdBefore: before.grantedById,
      grantedByIdAfter: subscription.grantedById,
      revokedByIdBefore: before.revokedById,
      revokedByIdAfter: subscription.revokedById,
      reason: "membership_fixture_grant",
      requestKey,
      requestFingerprint,
      impactFingerprint,
      previewId,
      transitionAt,
      createdAt: transitionAt,
      contractVersion: 2,
    },
  });
  await tx.membershipMutationPreview.update({ where: { id: previewId }, data: { consumedAt: transitionAt } });
  return subscription;
}

export async function extendControlledMembershipInTransaction(
  tx: MembershipTransaction,
  input: Readonly<{ subscriptionId: string; adminId: string; expiresAt: Date; note?: string | null; transitionAt?: Date }>,
): Promise<ControlledMembershipRow> {
  const before = await tx.membershipSubscription.findUniqueOrThrow({ where: { id: input.subscriptionId } });
  const previewId = randomUUID();
  const transitionAt = input.transitionAt ?? new Date();
  const requestKey = `membership-fixture-extend-${randomUUID().slice(0, 8)}`;
  const impactFingerprint = digest(`membership-fixture-impact:${previewId}`);
  const requestFingerprint = digest(`membership-fixture-request:${previewId}`);
  await setPreviewContext(tx, { previewId, actorId: input.adminId, userId: before.userId });
  await tx.membershipMutationPreview.create({
    data: {
      id: previewId,
      actorId: input.adminId,
      userId: before.userId,
      action: "extend",
      expectedVersion: before.version,
      impactFingerprint,
      requestFingerprint,
      issuedAt: new Date(transitionAt.getTime() - 1_000),
      expiresAt: new Date(transitionAt.getTime() + 5 * 60 * 1_000),
      createdAt: transitionAt,
    },
  });
  await setLifecycleContext(tx, {
    actorId: input.adminId,
    userId: before.userId,
    action: "extend",
    requestKey,
    requestFingerprint,
    impactFingerprint,
    previewId,
  });
  const subscription = await tx.membershipSubscription.update({
    where: { id: before.id },
    data: { status: "active", expiresAt: input.expiresAt, note: input.note ?? null, version: { increment: 1 } },
  });
  await tx.membershipSubscriptionAudit.create({
    data: {
      id: randomUUID(),
      subscriptionId: subscription.id,
      userId: subscription.userId,
      actorId: input.adminId,
      eventKind: "extend",
      startsAt: subscription.startsAt,
      expiresAt: subscription.expiresAt,
      note: subscription.note,
      versionBefore: before.version,
      versionAfter: subscription.version,
      statusBefore: before.status,
      statusAfter: subscription.status,
      startsAtBefore: before.startsAt,
      startsAtAfter: subscription.startsAt,
      expiresAtBefore: before.expiresAt,
      expiresAtAfter: subscription.expiresAt,
      revokedAtBefore: before.revokedAt,
      revokedAtAfter: subscription.revokedAt,
      revocationReasonBefore: before.revocationReason,
      revocationReasonAfter: subscription.revocationReason,
      noteBefore: before.note,
      noteAfter: subscription.note,
      grantedByIdBefore: before.grantedById,
      grantedByIdAfter: subscription.grantedById,
      revokedByIdBefore: before.revokedById,
      revokedByIdAfter: subscription.revokedById,
      reason: "membership_fixture_extend",
      requestKey,
      requestFingerprint,
      impactFingerprint,
      previewId,
      transitionAt,
      createdAt: transitionAt,
      contractVersion: 2,
    },
  });
  await tx.membershipMutationPreview.update({ where: { id: previewId }, data: { consumedAt: transitionAt } });
  return subscription;
}
