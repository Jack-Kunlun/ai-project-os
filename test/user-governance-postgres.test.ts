import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { AccessControlError, type AccessUser } from "../src/lib/access-control";
import { grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  WorkspaceError,
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  getWorkspaceInvitationImpact,
  revokeWorkspaceInvitation,
} from "../src/lib/workspaces";

const shouldRun = process.env.USER_GOVERNANCE_POSTGRES_GATE === "1";
const databaseName = "ai_project_os_user_governance_test";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("USER_GOVERNANCE_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(configuredUrl);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${databaseName}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("USER_GOVERNANCE_TEST_DATABASE_URL_INVALID");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof WorkspaceError || error instanceof AccessControlError ? error.code : undefined;
}

test(
  "workspace invitation governance enforces identity binding, impact fencing and immutable audit",
  { skip: !shouldRun ? "USER_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const ownerId = randomUUID();
    const outsiderId = randomUUID();
    const inviteeId = randomUUID();
    const unverifiedInviteeId = randomUUID();
    const owner: AccessUser = { id: ownerId, role: "user", accountAccessVersion: 1 };
    const outsider: AccessUser = { id: outsiderId, role: "admin", accountAccessVersion: 1 };

    await db.appUser.createMany({ data: [
      { id: ownerId, username: `governance_owner_${suffix}`, email: `owner-${suffix}@example.com`, role: "user" },
      { id: outsiderId, username: `governance_admin_${suffix}`, email: `admin-${suffix}@example.com`, role: "admin" },
      { id: inviteeId, username: `governance_invitee_${suffix}`, email: `invitee-${suffix}@example.com`, emailVerifiedAt: new Date(), role: "user" },
      { id: unverifiedInviteeId, username: `governance_unverified_${suffix}`, email: `unverified-${suffix}@example.com`, role: "user" },
    ] });
    await db.workspace.create({ data: { id: workspaceId, name: `Governance ${suffix}`, slug: `governance-${suffix}`, createdById: ownerId } });
    await db.project.create({ data: { id: projectId, workspaceId, name: `Governance project ${suffix}`, slug: `governance-project-${suffix}` } });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "user_governance_gate_owner_fixture" });
    });

    try {
      await assert.rejects(
        () => createWorkspaceInvitation(workspaceId, { email: `blocked-${suffix}@example.com`, workspaceRole: "admin", requestKey: randomUUID() }, outsider, db),
        (error: unknown) => errorCode(error) === "ACCESS_FORBIDDEN",
      );
      await assert.rejects(
        () => createWorkspaceInvitation(workspaceId, { email: null, workspaceRole: "member", requestKey: randomUUID() }, owner, db),
        (error: unknown) => error instanceof Error,
      );
      const unverifiedInvitation = await createWorkspaceInvitation(workspaceId, { email: `unverified-${suffix}@example.com`, workspaceRole: "member", requestKey: randomUUID() }, owner, db);
      await assert.rejects(
        () => acceptWorkspaceInvitation(unverifiedInvitation.token, { id: unverifiedInviteeId }, "/dashboard", db),
        (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_EMAIL_UNVERIFIED",
      );

      const requestKey = randomUUID();
      const createInput = { email: `invitee-${suffix}@example.com`, workspaceRole: "admin" as const, projectId, projectRole: "owner" as const, expiresInDays: 7, requestKey };
      const created = await createWorkspaceInvitation(workspaceId, createInput, owner, db);
      assert.equal(created.alreadyCreated, false);
      assert.equal(typeof created.token, "string");
      assert.equal(created.invitation.email, createInput.email);
      assert.equal(created.invitation.projectId, projectId);
      const replay = await createWorkspaceInvitation(workspaceId, createInput, owner, db);
      assert.equal(replay.alreadyCreated, true);
      assert.equal(replay.token, null);
      assert.equal(replay.invitation.id, created.invitation.id);
      await assert.rejects(
        () => createWorkspaceInvitation(workspaceId, { ...createInput, email: `other-${suffix}@example.com` }, owner, db),
        (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_IDEMPOTENCY_CONFLICT",
      );

      const impact = await getWorkspaceInvitationImpact(workspaceId, created.invitation.id, owner, db);
      assert.equal(impact.target.status, "pending");
      assert.equal(impact.expectedVersion, created.invitation.version);
      assert.match(impact.impactFingerprint, /^[0-9a-f]{64}$/u);
      assert.deepEqual(impact.blockingCategories, []);
      assert.equal("token" in impact, false);
     assert.equal("tokenHash" in impact, false);
     await assert.rejects(
       () => db.$executeRaw`UPDATE "WorkspaceInvitation" SET "email" = 'tampered-' || ${suffix} || '@example.com' WHERE "id" = ${created.invitation.id}::uuid`,
       (error: unknown) => error instanceof Error,
     );
      await assert.rejects(
        () => db.$executeRaw`UPDATE "WorkspaceInvitation" SET "tokenHash" = ${"c".repeat(64)} WHERE "id" = ${created.invitation.id}::uuid`,
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.$executeRaw`UPDATE "WorkspaceInvitation" SET "version" = 99 WHERE "id" = ${created.invitation.id}::uuid`,
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => revokeWorkspaceInvitation(workspaceId, created.invitation.id, { reason: "  ", requestKey: randomUUID(), expectedVersion: impact.expectedVersion, expectedImpactFingerprint: impact.impactFingerprint, confirmation: true }, owner, db),
        (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_REASON_REQUIRED",
      );
     await assert.rejects(
       () => revokeWorkspaceInvitation(workspaceId, created.invitation.id, { reason: "stale", requestKey: randomUUID(), expectedVersion: impact.expectedVersion, expectedImpactFingerprint: "0".repeat(64), confirmation: true }, owner, db),
       (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_IMPACT_STALE",
     );
      await assert.rejects(
        () => revokeWorkspaceInvitation(workspaceId, created.invitation.id, { reason: "a".repeat(64), requestKey: randomUUID(), expectedVersion: impact.expectedVersion, expectedImpactFingerprint: impact.impactFingerprint, confirmation: true }, owner, db),
        (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_UNSAFE_AUDIT_TEXT",
      );
      await assert.rejects(
        () => revokeWorkspaceInvitation(workspaceId, created.invitation.id, { reason: `remove ${createInput.email}`, requestKey: randomUUID(), expectedVersion: impact.expectedVersion, expectedImpactFingerprint: impact.impactFingerprint, confirmation: true }, owner, db),
        (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_UNSAFE_AUDIT_TEXT",
      );
      await assert.rejects(
        () => revokeWorkspaceInvitation(workspaceId, created.invitation.id, { reason: "scope changed", requestKey: `retry-${createInput.email}`, expectedVersion: impact.expectedVersion, expectedImpactFingerprint: impact.impactFingerprint, confirmation: true }, owner, db),
        (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_UNSAFE_AUDIT_TEXT",
      );
      await assert.rejects(
        () => db.$executeRaw`INSERT INTO "WorkspaceInvitationAudit" ("invitationId", "workspaceId", "event", "versionAfter", "statusAfter", "reason") VALUES (${created.invitation.id}::uuid, ${workspaceId}::uuid, 'created', 1, 'pending', ${`audit ${createInput.email}`})`,
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.$executeRaw`INSERT INTO "WorkspaceInvitationAudit" ("invitationId", "workspaceId", "event", "versionAfter", "statusAfter", "reason", "requestKey") VALUES (${created.invitation.id}::uuid, ${workspaceId}::uuid, 'created', 1, 'pending', 'audit text', ${`retry-${createInput.email}`})`,
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.$executeRaw`UPDATE "WorkspaceInvitation" SET "revokedAt" = CURRENT_TIMESTAMP, "revokedById" = ${ownerId}::uuid, "revocationReason" = ${`cancel ${createInput.email}`}, "revocationRequestKey" = ${randomUUID()}, "revocationRequestFingerprint" = ${"d".repeat(64)}, "revocationImpactFingerprint" = ${"e".repeat(64)}, "version" = ${created.invitation.version + 1} WHERE "id" = ${created.invitation.id}::uuid`,
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.$executeRaw`UPDATE "WorkspaceInvitation" SET "revokedAt" = CURRENT_TIMESTAMP, "revokedById" = ${ownerId}::uuid, "revocationReason" = 'safe reason', "revocationRequestKey" = ${`retry-${createInput.email}`}, "revocationRequestFingerprint" = ${"d".repeat(64)}, "revocationImpactFingerprint" = ${"e".repeat(64)}, "version" = ${created.invitation.version + 1} WHERE "id" = ${created.invitation.id}::uuid`,
        (error: unknown) => error instanceof Error,
      );
      const revokeRequest = { reason: "scope changed", requestKey: randomUUID(), expectedVersion: impact.expectedVersion, expectedImpactFingerprint: impact.impactFingerprint, confirmation: true };
      const revoked = await revokeWorkspaceInvitation(workspaceId, created.invitation.id, revokeRequest, owner, db);
      assert.equal(revoked.alreadyRevoked, false);
      assert.equal(revoked.invitation.revokedAt instanceof Date, true);
      const auditCount = await db.workspaceInvitationAudit.count({ where: { invitationId: created.invitation.id, event: "revoked" } });
      assert.equal(auditCount, 1);
      const revokeReplay = await revokeWorkspaceInvitation(workspaceId, created.invitation.id, revokeRequest, owner, db);
      assert.equal(revokeReplay.alreadyRevoked, true);
      assert.equal(await db.workspaceInvitationAudit.count({ where: { invitationId: created.invitation.id, event: "revoked" } }), 1);
      await assert.rejects(
        () => revokeWorkspaceInvitation(workspaceId, created.invitation.id, { ...revokeRequest, reason: "different reason" }, owner, db),
        (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_IDEMPOTENCY_CONFLICT",
      );
      await assert.rejects(
        () => revokeWorkspaceInvitation(workspaceId, created.invitation.id, { reason: "new request", requestKey: randomUUID(), expectedVersion: revoked.invitation.version, expectedImpactFingerprint: impact.impactFingerprint, confirmation: true }, owner, db),
        (error: unknown) => errorCode(error) === "WORKSPACE_INVITATION_STATE_CONFLICT",
      );
      const auditRows = await db.workspaceInvitationAudit.findMany({ where: { invitationId: created.invitation.id }, select: { event: true, reason: true, requestKey: true } });
      const plaintextToken = created.token;
      assert.equal(plaintextToken !== null && auditRows.every((row) => !row.reason.includes(plaintextToken)), true);
      assert.equal(auditRows.some((row) => row.requestKey === plaintextToken), false);
     await assert.rejects(
       () => db.workspaceInvitationAudit.updateMany({ where: { invitationId: created.invitation.id }, data: { reason: "tampered" } }),
       (error: unknown) => error instanceof Error,
     );
      await assert.rejects(
        () => db.$executeRaw`UPDATE "WorkspaceInvitation" SET "revokedAt" = NULL WHERE "id" = ${created.invitation.id}::uuid`,
        (error: unknown) => error instanceof Error,
      );

      const blankTokenHash = `${"b".repeat(63)}${suffix.slice(0, 1)}`;
      await assert.rejects(
        () => db.$executeRaw`INSERT INTO "WorkspaceInvitation" ("id", "workspaceId", "email", "tokenHash", "workspaceRole", "invitedById", "expiresAt") VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, NULL, ${blankTokenHash}, 'member', ${ownerId}::uuid, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.$executeRaw`INSERT INTO "WorkspaceInvitation" ("id", "workspaceId", "email", "tokenHash", "workspaceRole", "invitedById", "expiresAt") VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, '   ', ${blankTokenHash}, 'member', ${ownerId}::uuid, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        (error: unknown) => error instanceof Error,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
