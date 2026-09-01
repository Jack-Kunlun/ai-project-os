import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_UPLOAD_POLICY,
  getUploadPolicy,
  UploadPolicyConfigurationError,
} from "../src/lib/project-assets/policy";

test("upload policy exposes the documented safe defaults", () => {
  const policy = getUploadPolicy();
  assert.equal(policy.maxFiles, 10);
  assert.equal(policy.maxFileBytes, 25 * 1024 * 1024);
  assert.equal(policy.maxImageBytes, 10 * 1024 * 1024);
  assert.equal(policy.maxRequestBytes, 30 * 1024 * 1024);
  assert.equal(policy.maxProjectBytes, 1 * 1024 * 1024 * 1024);
  assert.equal(policy.maxWorkspaceBytes, 5 * 1024 * 1024 * 1024);
  assert.equal(policy.maxDeploymentBytes, 20 * 1024 * 1024 * 1024);
  assert.equal(policy.maxProjectAssets, 100);
  assert.equal(policy.maxProjectRetainedObjects, 1_000);
  assert.equal(policy.maxWorkspaceRetainedObjects, 5_000);
  assert.equal(policy.maxDeploymentRetainedObjects, 20_000);
  assert.equal(policy.maxUploadsPerMinute, 20);
  assert.equal(policy.maxConcurrentUploads, 2);
  assert.equal(policy.maxGlobalConcurrentUploads, 2);
  assert.equal(policy.parseLeaseMs, 30 * 60 * 1000);
  assert.equal(policy.bodyReadTimeoutMs, 2 * 60 * 1000);
  assert.deepEqual(DEFAULT_UPLOAD_POLICY, policy);
});

test("invalid upload policy overrides fail closed", () => {
  const previous = process.env.AI_PROJECT_OS_UPLOAD_MAX_FILES;
  process.env.AI_PROJECT_OS_UPLOAD_MAX_FILES = " 10 ";
  try {
    assert.throws(() => getUploadPolicy(), (error: unknown) =>
      error instanceof UploadPolicyConfigurationError
      && error.variable === "AI_PROJECT_OS_UPLOAD_MAX_FILES",
    );
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_UPLOAD_MAX_FILES;
    else process.env.AI_PROJECT_OS_UPLOAD_MAX_FILES = previous;
  }
});

test("inconsistent upload policy relationships fail closed", () => {
  const cases = [
    ["AI_PROJECT_OS_UPLOAD_MAX_REQUEST_BYTES", String(DEFAULT_UPLOAD_POLICY.maxFileBytes)],
    ["AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES", String(DEFAULT_UPLOAD_POLICY.maxFileBytes - 1)],
    ["AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_BYTES", String(DEFAULT_UPLOAD_POLICY.maxProjectBytes - 1)],
    ["AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_BYTES", String(DEFAULT_UPLOAD_POLICY.maxWorkspaceBytes - 1)],
    ["AI_PROJECT_OS_UPLOAD_ADMISSION_LEASE_MS", String(DEFAULT_UPLOAD_POLICY.bodyReadTimeoutMs - 1)],
  ] as const;
  for (const [variable, value] of cases) {
    const previous = process.env[variable];
    process.env[variable] = value;
    try {
      assert.throws(() => getUploadPolicy(), (error: unknown) =>
        error instanceof UploadPolicyConfigurationError
        && error.variable === "AI_PROJECT_OS_UPLOAD_POLICY_RELATION",
      );
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  }
});

test("upload route and UI share server policy, durable admission and quota usage", async () => {
  const [route, client, header, login, git, mcp, guide, migration, projects] = await Promise.all([
    readFile("src/app/api/projects/[projectId]/assets/route.ts", "utf8"),
    readFile("src/app/projects/[projectId]/assets/project-assets-client.tsx", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
    readFile("src/app/login/login-form.tsx", "utf8"),
    readFile("src/app/connections/connections-client.tsx", "utf8"),
    readFile("src/app/connections/mcp/mcp-connections-client.tsx", "utf8"),
    readFile("src/app/guide/page.tsx", "utf8"),
    readFile("prisma/migrations/20260901000000_add_project_asset_upload_admission/migration.sql", "utf8"),
    readFile("src/app/projects/projects-client.tsx", "utf8"),
  ]);
  assert.match(route, /acquireUploadAdmission/u);
  assert.match(route, /releaseUploadAdmission/u);
  assert.match(route, /ASSET_UPLOAD_TOO_MANY_FILES/u);
  assert.match(route, /ASSET_UPLOAD_ONE_FILE_ONLY/u);
  assert.match(route, /lease expiry will recover it/u);
  assert.doesNotMatch(route, /throw new ApiError\(503, "ASSET_UPLOAD_ADMISSION_RELEASE_FAILED"/u);
  assert.match(route, /let response: NextResponse \| undefined/u);
  assert.match(route, /response = NextResponse\.json\(\{ assets: \[asset\], asset \}/u);
  assert.match(route, /return response;/u);
  assert.doesNotMatch(route, /workspaceBytes|deploymentBytes/u);
  assert.match(await readFile("src/lib/project-assets/admission.ts", "utf8"), /RELEASE_RETRY_LIMIT = 3/u);
  assert.match(route, /values\.length !== 1/u);
  assert.match(route, /policy\.maxRequestBytes/u);
  assert.match(client, /selected\.slice\(0, policy\.maxFiles\)/u);
  assert.match(client, /for \(const file of files\)/u);
  assert.match(client, /projectBytes/u);
  assert.doesNotMatch(client, /usage\.workspaceBytes|usage\.deploymentBytes/u);
  assert.match(client, /maxUploadsPerMinute/u);
  assert.match(client, /maxConcurrentUploads/u);
  assert.match(client, /maxGlobalConcurrentUploads/u);
  assert.match(client, /retainedObjectCount/u);
  assert.doesNotMatch(client, /最多导入 100 个/u);
  assert.doesNotMatch(header, /项目导航[\s\S]{0,500}overflow-x-auto/u);
  assert.match(header, /项目列表/u);
  assert.match(header, /查看指引/u);
  assert.match(header, /projectSection === "guide"/u);
  assert.doesNotMatch(login, /打开使用指南/u);
  assert.match(git, /公网 HTTPS/u);
  assert.match(git, /自建 HTTPS \/ CA/u);
  assert.match(git, /SSH Deploy Key/u);
  assert.match(mcp, /发现快照/u);
  assert.match(mcp, /每次单独审批/u);
  assert.match(projects, /onDoubleClick=\{openProjectFromCard\}/u);
  assert.match(projects, /closest\("a,button,input,select,textarea,summary,details,label,form/u);
  assert.match(guide, /getUploadPolicy/u);
  assert.match(guide, /maxDeploymentBytes/u);
  assert.match(guide, /软删除但仍保留/u);
  assert.match(migration, /CREATE TABLE "ProjectAssetUploadAdmission"/u);
  assert.match(migration, /CREATE TABLE "ProjectAssetUploadReservation"/u);
  assert.match(migration, /ProjectAssetUploadReservation_storageKey_key/u);
  assert.match(migration, /leaseExpiresAt/u);
  assert.match(migration, /ProjectAssetExtractionRun_status_startedAt_createdAt_idx/u);
  assert.match(migration, /ON DELETE RESTRICT/u);
  const worker = await readFile("scripts/automation-worker.ts", "utf8");
  assert.match(worker, /runProjectAssetParsingWorkerCycle/u);
  assert.match(worker, /reconcileStaleProjectAssetUploadReservations/u);
  assert.match(await readFile("src/lib/project-assets/service.ts", "utf8"), /retryProjectAssetLocalExtraction/u);
  assert.match(await readFile("src/lib/project-assets/quota.ts", "utf8"), /take: boundedLimit/u);
  assert.match(await readFile("src/lib/project-assets/storage.ts", "utf8"), /error\.code === "ENOENT"/u);
  assert.match(await readFile("src/lib/prisma-transaction.ts", "utf8"), /isProjectSnapshotGenerationConflict/u);
  assert.match(await readFile("compose.yaml", "utf8"), /AI_PROJECT_OS_UPLOAD_MAX_FILES/u);
});
