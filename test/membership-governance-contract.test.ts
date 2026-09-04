import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  MembershipAccessAuditMembershipKind,
  MembershipAccessState,
  ProjectMembershipInheritanceMode,
} from "@prisma/client";
import {
  assertMembershipAccessTransition,
  buildConfirmedProjectMembershipWhere,
  buildConfirmedWorkspaceMembershipWhere,
  CONFIRMED_MEMBERSHIP_ACCESS_STATE,
  MEMBERSHIP_GOVERNANCE_CANDIDATE_CLASSIFICATIONS,
  MembershipGovernanceError,
  membershipFingerprint,
  membershipManifestFingerprint,
} from "../src/lib/membership-governance";
import {
  MEMBERSHIP_GOVERNANCE_INVENTORY_REPORT_VERSION,
  MEMBERSHIP_GOVERNANCE_INVENTORY_KIND,
  runMembershipGovernanceInventory,
} from "../scripts/membership-governance-inventory";

const migrationName = "20260904040000_add_membership_access_governance";
const membershipId = "00000000-0000-4000-8000-000000000011";
const workspaceId = "00000000-0000-4000-8000-000000000012";
const projectId = "00000000-0000-4000-8000-000000000013";
const userId = "00000000-0000-4000-8000-000000000014";

function readModel(schema: string, modelName: string): string {
  const model = schema.match(new RegExp(`^model ${modelName} \\{([\\s\\S]*?)^\\}`, "mu"))?.[1];
  assert.ok(model, `${modelName} model is missing`);
  return model;
}

test("membership governance schema declares pending access and project-only defaults", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  assert.match(schema, /^enum MembershipAccessState \{\s*pending\s*confirmed\s*revoked\s*\}/mu);
  assert.match(schema, /^enum ProjectMembershipInheritanceMode \{[\s\S]*workspaceInherited\s+@map\("workspace_inherited"\)[\s\S]*projectOnly\s+@map\("project_only"\)[\s\S]*\}/mu);
  assert.match(schema, /^enum MembershipAccessAuditMembershipKind \{\s*workspace\s*project\s*\}/mu);
  assert.match(schema, /^enum MembershipAccessAuditAction \{[\s\S]*migrationQuarantined\s+@map\("migration_quarantined"\)[\s\S]*confirmed[\s\S]*revoked[\s\S]*bootstrapConfirmed\s+@map\("bootstrap_confirmed"\)[\s\S]*\}/mu);

  const project = readModel(schema, "Project");
  assert.match(project, /^\s*membershipInheritanceMode\s+ProjectMembershipInheritanceMode\s+@default\(projectOnly\)\s*$/mu);

  const workspaceMembership = readModel(schema, "WorkspaceMembership");
  assert.match(workspaceMembership, /^\s*accessState\s+MembershipAccessState\s+@default\(pending\)\s*$/mu);
  assert.match(workspaceMembership, /@@index\(\[userId, workspaceId, accessState\]\)/u);

  const projectMembership = readModel(schema, "ProjectMembership");
  assert.match(projectMembership, /^\s*accessState\s+MembershipAccessState\s+@default\(pending\)\s*$/mu);
  assert.match(projectMembership, /@@index\(\[userId, projectId, accessState\]\)/u);

  const audit = readModel(schema, "MembershipAccessAudit");
  assert.match(audit, /membershipKind\s+MembershipAccessAuditMembershipKind/u);
  assert.match(audit, /membershipId\s+String\s+@db\.Uuid/u);
  assert.match(audit, /projectId\s+String\?\s+@db\.Uuid/u);
  assert.match(audit, /roleSnapshot\s+String\s+@db\.VarChar\(32\)/u);
  assert.match(audit, /membershipFingerprint\s+String\s+@db\.Char\(64\)/u);
  assert.match(audit, /manifestFingerprint\s+String\?\s+@db\.Char\(64\)/u);
  assert.match(audit, /transactionId\s+BigInt\s+@default\(dbgenerated\("txid_current\(\)"\)\)\s+@db\.BigInt/u);
  assert.match(audit, /@@unique\(\[membershipKind, membershipId, action\]\)/u);
  assert.doesNotMatch(audit, /@relation\(/u);
  assert.doesNotMatch(audit, /ResourceOwnershipState/u);
});

test("membership governance migration is additive, quarantines without auto-confirming, and is append-only", async () => {
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.at(-1), migrationName);

  const migration = await readFile(`prisma/migrations/${migrationName}/migration.sql`, "utf8");
  const executableSql = migration.replace(/--[^\n]*(?:\n|$)/gu, "");
  assert.match(executableSql, /CREATE TYPE "MembershipAccessState"[\s\S]*'pending'[\s\S]*'confirmed'[\s\S]*'revoked'/u);
  assert.match(executableSql, /ADD COLUMN "accessState" "MembershipAccessState" NOT NULL DEFAULT 'pending'/gu);
  assert.match(executableSql, /ADD COLUMN "membershipInheritanceMode" "ProjectMembershipInheritanceMode" NOT NULL DEFAULT 'project_only'/u);
  assert.match(executableSql, /CREATE TABLE "MembershipAccessAudit"/u);
  assert.match(executableSql, /CREATE UNIQUE INDEX "WorkspaceMembership_workspaceId_userId_active_key"[\s\S]*WHERE "accessState" <> 'revoked'/u);
  assert.match(executableSql, /CREATE UNIQUE INDEX "ProjectMembership_projectId_userId_active_key"[\s\S]*WHERE "accessState" <> 'revoked'/u);
  assert.match(executableSql, /DROP INDEX "WorkspaceMembership_workspaceId_userId_key"/u);
  assert.match(executableSql, /DROP INDEX "ProjectMembership_projectId_userId_key"/u);
  assert.match(executableSql, /membershipKind.*projectId.*IS NULL/u);
  assert.match(executableSql, /BEFORE UPDATE OR DELETE ON "MembershipAccessAudit"/u);
  assert.match(executableSql, /MembershipAccessAudit_action_state_check/u);
  assert.match(executableSql, /MembershipAccessAudit_insert_integrity_guard/u);
  assert.match(executableSql, /transactionId.*BIGINT NOT NULL DEFAULT txid_current\(\)/u);
  assert.match(executableSql, /membership\.xmin[\s\S]*txid_current\(\)\s*%\s*4294967296\)::text::xid/u);
  assert.match(executableSql, /DROP TRIGGER IF EXISTS "AiProviderConnection_workspace_membership_guard"/u);
  assert.match(executableSql, /DROP TRIGGER IF EXISTS "WorkspaceMembership_ai_provider_membership_guard"/u);
  assert.match(executableSql, /"scope" = 'platform'[\s\S]*"ownershipState" IN \('legacy_pending', 'confirmed'\)/u);
  assert.match(executableSql, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(executableSql, /migration_quarantined/u);
  assert.match(executableSql, /ON CONFLICT \("membershipKind", "membershipId", "action"\) DO NOTHING/u);
  assert.match(executableSql, /digest\(convert_to\([\s\S]*'sha256'/u);
  assert.doesNotMatch(executableSql, /\b(?:username|email|password|ciphertext|secret|description)\b/iu);
  assert.doesNotMatch(executableSql, /ResourceOwnershipState/u);
  assert.doesNotMatch(executableSql, /(?:^|;)\s*(?:UPDATE|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(executableSql, /FOREIGN KEY\s*\([^)]*membershipId/iu);
});

test("membership fingerprint and manifest stay deterministic and redacted", () => {
  const input = {
    membershipId,
    resourceId: workspaceId,
    userId,
    role: "owner",
    createdAt: "2026-09-04 04:00:00.000",
    updatedAt: "2026-09-04 04:00:00.000",
  } as const;
  const fingerprint = membershipFingerprint(input);
  assert.match(fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(
    membershipFingerprint({ ...input, createdAt: new Date("2026-09-04T04:00:00.000Z") }),
    fingerprint,
  );
  assert.notEqual(membershipFingerprint({ ...input, role: "admin" }), fingerprint);
  assert.notEqual(membershipFingerprint({ ...input, resourceId: projectId }), fingerprint);

  const entries = [
    { membershipKind: MembershipAccessAuditMembershipKind.workspace, membershipId, membershipFingerprint: fingerprint },
    { membershipKind: MembershipAccessAuditMembershipKind.project, membershipId: projectId, membershipFingerprint: "a".repeat(64) },
  ] as const;
  assert.match(membershipManifestFingerprint(entries), /^[0-9a-f]{64}$/u);
  assert.equal(membershipManifestFingerprint(entries), membershipManifestFingerprint([...entries].reverse()));
  assert.throws(
    () => membershipManifestFingerprint([{ membershipKind: "workspace", membershipId, membershipFingerprint: "bad" }]),
    (error: unknown) => error instanceof MembershipGovernanceError && error.code === "MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY",
  );
});

test("only confirmed memberships are exposed by the pure effective filters", () => {
  assert.equal(CONFIRMED_MEMBERSHIP_ACCESS_STATE, MembershipAccessState.confirmed);
  assert.deepEqual(buildConfirmedWorkspaceMembershipWhere({ workspaceId, userId }), {
    accessState: MembershipAccessState.confirmed,
    workspaceId,
    userId,
  });
  assert.deepEqual(buildConfirmedProjectMembershipWhere({ projectId, userId }), {
    accessState: MembershipAccessState.confirmed,
    projectId,
    userId,
  });
  assert.doesNotMatch(JSON.stringify(buildConfirmedWorkspaceMembershipWhere()), /admin|owner|system/iu);
  assert.deepEqual(MEMBERSHIP_GOVERNANCE_CANDIDATE_CLASSIFICATIONS, [
    "likely_migration_generated",
    "ambiguous",
    "not_evaluable",
  ]);
  assert.equal(ProjectMembershipInheritanceMode.projectOnly, "projectOnly");
});

test("membership access state machine is fail-closed for revoked revival", () => {
  assert.doesNotThrow(() => assertMembershipAccessTransition(MembershipAccessState.pending, MembershipAccessState.confirmed));
  assert.doesNotThrow(() => assertMembershipAccessTransition(MembershipAccessState.pending, MembershipAccessState.revoked));
  assert.doesNotThrow(() => assertMembershipAccessTransition(MembershipAccessState.confirmed, MembershipAccessState.revoked));
  assert.throws(
    () => assertMembershipAccessTransition(MembershipAccessState.revoked, MembershipAccessState.confirmed),
    (error: unknown) => error instanceof MembershipGovernanceError && error.code === "MEMBERSHIP_GOVERNANCE_INVALID_TRANSITION",
  );
  assert.throws(
    () => assertMembershipAccessTransition(MembershipAccessState.confirmed, MembershipAccessState.pending),
    (error: unknown) => error instanceof MembershipGovernanceError && error.code === "MEMBERSHIP_GOVERNANCE_INVALID_TRANSITION",
  );
});

test("governance inventory uses repeatable-read read-only rollback and redacts identity fields", async () => {
  const queries: string[] = [];
  const client = {
    async query<Row = unknown>(text: string): Promise<{ rows: readonly Row[] }> {
      queries.push(text);
      if (text.includes("FROM \"WorkspaceMembership\"")) {
        return {
          rows: [
            {
              membership_kind: "workspace",
              membership_id: membershipId,
              workspace_id: workspaceId,
              project_id: null,
              user_id: userId,
              role: "owner",
              access_state: "pending",
              created_at: "2026-09-04 04:00:00.000",
              updated_at: "2026-09-04 04:00:00.000",
            },
            {
              membership_kind: "project",
              membership_id: projectId,
              workspace_id: workspaceId,
              project_id: projectId,
              user_id: userId,
              role: "editor",
              access_state: "confirmed",
              created_at: "2026-09-04 04:00:00.000",
              updated_at: "2026-09-04 04:00:00.000",
            },
          ] as unknown as Row[],
        };
      }
      return { rows: [] };
    },
  };

  const report = await runMembershipGovernanceInventory(client);
  assert.equal(report.kind, MEMBERSHIP_GOVERNANCE_INVENTORY_KIND);
  assert.equal(report.reportVersion, MEMBERSHIP_GOVERNANCE_INVENTORY_REPORT_VERSION);
  assert.deepEqual(report.counts, {
    total: 2,
    byMembershipKind: { workspace: 1, project: 1 },
    byAccessState: { pending: 1, confirmed: 1, revoked: 0 },
    byCandidateClassification: {
      likely_migration_generated: 0,
      ambiguous: 1,
      not_evaluable: 1,
    },
  });
  assert.equal(report.memberships[0]?.candidateClassification, "ambiguous");
  assert.equal(report.memberships[1]?.candidateClassification, "not_evaluable");
  assert.equal(queries[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.match(queries[1] ?? "", /SET LOCAL search_path = pg_catalog, public/u);
  assert.match(queries[2] ?? "", /FROM "WorkspaceMembership"/u);
  assert.equal(queries.at(-1), "ROLLBACK");
  const sql = queries.join("\n");
  assert.doesNotMatch(sql, /\b(?:username|email|password|ciphertext|secret|description|name)\b/iu);
});
