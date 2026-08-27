import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  GITHUB_ACCEPT,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  GitHubReadError,
  createGitHubReadOnlyClient,
  createGitHubReadPlan,
  loadGitHubCredential,
  type GitHubCredentialHandle,
} from "@/lib/github";

const token = `github_pat_${"A".repeat(64)}`;
const owner = "octocat";
const repository = "memory-lab";
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobSha = "c".repeat(40);

async function credential(): Promise<GitHubCredentialHandle> {
  const handle = await loadGitHubCredential({
    environment: {
      GITHUB_ENABLED: "true",
      GITHUB_TOKEN_FILE: "/run/secrets/github_token",
    },
    readFileImplementation: async () => `${token}\n`,
  });
  if (handle === null) throw new Error("expected configured credential handle");
  return handle;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function assertCode(code: string) {
  return (error: unknown) => error instanceof GitHubReadError && error.code === code;
}

test("credential loader is deny-first and keeps a fine-grained PAT non-serializable", async () => {
  assert.equal(await loadGitHubCredential({ environment: {} }), null);
  assert.equal(await loadGitHubCredential({ environment: { GITHUB_ENABLED: "false" } }), null);
  await assert.rejects(
    () => loadGitHubCredential({
      environment: { GITHUB_ENABLED: "true", GITHUB_TOKEN_FILE: "relative/token" },
      readFileImplementation: async () => token,
    }),
    assertCode("GITHUB_CREDENTIAL_UNAVAILABLE"),
  );
  await assert.rejects(
    () => loadGitHubCredential({
      environment: {
        GITHUB_ENABLED: "true",
        GITHUB_TOKEN_FILE: "/run/secrets/github_token",
      },
      readFileImplementation: async () => `ghp_${"B".repeat(64)}`,
    }),
    assertCode("GITHUB_CREDENTIAL_UNAVAILABLE"),
  );
  const handle = await credential();
  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual(Object.keys(handle), ["contractVersion", "provider", "authRef"]);
  assert.equal(JSON.stringify(handle).includes("github_pat_"), false);
  assert.equal(Object.values(handle).some((value) => value === token), false);
});

test("request plans expose only pinned GET endpoints at api.github.com", () => {
  assert.deepEqual(createGitHubReadPlan({ kind: "repository", owner, repository }), {
    clientVersion: "github-read-only-client:v1",
    apiVersion: GITHUB_API_VERSION,
    endpointKind: "repository",
    method: "GET",
    url: `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}`,
    redirect: "error",
    timeoutMs: 15_000,
    maximumResponseBytes: 1_048_576,
  });
  assert.equal(
    createGitHubReadPlan({
      kind: "reference",
      owner,
      repository,
      trackedRef: "refs/heads/feature/safe-scan",
    }).url,
    `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}/git/ref/heads/feature/safe-scan`,
  );
  assert.equal(createGitHubReadPlan({ kind: "commit", owner, repository, commitSha }).method, "GET");
  assert.equal(createGitHubReadPlan({ kind: "tree", owner, repository, treeSha }).maximumResponseBytes, 8_388_608);
  assert.equal(createGitHubReadPlan({ kind: "blob", owner, repository, blobSha }).maximumResponseBytes, 393_216);
  assert.equal(
    createGitHubReadPlan({ kind: "issues", owner, repository, page: 2 }).url,
    `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}/issues?state=all&sort=updated&direction=asc&per_page=100&page=2`,
  );
  assert.equal(
    createGitHubReadPlan({ kind: "pulls", owner, repository, page: 3 }).url,
    `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}/pulls?state=all&sort=updated&direction=asc&per_page=100&page=3`,
  );
  assert.equal(
    createGitHubReadPlan({ kind: "pull", owner, repository, pullNumber: 42 }).url,
    `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}/pulls/42`,
  );
  assert.equal(
    createGitHubReadPlan({ kind: "pullFiles", owner, repository, pullNumber: 42, page: 1 }).url,
    `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}/pulls/42/files?per_page=100&page=1`,
  );
  assert.equal(
    createGitHubReadPlan({ kind: "releases", owner, repository, page: 1 }).url,
    `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}/releases?per_page=100&page=1`,
  );
});

test("request plans reject arbitrary origins, malformed repository names, refs and SHA values", () => {
  const invalid = [
    { kind: "repository", owner: "https://evil.example", repository },
    { kind: "repository", owner, repository: "memory-lab.git" },
    { kind: "reference", owner, repository, trackedRef: "refs/tags/v1" },
    { kind: "reference", owner, repository, trackedRef: "refs/heads/../main" },
    { kind: "reference", owner, repository, trackedRef: "refs/heads/main.lock" },
    { kind: "commit", owner, repository, commitSha: `${commitSha}0` },
    { kind: "tree", owner, repository, treeSha: "main" },
    { kind: "blob", owner, repository, blobSha: blobSha.toUpperCase() },
    { kind: "issues", owner, repository, page: 0 },
    { kind: "pulls", owner, repository, page: 10_001 },
    { kind: "pull", owner, repository, pullNumber: 0 },
    { kind: "pullFiles", owner, repository, pullNumber: 1, page: -1 },
  ] as const;
  for (const input of invalid) {
    assert.throws(
      () => createGitHubReadPlan(input),
      assertCode("GITHUB_INVALID_REQUEST"),
    );
  }
});

test("client validates paged Issues, pull request metadata/files, and Releases", async () => {
  const issueNext = `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}/issues?state=all&sort=updated&direction=asc&per_page=100&page=2`;
  const responses = [
    jsonResponse([
      {
        node_id: "I_SAFE_1",
        number: 7,
        title: "Preserve repository provenance",
        body: "Keep the frozen commit.\nDo not follow links.",
        state: "open",
        labels: [{ name: "memory" }, { name: "security" }],
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
        closed_at: null,
        html_url: `https://github.com/${owner}/${repository}/issues/7`,
      },
      {
        node_id: "PR_IN_ISSUES",
        number: 8,
        pull_request: { url: "ignored" },
      },
    ], {
      headers: { link: `<${issueNext}>; rel="next"` },
    }),
    jsonResponse([{
      node_id: "PR_SAFE_1",
      number: 12,
      updated_at: "2026-08-03T00:00:00Z",
    }]),
    jsonResponse({
      node_id: "PR_SAFE_1",
      number: 12,
      title: "Add immutable citations",
      body: "Includes line-scoped citations.",
      state: "closed",
      draft: false,
      base: {
        ref: "main",
        sha: "d".repeat(40),
        repo: { full_name: `${owner}/${repository}` },
      },
      head: { ref: "feature/citations", sha: "e".repeat(40) },
      additions: 20,
      deletions: 3,
      changed_files: 2,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-03T00:00:00Z",
      closed_at: "2026-08-03T00:00:00Z",
      merged_at: "2026-08-03T00:00:00Z",
      html_url: `https://github.com/${owner}/${repository}/pull/12`,
    }),
    jsonResponse([{
      sha: "f".repeat(40),
      filename: "src/citations.ts",
      status: "modified",
      additions: 20,
      deletions: 3,
      changes: 23,
      patch: "SECRET_PATCH_MUST_NOT_BE_RETURNED",
    }]),
    jsonResponse([{
      id: 99,
      node_id: "RE_SAFE_1",
      tag_name: "v1.0.0",
      name: "V1",
      body: "First governed memory release.",
      draft: false,
      prerelease: false,
      created_at: "2026-08-04T00:00:00Z",
      published_at: "2026-08-04T01:00:00Z",
      html_url: `https://github.com/${owner}/${repository}/releases/tag/v1.0.0`,
    }]),
  ];
  const client = createGitHubReadOnlyClient({
    credential: await credential(),
    fetchImplementation: async () => responses.shift()!,
  });

  const issues = await client.getIssuesPage({ owner, repository, page: 1 });
  assert.equal(issues.nextPage, 2);
  assert.equal(issues.items.length, 1);
  assert.deepEqual(issues.items[0]?.labels, ["memory", "security"]);
  const pulls = await client.getPullRequestsPage({ owner, repository, page: 1 });
  assert.deepEqual(pulls.items, [{
    nodeId: "PR_SAFE_1",
    number: 12,
    updatedAt: "2026-08-03T00:00:00Z",
  }]);
  const pull = await client.getPullRequest({ owner, repository, pullNumber: 12 });
  assert.equal(pull.changedFiles, 2);
  assert.equal(pull.headRef, "feature/citations");
  const files = await client.getPullRequestFilesPage({
    owner,
    repository,
    pullNumber: 12,
    page: 1,
  });
  assert.deepEqual(Object.keys(files.items[0]!).sort(), [
    "additions",
    "blobSha",
    "changes",
    "deletions",
    "filename",
    "previousFilename",
    "status",
  ]);
  assert.equal(JSON.stringify(files).includes("SECRET_PATCH"), false);
  const releases = await client.getReleasesPage({ owner, repository, page: 1 });
  assert.equal(releases.items[0]?.tagName, "v1.0.0");
  assert.equal(responses.length, 0);
});

test("paged client rejects foreign or non-sequential Link targets", async () => {
  const invalidTargets = [
    `https://evil.example/repos/${owner}/${repository}/issues?page=2`,
    `${GITHUB_API_ORIGIN}/repos/${owner}/${repository}/issues?state=all&sort=updated&direction=asc&per_page=100&page=3`,
  ];
  for (const target of invalidTargets) {
    const client = createGitHubReadOnlyClient({
      credential: await credential(),
      fetchImplementation: async () => jsonResponse([], {
        headers: { link: `<${target}>; rel="next"` },
      }),
    });
    await assert.rejects(
      () => client.getIssuesPage({ owner, repository, page: 1 }),
      assertCode("GITHUB_INVALID_RESPONSE"),
    );
  }
});

test("client resolves repository, frozen commit, tree and blob through verified GET responses", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const responses = [
    {
      id: 1296269,
      node_id: "R_kg_SAFE",
      name: repository,
      full_name: `${owner}/${repository}`,
      owner: { login: owner },
      private: true,
      archived: false,
      disabled: false,
      default_branch: "main",
    },
    { ref: "refs/heads/main", object: { type: "commit", sha: commitSha } },
    { sha: commitSha, tree: { sha: treeSha } },
    {
      sha: treeSha,
      truncated: false,
      tree: [
        { path: "src", mode: "040000", type: "tree", sha: "d".repeat(40) },
        { path: "README.md", mode: "100644", type: "blob", sha: blobSha, size: 12 },
      ],
    },
    {
      sha: blobSha,
      size: 12,
      encoding: "base64",
      content: Buffer.from("hello world\n", "utf8").toString("base64"),
    },
  ];
  const client = createGitHubReadOnlyClient({
    credential: await credential(),
    fetchImplementation: async (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      assert.notEqual(response, undefined);
      return jsonResponse(response);
    },
  });

  const remote = await client.getRepository({ owner, repository });
  assert.equal(remote.repositoryId, 1296269);
  assert.equal(remote.fullName, `${owner}/${repository}`);
  assert.equal((await client.getReference({ owner, repository, trackedRef: "refs/heads/main" })).commitSha, commitSha);
  assert.equal((await client.getCommit({ owner, repository, commitSha })).treeSha, treeSha);
  const tree = await client.getTree({ owner, repository, treeSha });
  assert.equal(tree.truncated, false);
  assert.equal(tree.entries[1]?.path, "README.md");
  const blob = await client.getBlob({ owner, repository, blobSha });
  assert.equal(blob.size, 12);
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.url.startsWith(`${GITHUB_API_ORIGIN}/repos/${owner}/${repository}`), true);
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.redirect, "error");
    assert.equal(call.init?.credentials, "omit");
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("accept"), GITHUB_ACCEPT);
    assert.equal(headers.get("user-agent"), GITHUB_USER_AGENT);
    assert.equal(headers.get("x-github-api-version"), GITHUB_API_VERSION);
    assert.equal(headers.get("authorization")?.startsWith("Bearer github_pat_"), true);
  }
});

test("identity mismatch and malformed Git objects fail closed", async () => {
  const client = createGitHubReadOnlyClient({
    credential: await credential(),
    fetchImplementation: async () => jsonResponse({
      id: 1,
      node_id: "R_BAD",
      name: "other-repository",
      full_name: `${owner}/other-repository`,
      owner: { login: owner },
      private: true,
      archived: false,
      disabled: false,
      default_branch: "main",
    }),
  });
  await assert.rejects(
    () => client.getRepository({ owner, repository }),
    assertCode("GITHUB_INVALID_RESPONSE"),
  );

  const malformedTreeClient = createGitHubReadOnlyClient({
    credential: await credential(),
    fetchImplementation: async () => jsonResponse({
      sha: treeSha,
      truncated: false,
      tree: [{ path: "link", mode: "120000", type: "blob", sha: "not-a-sha", size: 4 }],
    }),
  });
  await assert.rejects(
    () => malformedTreeClient.getTree({ owner, repository, treeSha }),
    assertCode("GITHUB_INVALID_RESPONSE"),
  );
});

test("redirects, access ambiguity and rate limits discard bodies without retrying", async () => {
  const samples: Array<{ status: number; headers: Record<string, string>; code: string }> = [
    { status: 302, headers: {}, code: "GITHUB_REDIRECT_REJECTED" },
    { status: 404, headers: {}, code: "GITHUB_ACCESS_UNKNOWN" },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" },
      code: "GITHUB_RATE_LIMITED",
    },
  ];
  for (const sample of samples) {
    let calls = 0;
    let cancelled = 0;
    const client = createGitHubReadOnlyClient({
      credential: await credential(),
      fetchImplementation: async () => {
        calls += 1;
        return {
          status: sample.status,
          ok: false,
          headers: new Headers(sample.headers),
          body: { cancel: async () => { cancelled += 1; } },
        } as unknown as Response;
      },
    });
    await assert.rejects(
      () => client.getRepository({ owner, repository }),
      assertCode(sample.code),
    );
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
  }
});

test("oversized or invalid success responses fail without exposing raw provider data", async () => {
  let cancelled = 0;
  const oversized = createGitHubReadOnlyClient({
    credential: await credential(),
    fetchImplementation: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({
        "content-type": "application/json",
        "content-length": "1048577",
      }),
      body: { cancel: async () => { cancelled += 1; } },
    } as unknown as Response),
  });
  await assert.rejects(
    () => oversized.getRepository({ owner, repository }),
    assertCode("GITHUB_RESPONSE_TOO_LARGE"),
  );
  assert.equal(cancelled, 1);

  const invalid = createGitHubReadOnlyClient({
    credential: await credential(),
    fetchImplementation: async () => new Response("SECRET_PROVIDER_BODY", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
  });
  await assert.rejects(
    () => invalid.getRepository({ owner, repository }),
    (error: unknown) =>
      error instanceof GitHubReadError &&
      error.code === "GITHUB_INVALID_RESPONSE" &&
      !error.message.includes("SECRET_PROVIDER_BODY"),
  );
});

test("network failures execute once and forged credential handles cannot dispatch", async () => {
  let calls = 0;
  const client = createGitHubReadOnlyClient({
    credential: await credential(),
    fetchImplementation: async () => {
      calls += 1;
      throw new Error("network unavailable");
    },
  });
  await assert.rejects(
    () => client.getRepository({ owner, repository }),
    assertCode("GITHUB_REQUEST_FAILED"),
  );
  assert.equal(calls, 1);
  assert.throws(
    () => createGitHubReadOnlyClient({
      credential: {
        contractVersion: "github-fine-grained-pat-file:v1",
        provider: "github",
        authRef: "github-token-file:v1",
      },
      fetchImplementation: async () => jsonResponse({}),
    }),
    assertCode("GITHUB_CREDENTIAL_UNAVAILABLE"),
  );
});

test("client source contains no write method, arbitrary origin, logging or retry loop", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/github/read-only-client.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/u);
  assert.doesNotMatch(source, /redirect:\s*["']follow["']/u);
  assert.doesNotMatch(source, /console\.|\blogger\b|setInterval\s*\(/u);
  assert.doesNotMatch(source, /while\s*\([^)]*(?:retry|attempt)/iu);
  assert.equal(source.includes('export const GITHUB_API_ORIGIN = "https://api.github.com"'), true);
});
