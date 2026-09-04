import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify as verifySignature } from "node:crypto";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import {
  canonicalMembershipGovernanceManifest,
  buildMembershipGovernanceSafeSnapshot,
  MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV,
  membershipGovernanceManifestFingerprint,
  membershipGovernanceTrustedSignerRegistryFingerprint,
  parseMembershipGovernanceApprovalText,
  parseMembershipGovernanceManifestText,
  parseTrustedMembershipGovernanceSignerRegistry,
  applyMembershipGovernanceManifest,
  MembershipGovernanceManifestError,
  type MembershipGovernanceApproval,
  type MembershipGovernanceQueryClient,
} from "../src/lib/membership-governance-manifest";
import {
  membershipFingerprint,
  membershipManifestFingerprint,
} from "../src/lib/membership-governance";

const shouldRun = process.env.MEMBERSHIP_GOVERNANCE_MANIFEST_POSTGRES_GATE === "1";
const databaseUrl = process.env.MEMBERSHIP_GOVERNANCE_MANIFEST_POSTGRES_DATABASE_URL ?? process.env.DATABASE_URL;

interface InventoryRow {
  membership_kind: "workspace" | "project";
  membership_id: string;
  workspace_id: string;
  project_id: string | null;
  user_id: string;
  role: string;
  access_state: "pending" | "confirmed" | "revoked";
  created_at: Date;
  updated_at: Date;
}

const inventorySql = `
  SELECT 'workspace'::text AS membership_kind, wm."id"::text AS membership_id,
    wm."workspaceId"::text AS workspace_id, NULL::text AS project_id,
    wm."userId"::text AS user_id, wm."role"::text AS role,
    wm."accessState"::text AS access_state,
    to_char(wm."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at,
    to_char(wm."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS updated_at
  FROM "WorkspaceMembership" wm
  UNION ALL
  SELECT 'project'::text AS membership_kind, pm."id"::text AS membership_id,
    p."workspaceId"::text AS workspace_id, pm."projectId"::text AS project_id,
    pm."userId"::text AS user_id, pm."role"::text AS role,
    pm."accessState"::text AS access_state,
    to_char(pm."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at,
    to_char(pm."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS updated_at
  FROM "ProjectMembership" pm JOIN "Project" p ON p."id" = pm."projectId"
  ORDER BY membership_kind, membership_id
`;

function rowFingerprint(row: InventoryRow): string {
  return membershipFingerprint({
    membershipId: row.membership_id,
    resourceId: row.membership_kind === "workspace" ? row.workspace_id : row.project_id ?? "",
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function buildManifest(
  rows: readonly InventoryRow[],
  executionNonce: string,
  decisions: ReadonlyMap<string, "confirm" | "revoke">,
  expiresAt = "2099-01-01T00:00:00.000Z",
) {
  const entries = rows.map((row) => ({
    membershipKind: row.membership_kind,
    membershipId: row.membership_id,
    membershipFingerprint: rowFingerprint(row),
  }));
  const value = {
    kind: "membership-governance-manifest",
    version: 1,
    executionNonce,
    expectedInventoryFingerprint: membershipManifestFingerprint(entries),
    expiresAt,
    reason: "postgres membership governance gate",
    coverage: "all_pending",
    items: rows
      .filter((row) => row.access_state === "pending")
      .map((row) => ({
        membershipKind: row.membership_kind,
        membershipId: row.membership_id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        userId: row.user_id,
        expectedRole: row.role,
        expectedAccessState: "pending" as const,
        expectedMembershipFingerprint: rowFingerprint(row),
        decision: decisions.get(`${row.membership_kind}:${row.membership_id}`) ?? "revoke",
      })),
  };
  return parseMembershipGovernanceManifestText(JSON.stringify(value));
}

async function insertPendingMembershipWithAudit(
  client: Client,
  input: Readonly<{
    kind: "workspace" | "project";
    membershipId: string;
    workspaceId: string;
    projectId: string | null;
    userId: string;
    role: string;
  }>,
): Promise<void> {
  if (input.kind === "workspace") {
    await client.query(`
      WITH inserted AS (
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "updatedAt")
        VALUES ($1, $2, $3, $4::"WorkspaceMembershipRole", CURRENT_TIMESTAMP)
        RETURNING "id", "workspaceId", "userId", "role", "accessState", "createdAt", "updatedAt"
      )
      INSERT INTO "MembershipAccessAudit" (
        "id", "membershipKind", "membershipId", "workspaceId", "userId", "action", "newState",
        "roleSnapshot", "reason", "membershipFingerprint"
      )
      SELECT gen_random_uuid(), 'workspace', inserted."id", inserted."workspaceId", inserted."userId",
        'migration_quarantined', 'pending', inserted."role"::text,
        'postgres manifest gate seed', encode(digest(convert_to(concat_ws(E'\\x1f',
          inserted."id"::text, inserted."workspaceId"::text, inserted."userId"::text,
          inserted."role"::text,
          to_char(inserted."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
          to_char(inserted."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
        ), 'UTF8'), 'sha256'), 'hex')
      FROM inserted
    `, [input.membershipId, input.workspaceId, input.userId, input.role]);
    return;
  }
  await client.query(`
    WITH inserted AS (
      INSERT INTO "ProjectMembership" ("id", "projectId", "userId", "role", "updatedAt")
      VALUES ($1, $2, $3, $4::"ProjectMembershipRole", CURRENT_TIMESTAMP)
      RETURNING "id", "projectId", "userId", "role", "accessState", "createdAt", "updatedAt"
    )
    INSERT INTO "MembershipAccessAudit" (
      "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "newState",
      "roleSnapshot", "reason", "membershipFingerprint"
    )
    SELECT gen_random_uuid(), 'project', inserted."id", project."workspaceId", inserted."projectId", inserted."userId",
      'migration_quarantined', 'pending', inserted."role"::text,
      'postgres manifest gate seed', encode(digest(convert_to(concat_ws(E'\\x1f',
        inserted."id"::text, inserted."projectId"::text, inserted."userId"::text,
        inserted."role"::text,
        to_char(inserted."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
        to_char(inserted."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
      ), 'UTF8'), 'sha256'), 'hex')
    FROM inserted JOIN "Project" project ON project."id" = inserted."projectId"
  `, [input.membershipId, input.projectId, input.userId, input.role]);
}

async function insertConfirmedMembershipWithAudit(
  client: Client,
  input: Readonly<{
    kind: "workspace" | "project";
    membershipId: string;
    workspaceId: string;
    projectId: string | null;
    userId: string;
    role: string;
  }>,
): Promise<void> {
  if (input.kind === "workspace") {
    await client.query(`
      WITH inserted AS (
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "accessState", "updatedAt")
        VALUES ($1, $2, $3, $4::"WorkspaceMembershipRole", 'confirmed'::"MembershipAccessState", CURRENT_TIMESTAMP)
        RETURNING "id", "workspaceId", "userId", "role", "accessState", "createdAt", "updatedAt"
      )
      INSERT INTO "MembershipAccessAudit" (
        "id", "membershipKind", "membershipId", "workspaceId", "userId", "action", "newState",
        "roleSnapshot", "reason", "membershipFingerprint"
      )
      SELECT gen_random_uuid(), 'workspace', inserted."id", inserted."workspaceId", inserted."userId",
        'bootstrap_confirmed', inserted."accessState", inserted."role"::text,
        'postgres manifest gate confirmed seed', encode(digest(convert_to(concat_ws(E'\\x1f',
          inserted."id"::text, inserted."workspaceId"::text, inserted."userId"::text,
          inserted."role"::text,
          to_char(inserted."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
          to_char(inserted."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
        ), 'UTF8'), 'sha256'), 'hex')
      FROM inserted
    `, [input.membershipId, input.workspaceId, input.userId, input.role]);
    return;
  }
  await client.query(`
    WITH inserted AS (
      INSERT INTO "ProjectMembership" ("id", "projectId", "userId", "role", "accessState", "updatedAt")
      VALUES ($1, $2, $3, $4::"ProjectMembershipRole", 'confirmed'::"MembershipAccessState", CURRENT_TIMESTAMP)
      RETURNING "id", "projectId", "userId", "role", "accessState", "createdAt", "updatedAt"
    )
    INSERT INTO "MembershipAccessAudit" (
      "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "newState",
      "roleSnapshot", "reason", "membershipFingerprint"
    )
    SELECT gen_random_uuid(), 'project', inserted."id", project."workspaceId", inserted."projectId", inserted."userId",
      'bootstrap_confirmed', inserted."accessState", inserted."role"::text,
      'postgres manifest gate confirmed seed', encode(digest(convert_to(concat_ws(E'\\x1f',
        inserted."id"::text, inserted."projectId"::text, inserted."userId"::text,
        inserted."role"::text,
        to_char(inserted."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
        to_char(inserted."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
      ), 'UTF8'), 'sha256'), 'hex')
    FROM inserted JOIN "Project" project ON project."id" = inserted."projectId"
  `, [input.membershipId, input.projectId, input.userId, input.role]);
}

test(
  "membership governance manifest applies atomically, preserves history, and is idempotent",
  { skip: !shouldRun ? "MEMBERSHIP_GOVERNANCE_MANIFEST_POSTGRES_GATE=1 is required" : false },
  async () => {
    if (typeof databaseUrl !== "string" || databaseUrl.length === 0) throw new Error("DATABASE_URL_REQUIRED");
    const client = new Client({ connectionString: databaseUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const workspaceMembershipId = randomUUID();
    const projectMembershipId = randomUUID();
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)`, [userId, `manifest_gate_${suffix}`]);
      await client.query(`INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [workspaceId, `Manifest gate ${suffix}`, `manifest-gate-${suffix}`, userId]);
      await client.query(`INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [projectId, workspaceId, `Manifest project ${suffix}`, `manifest-project-${suffix}`]);
      await insertPendingMembershipWithAudit(client, { kind: "workspace", membershipId: workspaceMembershipId, workspaceId, projectId: null, userId, role: "owner" });
      await insertPendingMembershipWithAudit(client, { kind: "project", membershipId: projectMembershipId, workspaceId, projectId, userId, role: "owner" });
      await client.query("COMMIT");

      const inventory = (await client.query<InventoryRow>(inventorySql)).rows;
      assert.equal(inventory.filter((row) => row.membership_id === workspaceMembershipId || row.membership_id === projectMembershipId).length, 2);
      const manifest = buildManifest(inventory, randomUUID(), new Map([
        [`workspace:${workspaceMembershipId}`, "confirm"],
        [`project:${projectMembershipId}`, "confirm"],
      ]));
      const db = client as unknown as MembershipGovernanceQueryClient;
      const signed = signedApprovals(manifest, "initial");
      const result = await applyWithTrustedRegistry(db, manifest, signed, "postgres-gate");
      assert.equal(result.status, "applied");
      const states = await client.query<{ workspace_state: string; project_state: string; audits: string; executions: string; approvals: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS workspace_state,
          (SELECT "accessState"::text FROM "ProjectMembership" WHERE "id" = $2) AS project_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $3) AS audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $3) AS executions,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceApproval" WHERE "executionId" = $4) AS approvals
      `, [workspaceMembershipId, projectMembershipId, result.manifestFingerprint, result.executionId]);
      assert.deepEqual(states.rows[0], { workspace_state: "confirmed", project_state: "confirmed", audits: "2", executions: "1", approvals: "2" });

      const evidence = await client.query<{
        trusted_registry_fingerprint: string;
        canonical_manifest: string;
        snapshot: Record<string, unknown>;
        public_key_fingerprint: string;
        signature_fingerprint: string;
        public_key_der: Buffer;
        signature: Buffer;
      }>(`
        SELECT
          execution."trustedSignerRegistryFingerprint" AS trusted_registry_fingerprint,
          execution."canonicalManifest" AS canonical_manifest,
          execution."snapshot" AS snapshot,
          approval."publicKeyFingerprint" AS public_key_fingerprint,
          approval."signatureFingerprint" AS signature_fingerprint,
          approval."publicKeyDer" AS public_key_der,
          approval."signature" AS signature
        FROM "MembershipGovernanceExecution" execution
        JOIN "MembershipGovernanceApproval" approval ON approval."executionId" = execution."id"
        WHERE execution."id" = $1
        ORDER BY approval."signerId"
      `, [result.executionId]);
      const parsedRegistry = parseTrustedMembershipGovernanceSignerRegistry(registryTextFor(signed));
      const directEvidenceRegistry = membershipGovernanceTrustedSignerRegistryFingerprint(parsedRegistry);
      assert.equal(evidence.rows.length, 2);
      assert.equal(
        evidence.rows[0]?.trusted_registry_fingerprint,
        membershipGovernanceTrustedSignerRegistryFingerprint(parsedRegistry),
      );
      for (const row of evidence.rows) {
        const snapshotManifest = parseMembershipGovernanceManifestText(JSON.stringify(row.snapshot));
        assert.deepEqual(snapshotManifest, manifest);
        assert.equal(row.canonical_manifest, canonicalMembershipGovernanceManifest(manifest));
        const publicKey = createPublicKey({ key: row.public_key_der, format: "der", type: "spki" });
        assert.equal(verifySignature(null, Buffer.from(row.canonical_manifest, "utf8"), publicKey, row.signature), true);
        assert.equal(createHash("sha256").update(row.public_key_der).digest("hex"), row.public_key_fingerprint);
        assert.equal(createHash("sha256").update(row.signature).digest("hex"), row.signature_fingerprint);
      }

      // The final evidence count must include every manifest-tagged audit, not
      // only the confirmed/revoked item transitions. A structurally complete
      // execution with one valid item audit plus an extra bootstrap audit must
      // fail at commit and leave the membership and all evidence untouched.
      const extraUserId = randomUUID();
      const extraMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)`, [extraUserId, `manifest_extra_${suffix}`]);
      await insertPendingMembershipWithAudit(client, {
        kind: "workspace",
        membershipId: extraMembershipId,
        workspaceId,
        projectId: null,
        userId: extraUserId,
        role: "viewer",
      });
      await client.query("COMMIT");

      const extraInventory = (await client.query<InventoryRow>(inventorySql)).rows;
      const extraPendingRow = extraInventory.find((row) => row.membership_id === extraMembershipId);
      assert.ok(extraPendingRow);
      const extraManifest = buildManifest(extraInventory, randomUUID(), new Map([
        [`workspace:${extraMembershipId}`, "confirm"],
      ]));
      const extraManifestFingerprint = membershipGovernanceManifestFingerprint(extraManifest);

      await client.query("BEGIN");
      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'confirmed' WHERE "id" = $1`, [extraMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'confirmed', 'pending', 'confirmed', $5, NULL, $6, $7, $8)
      `, [
        randomUUID(),
        extraMembershipId,
        extraPendingRow.workspace_id,
        extraPendingRow.user_id,
        extraPendingRow.role,
        "extra manifest item audit",
        rowFingerprint(extraPendingRow),
        extraManifestFingerprint,
      ]);
      const extraExecutionId = await insertDirectExecution(client, extraManifest, directEvidenceRegistry);
      for (const [index, approval] of evidence.rows.entries()) {
        await client.query(`
          INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        `, [
          randomUUID(),
          extraExecutionId,
          `extra_manifest_${index}`,
          approval.public_key_fingerprint,
          approval.signature_fingerprint,
          approval.public_key_der,
          approval.signature,
        ]);
      }
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'bootstrap_confirmed', NULL, 'confirmed', $5, NULL, $6, $7, $8)
      `, [
        randomUUID(),
        extraMembershipId,
        extraPendingRow.workspace_id,
        extraPendingRow.user_id,
        extraPendingRow.role,
        "extra non-item manifest audit",
        rowFingerprint(extraPendingRow),
        extraManifestFingerprint,
      ]);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      const extraRollback = await client.query<{
        access_state: string;
        audits: string;
        executions: string;
        approvals: string;
      }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS access_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $2) AS audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $2) AS executions,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceApproval" WHERE "executionId" = $3) AS approvals
      `, [extraMembershipId, extraManifestFingerprint, extraExecutionId]);
      assert.deepEqual(extraRollback.rows[0], {
        access_state: "pending",
        audits: "0",
        executions: "0",
        approvals: "0",
      });

      // Re-running only the execution evidence trigger must not open a timing
      // gap: after it passes, a second pending transition tagged with the same
      // manifest is still rejected by the audit/transition revalidation.
      const bypassUserId = randomUUID();
      const bypassMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)`, [bypassUserId, `manifest_bypass_${suffix}`]);
      await insertPendingMembershipWithAudit(client, {
        kind: "workspace",
        membershipId: bypassMembershipId,
        workspaceId,
        projectId: null,
        userId: bypassUserId,
        role: "viewer",
      });
      await client.query("COMMIT");
      const bypassSecondRow = (await client.query<InventoryRow>(inventorySql)).rows.find((row) => row.membership_id === bypassMembershipId);
      assert.ok(bypassSecondRow);

      const bypassExecutionId = randomUUID();
      await client.query("BEGIN");
      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'confirmed' WHERE "id" = $1`, [extraMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'confirmed', 'pending', 'confirmed', $5, NULL, $6, $7, $8)
      `, [
        randomUUID(),
        extraMembershipId,
        extraPendingRow.workspace_id,
        extraPendingRow.user_id,
        extraPendingRow.role,
        "immediate evidence item audit",
        rowFingerprint(extraPendingRow),
        extraManifestFingerprint,
      ]);
      await client.query(
        `INSERT INTO "MembershipGovernanceExecution" (
          "id", "manifestFingerprint", "executionNonce", "expectedInventoryFingerprint",
          "trustedSignerRegistryFingerprint", "version", "coverage", "expiresAt", "reason",
          "itemCount", "canonicalManifest", "snapshot", "executorLabel"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
        [
          bypassExecutionId,
          extraManifestFingerprint,
          extraManifest.executionNonce,
          extraManifest.expectedInventoryFingerprint,
          directEvidenceRegistry,
          extraManifest.version,
          extraManifest.coverage,
          extraManifest.expiresAt,
          extraManifest.reason,
          extraManifest.items.length,
          canonicalMembershipGovernanceManifest(extraManifest),
          JSON.stringify(buildMembershipGovernanceSafeSnapshot(extraManifest)),
          "immediate-evidence-test",
        ],
      );
      for (const [index, approval] of evidence.rows.entries()) {
        await client.query(`
          INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        `, [
          randomUUID(),
          bypassExecutionId,
          `immediate_evidence_${index}`,
          approval.public_key_fingerprint,
          approval.signature_fingerprint,
          approval.public_key_der,
          approval.signature,
        ]);
      }
      await client.query(`SET CONSTRAINTS "MembershipGovernanceExecution_membership_evidence_guard" IMMEDIATE`);

      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'confirmed' WHERE "id" = $1`, [bypassMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'confirmed', 'pending', 'confirmed', $5, NULL, $6, $7, $8)
      `, [
        randomUUID(),
        bypassMembershipId,
        bypassSecondRow.workspace_id,
        bypassSecondRow.user_id,
        bypassSecondRow.role,
        "immediate evidence extra transition",
        rowFingerprint(bypassSecondRow),
        extraManifestFingerprint,
      ]);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      const bypassRollback = await client.query<{
        first_state: string;
        second_state: string;
        audits: string;
        executions: string;
        approvals: string;
      }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS first_state,
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $2) AS second_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $3) AS audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $3) AS executions,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceApproval" WHERE "executionId" = $4) AS approvals
      `, [extraMembershipId, bypassMembershipId, extraManifestFingerprint, bypassExecutionId]);
      assert.deepEqual(bypassRollback.rows[0], {
        first_state: "pending",
        second_state: "pending",
        audits: "0",
        executions: "0",
        approvals: "0",
      });

      // Immediate validation also binds the final row state. After a complete
      // confirm evidence set passes all three relevant constraints immediately,
      // a later ordinary confirmed -> revoked mutation in the same transaction
      // must fail the deferred revalidation even though its audit is untagged.
      await client.query("BEGIN");
      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'confirmed' WHERE "id" = $1`, [extraMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'confirmed', 'pending', 'confirmed', $5, NULL, $6, $7, $8)
      `, [
        randomUUID(),
        extraMembershipId,
        extraPendingRow.workspace_id,
        extraPendingRow.user_id,
        extraPendingRow.role,
        "final state confirm audit",
        rowFingerprint(extraPendingRow),
        extraManifestFingerprint,
      ]);
      const finalStateExecutionId = await insertDirectExecution(client, extraManifest, directEvidenceRegistry);
      for (const [index, approval] of evidence.rows.entries()) {
        await client.query(`
          INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        `, [
          randomUUID(),
          finalStateExecutionId,
          `final_state_${index}`,
          approval.public_key_fingerprint,
          approval.signature_fingerprint,
          approval.public_key_der,
          approval.signature,
        ]);
      }
      await client.query(`SET CONSTRAINTS "MembershipGovernanceExecution_membership_evidence_guard", "MembershipAccessAudit_manifest_evidence_guard", "WorkspaceMembership_pending_transition_evidence_guard" IMMEDIATE`);
      await client.query(`SET CONSTRAINTS "MembershipGovernanceExecution_membership_evidence_guard", "MembershipAccessAudit_manifest_evidence_guard", "WorkspaceMembership_pending_transition_evidence_guard" DEFERRED`);

      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'revoked' WHERE "id" = $1`, [extraMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'revoked', 'confirmed', 'revoked', $5, NULL, $6, $7, NULL)
      `, [
        randomUUID(),
        extraMembershipId,
        extraPendingRow.workspace_id,
        extraPendingRow.user_id,
        extraPendingRow.role,
        "ordinary post-confirm revoke audit",
        rowFingerprint(extraPendingRow),
      ]);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      const finalStateRollback = await client.query<{
        access_state: string;
        audits: string;
        executions: string;
        approvals: string;
      }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS access_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $2) AS audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $2) AS executions,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceApproval" WHERE "executionId" = $3) AS approvals
      `, [extraMembershipId, extraManifestFingerprint, finalStateExecutionId]);
      assert.deepEqual(finalStateRollback.rows[0], {
        access_state: "pending",
        audits: "0",
        executions: "0",
        approvals: "0",
      });

      // A membership delete is also rejected when the same transaction has a
      // governance execution for that item: the shared validator must observe
      // the missing final row and roll back all evidence. Direct membership
      // DELETE remains forbidden by the legacy history guard, so use an
      // independent AppUser cascade to exercise the new AFTER DELETE path.
      // The legacy history guard permits this parent cascade after the user
      // row has disappeared, while a direct membership DELETE remains forbidden.
      const cascadeManifest = buildManifest([extraPendingRow], randomUUID(), new Map([
        [`workspace:${extraMembershipId}`, "confirm"],
      ]));
      const cascadeManifestFingerprint = membershipGovernanceManifestFingerprint(cascadeManifest);
      await client.query("BEGIN");
      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'confirmed' WHERE "id" = $1`, [extraMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'confirmed', 'pending', 'confirmed', $5, NULL, $6, $7, $8)
      `, [
        randomUUID(),
        extraMembershipId,
        extraPendingRow.workspace_id,
        extraPendingRow.user_id,
        extraPendingRow.role,
        "delete evidence confirm audit",
        rowFingerprint(extraPendingRow),
        cascadeManifestFingerprint,
      ]);
      const deleteExecutionId = await insertDirectExecution(client, cascadeManifest, directEvidenceRegistry);
      for (const [index, approval] of evidence.rows.entries()) {
        await client.query(`
          INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        `, [
          randomUUID(),
          deleteExecutionId,
          `delete_state_${index}`,
          approval.public_key_fingerprint,
          approval.signature_fingerprint,
          approval.public_key_der,
          approval.signature,
        ]);
      }
      await client.query(`SET CONSTRAINTS "MembershipGovernanceExecution_membership_evidence_guard", "MembershipAccessAudit_manifest_evidence_guard", "WorkspaceMembership_pending_transition_evidence_guard" IMMEDIATE`);
      await client.query(`SET CONSTRAINTS "MembershipGovernanceExecution_membership_evidence_guard", "MembershipAccessAudit_manifest_evidence_guard", "WorkspaceMembership_pending_transition_evidence_guard" DEFERRED`);
      await client.query(`DELETE FROM "AppUser" WHERE "id" = $1`, [extraUserId]);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      const deleteRollback = await client.query<{
        access_state: string;
        audits: string;
        executions: string;
        approvals: string;
      }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS access_state,
          (SELECT COUNT(*)::text FROM "AppUser" WHERE "id" = $4) AS app_users,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $2) AS audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $2) AS executions,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceApproval" WHERE "executionId" = $3) AS approvals
      `, [extraMembershipId, cascadeManifestFingerprint, deleteExecutionId, extraUserId]);
      assert.deepEqual(deleteRollback.rows[0], {
        access_state: "pending",
        app_users: "1",
        audits: "0",
        executions: "0",
        approvals: "0",
      });

      // Database backstops reject forged byte/fingerprint pairs even when a
      // caller bypasses the local Ed25519 verifier. The temporary execution
      // rows stay inside rolled-back transactions, so no evidence is left.
      const directFingerprintManifest = parseMembershipGovernanceManifestText(JSON.stringify({
        ...manifest,
        executionNonce: randomUUID(),
        reason: "direct fingerprint check",
      }));
      await client.query("BEGIN");
      const directKeyExecutionId = await insertDirectExecution(client, directFingerprintManifest, directEvidenceRegistry);
      await assert.rejects(
        () => client.query(`
          INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        `, [randomUUID(), directKeyExecutionId, "direct_key_forgery", "0".repeat(64), evidence.rows[0]!.signature_fingerprint, evidence.rows[0]!.public_key_der, evidence.rows[0]!.signature]),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      const directSignatureExecutionId = await insertDirectExecution(client, directFingerprintManifest, directEvidenceRegistry);
      await assert.rejects(
        () => client.query(`
          INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        `, [randomUUID(), directSignatureExecutionId, "direct_signature_forgery", evidence.rows[0]!.public_key_fingerprint, "0".repeat(64), evidence.rows[0]!.public_key_der, evidence.rows[0]!.signature]),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      // The execution stores the canonical payload and snapshot as one
      // semantic object. A direct SQL execution with an audit whose identity
      // or decision differs from the snapshot cannot commit.
      const snapshotMismatchManifest = parseMembershipGovernanceManifestText(JSON.stringify({
        ...manifest,
        executionNonce: randomUUID(),
        reason: "direct snapshot mismatch check",
        items: manifest.items.map((item) => ({
          ...item,
          membershipId: randomUUID(),
          decision: "revoke" as const,
        })),
      }));
      const snapshotMismatchRow = inventory.find((row) => row.membership_id === workspaceMembershipId)!;
      await client.query("BEGIN");
      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'revoked' WHERE "id" = $1`, [workspaceMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'revoked', 'confirmed', 'revoked', $5, NULL, $6, $7, $8)
      `, [
        randomUUID(),
        workspaceMembershipId,
        snapshotMismatchRow.workspace_id,
        snapshotMismatchRow.user_id,
        snapshotMismatchRow.role,
        "direct snapshot mismatch audit",
        rowFingerprint(snapshotMismatchRow),
        membershipGovernanceManifestFingerprint(snapshotMismatchManifest),
      ]);
      const snapshotMismatchExecutionId = await insertDirectExecution(
        client,
        snapshotMismatchManifest,
        directEvidenceRegistry,
      );
      for (const [index, approval] of evidence.rows.entries()) {
        await client.query(`
          INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        `, [
          randomUUID(),
          snapshotMismatchExecutionId,
          `snapshot_mismatch_${index}`,
          approval.public_key_fingerprint,
          approval.signature_fingerprint,
          approval.public_key_der,
          approval.signature,
        ]);
      }
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      // Neither approvals nor manifest-tagged audits may be appended to a
      // committed execution from a later transaction.
      await assert.rejects(
        () => client.query(`
          INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        `, [randomUUID(), result.executionId, "late_approval", evidence.rows[0]!.public_key_fingerprint, evidence.rows[0]!.signature_fingerprint, evidence.rows[0]!.public_key_der, evidence.rows[0]!.signature]),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );

      const staleAuditRow = inventory.find((row) => row.membership_id === projectMembershipId)!;
      await client.query("BEGIN");
      await client.query(`UPDATE "ProjectMembership" SET "accessState" = 'revoked' WHERE "id" = $1`, [projectMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'project', $2, $3, $4, $5, 'revoked', 'confirmed', 'revoked', $6, NULL, $7, $8, $9)
      `, [
        randomUUID(),
        projectMembershipId,
        staleAuditRow.workspace_id,
        staleAuditRow.project_id,
        staleAuditRow.user_id,
        staleAuditRow.role,
        "stale manifest audit",
        rowFingerprint(staleAuditRow),
        result.manifestFingerprint,
      ]);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      const replay = await applyWithTrustedRegistry(db, manifest, signed, "postgres-gate");
      assert.equal(replay.status, "alreadyApplied");
      assert.equal(replay.executionId, result.executionId);
      const auditCount = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $1`, [result.manifestFingerprint]);
      assert.equal(auditCount.rows[0]?.count, "2");

      // Two different manifests race over the same pending rows. Session
      // discovery locks force the loser to begin only after the winner has
      // committed, so exactly one batch can apply and the other must fail
      // against the changed pending set without partial writes.
      const raceWorkspaceId = randomUUID();
      const raceProjectId = randomUUID();
      const raceWorkspaceMembershipId = randomUUID();
      const raceProjectMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [raceWorkspaceId, `Manifest race workspace ${suffix}`, `manifest-race-${suffix}`, userId]);
      await client.query(`INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "membershipInheritanceMode", "updatedAt") VALUES ($1, $2, $3, $4, 'workspace_inherited', CURRENT_TIMESTAMP)`, [raceProjectId, raceWorkspaceId, `Manifest race project ${suffix}`, `manifest-race-project-${suffix}`]);
      await insertPendingMembershipWithAudit(client, { kind: "workspace", membershipId: raceWorkspaceMembershipId, workspaceId: raceWorkspaceId, projectId: null, userId, role: "owner" });
      await insertPendingMembershipWithAudit(client, { kind: "project", membershipId: raceProjectMembershipId, workspaceId: raceWorkspaceId, projectId: raceProjectId, userId, role: "viewer" });
      await client.query("COMMIT");

      const raceInventory = (await client.query<InventoryRow>(inventorySql)).rows;
      const raceManifestConfirm = buildManifest(raceInventory, randomUUID(), new Map([
        [`workspace:${raceWorkspaceMembershipId}`, "confirm"],
        [`project:${raceProjectMembershipId}`, "confirm"],
      ]));
      const raceManifestRevoke = buildManifest(raceInventory, randomUUID(), new Map([
        [`workspace:${raceWorkspaceMembershipId}`, "confirm"],
        [`project:${raceProjectMembershipId}`, "revoke"],
      ]));
      const raceConfirmSigned = signedApprovals(raceManifestConfirm, "race_confirm");
      const raceRevokeSigned = signedApprovals(raceManifestRevoke, "race_revoke");
      const raceClientConfirm = new Client({ connectionString: databaseUrl });
      const raceClientRevoke = new Client({ connectionString: databaseUrl });
      await Promise.all([raceClientConfirm.connect(), raceClientRevoke.connect()]);
      let raceResults: PromiseSettledResult<Awaited<ReturnType<typeof applyMembershipGovernanceManifest>>>[];
      const previousRaceTrustedRegistry = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
      process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = registryTextFor(raceConfirmSigned, raceRevokeSigned);
      try {
        raceResults = await Promise.allSettled([
          applyMembershipGovernanceManifest(
            raceClientConfirm as unknown as MembershipGovernanceQueryClient,
            canonicalMembershipGovernanceManifest(raceManifestConfirm),
            raceConfirmSigned.approvalTexts,
            "postgres-race-confirm",
          ),
          applyMembershipGovernanceManifest(
            raceClientRevoke as unknown as MembershipGovernanceQueryClient,
            canonicalMembershipGovernanceManifest(raceManifestRevoke),
            raceRevokeSigned.approvalTexts,
            "postgres-race-revoke",
          ),
        ]);
      } finally {
        restoreTrustedRegistry(previousRaceTrustedRegistry);
        await Promise.all([raceClientConfirm.end(), raceClientRevoke.end()]);
      }
      const raceSuccesses = raceResults.filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof applyMembershipGovernanceManifest>>> => entry.status === "fulfilled");
      const raceFailures = raceResults.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      assert.equal(raceSuccesses.length, 1);
      assert.equal(raceFailures.length, 1);
      const raceRevokeAuditCount = raceManifestRevoke.items.filter((item) => item.decision === "revoke").length.toString();
      assert.ok(raceFailures[0]?.reason instanceof MembershipGovernanceManifestError);
      assert.ok([
        "MEMBERSHIP_GOVERNANCE_PENDING_SET_MISMATCH",
        "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH",
        "MEMBERSHIP_GOVERNANCE_OWNER_LOCKOUT",
      ].includes((raceFailures[0]?.reason as MembershipGovernanceManifestError).code));
      const raceState = await client.query<{ workspace_state: string; project_state: string; confirmed_audits: string; revoked_audits: string; executions: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS workspace_state,
          (SELECT "accessState"::text FROM "ProjectMembership" WHERE "id" = $2) AS project_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $3 AND "action" = 'confirmed') AS confirmed_audits,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $4 AND "action" = 'revoked') AS revoked_audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" IN ($3, $4)) AS executions
      `, [raceWorkspaceMembershipId, raceProjectMembershipId, membershipGovernanceManifestFingerprint(raceManifestConfirm), membershipGovernanceManifestFingerprint(raceManifestRevoke)]);
      assert.deepEqual(raceState.rows[0], {
        workspace_state: "confirmed",
        project_state: raceSuccesses[0]?.value.manifestFingerprint === membershipGovernanceManifestFingerprint(raceManifestRevoke) ? "revoked" : "confirmed",
        confirmed_audits: raceSuccesses[0]?.value.manifestFingerprint === membershipGovernanceManifestFingerprint(raceManifestRevoke) ? "0" : "2",
        revoked_audits: raceSuccesses[0]?.value.manifestFingerprint === membershipGovernanceManifestFingerprint(raceManifestRevoke) ? raceRevokeAuditCount : "0",
        executions: "1",
      });

      // A disabled confirmed owner is not an effective owner. The workspace
      // case also includes a confirmed project owner deliberately: project
      // membership must never satisfy the workspace-owner invariant.
      const disabledOwnerId = randomUUID();
      const disabledWorkspaceId = randomUUID();
      const disabledProjectId = randomUUID();
      const disabledWorkspaceOwnerMembershipId = randomUUID();
      const disabledProjectOwnerMembershipId = randomUUID();
      const pendingWorkspaceOwnerMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`INSERT INTO "AppUser" ("id", "username", "role", "disabledAt", "updatedAt") VALUES ($1, $2, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [disabledOwnerId, `manifest_disabled_owner_${suffix}`]);
      await client.query(`INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [disabledWorkspaceId, `Manifest disabled workspace ${suffix}`, `manifest-disabled-${suffix}`, userId]);
      await client.query(`INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "membershipInheritanceMode", "updatedAt") VALUES ($1, $2, $3, $4, 'workspace_inherited', CURRENT_TIMESTAMP)`, [disabledProjectId, disabledWorkspaceId, `Manifest disabled project ${suffix}`, `manifest-disabled-project-${suffix}`]);
      await insertConfirmedMembershipWithAudit(client, { kind: "workspace", membershipId: disabledWorkspaceOwnerMembershipId, workspaceId: disabledWorkspaceId, projectId: null, userId: disabledOwnerId, role: "owner" });
      await insertConfirmedMembershipWithAudit(client, { kind: "project", membershipId: disabledProjectOwnerMembershipId, workspaceId: disabledWorkspaceId, projectId: disabledProjectId, userId: disabledOwnerId, role: "owner" });
      await insertPendingMembershipWithAudit(client, { kind: "workspace", membershipId: pendingWorkspaceOwnerMembershipId, workspaceId: disabledWorkspaceId, projectId: null, userId, role: "owner" });
      await client.query("COMMIT");
      const disabledWorkspaceInventory = (await client.query<InventoryRow>(inventorySql)).rows;
      const disabledWorkspaceManifest = buildManifest(disabledWorkspaceInventory, randomUUID(), new Map([
        [`workspace:${pendingWorkspaceOwnerMembershipId}`, "revoke"],
      ]));
      const disabledWorkspaceSigned = signedApprovals(disabledWorkspaceManifest, "disabled_workspace");
      const previousDisabledWorkspaceRegistry = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
      process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = registryTextFor(disabledWorkspaceSigned);
      try {
        await assert.rejects(
          () => applyMembershipGovernanceManifest(
            client as unknown as MembershipGovernanceQueryClient,
            canonicalMembershipGovernanceManifest(disabledWorkspaceManifest),
            disabledWorkspaceSigned.approvalTexts,
            "postgres-disabled-workspace",
          ),
          (error: unknown) => error instanceof MembershipGovernanceManifestError && error.code === "MEMBERSHIP_GOVERNANCE_OWNER_LOCKOUT",
        );
      } finally {
        restoreTrustedRegistry(previousDisabledWorkspaceRegistry);
      }
      const disabledWorkspaceState = await client.query<{ access_state: string; audits: string; executions: string; approvals: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS access_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "membershipId" = $1 AND "manifestFingerprint" = $2) AS audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $2) AS executions,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceApproval" approval JOIN "MembershipGovernanceExecution" execution ON execution."id" = approval."executionId" WHERE execution."manifestFingerprint" = $2) AS approvals
      `, [pendingWorkspaceOwnerMembershipId, membershipGovernanceManifestFingerprint(disabledWorkspaceManifest)]);
      assert.deepEqual(disabledWorkspaceState.rows[0], { access_state: "pending", audits: "0", executions: "0", approvals: "0" });

      // A project-only project likewise cannot retain a disabled confirmed
      // project owner after its only enabled pending owner is revoked.
      const projectOnlyWorkspaceId = randomUUID();
      const projectOnlyProjectId = randomUUID();
      const projectOnlyWorkspaceOwnerMembershipId = randomUUID();
      const projectOnlyDisabledOwnerMembershipId = randomUUID();
      const pendingProjectOnlyOwnerMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [projectOnlyWorkspaceId, `Manifest project-only workspace ${suffix}`, `manifest-project-only-${suffix}`, userId]);
      await client.query(`INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "membershipInheritanceMode", "updatedAt") VALUES ($1, $2, $3, $4, 'project_only', CURRENT_TIMESTAMP)`, [projectOnlyProjectId, projectOnlyWorkspaceId, `Manifest project-only project ${suffix}`, `manifest-project-only-project-${suffix}`]);
      await insertConfirmedMembershipWithAudit(client, { kind: "workspace", membershipId: projectOnlyWorkspaceOwnerMembershipId, workspaceId: projectOnlyWorkspaceId, projectId: null, userId, role: "owner" });
      await insertConfirmedMembershipWithAudit(client, { kind: "project", membershipId: projectOnlyDisabledOwnerMembershipId, workspaceId: projectOnlyWorkspaceId, projectId: projectOnlyProjectId, userId: disabledOwnerId, role: "owner" });
      await insertPendingMembershipWithAudit(client, { kind: "project", membershipId: pendingProjectOnlyOwnerMembershipId, workspaceId: projectOnlyWorkspaceId, projectId: projectOnlyProjectId, userId, role: "owner" });
      await client.query("COMMIT");
      const disabledProjectInventory = (await client.query<InventoryRow>(inventorySql)).rows;
      const disabledProjectManifest = buildManifest(disabledProjectInventory, randomUUID(), new Map([
        [`workspace:${pendingWorkspaceOwnerMembershipId}`, "confirm"],
        [`project:${pendingProjectOnlyOwnerMembershipId}`, "revoke"],
      ]));
      const disabledProjectSigned = signedApprovals(disabledProjectManifest, "disabled_project");
      const previousDisabledProjectRegistry = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
      process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = registryTextFor(disabledProjectSigned);
      try {
        await assert.rejects(
          () => applyMembershipGovernanceManifest(
            client as unknown as MembershipGovernanceQueryClient,
            canonicalMembershipGovernanceManifest(disabledProjectManifest),
            disabledProjectSigned.approvalTexts,
            "postgres-disabled-project",
          ),
          (error: unknown) => error instanceof MembershipGovernanceManifestError && error.code === "MEMBERSHIP_GOVERNANCE_OWNER_LOCKOUT",
        );
      } finally {
        restoreTrustedRegistry(previousDisabledProjectRegistry);
      }
      const disabledProjectState = await client.query<{ workspace_state: string; project_state: string; workspace_audits: string; project_audits: string; executions: string; approvals: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS workspace_state,
          (SELECT "accessState"::text FROM "ProjectMembership" WHERE "id" = $2) AS project_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "membershipId" IN ($1, $2) AND "manifestFingerprint" = $3) AS workspace_audits,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "membershipId" = $2 AND "manifestFingerprint" = $3) AS project_audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $3) AS executions,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceApproval" approval JOIN "MembershipGovernanceExecution" execution ON execution."id" = approval."executionId" WHERE execution."manifestFingerprint" = $3) AS approvals
      `, [pendingWorkspaceOwnerMembershipId, pendingProjectOnlyOwnerMembershipId, membershipGovernanceManifestFingerprint(disabledProjectManifest)]);
      assert.deepEqual(disabledProjectState.rows[0], { workspace_state: "pending", project_state: "pending", workspace_audits: "0", project_audits: "0", executions: "0", approvals: "0" });

      // Expiry is checked against clock_timestamp() only after all relation
      // and row locks. Holding a conflicting table lock here proves that a
      // manifest which expires while waiting cannot mutate any membership.
      const expiryWorkspaceId = randomUUID();
      const expiryMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [expiryWorkspaceId, `Manifest expiry workspace ${suffix}`, `manifest-expiry-${suffix}`, userId]);
      await insertPendingMembershipWithAudit(client, { kind: "workspace", membershipId: expiryMembershipId, workspaceId: expiryWorkspaceId, projectId: null, userId, role: "owner" });
      await client.query("COMMIT");
      const expiryInventory = (await client.query<InventoryRow>(inventorySql)).rows;
      const expiryManifest = buildManifest(
        expiryInventory,
        randomUUID(),
        new Map([[`workspace:${expiryMembershipId}`, "confirm"]]),
        new Date(Date.now() + 1000).toISOString(),
      );
      const expiryBlocker = new Client({ connectionString: databaseUrl });
      const expiryApplyClient = new Client({ connectionString: databaseUrl });
      await Promise.all([expiryBlocker.connect(), expiryApplyClient.connect()]);
      let expiryBlockerInTransaction = false;
      const expirySigned = signedApprovals(expiryManifest, "expiry");
      try {
        await expiryBlocker.query("BEGIN");
        expiryBlockerInTransaction = true;
        await expiryBlocker.query('LOCK TABLE "Workspace" IN ROW EXCLUSIVE MODE');
        const previousTrustedRegistry = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
        process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = registryTextFor(expirySigned);
        try {
          const expiryApply = applyMembershipGovernanceManifest(
            expiryApplyClient as unknown as MembershipGovernanceQueryClient,
            canonicalMembershipGovernanceManifest(expiryManifest),
            expirySigned.approvalTexts,
            "postgres-expiry",
          );
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await expiryBlocker.query("COMMIT");
          expiryBlockerInTransaction = false;
          await assert.rejects(
            () => expiryApply,
            (error: unknown) => error instanceof MembershipGovernanceManifestError && error.code === "MEMBERSHIP_GOVERNANCE_MANIFEST_EXPIRED",
          );
        } finally {
          restoreTrustedRegistry(previousTrustedRegistry);
        }
      } finally {
        if (expiryBlockerInTransaction) await expiryBlocker.query("ROLLBACK");
        await Promise.all([expiryBlocker.end(), expiryApplyClient.end()]);
      }
      const expiryState = await client.query<{ access_state: string; audits: string; executions: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS access_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "membershipId" = $1 AND "manifestFingerprint" = $2) AS audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $2) AS executions
      `, [expiryMembershipId, membershipGovernanceManifestFingerprint(expiryManifest)]);
      assert.deepEqual(expiryState.rows[0], { access_state: "pending", audits: "0", executions: "0" });

      // A complete workspace table check catches a workspace whose only owner
      // is pending: revoking that row must fail before any state or audit write.
      const lockoutWorkspaceId = randomUUID();
      const lockoutMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [lockoutWorkspaceId, `Manifest lockout workspace ${suffix}`, `manifest-lockout-${suffix}`, userId]);
      await insertPendingMembershipWithAudit(client, { kind: "workspace", membershipId: lockoutMembershipId, workspaceId: lockoutWorkspaceId, projectId: null, userId, role: "owner" });
      await client.query("COMMIT");
      const lockoutInventory = (await client.query<InventoryRow>(inventorySql)).rows;
      const lockoutManifest = buildManifest(lockoutInventory, randomUUID(), new Map([
        [`workspace:${lockoutMembershipId}`, "revoke"],
      ]));
      const lockoutSigned = signedApprovals(lockoutManifest, "lockout");
      const previousLockoutTrustedRegistry = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
      process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = registryTextFor(lockoutSigned);
      try {
        await assert.rejects(
          () => applyMembershipGovernanceManifest(
            client as unknown as MembershipGovernanceQueryClient,
            canonicalMembershipGovernanceManifest(lockoutManifest),
            lockoutSigned.approvalTexts,
            "postgres-lockout",
          ),
          (error: unknown) => error instanceof MembershipGovernanceManifestError && error.code === "MEMBERSHIP_GOVERNANCE_OWNER_LOCKOUT",
        );
      } finally {
        restoreTrustedRegistry(previousLockoutTrustedRegistry);
      }
      const lockoutState = await client.query<{ access_state: string; audits: string; executions: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS access_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "manifestFingerprint" = $2) AS audits,
          (SELECT COUNT(*)::text FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $2) AS executions
      `, [lockoutMembershipId, membershipGovernanceManifestFingerprint(lockoutManifest)]);
      assert.deepEqual(lockoutState.rows[0], { access_state: "pending", audits: "0", executions: "0" });

      // Ordinary SQL that appears to provide a correctly shaped audit still
      // cannot finalize a pending row.  The deferred transition evidence
      // guard requires a same-transaction manifest execution, so both the
      // state mutation and ordinary audit roll back atomically.
      const directPendingUserId = randomUUID();
      const directPendingWorkspaceId = randomUUID();
      const directPendingProjectId = randomUUID();
      const directPendingWorkspaceMembershipId = randomUUID();
      const directPendingProjectMembershipId = randomUUID();
      await client.query("BEGIN");
      await client.query(`INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)`, [directPendingUserId, `manifest_direct_pending_${suffix}`]);
      await client.query(`INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [directPendingWorkspaceId, `Manifest direct pending workspace ${suffix}`, `manifest-direct-pending-${suffix}`, userId]);
      await client.query(`INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [directPendingProjectId, directPendingWorkspaceId, `Manifest direct pending project ${suffix}`, `manifest-direct-pending-project-${suffix}`]);
      await insertPendingMembershipWithAudit(client, { kind: "workspace", membershipId: directPendingWorkspaceMembershipId, workspaceId: directPendingWorkspaceId, projectId: null, userId: directPendingUserId, role: "owner" });
      await insertPendingMembershipWithAudit(client, { kind: "project", membershipId: directPendingProjectMembershipId, workspaceId: directPendingWorkspaceId, projectId: directPendingProjectId, userId: directPendingUserId, role: "viewer" });
      await client.query("COMMIT");
      const directPendingRows = (await client.query<InventoryRow>(inventorySql)).rows;
      const directPendingWorkspaceRow = directPendingRows.find((row) => row.membership_id === directPendingWorkspaceMembershipId)!;
      const directPendingProjectRow = directPendingRows.find((row) => row.membership_id === directPendingProjectMembershipId)!;

      await client.query("BEGIN");
      await client.query(`UPDATE "WorkspaceMembership" SET "accessState" = 'confirmed' WHERE "id" = $1`, [directPendingWorkspaceMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'workspace', $2, $3, NULL::uuid, $4, 'confirmed', 'pending', 'confirmed', $5, NULL, $6, $7, NULL)
      `, [
        randomUUID(),
        directPendingWorkspaceMembershipId,
        directPendingWorkspaceRow.workspace_id,
        directPendingWorkspaceRow.user_id,
        directPendingWorkspaceRow.role,
        "ordinary direct transition",
        rowFingerprint(directPendingWorkspaceRow),
      ]);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      const directConfirmedState = await client.query<{ access_state: string; confirmed_audits: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "WorkspaceMembership" WHERE "id" = $1) AS access_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "membershipId" = $1 AND "action" = 'confirmed') AS confirmed_audits
      `, [directPendingWorkspaceMembershipId]);
      assert.deepEqual(directConfirmedState.rows[0], { access_state: "pending", confirmed_audits: "0" });

      await client.query("BEGIN");
      await client.query(`UPDATE "ProjectMembership" SET "accessState" = 'revoked' WHERE "id" = $1`, [directPendingProjectMembershipId]);
      await client.query(`
        INSERT INTO "MembershipAccessAudit" (
          "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState",
          "roleSnapshot", "actorId", "reason", "membershipFingerprint", "manifestFingerprint"
        ) VALUES ($1, 'project', $2, $3, $4, $5, 'revoked', 'pending', 'revoked', $6, NULL, $7, $8, NULL)
      `, [
        randomUUID(),
        directPendingProjectMembershipId,
        directPendingProjectRow.workspace_id,
        directPendingProjectRow.project_id,
        directPendingProjectRow.user_id,
        directPendingProjectRow.role,
        "ordinary direct transition",
        rowFingerprint(directPendingProjectRow),
      ]);
      await assert.rejects(
        () => client.query("COMMIT"),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");

      const directRevokedState = await client.query<{ access_state: string; revoked_audits: string }>(`
        SELECT
          (SELECT "accessState"::text FROM "ProjectMembership" WHERE "id" = $1) AS access_state,
          (SELECT COUNT(*)::text FROM "MembershipAccessAudit" WHERE "membershipId" = $1 AND "action" = 'revoked') AS revoked_audits
      `, [directPendingProjectMembershipId]);
      assert.deepEqual(directRevokedState.rows[0], { access_state: "pending", revoked_audits: "0" });

      await assert.rejects(
        () => client.query(`UPDATE "MembershipGovernanceExecution" SET "reason" = 'tampered' WHERE "id" = $1`, [result.executionId]),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && String((error as { code: string }).code) === "23514",
      );
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  },
);

function keyPair() {
  return generateKeyPairSync("ed25519");
}

async function insertDirectExecution(
  client: Client,
  manifest: ReturnType<typeof buildManifest>,
  trustedSignerRegistryFingerprint: string,
): Promise<string> {
  const executionId = randomUUID();
  await client.query(
    `INSERT INTO "MembershipGovernanceExecution" (
      "id", "manifestFingerprint", "executionNonce", "expectedInventoryFingerprint",
      "trustedSignerRegistryFingerprint", "version", "coverage", "expiresAt", "reason",
      "itemCount", "canonicalManifest", "snapshot", "executorLabel"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
    [
      executionId,
      membershipGovernanceManifestFingerprint(manifest),
      manifest.executionNonce,
      manifest.expectedInventoryFingerprint,
      trustedSignerRegistryFingerprint,
      manifest.version,
      manifest.coverage,
      manifest.expiresAt,
      manifest.reason,
      manifest.items.length,
      canonicalMembershipGovernanceManifest(manifest),
      JSON.stringify(buildMembershipGovernanceSafeSnapshot(manifest)),
      "direct-test",
    ],
  );
  return executionId;
}

type SignedApprovalFixture = Readonly<{
  approvals: readonly MembershipGovernanceApproval[];
  approvalTexts: readonly string[];
  registry: Readonly<Record<string, string>>;
}>;

function signedApprovals(manifest: ReturnType<typeof buildManifest>, prefix: string): SignedApprovalFixture {
  const first = keyPair();
  const second = keyPair();
  const firstSignerId = `${prefix}_a`;
  const secondSignerId = `${prefix}_b`;
  const registry = Object.freeze({
    [firstSignerId]: first.publicKey.export({ type: "spki", format: "pem" }).toString(),
    [secondSignerId]: second.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  const bytes = Buffer.from(canonicalMembershipGovernanceManifest(manifest));
  const approvalTexts = [first, second].map((pair, index) => JSON.stringify({
    kind: "membership-governance-approval",
    version: 1,
    signerId: index === 0 ? firstSignerId : secondSignerId,
    signature: sign(null, bytes, pair.privateKey).toString("base64"),
  }));
  const approvals = approvalTexts.map(parseMembershipGovernanceApprovalText);
  return Object.freeze({
    approvals: Object.freeze(approvals),
    approvalTexts: Object.freeze(approvalTexts),
    registry,
  });
}

function registryTextFor(...fixtures: readonly SignedApprovalFixture[]): string {
  const registry: Record<string, string> = {};
  for (const fixture of fixtures) Object.assign(registry, fixture.registry);
  return JSON.stringify(registry);
}

function restoreTrustedRegistry(previous: string | undefined): void {
  if (previous === undefined) delete process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
  else process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = previous;
}

async function applyWithTrustedRegistry(
  db: MembershipGovernanceQueryClient,
  manifest: ReturnType<typeof buildManifest>,
  signed: SignedApprovalFixture,
  executorLabel: string,
) {
  const previous = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
  process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = registryTextFor(signed);
  try {
    return await applyMembershipGovernanceManifest(
      db,
      canonicalMembershipGovernanceManifest(manifest),
      signed.approvalTexts,
      executorLabel,
    );
  } finally {
    restoreTrustedRegistry(previous);
  }
}
