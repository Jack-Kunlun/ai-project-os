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
  const jobGuard = await readFile("prisma/migrations/20260829151000_guard_archived_project_jobs/migration.sql", "utf8");
  assert.match(migration, /ProjectLifecycleRevision_immutable_guard/u);
  assert.match(migration, /project lifecycle revision must match current project state/u);
  assert.match(migration, /ProjectDataExportAudit_immutable_guard/u);
  assert.match(migration, /byteCount" > 0/u);
  assert.doesNotMatch(migration, /credential|ciphertext|nonce|authTag|providerRequestId/u);
  assert.match(jobGuard, /BackgroundJob_archived_project_guard/u);
  assert.match(jobGuard, /'queued', 'waitingConsent', 'running'/u);
});

test("all project mutation routes reject archived projects except bounded lifecycle and export", async () => {
  const root = "src/app/api/projects/[projectId]";
  const entries = await readdir(root, { recursive: true });
  const exempt = new Set([
    "src/app/api/projects/[projectId]/lifecycle/route.ts",
    "src/app/api/projects/[projectId]/export/route.ts",
  ]);
  for (const entry of entries.filter((value) => value.endsWith("route.ts"))) {
    const path = `${root}/${entry}`;
    if (exempt.has(path)) continue;
    const source = await readFile(path, "utf8");
    if (!/export async function (POST|PUT|PATCH|DELETE)/u.test(source)) continue;
    assert.match(source, /assertProjectActive/u, `${path} must reject archived project mutations`);
  }

  const lifecycleRoute = await readFile("src/app/api/projects/[projectId]/lifecycle/route.ts", "utf8");
  assert.match(lifecycleRoute, /assertSameOrigin\(request\)/u);
  assert.match(lifecycleRoute, /requireApiSession\(request\)/u);
  assert.match(lifecycleRoute, /expectedUpdatedAt/u);
});

test("active workspace reads exclude archived projects while the project list exposes an explicit view", async () => {
  const dashboard = await readFile("src/app/api/dashboard/route.ts", "utf8");
  const projects = await readFile("src/app/api/projects/route.ts", "utf8");
  assert.match(dashboard, /const projectWhere = \{ AND: \[accessibleProjectWhere\(user\), \{ archivedAt: null \}\] \}/u);
  assert.ok((dashboard.match(/project: \{ is: projectWhere \}/gu) ?? []).length >= 2);
  assert.match(projects, /z\.enum\(\["active", "archived"\]\)/u);
  assert.match(projects, /counts: \{ active: activeCount, archived: archivedCount \}/u);
});
