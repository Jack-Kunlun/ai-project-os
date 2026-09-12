import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import {
  AccountAccessServiceError,
  executeAccountAccess,
  previewAccountAccess,
} from "@/lib/account-access-service";
import { getDb } from "@/lib/db";
import {
  executeWorkspaceRoleMutation,
  previewWorkspaceRoleMutation,
  WorkspaceRoleGovernanceError,
  type WorkspaceRoleMutationPreview,
} from "@/lib/workspace-role-governance-service";

const shouldRun = process.env.WORKSPACE_ROLE_GOVERNANCE_POSTGRES_GATE === "1";
const databaseName = "ai_project_os_workspace_role_governance_test";
const gateUser = "ai_project_os_gate";

function assertDisposableGateDatabase(): string {
  const value = process.env.DATABASE_URL;
  if (typeof value !== "string" || value.length === 0) throw new Error("WORKSPACE_ROLE_GOVERNANCE_DATABASE_URL_REQUIRED");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
    || url.port !== "56432"
    || url.pathname !== `/${databaseName}`
    || url.username !== gateUser
    || url.password.length === 0
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("WORKSPACE_ROLE_GOVERNANCE_DATABASE_URL_INVALID");
  return url.toString();
}

async function rollback(client: Client): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* the transaction may already be closed after a deferred error */ }
}

function roleExecuteInput(preview: WorkspaceRoleMutationPreview, reason: string) {
  return {
    workspaceId: preview.workspaceId,
    subjectId: preview.subject.id,
    actorId: preview.actorId,
    actorAccountAccessVersion: 1,
    targetRole: preview.target.role,
    reason,
    requestKey: preview.requestKey,
    previewId: preview.previewId,
    currentRole: preview.current.role,
    requestFingerprint: preview.requestFingerprint,
    expectedImpactFingerprint: preview.impactFingerprint,
    expectedOwnerCount: preview.ownerCount,
    expectedProjectGrantCount: preview.projectGrantCount,
    expectedProjectGrantFingerprint: preview.projectGrantFingerprint,
    expectedMembershipFingerprint: preview.membershipFingerprint,
    previewIssuedAt: preview.issuedAt,
    previewExpiresAt: preview.expiresAt,
    confirmation: true as const,
    confirmationUsername: preview.subject.username,
  };
}

test(
  "workspace role governance enforces the final enabled-owner invariant and append-only controls",
  { skip: !shouldRun ? "WORKSPACE_ROLE_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const databaseUrl = assertDisposableGateDatabase();
    const client = new Client({ connectionString: databaseUrl });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const actorId = randomUUID();
    const subjectId = randomUUID();
    const workspaceId = randomUUID();
    const uninitializedWorkspaceId = randomUUID();
    const actorMembershipId = randomUUID();
    const subjectMembershipId = randomUUID();
    await client.connect();
    try {
      const functionRows = await client.query<{ function_name: string; owner: string; prosecdef: boolean; public_execute: boolean }>(`
        SELECT p.oid::regprocedure::text AS function_name,
               pg_get_userbyid(p.proowner) AS owner,
               p.prosecdef,
               COALESCE((
                 SELECT bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')
                   FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
               ), false) AS public_execute
          FROM pg_proc AS p
         WHERE p.oid IN (
           'workspace_role_check_owner(uuid)'::regprocedure,
           'workspace_role_mutation_preview_guard()'::regprocedure,
           'workspace_role_mutation_audit_guard()'::regprocedure,
           'workspace_role_owner_workspace_guard()'::regprocedure
         )
         ORDER BY function_name
      `);
      assert.equal(functionRows.rows.length, 4);
      assert.ok(functionRows.rows.every((row) => row.prosecdef === false));
      assert.ok(functionRows.rows.every((row) => row.public_execute === false));
      assert.ok(functionRows.rows.every((row) => row.owner.length > 0));

      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "AppUser" ("id", "username", "role", "updatedAt")
        VALUES ($1, $2, 'admin', clock_timestamp() AT TIME ZONE 'UTC'),
               ($3, $4, 'user', clock_timestamp() AT TIME ZONE 'UTC')
      `, [actorId, `workspace_role_actor_${suffix}`, subjectId, `workspace_role_subject_${suffix}`]);
      await client.query(`
        INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt")
        VALUES ($1, $2, $3, $4, clock_timestamp() AT TIME ZONE 'UTC')
      `, [workspaceId, `Workspace role ${suffix}`, `workspace-role-${suffix}`, actorId]);
      const membershipTimestamp = await client.query<{ epoch_ms: string }>("SELECT round(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS epoch_ms");
      const membershipEpochMs = Number(membershipTimestamp.rows[0]?.epoch_ms);
      assert.ok(Number.isSafeInteger(membershipEpochMs));
      const membershipNow = new Date(membershipEpochMs);
      await client.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "createdAt", "updatedAt")
        VALUES ($1, $3, $4, 'owner', 'confirmed', $6, $6),
               ($2, $3, $5, 'member', 'confirmed', $6, $6)
      `, [actorMembershipId, subjectMembershipId, workspaceId, actorId, subjectId, membershipNow]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action",
          "previousState", "newState", "roleSnapshot", "actorId", "reason", "membershipFingerprint"
        )
        SELECT gen_random_uuid(), 'workspace', membership."id", membership."workspaceId", NULL, membership."userId",
               'confirmed', NULL, membership."accessState", membership."role", $1, 'workspace role gate fixture',
               encode(digest(convert_to(concat_ws(E'\\x1f', membership."id"::text, membership."workspaceId"::text,
                 membership."userId"::text, membership."role"::text,
                 to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
                 to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')), 'UTF8'), 'sha256'), 'hex')
          FROM "WorkspaceMembership" membership
         WHERE membership."id" IN ($2, $3)
      `, [actorId, actorMembershipId, subjectMembershipId]);
      await client.query("COMMIT");

      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt")
        VALUES ($1, $2, $3, NULL, clock_timestamp() AT TIME ZONE 'UTC')
      `, [uninitializedWorkspaceId, `Uninitialized ${suffix}`, `uninitialized-role-${suffix}`]);
      await client.query("COMMIT");
      await client.query("BEGIN");
      await client.query(`UPDATE "Workspace" SET "createdById" = $1, "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = $2`, [actorId, uninitializedWorkspaceId]);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => /enabled confirmed owner|owner invariant|check_violation/iu.test(error instanceof Error ? error.message : ""),
      );
      await rollback(client);

      const db = getDb();
      const lastOwnerReason = "workspace role gate rejects sole owner self demotion";
      await assert.rejects(
        () => previewWorkspaceRoleMutation({
          workspaceId,
          subjectId: actorId,
          actorId,
          actorAccountAccessVersion: 1,
          targetRole: "member",
          reason: lastOwnerReason,
          requestKey: `sole-owner-${suffix}`,
        }, db),
        (error: unknown) => error instanceof WorkspaceRoleGovernanceError && error.code === "WORKSPACE_ROLE_GOVERNANCE_LAST_OWNER_REQUIRED",
      );

      const promoteReason = "workspace role gate promotes the successor owner";
      const promotion = await previewWorkspaceRoleMutation({
        workspaceId,
        subjectId,
        actorId,
        actorAccountAccessVersion: 1,
        targetRole: "owner",
        reason: promoteReason,
        requestKey: `promote-owner-${suffix}`,
      }, db);
      const promoted = await executeWorkspaceRoleMutation(roleExecuteInput(promotion, promoteReason), db);

      const demoteReason = "workspace role gate completes owner self transfer";
      const demotion = await previewWorkspaceRoleMutation({
        workspaceId,
        subjectId: actorId,
        actorId,
        actorAccountAccessVersion: 1,
        targetRole: "member",
        reason: demoteReason,
        requestKey: `demote-owner-${suffix}`,
      }, db);
      await executeWorkspaceRoleMutation(roleExecuteInput(demotion, demoteReason), db);
      const replay = await executeWorkspaceRoleMutation(roleExecuteInput(demotion, demoteReason), db);
      assert.equal(replay.replayed, true);

      const disableReason = "workspace role gate rejects disabling the sole workspace owner";
      const disablePreview = await previewAccountAccess({
        adminUserId: actorId,
        adminAccountAccessVersion: 1,
        userId: subjectId,
        action: "disable",
        reason: disableReason,
        expectedVersion: 1,
      }, db);
      assert.equal(disablePreview.canExecute, false);
      assert.ok(disablePreview.blockingCategories.includes("last_enabled_workspace_owner"));
      await assert.rejects(
        () => executeAccountAccess({
          adminUserId: actorId,
          adminAccountAccessVersion: 1,
          userId: subjectId,
          action: "disable",
          reason: disableReason,
          expectedVersion: disablePreview.current.accountAccessVersion,
          expectedImpactFingerprint: disablePreview.impactFingerprint,
          requestKey: `disable-sole-owner-${suffix}`,
          requestFingerprint: disablePreview.requestFingerprint,
          previewId: disablePreview.previewId,
          previewIssuedAt: disablePreview.previewIssuedAt,
          previewExpiresAt: disablePreview.previewExpiresAt,
          confirmation: true,
          confirmationUsername: disablePreview.user.username,
        }, db),
        (error: unknown) => error instanceof AccountAccessServiceError && error.code === "ACCOUNT_ACCESS_LAST_OWNER_REQUIRED",
      );

      await client.query("BEGIN");
      await assert.rejects(
        () => client.query(`UPDATE "AppUser" SET "disabledAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = $1`, [subjectId]),
        (error: unknown) => /account access lifecycle context|required|enabled confirmed owner|owner invariant|check_violation/iu.test(error instanceof Error ? error.message : ""),
      );
      await rollback(client);

      await assert.rejects(
        () => client.query(`
          INSERT INTO "WorkspaceRoleMutationPreview" (
            "id", "workspaceId", "actorId", "subjectId", "membershipId", "currentRole", "targetRole",
            "actorAccountAccessVersion", "subjectAccountAccessVersion", "ownerCount", "projectGrantCount",
            "projectGrantSnapshot", "projectGrantFingerprint", "membershipFingerprint", "reason", "requestKey",
            "requestFingerprint", "impactFingerprint", "issuedAt", "expiresAt", "createdAt"
          ) VALUES (
            $1, $2, $3, $4, $5, 'member', 'admin', 1, 1, 1, 0, '[]'::jsonb,
            repeat('a', 64), repeat('b', 64), 'direct bypass', 'workspace-role-direct', repeat('c', 64), repeat('d', 64),
            clock_timestamp() AT TIME ZONE 'UTC', (clock_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes', clock_timestamp() AT TIME ZONE 'UTC'
          )
        `, [randomUUID(), workspaceId, actorId, subjectId, subjectMembershipId]),
        (error: unknown) => /requires server context|check_violation/iu.test(error instanceof Error ? error.message : ""),
      );

      // A preview that was valid at insert time cannot be consumed after its
      // persisted TTL.  The guard uses clock_timestamp(), so the negative is
      // independent of transaction-start time and proves expired consumption
      // is rejected even when the transaction remains open.
      const expiringPreviewId = randomUUID();
      await client.query("BEGIN");
      for (const [name, value] of [
        ["app.workspace_role_preview_context", "1"],
        ["app.workspace_role_preview_id", expiringPreviewId],
        ["app.workspace_role_workspace_id", workspaceId],
        ["app.workspace_role_actor_id", actorId],
        ["app.workspace_role_subject_id", subjectId],
        ["app.workspace_role_membership_id", promoted.newMembershipId],
        ["app.workspace_role_current_role", "owner"],
        ["app.workspace_role_target_role", "admin"],
        ["app.workspace_role_actor_version", "1"],
        ["app.workspace_role_subject_version", "1"],
        ["app.workspace_role_owner_count", "1"],
        ["app.workspace_role_project_grant_count", "0"],
        ["app.workspace_role_project_grant_fingerprint", "a".repeat(64)],
        ["app.workspace_role_membership_fingerprint", "b".repeat(64)],
        ["app.workspace_role_request_key", "expired-preview"],
        ["app.workspace_role_request_fingerprint", "c".repeat(64)],
        ["app.workspace_role_impact_fingerprint", "d".repeat(64)],
      ] as const) await client.query("SELECT set_config($1, $2, true)", [name, value]);
      await client.query(`
        INSERT INTO "WorkspaceRoleMutationPreview" (
          "id", "workspaceId", "actorId", "subjectId", "membershipId", "currentRole", "targetRole",
          "actorAccountAccessVersion", "subjectAccountAccessVersion", "ownerCount", "projectGrantCount",
          "projectGrantSnapshot", "projectGrantFingerprint", "membershipFingerprint", "reason", "requestKey",
          "requestFingerprint", "impactFingerprint", "issuedAt", "expiresAt", "createdAt"
        ) VALUES ($1, $2, $3, $4, $5, 'owner', 'admin', 1, 1, 1, 0, '[]'::jsonb,
          repeat('a', 64), repeat('b', 64), 'expiring preview', 'expired-preview', repeat('c', 64), repeat('d', 64),
          (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
          (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) + interval '1 second',
          (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
      `, [expiringPreviewId, workspaceId, actorId, subjectId, promoted.newMembershipId]);
      await client.query("SELECT pg_sleep(1.2)");
      await client.query("SELECT set_config($1, $2, true)", ["app.workspace_role_execute_context", "1"]);
      await client.query("SELECT set_config($1, $2, true)", ["app.workspace_role_execute_preview_id", expiringPreviewId]);
      await assert.rejects(
        () => client.query(`UPDATE "WorkspaceRoleMutationPreview" SET "consumedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) WHERE "id" = $1`, [expiringPreviewId]),
        (error: unknown) => /can only be consumed once|check_violation/iu.test(error instanceof Error ? error.message : ""),
      );
      await rollback(client);
    } finally {
      await rollback(client);
      await client.end();
    }
  },
);
