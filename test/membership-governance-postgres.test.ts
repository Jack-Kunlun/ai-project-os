import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

const shouldRun = process.env.MEMBERSHIP_GOVERNANCE_POSTGRES_GATE === "1";
const databaseUrl = process.env.MEMBERSHIP_GOVERNANCE_POSTGRES_DATABASE_URL ?? process.env.DATABASE_URL;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

test(
  "membership governance migration preserves/quarantines legacy memberships and enforces immutable audit",
  { skip: !shouldRun ? "MEMBERSHIP_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
      throw new Error("MEMBERSHIP_GOVERNANCE_POSTGRES_DATABASE_URL_REQUIRED");
    }

    const client = new Client({ connectionString: databaseUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const secondaryWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const workspaceMembershipId = randomUUID();
    const projectMembershipId = randomUUID();
    const workspaceAuditId = randomUUID();
    await client.connect();
    try {
      const enumRows = await client.query<{ typname: string; enumlabel: string }>(`
        SELECT type_meta.typname, enum_meta.enumlabel
        FROM pg_type AS type_meta
        JOIN pg_enum AS enum_meta ON enum_meta.enumtypid = type_meta.oid
        WHERE type_meta.typname IN (
          'MembershipAccessState',
          'ProjectMembershipInheritanceMode',
          'MembershipAccessAuditAction'
        )
        ORDER BY type_meta.typname, enum_meta.enumsortorder
      `);
      const enumValues = new Map<string, string[]>();
      for (const row of enumRows.rows) {
        const values = enumValues.get(row.typname) ?? [];
        values.push(row.enumlabel);
        enumValues.set(row.typname, values);
      }
      assert.deepEqual(enumValues.get("MembershipAccessState"), ["pending", "confirmed", "revoked"]);
      assert.deepEqual(enumValues.get("ProjectMembershipInheritanceMode"), ["workspace_inherited", "project_only"]);
      assert.deepEqual(enumValues.get("MembershipAccessAuditAction"), [
        "migration_quarantined",
        "confirmed",
        "revoked",
        "bootstrap_confirmed",
      ]);

      const existing = await client.query<{ memberships: string; audits: string; non_project_only: string }>(`
        SELECT
          ((SELECT COUNT(*) FROM "WorkspaceMembership")
            + (SELECT COUNT(*) FROM "ProjectMembership"))::text AS memberships,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "action" = 'migration_quarantined') AS audits,
          (SELECT COUNT(*)::text FROM "Project" WHERE "membershipInheritanceMode" <> 'project_only') AS non_project_only
      `);
      assert.equal(existing.rows[0]?.memberships, existing.rows[0]?.audits);
      assert.equal(existing.rows[0]?.non_project_only, "0");

      const foreignKeys = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM pg_constraint
        WHERE conrelid = '"MembershipAccessAudit"'::regclass
          AND contype = 'f'
      `);
      assert.equal(foreignKeys.rows[0]?.count, "0");

      const partialIndexes = await client.query<{ index_name: string; predicate: string | null }>(`
        SELECT index_rel.relname AS index_name, pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
        FROM pg_index AS index_meta
        JOIN pg_class AS index_rel ON index_rel.oid = index_meta.indexrelid
        WHERE index_meta.indrelid IN ('"WorkspaceMembership"'::regclass, '"ProjectMembership"'::regclass)
          AND index_rel.relname IN ('WorkspaceMembership_workspaceId_userId_active_key', 'ProjectMembership_projectId_userId_active_key')
        ORDER BY index_name
      `);
      assert.equal(partialIndexes.rows.length, 2);
      assert.ok(partialIndexes.rows.every((row) => row.predicate?.includes('accessState')));

      const triggerNames = await client.query<{ tgname: string }>(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid IN ('"AiProviderConnection"'::regclass, '"WorkspaceMembership"'::regclass)
          AND NOT tgisinternal
        ORDER BY tgname
      `);
      assert.ok(!triggerNames.rows.some((row) => row.tgname === "AiProviderConnection_workspace_membership_guard"));
      assert.ok(!triggerNames.rows.some((row) => row.tgname === "WorkspaceMembership_ai_provider_membership_guard"));

      const insertWorkspaceAudit = async (input: Readonly<{
        auditId?: string;
        membershipId: string;
        action: "migration_quarantined" | "confirmed" | "revoked";
        newState: "pending" | "confirmed" | "revoked";
        previousState?: "pending" | "confirmed" | null;
        workspaceId: string;
        userId: string;
      }>) => client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "userId", "action", "previousState",
          "newState", "roleSnapshot", "reason", "membershipFingerprint"
        )
        SELECT $1, 'workspace', membership."id", membership."workspaceId", membership."userId",
          $3::"MembershipAccessAuditAction", $4::"MembershipAccessState", $5::"MembershipAccessState",
          membership."role"::text, 'membership governance gate',
          encode(digest(convert_to(concat_ws(
            E'\\x1f', membership."id"::text, membership."workspaceId"::text, membership."userId"::text,
            membership."role"::text, to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
            to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
          ), 'UTF8'), 'sha256'), 'hex')
        FROM "WorkspaceMembership" AS membership
        WHERE membership."id" = $2 AND membership."workspaceId" = $6 AND membership."userId" = $7
      `, [input.auditId ?? randomUUID(), input.membershipId, input.action, input.previousState ?? null, input.newState, input.workspaceId, input.userId]);

      const insertProjectAudit = async (input: Readonly<{
        auditId?: string;
        membershipId: string;
        action: "confirmed" | "revoked";
        newState: "confirmed" | "revoked";
        previousState?: "confirmed" | null;
        projectId: string;
        userId: string;
      }>) => client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState",
          "newState", "roleSnapshot", "reason", "membershipFingerprint"
        )
        SELECT $1, 'project', membership."id", project."workspaceId", membership."projectId", membership."userId",
          $3::"MembershipAccessAuditAction", $4::"MembershipAccessState", $5::"MembershipAccessState",
          membership."role"::text, 'membership governance gate',
          encode(digest(convert_to(concat_ws(
            E'\\x1f', membership."id"::text, membership."projectId"::text, membership."userId"::text,
            membership."role"::text, to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
            to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
          ), 'UTF8'), 'sha256'), 'hex')
        FROM "ProjectMembership" AS membership
        JOIN "Project" AS project ON project."id" = membership."projectId"
        WHERE membership."id" = $2 AND membership."projectId" = $6 AND membership."userId" = $7
      `, [input.auditId ?? randomUUID(), input.membershipId, input.action, input.previousState ?? null, input.newState, input.projectId, input.userId]);

      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "AppUser" ("id", "username", "role", "updatedAt")
        VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)
      `, [userId, `membership_governance_${suffix}`]);
      await client.query(`
        INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt")
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [workspaceId, `Governance ${suffix}`, `governance-${suffix}`, userId]);
      await client.query(`
        INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt")
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [projectId, workspaceId, `Governance project ${suffix}`, `governance-project-${suffix}`]);
      await client.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "updatedAt")
        VALUES ($1, $2, $3, 'owner', CURRENT_TIMESTAMP)
      `, [workspaceMembershipId, workspaceId, userId]);
      await client.query(`
        INSERT INTO "ProjectMembership" ("id", "projectId", "userId", "role", "updatedAt")
        VALUES ($1, $2, $3, 'owner', CURRENT_TIMESTAMP)
      `, [projectMembershipId, projectId, userId]);

      const defaults = await client.query<{ workspace_access: string; project_access: string; inheritance: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS workspace_access,
          (SELECT "accessState"::text FROM "ProjectMembership" WHERE "id" = $2) AS project_access,
          (SELECT "membershipInheritanceMode"::text FROM "Project" WHERE "id" = $3) AS inheritance
      `, [workspaceMembershipId, projectMembershipId, projectId]);
      assert.deepEqual(defaults.rows[0], {
        workspace_access: "pending",
        project_access: "pending",
        inheritance: "project_only",
      });

      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "userId", "action",
          "newState", "roleSnapshot", "reason", "membershipFingerprint"
        )
        VALUES ($1, 'workspace', $2, $3, $4, 'migration_quarantined', 'pending', 'owner', $5, repeat('a', 64))
      `, [workspaceAuditId, workspaceMembershipId, workspaceId, userId, "test-only rollback audit"]);

      await client.query("SAVEPOINT membership_audit_update_guard");
      await assert.rejects(
        () => client.query(`UPDATE "MembershipAccessAudit" SET "reason" = 'changed' WHERE "id" = $1`, [workspaceAuditId]),
        (error: unknown) => errorCode(error) === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT membership_audit_update_guard");

      await client.query("SAVEPOINT membership_audit_delete_guard");
      await assert.rejects(
        () => client.query(`DELETE FROM "MembershipAccessAudit" WHERE "id" = $1`, [workspaceAuditId]),
        (error: unknown) => errorCode(error) === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT membership_audit_delete_guard");

      await client.query("ROLLBACK");

      // A fresh confirmed membership and its audit can be committed together.
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "AppUser" ("id", "username", "role", "updatedAt")
        VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)
      `, [userId, `membership_governance_runtime_${suffix}`]);
      await client.query(`
        INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt")
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [workspaceId, `Governance runtime ${suffix}`, `governance-runtime-${suffix}`, userId]);
      await client.query(`
        INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt")
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [secondaryWorkspaceId, `Governance secondary ${suffix}`, `governance-secondary-${suffix}`, userId]);
      await client.query(`
        INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt")
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [projectId, workspaceId, `Governance runtime project ${suffix}`, `governance-runtime-project-${suffix}`]);
      await client.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, 'owner', 'confirmed', CURRENT_TIMESTAMP)
      `, [workspaceMembershipId, workspaceId, userId]);
      await insertWorkspaceAudit({ membershipId: workspaceMembershipId, action: "confirmed", newState: "confirmed", workspaceId, userId });
      await client.query(`
        INSERT INTO "ProjectMembership" ("id", "projectId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, 'owner', 'confirmed', CURRENT_TIMESTAMP)
      `, [projectMembershipId, projectId, userId]);
      await insertProjectAudit({ membershipId: projectMembershipId, action: "confirmed", newState: "confirmed", projectId, userId });
      await client.query("COMMIT");

      // Revoked rows remain in history and do not block a new current row.
      const revokedHistoryId = randomUUID();
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, 'owner', 'revoked', CURRENT_TIMESTAMP)
      `, [revokedHistoryId, workspaceId, userId]);
      await insertWorkspaceAudit({ membershipId: revokedHistoryId, action: "revoked", newState: "revoked", workspaceId, userId });
      await client.query("COMMIT");
      const historyCount = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM "WorkspaceMembership" WHERE "workspaceId" = $1 AND "userId" = $2
      `, [workspaceId, userId]);
      assert.equal(historyCount.rows[0]?.count, "2");

      await assert.rejects(
        () => client.query(`
          INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
          VALUES ($1, $2, $3, 'member', 'confirmed', CURRENT_TIMESTAMP)
        `, [randomUUID(), workspaceId, userId]),
        (error: unknown) => errorCode(error) === "23505",
      );
      await assert.rejects(
        () => client.query(`UPDATE "WorkspaceMembership" SET "role" = 'admin' WHERE "id" = $1`, [workspaceMembershipId]),
        (error: unknown) => errorCode(error) === "23514",
      );
      await assert.rejects(
        () => client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'confirmed' WHERE "id" = $1`, [revokedHistoryId]),
        (error: unknown) => errorCode(error) === "23514",
      );
      await assert.rejects(
        () => client.query(`DELETE FROM "WorkspaceMembership" WHERE "id" = $1`, [workspaceMembershipId]),
        (error: unknown) => errorCode(error) === "23514",
      );
      // A true SQL no-op is harmless, but an ORM touch that changes updatedAt
      // would desynchronise the fingerprinted audit snapshot and is rejected.
      await client.query(`UPDATE "WorkspaceMembership" SET "updatedAt" = "updatedAt" WHERE "id" = $1`, [workspaceMembershipId]);
      await assert.rejects(
        () => client.query(`UPDATE "WorkspaceMembership" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [workspaceMembershipId]),
        (error: unknown) => errorCode(error) === "23514",
      );
      const noOpFingerprint = await client.query<{ current_fingerprint: string; audit_fingerprint: string }>(`
        SELECT
          encode(digest(convert_to(concat_ws(
            E'\\x1f', membership."id"::text, membership."workspaceId"::text, membership."userId"::text,
            membership."role"::text, to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
            to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
          ), 'UTF8'), 'sha256'), 'hex') AS current_fingerprint,
          audit."membershipFingerprint" AS audit_fingerprint
        FROM "WorkspaceMembership" AS membership
        JOIN "MembershipAccessAudit" AS audit
          ON audit."membershipKind" = 'workspace'
         AND audit."membershipId" = membership."id"
         AND audit."action" = 'confirmed'
        WHERE membership."id" = $1
      `, [workspaceMembershipId]);
      assert.equal(noOpFingerprint.rows[0]?.current_fingerprint, noOpFingerprint.rows[0]?.audit_fingerprint);

      // A SQL no-op is allowed only without a corresponding access audit. It
      // cannot be used to manufacture a fresh xmin and smuggle in a semantic
      // state claim without an actual state transition.
      await assert.rejects(
        async () => {
          await client.query("BEGIN");
          await client.query(`UPDATE "WorkspaceMembership" SET "updatedAt" = "updatedAt" WHERE "id" = $1`, [workspaceMembershipId]);
          await client.query(`
            INSERT INTO "MembershipAccessAudit" (
              "id", "membershipKind", "membershipId", "workspaceId", "userId", "action", "newState", "roleSnapshot", "reason", "membershipFingerprint"
            )
            SELECT $1, 'workspace', membership."id", membership."workspaceId", membership."userId", 'bootstrap_confirmed', 'confirmed', membership."role"::text,
              'no-op audit forge', encode(digest(convert_to(concat_ws(E'\\x1f', membership."id"::text, membership."workspaceId"::text, membership."userId"::text, membership."role"::text,
                to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')), 'UTF8'), 'sha256'), 'hex')
            FROM "WorkspaceMembership" AS membership WHERE membership."id" = $2
          `, [randomUUID(), workspaceMembershipId]);
          await client.query("COMMIT");
        },
        (error: unknown) => errorCode(error) === "23514",
      );
      await client.query("ROLLBACK").catch(() => undefined);

      // ProjectMembership uses the same trigger body but a different table
      // shape; this catches accidental NEW.workspaceId access in that branch.
      const projectRevokedId = randomUUID();
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "ProjectMembership" ("id", "projectId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, 'editor', 'revoked', CURRENT_TIMESTAMP)
      `, [projectRevokedId, projectId, userId]);
      await insertProjectAudit({ membershipId: projectRevokedId, action: "revoked", newState: "revoked", projectId, userId });
      await client.query("COMMIT");
      await assert.rejects(
        () => client.query(`UPDATE "ProjectMembership" SET "accessState" = 'confirmed' WHERE "id" = $1`, [projectRevokedId]),
        (error: unknown) => errorCode(error) === "23514",
      );
      await assert.rejects(
        () => client.query(`DELETE FROM "ProjectMembership" WHERE "id" = $1`, [projectMembershipId]),
        (error: unknown) => errorCode(error) === "23514",
      );

      // The database rejects an audit whose action and state disagree before
      // it can become a deferred orphan or forged snapshot.
      await assert.rejects(
        () => client.query(`
          INSERT INTO "MembershipAccessAudit" (
            "id", "membershipKind", "membershipId", "workspaceId", "userId", "action", "newState", "roleSnapshot", "reason", "membershipFingerprint"
          ) VALUES ($1, 'workspace', $2, $3, $4, 'confirmed', 'revoked', 'owner', 'invalid action/state', repeat('a', 64))
        `, [randomUUID(), randomUUID(), workspaceId, userId]),
        (error: unknown) => errorCode(error) === "23514",
      );

      // A matching snapshot prepared with a previous transaction id cannot
      // satisfy a later membership mutation.  The row itself is first made a
      // valid pending membership so the audit trigger cannot be bypassed by
      // pre-seeding an orphan row.
      const crossTransactionMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, 'viewer', 'pending', CURRENT_TIMESTAMP)
      `, [crossTransactionMembershipId, secondaryWorkspaceId, userId]);
      await insertWorkspaceAudit({ membershipId: crossTransactionMembershipId, action: "migration_quarantined", newState: "pending", workspaceId: secondaryWorkspaceId, userId });
      await client.query("COMMIT");
      const previousTransactionId = (await client.query<{ transaction_id: string }>("SELECT txid_current()::text AS transaction_id")).rows[0]?.transaction_id;
      assert.ok(previousTransactionId);
      await assert.rejects(
        async () => {
          await client.query("BEGIN");
          await client.query(`
            UPDATE "WorkspaceMembership"
               SET "accessState" = 'confirmed'
             WHERE "id" = $1 AND "accessState" = 'pending'
          `, [crossTransactionMembershipId]);
          await client.query(`
            INSERT INTO "MembershipAccessAudit" (
              "id", "membershipKind", "membershipId", "workspaceId", "userId", "action", "previousState", "newState", "roleSnapshot", "reason", "membershipFingerprint", "transactionId"
            )
            SELECT $1, 'workspace', membership."id", membership."workspaceId", membership."userId", 'confirmed', 'pending', 'confirmed', membership."role"::text,
              'pre-seeded transaction id', encode(digest(convert_to(concat_ws(E'\\x1f', membership."id"::text, membership."workspaceId"::text, membership."userId"::text, membership."role"::text,
                to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')), 'UTF8'), 'sha256'), 'hex'), $3::bigint
              FROM "WorkspaceMembership" AS membership WHERE membership."id" = $2
          `, [randomUUID(), crossTransactionMembershipId, previousTransactionId]);
          await client.query("COMMIT");
        },
        (error: unknown) => errorCode(error) === "23514",
      );
      await client.query("ROLLBACK").catch(() => undefined);
      await assert.rejects(
        async () => {
          await client.query("BEGIN");
          await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'revoked' WHERE "id" = $1 AND "accessState" = 'pending'`, [crossTransactionMembershipId]);
          await insertWorkspaceAudit({ membershipId: crossTransactionMembershipId, action: "revoked", newState: "revoked", previousState: "pending", workspaceId: secondaryWorkspaceId, userId });
          await client.query("COMMIT");
        },
        (error: unknown) => errorCode(error) === "23514",
      );
      await client.query("ROLLBACK").catch(() => undefined);
      const pendingAfterOrdinaryRevoke = await client.query<{ access_state: string }>(
        `SELECT "accessState"::text AS access_state FROM "WorkspaceMembership" WHERE "id" = $1`,
        [crossTransactionMembershipId],
      );
      assert.equal(pendingAfterOrdinaryRevoke.rows[0]?.access_state, "pending");

      // Concurrent regrant attempts may race in application code, but the
      // state-aware partial unique index must leave exactly one current row.
      const concurrentClients = [new Client({ connectionString: databaseUrl }), new Client({ connectionString: databaseUrl })];
      const concurrentMembershipIds = [randomUUID(), randomUUID()];
      const concurrentUserId = randomUUID();
      await client.query(`
        INSERT INTO "AppUser" ("id", "username", "role", "updatedAt")
        VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)
      `, [concurrentUserId, `mg_concurrent_${suffix}`]);
      await Promise.all(concurrentClients.map((connection) => connection.connect()));
      const concurrentAttempt = async (connection: Client, membershipId: string) => {
        try {
          await connection.query("BEGIN");
          await connection.query(`
            INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
            VALUES ($1, $2, $3, 'viewer', 'confirmed', CURRENT_TIMESTAMP)
          `, [membershipId, secondaryWorkspaceId, concurrentUserId]);
          await connection.query(`
            INSERT INTO "MembershipAccessAudit" (
              "id", "membershipKind", "membershipId", "workspaceId", "userId", "action", "newState", "roleSnapshot", "reason", "membershipFingerprint"
            )
            SELECT $1, 'workspace', membership."id", membership."workspaceId", membership."userId", 'confirmed', 'confirmed', membership."role"::text,
              'concurrent regrant gate',
              encode(digest(convert_to(concat_ws(E'\\x1f', membership."id"::text, membership."workspaceId"::text, membership."userId"::text, membership."role"::text,
                to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')), 'UTF8'), 'sha256'), 'hex')
            FROM "WorkspaceMembership" AS membership WHERE membership."id" = $2
          `, [randomUUID(), membershipId]);
          await connection.query("COMMIT");
          return "success" as const;
        } catch (error) {
          await connection.query("ROLLBACK").catch(() => undefined);
          return errorCode(error) === "23505" ? "conflict" as const : "failure" as const;
        }
      };
      const concurrentOutcomes = await Promise.all(concurrentClients.map((connection, index) => concurrentAttempt(connection, concurrentMembershipIds[index]!)));
      await Promise.all(concurrentClients.map((connection) => connection.end()));
      assert.equal(concurrentOutcomes.filter((outcome) => outcome === "success").length, 1);
      assert.equal(concurrentOutcomes.filter((outcome) => outcome === "conflict").length, 1);
      const concurrentCurrent = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM "WorkspaceMembership"
        WHERE "workspaceId" = $1 AND "userId" = $2 AND "accessState" <> 'revoked'
      `, [secondaryWorkspaceId, concurrentUserId]);
      assert.equal(concurrentCurrent.rows[0]?.count, "1");

      const replacementMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'revoked' WHERE "id" = $1 AND "accessState" = 'confirmed'`, [workspaceMembershipId]);
      await insertWorkspaceAudit({ membershipId: workspaceMembershipId, action: "revoked", newState: "revoked", previousState: "confirmed", workspaceId, userId });
      await client.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, 'admin', 'confirmed', CURRENT_TIMESTAMP)
      `, [replacementMembershipId, workspaceId, userId]);
      await insertWorkspaceAudit({ membershipId: replacementMembershipId, action: "confirmed", newState: "confirmed", workspaceId, userId });
      await client.query("COMMIT");
      const replacement = await client.query<{ old_state: string; new_role: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS old_state,
          (SELECT "role"::text FROM "WorkspaceMembership" WHERE "id" = $2) AS new_role
      `, [workspaceMembershipId, replacementMembershipId]);
      assert.deepEqual(replacement.rows[0], { old_state: "revoked", new_role: "admin" });

      // A correctly shaped snapshot is still invalid when it is inserted in
      // a later transaction without a membership mutation.  The audit guard
      // binds the snapshot to the membership row's current MVCC xid, not only
      // to a caller-supplied fingerprint or transaction id.
      await assert.rejects(
        async () => {
          await client.query("BEGIN");
          await client.query(`
            INSERT INTO "MembershipAccessAudit" (
              "id", "membershipKind", "membershipId", "workspaceId", "userId", "action", "newState", "roleSnapshot", "reason", "membershipFingerprint"
            )
            SELECT $1, 'workspace', membership."id", membership."workspaceId", membership."userId", 'bootstrap_confirmed', 'confirmed', membership."role"::text,
              'audit-only forged snapshot', encode(digest(convert_to(concat_ws(E'\\x1f', membership."id"::text, membership."workspaceId"::text, membership."userId"::text, membership."role"::text,
                to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')), 'UTF8'), 'sha256'), 'hex')
            FROM "WorkspaceMembership" AS membership WHERE membership."id" = $2
          `, [randomUUID(), replacementMembershipId]);
          await client.query("COMMIT");
        },
        (error: unknown) => errorCode(error) === "23514",
      );
      await client.query("ROLLBACK").catch(() => undefined);

      await assert.rejects(
        async () => {
          await client.query("BEGIN");
          await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'revoked' WHERE "id" = $1`, [replacementMembershipId]);
          await insertWorkspaceAudit({ membershipId: replacementMembershipId, action: "revoked", newState: "revoked", previousState: "confirmed", workspaceId, userId });
          await client.query("COMMIT");
        },
        (error: unknown) => errorCode(error) === "23514",
      );
      await client.query("ROLLBACK").catch(() => undefined);
      const stillOwner = await client.query<{ access_state: string }>(`SELECT "accessState"::text AS access_state FROM "WorkspaceMembership" WHERE "id" = $1`, [replacementMembershipId]);
      assert.equal(stillOwner.rows[0]?.access_state, "confirmed");

      await client.query("BEGIN");
      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'revoked' WHERE "id" = $1`, [replacementMembershipId]);
      await insertWorkspaceAudit({ membershipId: replacementMembershipId, action: "revoked", newState: "revoked", previousState: "confirmed", workspaceId, userId });
      await client.query("COMMIT");

      const memberId = randomUUID();
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, 'member', 'confirmed', CURRENT_TIMESTAMP)
      `, [memberId, workspaceId, userId]);
      await insertWorkspaceAudit({ membershipId: memberId, action: "confirmed", newState: "confirmed", workspaceId, userId });
      await client.query("COMMIT");
      // Project/User membership FKs still cascade, but their immutable audit
      // snapshots are independent and must survive the parent deletion.
      const projectAuditCount = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM "MembershipAccessAudit"
        WHERE "membershipKind" = 'project' AND "membershipId" = $1
      `, [projectMembershipId]);
      assert.equal(projectAuditCount.rows[0]?.count, "1");
      await client.query(`DELETE FROM "Project" WHERE "id" = $1`, [projectId]);
      const projectCascade = await client.query<{ memberships: string; audits: string }>(`
        SELECT
          (SELECT COUNT(*)::text FROM "ProjectMembership" WHERE "id" = $1) AS memberships,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "membershipKind" = 'project' AND "membershipId" = $1) AS audits
      `, [projectMembershipId]);
      assert.deepEqual(projectCascade.rows[0], { memberships: "0", audits: "1" });

      const cascadeUserId = randomUUID();
      const cascadeWorkspaceId = randomUUID();
      const cascadeMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO "AppUser" ("id", "username", "role", "updatedAt")
        VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)
      `, [cascadeUserId, `membership_governance_cascade_${suffix}`]);
      await client.query(`
        INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt")
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [cascadeWorkspaceId, `Governance cascade ${suffix}`, `governance-cascade-${suffix}`, cascadeUserId]);
      await client.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, 'member', 'confirmed', CURRENT_TIMESTAMP)
      `, [cascadeMembershipId, cascadeWorkspaceId, cascadeUserId]);
      await insertWorkspaceAudit({ membershipId: cascadeMembershipId, action: "confirmed", newState: "confirmed", workspaceId: cascadeWorkspaceId, userId: cascadeUserId });
      await client.query("COMMIT");
      await client.query(`DELETE FROM "Workspace" WHERE "id" = $1`, [cascadeWorkspaceId]);
      const workspaceCascade = await client.query<{ memberships: string; audits: string }>(`
        SELECT
          (SELECT COUNT(*)::text FROM "WorkspaceMembership" WHERE "id" = $1) AS memberships,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "membershipKind" = 'workspace' AND "membershipId" = $1) AS audits
      `, [cascadeMembershipId]);
      assert.deepEqual(workspaceCascade.rows[0], { memberships: "0", audits: "1" });
    } finally {
      await client.end();
    }
  },
);
