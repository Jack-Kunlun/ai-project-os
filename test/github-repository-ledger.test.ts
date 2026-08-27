import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ProjectRepositoryRole } from "@prisma/client";
import {
  GITHUB_AUTH_REF,
  GITHUB_REPOSITORY_LEDGER_VERSION,
  GITHUB_SOFT_EXCLUDE_CLASSES,
  GitHubLedgerError,
  createGitHubRepositoryLedgerService,
} from "@/lib/github";

const repositoryRoot = process.cwd();
const schema = readFileSync(join(repositoryRoot, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(
    repositoryRoot,
    "prisma/migrations/20260829010000_add_github_repository_ledger/migration.sql",
  ),
  "utf8",
);

const projectId = "11111111-1111-4111-8111-111111111111";

const repository = Object.freeze({
  repositoryId: 12_962_690,
  nodeId: "R_kg_SAFE",
  owner: "octocat",
  name: "memory-lab",
  fullName: "octocat/memory-lab",
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

const config = Object.freeze({
  role: ProjectRepositoryRole.primary,
  requiredForProjectSnapshot: true,
  trackedRef: "refs/heads/main",
  codeEnabled: true,
  metadataEnabled: true,
  readmeEnabled: true,
  markdownEnabled: false,
  issuesEnabled: false,
  pullRequestsEnabled: false,
  releasesEnabled: false,
  includeRoots: ["src", "README.md"],
  softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
});

function assertInvalid(error: unknown): boolean {
  return error instanceof GitHubLedgerError && error.code === "GITHUB_LEDGER_INVALID_INPUT";
}

test("repository ledger uses a fixed auth reference and a versioned contract", () => {
  assert.equal(GITHUB_AUTH_REF, "github-token-file:v1");
  assert.equal(GITHUB_REPOSITORY_LEDGER_VERSION, "github-repository-ledger:v1");
  assert.equal(new Set(GITHUB_SOFT_EXCLUDE_CLASSES).size, GITHUB_SOFT_EXCLUDE_CLASSES.length);
  assert.equal(Object.isFrozen(GITHUB_SOFT_EXCLUDE_CLASSES), true);
});

test("repository ledger rejects ambiguous scope before opening a transaction", async () => {
  let transactionCount = 0;
  const service = createGitHubRepositoryLedgerService({
    db: {
      $transaction: async () => {
        transactionCount += 1;
        throw new Error("transaction should not run");
      },
    } as never,
  });

  const invalidInputs = [
    { projectId, repository, config: { ...config, trackedRef: "main" } },
    { projectId, repository, config: { ...config, trackedRef: "refs/tags/v1" } },
    { projectId, repository, config: { ...config, includeRoots: ["../secret"] } },
    { projectId, repository, config: { ...config, includeRoots: ["src\\server"] } },
    { projectId, repository, config: { ...config, softExcludePatterns: ["secrets"] } },
    {
      projectId,
      repository,
      config: {
        ...config,
        codeEnabled: false,
        metadataEnabled: false,
        readmeEnabled: false,
        markdownEnabled: false,
        issuesEnabled: false,
        pullRequestsEnabled: false,
        releasesEnabled: false,
      },
    },
    { projectId, repository: { ...repository, fullName: "octocat/other" }, config },
    { projectId, repository, config: { ...config, unexpected: true } },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(() => service.connect(input), assertInvalid);
  }
  assert.equal(transactionCount, 0);
});

test("schema scopes repository content and derived rows to their project link", () => {
  for (const model of [
    "GitHubConnection",
    "GitHubRepository",
    "ProjectRepositoryLink",
    "ProjectRepositoryLinkConfigVersion",
    "ProjectScanBatch",
    "RepoCodeScanRun",
    "RepositoryFile",
    "RepositoryFileRevision",
    "RepositoryCodeGeneration",
    "RepositoryCodeGenerationEntry",
    "RepositoryCodeGenerationPointer",
    "ProjectCodeSnapshot",
    "ProjectCodeSnapshotEntry",
    "ProjectCodeSnapshotPointer",
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /RepositoryFileRevision_file_fkey/);
  assert.match(schema, /RepositoryCodeGenerationEntry_revision_fkey/);
  assert.match(schema, /ProjectCodeSnapshotEntry_generation_fkey/);
  assert.match(schema, /ProjectSource\[\]\s+@relation\("RepositoryLinkSources"\)/);
  assert.doesNotMatch(schema, /githubToken|accessToken|personalAccessToken/i);
});

test("migration enforces admission, immutability and atomic pointer publication", () => {
  assert.match(migration, /ProjectScanBatch_pending_project_key/);
  assert.match(migration, /RepoCodeScanRun_pending_link_key/);
  assert.match(migration, /WHERE "status" IN \('queued', 'running', 'unknown'\)/);
  assert.match(migration, /ProjectRepositoryLinkConfigVersion_immutable/);
  assert.match(migration, /RepositoryFileRevision_immutable/);
  assert.match(migration, /RepositoryCodeGenerationEntry_immutable/);
  assert.match(migration, /RepositoryCodeGenerationEntry_validate/);
  assert.match(migration, /ProjectCodeSnapshotEntry_immutable/);
  assert.match(migration, /ProjectCodeSnapshotEntry_validate/);
  assert.match(migration, /GITHUB_CONFIG_POINTER_INELIGIBLE/);
  assert.match(migration, /GITHUB_CODE_POINTER_INELIGIBLE/);
  assert.match(migration, /GITHUB_CODE_POINTER_CAS_FAILED/);
  assert.match(migration, /PROJECT_CODE_SNAPSHOT_INCOMPLETE/);
  assert.match(migration, /"requiredForProjectSnapshot" = true/);
  assert.match(migration, /"authRef" = 'github-token-file:v1'/);
  assert.doesNotMatch(migration, /github_pat_|ghp_|authorization:/i);
  assert.doesNotMatch(migration, /Rename(?:ForeignKey|Index)/);
});
