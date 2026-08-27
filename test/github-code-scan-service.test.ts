import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  GITHUB_CODE_SCAN_SERVICE_VERSION,
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GitHubCodeScanServiceError,
  createGitHubCodeScanService,
  type GitHubReadOnlyClient,
} from "@/lib/github";

const projectId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";

const unusedClient: GitHubReadOnlyClient = Object.freeze({
  version: GITHUB_READ_ONLY_CLIENT_VERSION,
  async getRepository() { throw new Error("must not dispatch"); },
  async getReference() { throw new Error("must not dispatch"); },
  async getCommit() { throw new Error("must not dispatch"); },
  async getTree() { throw new Error("must not dispatch"); },
  async getBlob() { throw new Error("must not dispatch"); },
});

function assertInvalid(error: unknown): boolean {
  return error instanceof GitHubCodeScanServiceError &&
    error.code === "GITHUB_CODE_SCAN_INVALID_INPUT";
}

test("scan service validates every public identifier before a database transaction", async () => {
  let transactions = 0;
  const service = createGitHubCodeScanService({
    db: {
      $transaction: async () => {
        transactions += 1;
        throw new Error("must not transact");
      },
    } as never,
    client: unusedClient,
  });
  assert.equal(GITHUB_CODE_SCAN_SERVICE_VERSION, "github-code-scan-service:v1");
  await assert.rejects(() => service.prepareProjectScan("invalid"), assertInvalid);
  await assert.rejects(
    () => service.executeProjectScan({ projectId, batchId: "invalid" }),
    assertInvalid,
  );
  await assert.rejects(
    () => service.getProjectScan({ projectId, batchId, extra: true }),
    assertInvalid,
  );
  assert.equal(transactions, 0);
});

test("scan publication migration binds scanner state, batch membership and pointer CAS", () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/20260829020000_bind_github_scan_security/migration.sql",
    ),
    "utf8",
  );
  assert.match(migration, /RepositoryFileRevision_blob_scanner_key/);
  assert.match(migration, /RepoCodeScanRun_batch_link_key/);
  assert.match(migration, /RepositoryCodeGeneration_security_scan_check/);
  assert.match(migration, /ProjectScanBatch_expected_snapshot_fkey/);
  assert.match(migration, /PROJECT_CODE_SNAPSHOT_CAS_FAILED/);
  assert.match(migration, /expectedActiveCodeSnapshotId/);
  assert.match(migration, /RepoCodeScanRun_guard_update/);
  assert.match(migration, /RepositoryCodeGeneration_guard_update/);
  assert.match(migration, /ProjectScanBatch_guard_update/);
  assert.match(migration, /ProjectCodeSnapshot_guard_update/);
  assert.doesNotMatch(migration, /github_pat_|ghp_|authorization:/i);
});

test("scan service has no credential, shell, filesystem or arbitrary transport capability", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/github/code-scan-service.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /node:fs|child_process|execFile|spawn\(|process\.env|GITHUB_TOKEN_FILE/i);
  assert.doesNotMatch(source, /fetch\s*\(|authorization|console\.|logger\./i);
  assert.match(source, /scanGitHubRepositoryCode/);
  assert.match(source, /Prisma\.TransactionIsolationLevel\.Serializable/);
});
