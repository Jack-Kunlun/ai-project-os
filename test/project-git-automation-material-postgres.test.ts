import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Client } from "pg";
import { getDb, getGitAutomationWorkerDb } from "../src/lib/db";
import { sealSecret } from "../src/lib/credential-vault";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { createGitConnectionFixture } from "./personal-connection-probe-fixture";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";
import {
  activateProjectGitAutomationGrantProjectOwner,
  confirmProjectGitAutomationGrantConnectionOwner,
  proposeProjectGitAutomationGrant,
  revokeProjectGitAutomationGrant,
} from "../src/lib/project-git-automation-grant-service";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";
import {
  claimNextProjectGitAutomationMaterialRun,
  finalizeProjectGitAutomationMaterialRun,
  markProjectGitAutomationMaterialRunDispatched,
  type ProjectGitAutomationMaterialKind,
  type ProjectGitAutomationMaterialRunClaim,
} from "../src/lib/project-git-automation-material-run-service";
import { loadGitAutomationMaterialReadContext } from "../src/lib/project-git-automation-material-read-context";

const shouldRun = process.env.PROJECT_GIT_AUTOMATION_MATERIAL_POSTGRES_GATE === "1";
const databaseName = "ai_project_os_project_git_automation_material_test";
const seededAdminId = "00000000-0000-4000-8000-000000000010";
const workerId = "material-ledger-gate-worker";
const testMasterKey = Buffer.alloc(32, 0x57);

after(async () => {
  if (!shouldRun) return;
  await Promise.all([getDb().$disconnect(), getGitAutomationWorkerDb().$disconnect()]);
});

type MaterialReads = Readonly<{ issues: boolean; pullRequests: boolean; releases: boolean }>;
type Fixture = Readonly<{
  grantId: string;
  projectId: string;
  baseDelegationId: string;
  connectionOwnerActor: { id: string; role: "user"; accountAccessVersion: number };
  projectOwnerActor: { id: string; role: "user"; accountAccessVersion: number };
  secret: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireDatabaseUrl(environmentName: string, roleName: string): string {
  const raw = process.env[environmentName];
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`${environmentName}_REQUIRED`);
  const parsed = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${databaseName}`
    || decodeURIComponent(parsed.username) !== roleName
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error(`${environmentName}_INVALID`);
  }
  return parsed.toString();
}

function assertDisposableGateDatabase(): void {
  requireDatabaseUrl("DATABASE_URL", "ai_project_os_runtime");
  requireDatabaseUrl("DATABASE_PRINCIPAL_ADMIN_URL", "ai_project_os_cluster_admin");
  requireDatabaseUrl("GIT_AUTOMATION_DATABASE_URL", "ai_project_os_git_automation_worker");
}

async function withGateAdmin<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = requireDatabaseUrl("DATABASE_PRINCIPAL_ADMIN_URL", "ai_project_os_cluster_admin");
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function withReplicatedAdmin<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  return withGateAdmin(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = 'replica'");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

async function createActiveGrant(reads: MaterialReads): Promise<Fixture> {
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(db);
  const connectionOwnerId = randomUUID();
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const secret = `github_pat_${suffix}${"x".repeat(32)}`;
  const sealed = sealSecret("git", secret, testMasterKey);
  const connectionOwnerActor = { id: connectionOwnerId, role: "user" as const, accountAccessVersion: 1 };
  const projectOwnerActor = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
  const projectOwner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };

  await db.appUser.create({ data: { id: connectionOwnerId, username: `material_owner_${suffix}`, role: "user" } });
  await db.project.create({ data: { id: projectId, workspaceId, name: `Git material ${suffix}`, slug: `git-material-${suffix}` } });
  await db.$transaction(async (tx) => {
    await grantWorkspaceMembership(tx, {
      workspaceId, userId: connectionOwnerId, role: "member", actorId: seededAdminId,
      reason: "git_material_connection_owner",
    });
    await grantProjectMembership(tx, {
      projectId, workspaceId, userId: connectionOwnerId, role: "editor", actorId: seededAdminId,
      reason: "git_material_connection_owner",
    });
    await grantProjectMembership(tx, {
      projectId, workspaceId, userId: ownerId, role: "owner", actorId: seededAdminId,
      reason: "git_material_project_owner",
    });
  });
  await db.externalCredential.create({
    data: { id: credentialId, kind: "git", ...sealed },
  });
  await createGitConnectionFixture({
    id: connectionId,
    name: `Git material ${suffix}`,
    providerKind: "github",
    transport: "https",
    baseUrl: "https://github.com",
    authKind: "token",
    status: "verified",
    ownershipState: "confirmed",
    resolvedAddressFingerprint: "a".repeat(64),
    createdById: connectionOwnerId,
    ownerUserId: connectionOwnerId,
    ownerAccountAccessVersion: 1,
    credentialId,
  }, db);

  const delegation = await proposeProjectGitRepositoryDelegation(projectId, {
    gitConnectionId: connectionId,
    repositoryPath: "org/material-gate",
    trackedRef: "main",
    includeRoots: ["."],
    softExcludePatterns: ["tmp/**"],
    role: "primary",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  }, connectionOwnerActor, db);
  const ownerConfirmedDelegation = await confirmProjectGitRepositoryDelegationOwner(projectId, delegation.id, {
    expectedVersion: delegation.version,
    acknowledgeReadOnlyCredentialUse: true,
  }, connectionOwnerActor, db);
  const activeDelegation = await confirmProjectGitRepositoryDelegationProject(projectId, delegation.id, {
    expectedVersion: ownerConfirmedDelegation.version,
    acknowledgeRepositoryScope: true,
    acknowledgeDataEgress: true,
  }, projectOwner, db);
  const grant = await proposeProjectGitAutomationGrant(projectId, {
    baseDelegationId: activeDelegation.id,
    runIntervalMinutes: 60,
    issuesEnabled: reads.issues,
    pullRequestsEnabled: reads.pullRequests,
    releasesEnabled: reads.releases,
    expiresAt: activeDelegation.expiresAt,
  }, connectionOwnerActor, db);
  const ownerAcknowledgements = {
    acknowledgeIssueRead: reads.issues,
    acknowledgePullRequestRead: reads.pullRequests,
    acknowledgeReleaseRead: reads.releases,
  };
  if (reads.issues || reads.pullRequests || reads.releases) {
    await assert.rejects(
      () => confirmProjectGitAutomationGrantConnectionOwner(projectId, grant.id, {
        expectedVersion: grant.version,
        acknowledgeReadOnlyScheduledAccess: true,
      }, connectionOwnerActor, db),
      (error: unknown) => typeof error === "object" && error !== null
        && "code" in error && (error as { code?: unknown }).code === "PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT",
      "per-kind read consent must be explicitly acknowledged by the connection owner",
    );
  }
  const ownerConfirmedGrant = await confirmProjectGitAutomationGrantConnectionOwner(projectId, grant.id, {
    expectedVersion: grant.version,
    acknowledgeReadOnlyScheduledAccess: true,
    ...ownerAcknowledgements,
  }, connectionOwnerActor, db);
  await activateProjectGitAutomationGrantProjectOwner(projectId, grant.id, {
    expectedVersion: ownerConfirmedGrant.version,
    acknowledgeExactRepositoryScope: true,
    acknowledgeReadOnlyDataEgress: true,
    ...ownerAcknowledgements,
  }, projectOwner, db);

  return Object.freeze({
    grantId: grant.id,
    projectId,
    baseDelegationId: activeDelegation.id,
    connectionOwnerActor,
    projectOwnerActor,
    secret,
  });
}

async function makeCursorDue(grantId: string, kind: ProjectGitAutomationMaterialKind): Promise<void> {
  await withReplicatedAdmin((client) => client.query(`
    UPDATE public."ProjectGitRepositoryMaterialCursor"
       SET "nextRunAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute'
     WHERE "grantId" = $1::uuid AND "materialKind" = $2::public."ProjectGitRepositoryMaterialKind"
  `, [grantId, kind]).then(() => undefined));
}

async function claimAndDispatch(grantId: string, kind: ProjectGitAutomationMaterialKind): Promise<ProjectGitAutomationMaterialRunClaim> {
  await makeCursorDue(grantId, kind);
  const db = getGitAutomationWorkerDb();
  const claim = await claimNextProjectGitAutomationMaterialRun(workerId, db);
  assert.ok(claim, `expected a due ${kind} material run`);
  assert.equal(claim.grantId, grantId);
  assert.equal(claim.materialKind, kind);
  const dispatched = await markProjectGitAutomationMaterialRunDispatched(claim.id, workerId, claim.leaseToken, db);
  assert.equal(dispatched?.accepted, true);
  assert.equal(dispatched?.status, "dispatched");
  return claim;
}

function materialSource(kind: ProjectGitAutomationMaterialKind, number: number, body = `material-${kind}-${number}`) {
  const scannerKind = kind === "pull_request" ? "pullRequest" : kind;
  const identityKind = kind === "pull_request" ? "pull_request" : kind;
  const path = kind === "issue" ? "issues" : kind === "pull_request" ? "pull" : "releases/tag";
  const contentText = JSON.stringify({ id: number, body });
  return Object.freeze({
    materialKind: scannerKind,
    remoteIdentity: `${identityKind}:${number}`,
    remoteRevisionFingerprint: sha256(`revision:${kind}:${number}:${body}`),
    remoteNumber: number,
    normalizedPath: null,
    externalRef: `https://github.com/org/material-gate/${path}/${kind === "release" ? `v${number}` : number}`,
    capturedAt: new Date().toISOString(),
    contentText,
    contentHash: sha256(contentText),
    contentBytes: Buffer.byteLength(contentText, "utf8"),
  });
}

async function finalize(
  claim: ProjectGitAutomationMaterialRunClaim,
  sources: readonly ReturnType<typeof materialSource>[],
) {
  return finalizeProjectGitAutomationMaterialRun({
    runId: claim.id,
    workerId,
    leaseToken: claim.leaseToken,
    repositoryId: 123456,
    repositoryNodeId: "R_kgDOmaterialGate",
    observedHeadCommitSha: "c".repeat(40),
    sources,
  }, getGitAutomationWorkerDb());
}

async function codeHeadSnapshot(projectId: string, delegationId: string) {
  return withGateAdmin(async (client) => {
    const rows = await client.query(`
      SELECT "currentPublicationVersionId"::text AS "currentPublicationVersionId", "generation", "publishedAt"
        FROM public."ProjectGitRepositoryPublicationHead"
       WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
    `, [projectId, delegationId]);
    return rows.rows;
  });
}

test("dedicated material worker imports consented GitHub issue, pull request, and release snapshots", {
  skip: !shouldRun ? "explicit isolated PostgreSQL gate is required" : false,
}, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const defaults = await createActiveGrant({ issues: false, pullRequests: false, releases: false });
  const defaultGrant = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: defaults.grantId } });
  assert.equal(defaultGrant.issuesEnabled, false);
  assert.equal(defaultGrant.pullRequestsEnabled, false);
  assert.equal(defaultGrant.releasesEnabled, false);
  const defaultCursorCount = await withGateAdmin(async (client) => {
    const result = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
        FROM public."ProjectGitRepositoryMaterialCursor"
       WHERE "grantId" = $1::uuid
    `, [defaults.grantId]);
    return Number(result.rows[0]?.count ?? -1);
  });
  assert.equal(defaultCursorCount, 0);
  assert.equal(await claimNextProjectGitAutomationMaterialRun(workerId, getGitAutomationWorkerDb()), null);

  const fixture = await createActiveGrant({ issues: true, pullRequests: true, releases: true });
  const codeHeadBefore = await codeHeadSnapshot(fixture.projectId, fixture.baseDelegationId);
  const workerDb = getGitAutomationWorkerDb();
  const issueClaim = await claimAndDispatch(fixture.grantId, "issue");
  const context = await loadGitAutomationMaterialReadContext({
    runId: issueClaim.id, workerId, leaseToken: issueClaim.leaseToken,
  }, workerDb);
  assert.ok(context);
  assert.equal(context.scope.materialKind, "issue");
  assert.doesNotMatch(JSON.stringify(issueClaim), new RegExp(fixture.secret, "u"));
  assert.doesNotMatch(JSON.stringify(context), new RegExp(fixture.secret, "u"));

  const [issueResult, pullResult] = await Promise.all([
    finalize(issueClaim, [materialSource("issue", 11)]),
    (async () => {
      const pullClaim = await claimAndDispatch(fixture.grantId, "pull_request");
      return finalize(pullClaim, [materialSource("pull_request", 21)]);
    })(),
  ]);
  assert.equal(issueResult?.accepted, true);
  assert.equal(issueResult?.status, "succeeded");
  assert.equal(pullResult?.accepted, true);
  assert.equal(pullResult?.status, "succeeded");

  const releaseClaim = await claimAndDispatch(fixture.grantId, "release");
  const releaseResult = await finalize(releaseClaim, [materialSource("release", 31)]);
  assert.equal(releaseResult?.accepted, true);
  assert.equal(releaseResult?.status, "succeeded");

  const issueSecondClaim = await claimAndDispatch(fixture.grantId, "issue");
  const emptyReplacement = await finalize(issueSecondClaim, []);
  assert.equal(emptyReplacement?.accepted, true);
  assert.equal(emptyReplacement?.status, "succeeded");
  const retirement = await withGateAdmin(async (client) => client.query<{ retiredAt: Date | null; contentText: string }>(`
    SELECT source_row."retiredAt", source_row."contentText"
      FROM public."ProjectSource" source_row
      JOIN public."ProjectGitRepositoryMaterialSourceVersion" source_version
        ON source_version."projectId" = source_row."projectId" AND source_version."projectSourceId" = source_row."id"
     WHERE source_version."grantId" = $1::uuid AND source_version."materialKind" = 'issue'
  `, [fixture.grantId]));
  assert.equal(retirement.rows.length, 1);
  assert.ok(retirement.rows[0]?.retiredAt, "a source absent from a complete later scan is retired");
  assert.doesNotMatch(retirement.rows[0]?.contentText ?? "", new RegExp(fixture.secret, "u"));

  const currentIssueHead = await withGateAdmin(async (client) => {
    const rows = await client.query<{ currentVersionId: string; publishedAt: Date }>(`
      SELECT "currentVersionId"::text AS "currentVersionId", "publishedAt"
        FROM public."ProjectGitRepositoryMaterialPublicationHead"
       WHERE "projectId" = $1::uuid AND "grantId" = $2::uuid AND "materialKind" = 'issue'
    `, [fixture.projectId, fixture.grantId]);
    return rows.rows[0];
  });
  assert.ok(currentIssueHead);
  const staleClaim = await claimAndDispatch(fixture.grantId, "issue");
  const priorIssueVersion = await withGateAdmin(async (client) => {
    const rows = await client.query<{ id: string; publishedAt: Date }>(`
      SELECT "id"::text AS "id", "publishedAt"
        FROM public."ProjectGitRepositoryMaterialPublicationVersion"
       WHERE "projectId" = $1::uuid AND "grantId" = $2::uuid AND "materialKind" = 'issue'
       ORDER BY "previousGeneration" ASC LIMIT 1
    `, [fixture.projectId, fixture.grantId]);
    return rows.rows[0];
  });
  assert.ok(priorIssueVersion);
  await withReplicatedAdmin((client) => client.query(`
    UPDATE public."ProjectGitRepositoryMaterialPublicationHead"
       SET "currentVersionId" = $3::uuid, "publishedAt" = $4::timestamp(3)
     WHERE "projectId" = $1::uuid AND "grantId" = $2::uuid AND "materialKind" = 'issue'
  `, [fixture.projectId, fixture.grantId, priorIssueVersion.id, priorIssueVersion.publishedAt]).then(() => undefined));
  const staleResult = await finalize(staleClaim, [materialSource("issue", 12)]);
  assert.equal(staleResult?.accepted, false);
  assert.equal(staleResult?.status, "failed");
  assert.equal(staleResult?.reason, "PUBLICATION_HEAD_STALE");
  await withReplicatedAdmin((client) => client.query(`
    UPDATE public."ProjectGitRepositoryMaterialPublicationHead"
       SET "currentVersionId" = $3::uuid, "publishedAt" = $4::timestamp(3)
     WHERE "projectId" = $1::uuid AND "grantId" = $2::uuid AND "materialKind" = 'issue'
  `, [fixture.projectId, fixture.grantId, currentIssueHead.currentVersionId, currentIssueHead.publishedAt]).then(() => undefined));

  const pendingRevocationClaim = await claimAndDispatch(fixture.grantId, "issue");
  const activeGrant = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: fixture.grantId } });
  await revokeProjectGitAutomationGrant(fixture.projectId, fixture.grantId, {
    expectedVersion: activeGrant.version,
    reason: "material read revoke fence test",
  }, fixture.connectionOwnerActor, db);
  const fenced = await finalize(pendingRevocationClaim, [materialSource("issue", 99)]);
  assert.equal(fenced?.accepted, false);
  assert.equal(fenced?.status, "unknown");

  const expired = await createActiveGrant({ issues: true, pullRequests: false, releases: false });
  await withReplicatedAdmin((client) => client.query(`
    UPDATE public."ProjectGitRepositoryAutomationGrant"
       SET "proposedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '2 minutes',
           "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute'
     WHERE "id" = $1::uuid
  `, [expired.grantId]).then(() => undefined));
  await makeCursorDue(expired.grantId, "issue");
  assert.equal(await claimNextProjectGitAutomationMaterialRun(workerId, workerDb), null);
  const expiredCursor = await withGateAdmin(async (client) => {
    const result = await client.query<{ status: string; pauseReason: string | null }>(`
      SELECT "status"::text AS "status", "pauseReason"::text AS "pauseReason"
        FROM public."ProjectGitRepositoryMaterialCursor"
       WHERE "grantId" = $1::uuid
       LIMIT 1
    `, [expired.grantId]);
    return result.rows[0] ?? null;
  });
  assert.ok(expiredCursor);
  assert.equal(expiredCursor.status, "paused");
  assert.equal(expiredCursor.pauseReason, "grant_expired");
  const expiredRunCount = await withGateAdmin(async (client) => {
    const result = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
        FROM public."ProjectGitRepositoryMaterialRun"
       WHERE "grantId" = $1::uuid
    `, [expired.grantId]);
    return Number(result.rows[0]?.count ?? -1);
  });
  assert.equal(expiredRunCount, 0);

  const auditAndHeads = await withGateAdmin(async (client) => {
    const [headRows, codeRows, auditRows] = await Promise.all([
      client.query<{ materialKind: string; sourceCount: number }>(`
        SELECT head_row."materialKind"::text AS "materialKind", version_row."sourceCount"
          FROM public."ProjectGitRepositoryMaterialPublicationHead" head_row
          JOIN public."ProjectGitRepositoryMaterialPublicationVersion" version_row
            ON version_row."id" = head_row."currentVersionId"
         WHERE head_row."projectId" = $1::uuid AND head_row."grantId" = $2::uuid
      `, [fixture.projectId, fixture.grantId]),
      client.query(`SELECT * FROM public."ProjectGitRepositoryPublicationHead" WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid`, [fixture.projectId, fixture.baseDelegationId]),
      client.query<{ reason: string | null }>(`
        SELECT "reason" FROM public."ProjectGitRepositoryMaterialRunAudit" WHERE "grantId" = $1::uuid
      `, [fixture.grantId]),
    ]);
    return { headRows: headRows.rows, codeRows: codeRows.rows, auditRows: auditRows.rows };
  });
  assert.deepEqual(auditAndHeads.headRows.map((row) => row.materialKind).sort(), ["issue", "pull_request", "release"]);
  assert.equal(auditAndHeads.headRows.find((row) => row.materialKind === "issue")?.sourceCount, 0);
  assert.deepEqual(auditAndHeads.codeRows, codeHeadBefore);
  assert.ok(auditAndHeads.auditRows.every((row) => row.reason === null || !row.reason.includes(fixture.secret)));

});
