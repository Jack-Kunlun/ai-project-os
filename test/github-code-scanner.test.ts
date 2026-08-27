import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  GITHUB_CODE_SCANNER_FINGERPRINT,
  GITHUB_CODE_SCANNER_VERSION,
  GITHUB_CODE_SCAN_BUDGETS,
  GITHUB_READ_ONLY_CLIENT_VERSION,
  GITHUB_SOFT_EXCLUDE_CLASSES,
  GitHubCodeScanError,
  scanGitHubRepositoryCode,
  type GitHubReadOnlyClient,
  type VerifiedGitHubTree,
} from "@/lib/github";

const owner = "acme";
const repositoryName = "application";
const repositoryId = 1_000_001;
const nodeId = "R_SAFE_APP";
const commitSha = "a".repeat(40);
const rootTreeSha = "b".repeat(40);
const srcTreeSha = "c".repeat(40);
const indexBlobSha = "d".repeat(40);
const piiBlobSha = "e".repeat(40);

type FakeClientOptions = Readonly<{
  trees: Readonly<Record<string, VerifiedGitHubTree>>;
  blobs: Readonly<Record<string, Readonly<{ size: number; content: string }>>>;
  repositoryId?: number;
}>;

function fakeClient(options: FakeClientOptions): Readonly<{
  client: GitHubReadOnlyClient;
  calls: string[];
}> {
  const calls: string[] = [];
  const client: GitHubReadOnlyClient = Object.freeze({
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    async getRepository() {
      calls.push("repository");
      return Object.freeze({
        repositoryId: options.repositoryId ?? repositoryId,
        nodeId,
        owner,
        name: repositoryName,
        fullName: `${owner}/${repositoryName}`,
        private: true,
        archived: false,
        disabled: false,
        defaultBranch: "main",
      });
    },
    async getReference(input: Readonly<{ trackedRef: string }>) {
      calls.push(`reference:${input.trackedRef}`);
      return Object.freeze({ ref: input.trackedRef, commitSha });
    },
    async getCommit(input: Readonly<{ commitSha: string }>) {
      calls.push(`commit:${input.commitSha}`);
      return Object.freeze({ commitSha: input.commitSha, treeSha: rootTreeSha });
    },
    async getTree(input: Readonly<{ treeSha: string }>) {
      calls.push(`tree:${input.treeSha}`);
      const tree = options.trees[input.treeSha];
      if (tree === undefined) throw new Error("unexpected tree");
      return tree;
    },
    async getBlob(input: Readonly<{ blobSha: string }>) {
      calls.push(`blob:${input.blobSha}`);
      const blob = options.blobs[input.blobSha];
      if (blob === undefined) throw new Error("unexpected blob");
      return Object.freeze({
        blobSha: input.blobSha,
        size: blob.size,
        encoding: "base64" as const,
        content: blob.content,
      });
    },
  });
  return Object.freeze({ client, calls });
}

function tree(
  treeSha: string,
  entries: VerifiedGitHubTree["entries"],
  truncated = false,
): VerifiedGitHubTree {
  return Object.freeze({ treeSha, truncated, entries: Object.freeze([...entries]) });
}

function encoded(text: string): Readonly<{ size: number; content: string }> {
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({ size: bytes.byteLength, content: bytes.toString("base64") });
}

function scanInput(client: GitHubReadOnlyClient, overrides: Record<string, unknown> = {}) {
  return {
    client,
    owner,
    repository: repositoryName,
    expectedRepositoryId: repositoryId,
    expectedNodeId: nodeId,
    trackedRef: "refs/heads/main",
    includeRoots: ["src"],
    softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
    scanScopeFingerprint: "1".repeat(64),
    ...overrides,
  };
}

function assertCode(code: string) {
  return (error: unknown) => error instanceof GitHubCodeScanError && error.code === code;
}

test("scanner freezes one commit and produces a deterministic scoped manifest", async () => {
  const indexText = "export const answer = 42;\n";
  const piiText = "export const ownerEmail = \"owner@example.com\";\n";
  const fixture = fakeClient({
    trees: {
      [rootTreeSha]: tree(rootTreeSha, [
        { path: "outside.txt", mode: "100644", type: "blob", sha: "1".repeat(40), size: 8 },
        { path: "src", mode: "040000", type: "tree", sha: srcTreeSha, size: null },
      ]),
      [srcTreeSha]: tree(srcTreeSha, [
        { path: "generated", mode: "040000", type: "tree", sha: "2".repeat(40), size: null },
        { path: "image.png", mode: "100644", type: "blob", sha: "3".repeat(40), size: 128 },
        { path: "index.ts", mode: "100644", type: "blob", sha: indexBlobSha, size: Buffer.byteLength(indexText) },
        { path: "link", mode: "120000", type: "blob", sha: "4".repeat(40), size: 9 },
        { path: "module", mode: "160000", type: "commit", sha: "5".repeat(40), size: null },
        { path: "owner.ts", mode: "100644", type: "blob", sha: piiBlobSha, size: Buffer.byteLength(piiText) },
        { path: "run.sh", mode: "100755", type: "blob", sha: "6".repeat(40), size: 12 },
      ]),
    },
    blobs: {
      [indexBlobSha]: encoded(indexText),
      [piiBlobSha]: encoded(piiText),
    },
  });

  const first = await scanGitHubRepositoryCode(scanInput(fixture.client));
  const second = await scanGitHubRepositoryCode(scanInput(fakeClient({
    trees: {
      [rootTreeSha]: tree(rootTreeSha, [
        { path: "src", mode: "040000", type: "tree", sha: srcTreeSha, size: null },
        { path: "outside.txt", mode: "100644", type: "blob", sha: "1".repeat(40), size: 8 },
      ]),
      [srcTreeSha]: tree(srcTreeSha, [
        { path: "run.sh", mode: "100755", type: "blob", sha: "6".repeat(40), size: 12 },
        { path: "owner.ts", mode: "100644", type: "blob", sha: piiBlobSha, size: Buffer.byteLength(piiText) },
        { path: "module", mode: "160000", type: "commit", sha: "5".repeat(40), size: null },
        { path: "link", mode: "120000", type: "blob", sha: "4".repeat(40), size: 9 },
        { path: "index.ts", mode: "100644", type: "blob", sha: indexBlobSha, size: Buffer.byteLength(indexText) },
        { path: "image.png", mode: "100644", type: "blob", sha: "3".repeat(40), size: 128 },
        { path: "generated", mode: "040000", type: "tree", sha: "2".repeat(40), size: null },
      ]),
    },
    blobs: {
      [indexBlobSha]: encoded(indexText),
      [piiBlobSha]: encoded(piiText),
    },
  }).client));

  assert.equal(first.contractVersion, GITHUB_CODE_SCANNER_VERSION);
  assert.equal(first.scannerFingerprint, GITHUB_CODE_SCANNER_FINGERPRINT);
  assert.equal(first.frozenCommitSha, commitSha);
  assert.equal(first.rootTreeSha, rootTreeSha);
  assert.equal(first.requestCount, 7);
  assert.equal(first.visitedTreeEntryCount, 9);
  assert.equal(first.files.length, 2);
  assert.deepEqual(first.files.map((file) => file.normalizedPath), ["src/index.ts", "src/owner.ts"]);
  assert.deepEqual(first.exclusions.map((item) => [item.normalizedPath, item.reason]), [
    ["src/generated", "SOFT_GENERATED"],
    ["src/image.png", "BINARY_EXTENSION"],
    ["src/link", "SYMLINK"],
    ["src/module", "SUBMODULE"],
    ["src/run.sh", "EXECUTABLE_NOT_ALLOWED"],
  ]);
  assert.deepEqual(first.securityFindings, [
    { normalizedPath: "src/owner.ts", categories: ["EMAIL_ADDRESS"] },
  ]);
  assert.equal(first.modelTransferScanResult, "blocked");
  assert.match(first.manifestFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.manifestFingerprint, second.manifestFingerprint);
  assert.deepEqual(first.files, second.files);
  assert.equal(fixture.calls.includes("blob:1111111111111111111111111111111111111111"), false);
});

test("hard or soft excluded explicit roots fail before reading their blobs", async () => {
  const fixture = fakeClient({
    trees: {
      [rootTreeSha]: tree(rootTreeSha, [
        { path: ".env", mode: "100644", type: "blob", sha: indexBlobSha, size: 10 },
        { path: "node_modules", mode: "040000", type: "tree", sha: srcTreeSha, size: null },
      ]),
    },
    blobs: {},
  });
  await assert.rejects(
    () => scanGitHubRepositoryCode(scanInput(fixture.client, { includeRoots: [".env"] })),
    assertCode("GITHUB_SCAN_SCOPE_EXCLUDED"),
  );
  await assert.rejects(
    () => scanGitHubRepositoryCode(scanInput(fixture.client, { includeRoots: ["node_modules/pkg"] })),
    assertCode("GITHUB_SCAN_SCOPE_EXCLUDED"),
  );
  assert.equal(fixture.calls.some((call) => call.startsWith("blob:")), false);
});

test("identity, missing roots and truncated trees fail closed", async () => {
  const mismatched = fakeClient({
    repositoryId: repositoryId + 1,
    trees: {},
    blobs: {},
  });
  await assert.rejects(
    () => scanGitHubRepositoryCode(scanInput(mismatched.client)),
    assertCode("GITHUB_SCAN_IDENTITY_MISMATCH"),
  );

  const missing = fakeClient({
    trees: { [rootTreeSha]: tree(rootTreeSha, []) },
    blobs: {},
  });
  await assert.rejects(
    () => scanGitHubRepositoryCode(scanInput(missing.client)),
    assertCode("GITHUB_SCAN_SCOPE_NOT_FOUND"),
  );

  const truncated = fakeClient({
    trees: { [rootTreeSha]: tree(rootTreeSha, [], true) },
    blobs: {},
  });
  await assert.rejects(
    () => scanGitHubRepositoryCode(scanInput(truncated.client)),
    assertCode("GITHUB_SCAN_TREE_TRUNCATED"),
  );
});

test("secret, bidi and oversized line findings abort the whole repository scan", async () => {
  const samples = [
    { text: 'const password = "CorrectHorseBatteryStaple";\n', code: "GITHUB_SCAN_SECRET_DETECTED" },
    { text: "const safe = true; // \u202eevil\n", code: "GITHUB_SCAN_UNSAFE_CONTENT" },
    { text: "x".repeat(GITHUB_CODE_SCAN_BUDGETS.maximumLineBytes + 1), code: "GITHUB_SCAN_UNSAFE_CONTENT" },
  ];
  for (const [index, sample] of samples.entries()) {
    const blobSha = String(index + 7).repeat(40);
    const fixture = fakeClient({
      trees: {
        [rootTreeSha]: tree(rootTreeSha, [
          { path: "src", mode: "040000", type: "tree", sha: srcTreeSha, size: null },
        ]),
        [srcTreeSha]: tree(srcTreeSha, [
          { path: "unsafe.ts", mode: "100644", type: "blob", sha: blobSha, size: Buffer.byteLength(sample.text) },
        ]),
      },
      blobs: { [blobSha]: encoded(sample.text) },
    });
    await assert.rejects(
      () => scanGitHubRepositoryCode(scanInput(fixture.client)),
      assertCode(sample.code),
    );
  }
});

test("invalid UTF-8 and LFS pointers are excluded with no visible code body", async () => {
  const invalidSha = "7".repeat(40);
  const lfsSha = "8".repeat(40);
  const invalid = Buffer.from([0xff, 0xfe]);
  const lfs = encoded("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n");
  const fixture = fakeClient({
    trees: {
      [rootTreeSha]: tree(rootTreeSha, [
        { path: "src", mode: "040000", type: "tree", sha: srcTreeSha, size: null },
      ]),
      [srcTreeSha]: tree(srcTreeSha, [
        { path: "invalid.txt", mode: "100644", type: "blob", sha: invalidSha, size: invalid.byteLength },
        { path: "large.bin.txt", mode: "100644", type: "blob", sha: lfsSha, size: lfs.size },
      ]),
    },
    blobs: {
      [invalidSha]: { size: invalid.byteLength, content: invalid.toString("base64") },
      [lfsSha]: lfs,
    },
  });
  const result = await scanGitHubRepositoryCode(scanInput(fixture.client));
  assert.equal(result.files.length, 0);
  assert.deepEqual(result.exclusions.map((item) => item.reason), ["INVALID_UTF8", "GIT_LFS_POINTER"]);
  assert.equal(JSON.stringify(result).includes("git-lfs.github.com"), false);
});

test("budgets and base64 integrity are enforced before publication", async () => {
  const oversized = fakeClient({
    trees: {
      [rootTreeSha]: tree(rootTreeSha, [
        { path: "src", mode: "040000", type: "tree", sha: srcTreeSha, size: null },
      ]),
      [srcTreeSha]: tree(srcTreeSha, [
        {
          path: "huge.ts",
          mode: "100644",
          type: "blob",
          sha: indexBlobSha,
          size: GITHUB_CODE_SCAN_BUDGETS.maximumFileBytes + 1,
        },
      ]),
    },
    blobs: {},
  });
  await assert.rejects(
    () => scanGitHubRepositoryCode(scanInput(oversized.client)),
    assertCode("GITHUB_SCAN_BUDGET_EXCEEDED"),
  );

  const invalidBase64 = fakeClient({
    trees: {
      [rootTreeSha]: tree(rootTreeSha, [
        { path: "src", mode: "040000", type: "tree", sha: srcTreeSha, size: null },
      ]),
      [srcTreeSha]: tree(srcTreeSha, [
        { path: "index.ts", mode: "100644", type: "blob", sha: indexBlobSha, size: 1 },
      ]),
    },
    blobs: { [indexBlobSha]: { size: 1, content: "A===" } },
  });
  await assert.rejects(
    () => scanGitHubRepositoryCode(scanInput(invalidBase64.client)),
    assertCode("GITHUB_SCAN_BLOB_INTEGRITY_ERROR"),
  );
});

test("input scope is canonical and scanner source has no direct transport or filesystem access", async () => {
  const fixture = fakeClient({ trees: {}, blobs: {} });
  const invalid = [
    { includeRoots: ["src", "src/lib"] },
    { includeRoots: ["../src"] },
    { includeRoots: ["src%2flib"] },
    { includeRoots: [] },
    { softExcludePatterns: ["arbitrary"] },
    { scanScopeFingerprint: "not-a-fingerprint" },
  ];
  for (const overrides of invalid) {
    await assert.rejects(
      () => scanGitHubRepositoryCode(scanInput(fixture.client, overrides)),
      assertCode("GITHUB_SCAN_INVALID_INPUT"),
    );
  }
  const source = readFileSync(
    join(process.cwd(), "src/lib/github/code-scanner.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /node:fs|child_process|\.get\(|\.post\(|fetch\s*\(/i);
  assert.doesNotMatch(source, /console\.|logger\.|authorization|process\.env|GITHUB_TOKEN_FILE/i);
});
