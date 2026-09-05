import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { updateProjectLifecycleSchema } from "../src/lib/validation";

test("project lifecycle input is optimistic and strict", () => {
  const timestamp = "2026-08-29T08:00:00.000Z";
  assert.deepEqual(updateProjectLifecycleSchema.parse({ action: "archive", expectedUpdatedAt: timestamp }), {
    action: "archive",
    expectedUpdatedAt: timestamp,
  });
  assert.deepEqual(updateProjectLifecycleSchema.parse({ action: "restore", expectedUpdatedAt: timestamp }), {
    action: "restore",
    expectedUpdatedAt: timestamp,
  });
  assert.equal(updateProjectLifecycleSchema.safeParse({ action: "archive" }).success, false);
  assert.equal(updateProjectLifecycleSchema.safeParse({ action: "archive", expectedUpdatedAt: timestamp, force: true }).success, false);
});

test("lifecycle and export audit tables are constrained and immutable", async () => {
  const migration = await readFile("prisma/migrations/20260829150000_add_project_lifecycle_and_export_audits/migration.sql", "utf8");
  const deletionMigration = await readFile("prisma/migrations/20260901010000_add_safe_project_deletion/migration.sql", "utf8");
  const jobGuard = await readFile("prisma/migrations/20260829151000_guard_archived_project_jobs/migration.sql", "utf8");
  assert.match(migration, /ProjectLifecycleRevision_immutable_guard/u);
  assert.match(migration, /project lifecycle revision must match current project state/u);
  assert.match(migration, /ProjectDataExportAudit_immutable_guard/u);
  assert.match(migration, /byteCount" > 0/u);
  assert.doesNotMatch(migration, /credential|ciphertext|nonce|authTag|providerRequestId/u);
  assert.match(jobGuard, /BackgroundJob_archived_project_guard/u);
  assert.match(jobGuard, /'queued', 'waitingConsent', 'running'/u);
  assert.match(deletionMigration, /ProjectDeletionReceipt_state_check/u);
  assert.match(deletionMigration, /ProjectDeletionReceipt_guard/u);
  assert.match(deletionMigration, /project deletion receipts are immutable/u);
  assert.doesNotMatch(deletionMigration, /projectName|contentText|storageKey/u);
});

test("project lifecycle blocks live delegated Git manual runs", async () => {
  const source = await readFile("src/lib/project-lifecycle.ts", "utf8");
  assert.match(source, /projectGitRepositoryManualRun\.count/u);
  assert.match(source, /status:\s*\{\s*in:\s*\["queued",\s*"running"\]/u);
  assert.match(source, /PROJECT_HAS_UNRESOLVED_JOBS/u);
});

test("delegated Git runtime keeps connection infrastructure out of project projections", async () => {
  const source = await readFile("src/lib/project-delegated-git-runtime-service.ts", "utf8");
  const migration = await readFile("prisma/migrations/20260904160000_add_project_git_manual_runtime/migration.sql", "utf8");
  const projection = source.slice(source.indexOf("function publicRun"), source.indexOf("type AdmissionConnection"));
  assert.doesNotMatch(projection, /baseUrl|username|tlsCaCertificate|sshKnownHost|externalRef/u);
  assert.match(source, /externalRef: null/u);
  const admitRun = source.slice(source.indexOf("async function admitRun"), source.indexOf("async function loadFreshConnection"));
  assert.match(admitRun, /replayExistingRunInTransaction/u);
  assert.doesNotMatch(admitRun, /if \(existing !== null\) return \{ run: existing, claimed: false \}/u);
  assert.match(admitRun, /isPrismaCode\(error, "P2002"\)[\s\S]*replayExistingRun/u);
  const successGuard = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION "project_git_manual_runtime_success_guard"'),
    migration.indexOf('CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRun_success_guard"'),
  );
  assert.match(successGuard, /pg_advisory_xact_lock\(hashtextextended\('ai-project-git-repository-delegation-global', 0\)\)/u);
});

test("all project mutation routes reject archived projects except bounded lifecycle and export", async () => {
  const root = "src/app/api/projects/[projectId]";
  const entries = await readdir(root, { recursive: true });
  const exempt = new Set([
    "src/app/api/projects/[projectId]/route.ts",
    "src/app/api/projects/[projectId]/lifecycle/route.ts",
    "src/app/api/projects/[projectId]/export/route.ts",
  ]);
  const frozenLegacyRoutes = new Set([
    "src/app/api/projects/[projectId]/repositories/route.ts",
    "src/app/api/projects/[projectId]/repositories/[linkId]/route.ts",
  ]);
  const serviceLifecycleGuarded = new Set([
    "src/app/api/projects/[projectId]/memory/extract/route.ts",
    "src/app/api/projects/[projectId]/memory/search/route.ts",
    "src/app/api/projects/[projectId]/memory/index/route.ts",
    "src/app/api/projects/[projectId]/memory/answers/route.ts",
    "src/app/api/projects/[projectId]/intelligence/brief/route.ts",
    "src/app/api/projects/[projectId]/intelligence/agent/route.ts",
    "src/app/api/projects/[projectId]/assets/[assetId]/recognize/route.ts",
    "src/app/api/projects/[projectId]/repositories/scan/route.ts",
    "src/app/api/projects/[projectId]/repositories/materials/route.ts",
    "src/app/api/projects/[projectId]/repositories/sync/route.ts",
    "src/app/api/projects/[projectId]/jobs/[jobId]/route.ts",
    "src/app/api/projects/[projectId]/memory/candidates/[candidateId]/route.ts",
    "src/app/api/projects/[projectId]/ai-memory/candidates/[candidateId]/route.ts",
    "src/app/api/projects/[projectId]/git-repositories/route.ts",
    "src/app/api/projects/[projectId]/git-repositories/[linkId]/route.ts",
    "src/app/api/projects/[projectId]/git-repositories/[linkId]/sync/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/owner-confirmation/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/project-confirmation/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/rejection/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/revocation/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/owner-confirmation/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/project-confirmation/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/rejection/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/revocation/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/manual-sync/route.ts",
    "src/app/api/projects/[projectId]/ai-effective-route-selections/[operation]/route.ts",
  ]);
  for (const entry of entries.filter((value) => value.endsWith("route.ts"))) {
    const path = `${root}/${entry}`;
    if (exempt.has(path)) continue;
    const source = await readFile(path, "utf8");
    if (frozenLegacyRoutes.has(path)) {
      assert.match(
        source,
        /GITHUB_WEB_PROJECT_CONNECT_FROZEN/u,
        `${path} must fail closed before legacy project access`,
      );
      assert.doesNotMatch(
        source,
        /assertProjectActive|readJsonBody/u,
        `${path} must not read legacy project state or body`,
      );
      continue;
    }
    if (!/export async function (POST|PUT|PATCH|DELETE)/u.test(source)) continue;
    if (serviceLifecycleGuarded.has(path)) {
      assert.doesNotMatch(source, /assertProjectActive/u, `${path} delegates lifecycle checks`);
      assert.match(source, /(?:requestedBy|actor):\s*user|,\s*(?:user|actor)\s*(?:,|\))/u, `${path} passes the session actor`);
      continue;
    }
    assert.match(source, /assertProjectActive/u, `${path} must reject archived project mutations`);
  }

  const lifecycleRoute = await readFile("src/app/api/projects/[projectId]/lifecycle/route.ts", "utf8");
  assert.match(lifecycleRoute, /assertSameOrigin\(request\)/u);
  assert.match(lifecycleRoute, /requireApiSession\(request\)/u);
  assert.match(lifecycleRoute, /expectedUpdatedAt/u);

  const projectRoute = await readFile("src/app/api/projects/[projectId]/route.ts", "utf8");
  assert.match(projectRoute, /export async function DELETE/u);
  assert.match(projectRoute, /deleteArchivedProject/u);
  assert.match(projectRoute, /confirmationName/u);
  assert.match(projectRoute, /expectedUpdatedAt/u);
});

test("active workspace reads exclude archived projects while the project list exposes an explicit view", async () => {
  const dashboard = await readFile("src/app/api/dashboard/route.ts", "utf8");
  const projects = await readFile("src/app/api/projects/route.ts", "utf8");
  assert.match(dashboard, /const projectWhere = \{ AND: \[accessibleProjectWhere\(user\), \{ archivedAt: null \}\] \}/u);
  assert.ok((dashboard.match(/project: \{ is: projectWhere \}/gu) ?? []).length >= 2);
  assert.match(projects, /z\.enum\(\["active", "archived"\]\)/u);
  assert.match(projects, /counts: \{ active: activeCount, archived: archivedCount \}/u);
});
