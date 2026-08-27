import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_MATERIAL_SCANNER_FINGERPRINT,
  GITHUB_MATERIAL_SCANNER_VERSION,
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GitHubMaterialScanError,
  scanGitHubRepositoryMaterials,
  type GitHubMaterialReadOnlyClient,
} from "@/lib/github";

const owner = "acme";
const repositoryName = "application";
const commitSha = "a".repeat(40);
const rootTreeSha = "b".repeat(40);
const readmeSha = "c".repeat(40);
const docsTreeSha = "d".repeat(40);
const architectureSha = "e".repeat(40);
const secretSha = "f".repeat(40);

const repository = Object.freeze({
  repositoryId: 2_000_001,
  nodeId: "R_MATERIAL_SAFE",
  owner,
  name: repositoryName,
  fullName: `${owner}/${repositoryName}`,
  private: true,
  archived: false,
  disabled: false,
  defaultBranch: "main",
});

const policy = Object.freeze({
  metadataEnabled: true,
  readmeEnabled: true,
  markdownEnabled: true,
  markdownPaths: ["docs/architecture.md", "docs/secret.md"],
  issuesEnabled: true,
  pullRequestsEnabled: true,
  releasesEnabled: true,
  policyFingerprint: "1".repeat(64),
});

function encoded(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({ size: bytes.byteLength, content: bytes.toString("base64") });
}

function fixtureClient(options: Readonly<{ changedReference?: boolean }> = {}): GitHubMaterialReadOnlyClient {
  let referenceReads = 0;
  const readme = encoded("# Governed memory\n");
  const architecture = encoded("# Architecture\nRepository material is immutable.\n");
  const secret = encoded('password = "CorrectHorseBatteryStaple"\n');
  return Object.freeze({
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    async getRepository() {
      return repository;
    },
    async getReference() {
      referenceReads += 1;
      return Object.freeze({
        ref: "refs/heads/main",
        commitSha: options.changedReference && referenceReads > 1
          ? "9".repeat(40)
          : commitSha,
      });
    },
    async getCommit() {
      return Object.freeze({ commitSha, treeSha: rootTreeSha });
    },
    async getTree(input: Readonly<{ owner: string; repository: string; treeSha: string }>) {
      if (input.treeSha === rootTreeSha) {
        return Object.freeze({
          treeSha: rootTreeSha,
          truncated: false,
          entries: Object.freeze([
            Object.freeze({ path: "README.md", mode: "100644" as const, type: "blob" as const, sha: readmeSha, size: readme.size }),
            Object.freeze({ path: "docs", mode: "040000" as const, type: "tree" as const, sha: docsTreeSha, size: null }),
          ]),
        });
      }
      assert.equal(input.treeSha, docsTreeSha);
      return Object.freeze({
        treeSha: docsTreeSha,
        truncated: false,
        entries: Object.freeze([
          Object.freeze({ path: "architecture.md", mode: "100644" as const, type: "blob" as const, sha: architectureSha, size: architecture.size }),
          Object.freeze({ path: "secret.md", mode: "100644" as const, type: "blob" as const, sha: secretSha, size: secret.size }),
        ]),
      });
    },
    async getBlob(input: Readonly<{ owner: string; repository: string; blobSha: string }>) {
      const content = input.blobSha === readmeSha
        ? readme
        : input.blobSha === architectureSha
          ? architecture
          : secret;
      return Object.freeze({
        blobSha: input.blobSha,
        encoding: "base64" as const,
        ...content,
      });
    },
    async getIssuesPage() {
      return Object.freeze({
        items: Object.freeze([Object.freeze({
          nodeId: "I_SAFE_7",
          number: 7,
          title: "Keep citations immutable",
          body: "The citation must retain its source identity.",
          state: "open" as const,
          labels: Object.freeze(["memory"]),
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
          closedAt: null,
          htmlUrl: `https://github.com/${owner}/${repositoryName}/issues/7`,
        })]),
        nextPage: null,
      });
    },
    async getPullRequestsPage() {
      return Object.freeze({
        items: Object.freeze([Object.freeze({
          nodeId: "PR_SAFE_12",
          number: 12,
          updatedAt: "2026-08-03T00:00:00Z",
        })]),
        nextPage: null,
      });
    },
    async getPullRequest() {
      return Object.freeze({
        nodeId: "PR_SAFE_12",
        number: 12,
        title: "Add immutable citations",
        body: "Includes line-scoped citations.",
        state: "closed" as const,
        draft: false,
        baseRef: "main",
        baseSha: "2".repeat(40),
        headRef: "feature/citations",
        headSha: "3".repeat(40),
        additions: 20,
        deletions: 3,
        changedFiles: 1,
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-03T00:00:00Z",
        closedAt: "2026-08-03T00:00:00Z",
        mergedAt: "2026-08-03T00:00:00Z",
        htmlUrl: `https://github.com/${owner}/${repositoryName}/pull/12`,
      });
    },
    async getPullRequestFilesPage() {
      return Object.freeze({
        items: Object.freeze([Object.freeze({
          blobSha: "4".repeat(40),
          filename: "src/citations.ts",
          previousFilename: null,
          status: "modified" as const,
          additions: 20,
          deletions: 3,
          changes: 23,
        })]),
        nextPage: null,
      });
    },
    async getReleasesPage() {
      return Object.freeze({
        items: Object.freeze([Object.freeze({
          releaseId: 99,
          nodeId: "RE_SAFE_99",
          tagName: "v1.0.0",
          name: "V1",
          body: "First governed memory release.",
          draft: false,
          prerelease: false,
          createdAt: "2026-08-04T00:00:00Z",
          updatedAt: "2026-08-04T02:00:00Z",
          publishedAt: "2026-08-04T01:00:00Z",
          htmlUrl: `https://github.com/${owner}/${repositoryName}/releases/tag/v1.0.0`,
        })]),
        nextPage: null,
      });
    },
  });
}

function scan(client: GitHubMaterialReadOnlyClient) {
  return scanGitHubRepositoryMaterials({
    client,
    owner,
    repository: repositoryName,
    expectedRepositoryId: repository.repositoryId,
    expectedNodeId: repository.nodeId,
    trackedRef: "refs/heads/main",
    policy,
    now: () => 1_788_000_000_000,
  });
}

test("material scanner freezes repository identity and quarantines secret-bearing sources", async () => {
  const result = await scan(fixtureClient());
  assert.equal(result.contractVersion, GITHUB_MATERIAL_SCANNER_VERSION);
  assert.equal(result.scannerFingerprint, GITHUB_MATERIAL_SCANNER_FINGERPRINT);
  assert.equal(result.observedHeadCommitSha, commitSha);
  assert.equal(result.rootTreeSha, rootTreeSha);
  assert.equal(result.requestCount, 15);
  assert.equal(result.fetchedObjectCount, 7);
  assert.deepEqual(result.sources.map((source) => source.materialKind), [
    "repositoryMetadata",
    "readme",
    "markdown",
    "issue",
    "pullRequest",
    "release",
  ]);
  assert.equal(result.quarantines.length, 1);
  assert.equal(result.quarantines[0]?.materialKind, "markdown");
  assert.equal(result.quarantines[0]?.reasonCode, "secretDetected");
  assert.match(result.sourceSetFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes("CorrectHorseBatteryStaple"), false);
  const pull = result.sources.find((source) => source.materialKind === "pullRequest");
  assert.equal(pull?.contentText.includes("patch"), false);
  assert.equal(Object.isFrozen(result.sources), true);
  assert.equal(Object.isFrozen(result.quarantines), true);
});

test("material scanner fails closed when the tracked branch changes during collection", async () => {
  await assert.rejects(
    () => scan(fixtureClient({ changedReference: true })),
    (error: unknown) =>
      error instanceof GitHubMaterialScanError &&
      error.code === "GITHUB_MATERIAL_SCAN_REFERENCE_CHANGED",
  );
});

test("material scanner rejects an enabled Markdown class without exact paths", async () => {
  let repositoryReads = 0;
  await assert.rejects(
    () => scanGitHubRepositoryMaterials({
      client: Object.freeze({
        ...fixtureClient(),
        async getRepository() {
          repositoryReads += 1;
          return repository;
        },
      }),
      owner,
      repository: repositoryName,
      expectedRepositoryId: repository.repositoryId,
      expectedNodeId: repository.nodeId,
      trackedRef: "refs/heads/main",
      policy: { ...policy, markdownPaths: [] },
    }),
    (error: unknown) =>
      error instanceof GitHubMaterialScanError &&
      error.code === "GITHUB_MATERIAL_SCAN_INVALID_INPUT",
  );
  assert.equal(repositoryReads, 0);
});
