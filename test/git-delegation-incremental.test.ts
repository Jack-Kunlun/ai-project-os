import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  assertPinnedGitEndpoint,
  GitRunnerError,
  GitSafetyError,
  GitServiceError,
  encodeGitCredential,
  isDefinitelyPreDispatchGitSyncFailure,
  readGitRepositoryFilesForDelegation,
  type GitDelegationBaseline,
  type GitScannedFile,
} from "../src/lib/git";

function findGitBinary(): string {
  const pathEntries = (process.env.PATH ?? "").split(":");
  const entry = pathEntries.find((path) => {
    try {
      accessSync(join(path, "git"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (entry === undefined) throw new Error("GIT_EXECUTABLE_UNAVAILABLE");
  return join(entry, "git");
}

function git(binary: string, args: readonly string[], cwd: string): string {
  return execFileSync(binary, [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function fileProjection(files: readonly GitScannedFile[]) {
  return files.map(({ path, blobOid, contentText, contentHash, contentBytes, lineCount }) => ({
    path,
    blobOid,
    contentText,
    contentHash,
    contentBytes,
    lineCount,
  }));
}

function catFileBlobs(commands: readonly string[]): string[] {
  return commands
    .filter((command) => command.includes(" cat-file blob "))
    .map((command) => command.split(" ").at(-1)!)
    .sort();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

async function captureRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject");
}

async function waitForFileContents(path: string): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Process ${pid} is still running`);
}

test("delegated Git incremental sync reuses only verified path/blob text and traces actual runner commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-git-incremental-"));
  const realGit = findGitBinary();
  const worktree = join(root, "worktree");
  const bareRemote = join(root, "repository.git");
  const shimDirectory = join(root, "bin");
  const tracePath = join(root, "git-command-trace.log");
  let activeProcessGroupId: number | undefined;
  const remoteUrl = pathToFileURL(bareRemote).href;
  const oldPath = process.env.PATH;

  try {
    await mkdir(shimDirectory);
    execFileSync(realGit, ["init", "--bare", "--initial-branch=main", bareRemote], { stdio: "ignore" });
    execFileSync(realGit, ["init", "--initial-branch=main", worktree], { stdio: "ignore" });
    git(realGit, ["config", "user.name", "Git Incremental Test"], worktree);
    git(realGit, ["config", "user.email", "git-incremental@example.invalid"], worktree);
    git(realGit, ["remote", "add", "origin", bareRemote], worktree);
    await mkdir(join(worktree, "src"));
    await writeFile(join(worktree, "src/keep.ts"), "export const keep = 'unchanged';\n", "utf8");
    await writeFile(join(worktree, "src/change.ts"), "export const changed = 'before';\n", "utf8");
    await writeFile(join(worktree, "src/delete.ts"), "export const removed = true;\n", "utf8");
    git(realGit, ["add", "src"], worktree);
    git(realGit, ["commit", "-m", "baseline"], worktree);
    execFileSync(realGit, ["push", "origin", "main"], { cwd: worktree, stdio: "ignore" });

    const initialCommit = git(realGit, ["rev-parse", "HEAD"], worktree);
    const initialKeepOid = git(realGit, ["rev-parse", "HEAD:src/keep.ts"], worktree);
    const initialChangeOid = git(realGit, ["rev-parse", "HEAD:src/change.ts"], worktree);
    const initialDeleteOid = git(realGit, ["rev-parse", "HEAD:src/delete.ts"], worktree);
    const wrapper = [
      "#!/bin/bash",
      "set -euo pipefail",
      `trace_path=${shellQuote(tracePath)}`,
      `remote_url=${shellQuote(remoteUrl)}`,
      `real_git=${shellQuote(realGit)}`,
      'printf "%s\\n" "$*" >> "$trace_path"',
      'args=("$@")',
      'if [[ " ${args[*]} " == *" remote add origin "* ]]; then args[$((${#args[@]} - 1))]="$remote_url"; fi',
      "unset GIT_ALLOW_PROTOCOL",
      'exec "$real_git" "${args[@]}" 2>> "$trace_path.stderr"',
      "",
    ].join("\n");
    const shimPath = join(shimDirectory, "git");
    await writeFile(shimPath, wrapper, { encoding: "utf8", mode: 0o700 });
    await chmod(shimPath, 0o700);
    process.env.PATH = `${shimDirectory}:${oldPath ?? ""}`;

    type DelegatedConnection = Parameters<typeof readGitRepositoryFilesForDelegation>[0]["connection"];
    const connection: DelegatedConnection = {
      baseUrl: "https://127.0.0.1",
      transport: "https",
      authKind: "none",
      username: null,
      providerKind: "github",
      allowPrivateNetwork: true,
      tlsCaCertificate: null,
      sshKnownHost: null,
      resolvedAddressFingerprint: "",
      verifiedAddresses: null,
    };
    const pinnedResolution = await assertPinnedGitEndpoint({
      baseUrl: connection.baseUrl,
      allowPrivateNetwork: connection.allowPrivateNetwork,
      expectedFingerprint: null,
    });
    const read = async (input: Readonly<{
      connection?: DelegatedConnection;
      db?: PrismaClient;
      unchangedIfCommitSha?: string;
      incrementalBaseline?: GitDelegationBaseline | null;
      softExcludePatterns?: readonly string[];
      onDispatchBoundary?: () => Promise<boolean>;
      onBeforeCredentialRead?: () => Promise<boolean>;
      onBeforeExternalRequest?: () => Promise<boolean>;
      loadCredentialSecret?: () => Promise<string>;
      pinnedResolution?: typeof pinnedResolution;
      signal?: AbortSignal;
    }> = {}) => readGitRepositoryFilesForDelegation({
      connection: input.connection ?? connection,
      repositoryPath: "org/repository",
      trackedRef: "main",
      includeRoots: ["src"],
      softExcludePatterns: input.softExcludePatterns ?? [],
      db: input.db ?? {} as PrismaClient,
      pinnedResolution: input.pinnedResolution ?? pinnedResolution,
      onDispatchBoundary: input.onDispatchBoundary ?? (async () => true),
      onBeforeCredentialRead: input.onBeforeCredentialRead,
      onBeforeExternalRequest: input.onBeforeExternalRequest,
      loadCredentialSecret: input.loadCredentialSecret,
      signal: input.signal,
      unchangedIfCommitSha: input.unchangedIfCommitSha,
      incrementalBaseline: input.incrementalBaseline,
    });
    const readTrace = async () => {
      try {
        return (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    const clearTrace = async () => writeFile(tracePath, "", "utf8");

    await clearTrace();
    const initial = await read();
    assert.equal(initial.outcome, "changed");
    if (initial.outcome !== "changed") return;
    assert.deepEqual(catFileBlobs(await readTrace()), [initialChangeOid, initialDeleteOid, initialKeepOid].sort());
    assert.deepEqual(initial.files.map((file) => file.path), ["src/change.ts", "src/delete.ts", "src/keep.ts"]);

    const baseline: GitDelegationBaseline = Object.freeze({
      runId: randomUUID(),
      frozenCommitSha: initialCommit,
      manifestFingerprint: "b".repeat(64),
      publishedAt: new Date(),
      repositoryPath: "org/repository",
      files: initial.files,
    });

    const tokenConnection: DelegatedConnection = {
      ...connection,
      authKind: "token",
      credentialId: randomUUID(),
      credential: { secretFingerprint: "c".repeat(64) },
    };
    let credentialDbAccesses = 0;
    const credentialDbTrap = new Proxy({}, {
      get: () => {
        credentialDbAccesses += 1;
        throw new Error("UNEXPECTED_GIT_CREDENTIAL_DATABASE_ACCESS");
      },
    }) as PrismaClient;
    let injectedCredentialLoads = 0;
    await clearTrace();
    const injectedCredentialRead = await read({
      connection: tokenConnection,
      db: credentialDbTrap,
      loadCredentialSecret: async () => {
        injectedCredentialLoads += 1;
        const encoded = encodeGitCredential("token", "local-test-token-123");
        return encoded;
      },
    });
    assert.equal(injectedCredentialRead.outcome, "changed");
    assert.equal(injectedCredentialLoads, 1);
    assert.equal(credentialDbAccesses, 0);

    let deniedCredentialLoads = 0;
    await clearTrace();
    await assert.rejects(
      () => read({
        connection: tokenConnection,
        db: credentialDbTrap,
        onDispatchBoundary: async () => false,
        loadCredentialSecret: async () => {
          deniedCredentialLoads += 1;
          return encodeGitCredential("token", "local-test-token-123");
        },
      }),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_VERIFIED",
    );
    assert.equal(deniedCredentialLoads, 0);
    assert.equal(credentialDbAccesses, 0);
    assert.deepEqual(await readTrace(), []);

    await assert.rejects(
      () => read({
        connection: tokenConnection,
        db: credentialDbTrap,
        onBeforeCredentialRead: async () => false,
        loadCredentialSecret: async () => {
          deniedCredentialLoads += 1;
          return encodeGitCredential("token", "local-test-token-123");
        },
      }),
      (error: unknown) => error instanceof GitRunnerError && error.code === "GIT_REQUEST_BOUNDARY_REJECTED",
    );
    assert.equal(deniedCredentialLoads, 0);
    assert.equal(credentialDbAccesses, 0);

    await assert.rejects(
      () => read({
        connection: tokenConnection,
        db: credentialDbTrap,
        loadCredentialSecret: async () => 42 as unknown as string,
      }),
      (error: unknown) => error instanceof Error && error.message === "GIT_CREDENTIAL_INVALID",
    );
    assert.equal(credentialDbAccesses, 0);
    assert.equal((await readTrace()).some((command) => /\b(?:ls-remote|fetch|ls-tree|cat-file)\b/u.test(command)), false);

    await clearTrace();
    const unchanged = await read({ unchangedIfCommitSha: initialCommit, incrementalBaseline: baseline });
    assert.equal(unchanged.outcome, "unchanged");
    const unchangedCommands = await readTrace();
    assert.equal(unchangedCommands.filter((command) => command.includes(" ls-remote ")).length, 1);
    assert.equal(unchangedCommands.some((command) => /\b(?:fetch|ls-tree|cat-file)\b/u.test(command)), false);

    await writeFile(join(worktree, "src/change.ts"), "export const changed = 'after';\n", "utf8");
    await rm(join(worktree, "src/delete.ts"));
    await writeFile(join(worktree, "src/new.ts"), "export const added = 'new';\n", "utf8");
    git(realGit, ["add", "-A", "src"], worktree);
    git(realGit, ["commit", "-m", "changed"], worktree);
    execFileSync(realGit, ["push", "origin", "main"], { cwd: worktree, stdio: "ignore" });
    const changedCommit = git(realGit, ["rev-parse", "HEAD"], worktree);
    const changedOid = git(realGit, ["rev-parse", "HEAD:src/change.ts"], worktree);
    const newOid = git(realGit, ["rev-parse", "HEAD:src/new.ts"], worktree);

    await clearTrace();
    const incremental = await read({ unchangedIfCommitSha: initialCommit, incrementalBaseline: baseline });
    assert.equal(incremental.outcome, "changed");
    if (incremental.outcome !== "changed") return;
    assert.equal(incremental.commitSha, changedCommit);
    assert.deepEqual(incremental.files.map((file) => file.path), ["src/change.ts", "src/keep.ts", "src/new.ts"]);
    assert.deepEqual(catFileBlobs(await readTrace()), [changedOid, newOid].sort());

    await clearTrace();
    const full = await read();
    assert.equal(full.outcome, "changed");
    if (full.outcome !== "changed") return;
    assert.deepEqual(fileProjection(incremental.files), fileProjection(full.files));
    assert.equal(catFileBlobs(await readTrace()).length, 3);

    await clearTrace();
    const filteredIncremental = await read({
      unchangedIfCommitSha: initialCommit,
      incrementalBaseline: baseline,
      softExcludePatterns: ["src/keep.ts"],
    });
    assert.equal(filteredIncremental.outcome, "changed");
    if (filteredIncremental.outcome !== "changed") return;
    assert.deepEqual(catFileBlobs(await readTrace()), [changedOid, newOid].sort());
    await clearTrace();
    const filteredFull = await read({ softExcludePatterns: ["src/keep.ts"] });
    assert.equal(filteredFull.outcome, "changed");
    if (filteredFull.outcome !== "changed") return;
    assert.deepEqual(fileProjection(filteredIncremental.files), fileProjection(filteredFull.files));
    assert.equal(catFileBlobs(await readTrace()).length, 2);
    assert.equal(filteredIncremental.files.some((file) => file.path === "src/delete.ts"), false);

    const corruptBaseline: GitDelegationBaseline = Object.freeze({
      ...baseline,
      files: Object.freeze(baseline.files.map((file) => file.path === "src/keep.ts"
        ? Object.freeze({
            ...file,
            contentText: "corrupt baseline text",
            contentHash: createHash("sha256").update("corrupt baseline text", "utf8").digest("hex"),
            contentBytes: Buffer.byteLength("corrupt baseline text", "utf8"),
            lineCount: 1,
          })
        : file)),
    });
    await clearTrace();
    const invalidBaselineFallback = await read({ unchangedIfCommitSha: initialCommit, incrementalBaseline: corruptBaseline });
    assert.equal(invalidBaselineFallback.outcome, "changed");
    if (invalidBaselineFallback.outcome !== "changed") return;
    assert.deepEqual(fileProjection(invalidBaselineFallback.files), fileProjection(full.files));
    assert.deepEqual(catFileBlobs(await readTrace()), ["src/keep.ts", "src/change.ts", "src/new.ts"].map((path) => git(realGit, ["rev-parse", `HEAD:${path}`], worktree)).sort());

    await clearTrace();
    await assert.rejects(
      () => read({ incrementalBaseline: baseline, onDispatchBoundary: async () => false }),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_VERIFIED",
    );
    assert.deepEqual(await readTrace(), []);

    await clearTrace();
    let credentialBoundaryCalls = 0;
    let externalBoundaryCalls = 0;
    const afterRemoteError = await captureRejection(
      () => read({
        unchangedIfCommitSha: initialCommit,
        incrementalBaseline: baseline,
        onBeforeCredentialRead: async () => { credentialBoundaryCalls += 1; return true; },
        onBeforeExternalRequest: async () => { externalBoundaryCalls += 1; return externalBoundaryCalls <= 2; },
      }),
    );
    assert.ok(afterRemoteError instanceof GitRunnerError && afterRemoteError.code === "GIT_REQUEST_BOUNDARY_REJECTED");
    const revokedBetweenRemoteRequests = await readTrace();
    assert.equal(credentialBoundaryCalls, 1);
    assert.equal(externalBoundaryCalls, 3);
    assert.equal(revokedBetweenRemoteRequests.some((command) => command.includes(" ls-remote ")), true);
    assert.equal(revokedBetweenRemoteRequests.some((command) => /\b(?:fetch|ls-tree|cat-file)\b/u.test(command)), false);
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(afterRemoteError), false);

    await clearTrace();
    let postRemoteSafetyChecks = 0;
    const postRemoteSafetyError = await captureRejection(() => read({
      unchangedIfCommitSha: initialCommit,
      incrementalBaseline: baseline,
      onBeforeExternalRequest: async () => {
        postRemoteSafetyChecks += 1;
        if (postRemoteSafetyChecks === 3) throw new GitSafetyError("GIT_HOST_UNRESOLVED");
        return true;
      },
    }));
    assert.ok(postRemoteSafetyError instanceof GitSafetyError && postRemoteSafetyError.code === "GIT_HOST_UNRESOLVED");
    assert.equal(postRemoteSafetyChecks, 3);
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(postRemoteSafetyError), false);
    const postRemoteSafetyTrace = await readTrace();
    assert.equal(postRemoteSafetyTrace.some((command) => command.includes(" ls-remote ")), true);
    assert.equal(postRemoteSafetyTrace.some((command) => /\b(?:fetch|ls-tree|cat-file)\b/u.test(command)), false);

    await clearTrace();
    let firstRequestBoundaryCalls = 0;
    const beforeFirstRemoteError = await captureRejection(
      () => read({
        onBeforeCredentialRead: async () => true,
        onBeforeExternalRequest: async () => { firstRequestBoundaryCalls += 1; return false; },
      }),
    );
    assert.ok(beforeFirstRemoteError instanceof GitRunnerError && beforeFirstRemoteError.code === "GIT_REQUEST_BOUNDARY_REJECTED");
    assert.equal(firstRequestBoundaryCalls, 1);
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(beforeFirstRemoteError), true);
    assert.equal((await readTrace()).some((command) => /\b(?:ls-remote|fetch|ls-tree|cat-file)\b/u.test(command)), false);

    await clearTrace();
    await assert.rejects(
      () => read({
        unchangedIfCommitSha: initialCommit,
        incrementalBaseline: baseline,
        onBeforeExternalRequest: async () => true,
        pinnedResolution: { ...pinnedResolution, fingerprint: "f".repeat(64) },
      }),
      (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_NETWORK_CHANGED",
    );
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(new GitSafetyError("GIT_NETWORK_CHANGED")), false);
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(new GitSafetyError("GIT_HOST_UNRESOLVED")), true);
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(new GitSafetyError("GIT_NETWORK_BLOCKED")), true);
    assert.equal((await readTrace()).some((command) => /\b(?:ls-remote|fetch|ls-tree|cat-file)\b/u.test(command)), false);

    await clearTrace();
    let releaseExternalBoundary!: () => void;
    let markExternalBoundaryStarted!: () => void;
    const externalBoundaryStarted = new Promise<void>((resolve) => { markExternalBoundaryStarted = resolve; });
    const externalBoundaryRelease = new Promise<void>((resolve) => { releaseExternalBoundary = resolve; });
    const boundaryAbort = new AbortController();
    const boundaryRead = captureRejection(() => read({
      signal: boundaryAbort.signal,
      onBeforeExternalRequest: async () => {
        markExternalBoundaryStarted();
        await externalBoundaryRelease;
        return true;
      },
    }));
    await externalBoundaryStarted;
    boundaryAbort.abort();
    releaseExternalBoundary();
    const boundaryAbortError = await boundaryRead;
    assert.ok(boundaryAbortError instanceof GitRunnerError && boundaryAbortError.code === "GIT_OPERATION_ABORTED");
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(boundaryAbortError), true);
    assert.equal((await readTrace()).some((command) => /\b(?:ls-remote|fetch|ls-tree|cat-file)\b/u.test(command)), false);

    await clearTrace();
    let releaseCredentialLoader!: () => void;
    let markCredentialLoaderStarted!: () => void;
    const credentialLoaderStarted = new Promise<void>((resolve) => { markCredentialLoaderStarted = resolve; });
    const credentialLoaderRelease = new Promise<void>((resolve) => { releaseCredentialLoader = resolve; });
    const credentialAbort = new AbortController();
    let credentialLoadsBeforeAbort = 0;
    const credentialAbortRead = captureRejection(() => read({
      connection: tokenConnection,
      db: credentialDbTrap,
      signal: credentialAbort.signal,
      loadCredentialSecret: async () => {
        credentialLoadsBeforeAbort += 1;
        markCredentialLoaderStarted();
        await credentialLoaderRelease;
        return encodeGitCredential("token", "local-test-token-123");
      },
    }));
    await credentialLoaderStarted;
    credentialAbort.abort();
    releaseCredentialLoader();
    const credentialAbortError = await credentialAbortRead;
    assert.ok(credentialAbortError instanceof GitRunnerError && credentialAbortError.code === "GIT_OPERATION_ABORTED");
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(credentialAbortError), true);
    assert.equal(credentialLoadsBeforeAbort, 1);
    assert.equal(credentialDbAccesses, 0);
    assert.equal((await readTrace()).some((command) => /\b(?:ls-remote|fetch|ls-tree|cat-file)\b/u.test(command)), false);

    await clearTrace();
    const preAborted = new AbortController();
    preAborted.abort();
    let preAbortDispatchCalls = 0;
    let preAbortCredentialFenceCalls = 0;
    let preAbortCredentialLoads = 0;
    const preAbortError = await captureRejection(() => read({
      connection: tokenConnection,
      db: credentialDbTrap,
      signal: preAborted.signal,
      onDispatchBoundary: async () => { preAbortDispatchCalls += 1; return true; },
      onBeforeCredentialRead: async () => { preAbortCredentialFenceCalls += 1; return true; },
      loadCredentialSecret: async () => {
        preAbortCredentialLoads += 1;
        return encodeGitCredential("token", "local-test-token-123");
      },
    }));
    assert.ok(preAbortError instanceof GitRunnerError && preAbortError.code === "GIT_OPERATION_ABORTED");
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(preAbortError), true);
    assert.equal(preAbortDispatchCalls, 0);
    assert.equal(preAbortCredentialFenceCalls, 0);
    assert.equal(preAbortCredentialLoads, 0);
    assert.equal(credentialDbAccesses, 0);
    assert.deepEqual(await readTrace(), []);

    const blockedPidPath = join(root, "blocked-fetch.pid");
    const blockedDescendantPidPath = join(root, "blocked-fetch.descendant-pid");
    const blockedDescendantMarkerPath = join(root, "blocked-fetch.descendant-marker");
    const blockedRepositoryPath = join(root, "blocked-fetch.repository-dir");
    const blockingChildScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(blockedDescendantMarkerPath)}, 'still-running'), 300)`)}], { stdio: "inherit" });`,
      `writeFileSync(${JSON.stringify(blockedDescendantPidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const blockingWrapper = [
      "#!/bin/bash",
      "set -euo pipefail",
      `trace_path=${shellQuote(tracePath)}`,
      `remote_url=${shellQuote(remoteUrl)}`,
      `real_git=${shellQuote(realGit)}`,
      'printf "%s\\n" "$*" >> "$trace_path"',
      'args=("$@")',
      'if [[ " ${args[*]} " == *" remote add origin "* ]]; then args[$((${#args[@]} - 1))]="$remote_url"; fi',
      'if [[ " ${args[*]} " == *" fetch "* ]]; then',
      '  for ((i=0; i<${#args[@]}; i++)); do',
      '    if [[ "${args[$i]}" == "-C" ]]; then',
      `      printf '%s\\n' "\${args[$((i + 1))]}" > ${shellQuote(blockedRepositoryPath)}`,
      "    fi",
      "  done",
      `  printf '%s\\n' "$$" > ${shellQuote(blockedPidPath)}`,
      `  exec ${shellQuote(process.execPath)} -e ${shellQuote(blockingChildScript)}`,
      "fi",
      "unset GIT_ALLOW_PROTOCOL",
      'exec "$real_git" "${args[@]}" 2>> "$trace_path.stderr"',
      "",
    ].join("\n");
    await writeFile(shimPath, blockingWrapper, { encoding: "utf8", mode: 0o700 });
    await chmod(shimPath, 0o700);
    await clearTrace();
    const inFlightAbort = new AbortController();
    const inFlightRead = captureRejection(() => read({ signal: inFlightAbort.signal }));
    const blockedPid = Number((await waitForFileContents(blockedPidPath)).trim());
    assert.ok(Number.isInteger(blockedPid) && blockedPid > 0);
    activeProcessGroupId = blockedPid;
    const blockedDescendantPid = Number((await waitForFileContents(blockedDescendantPidPath)).trim());
    const blockedRepositoryDir = (await waitForFileContents(blockedRepositoryPath)).trim();
    const blockedTempRoot = dirname(blockedRepositoryDir);
    assert.ok(Number.isInteger(blockedDescendantPid) && blockedDescendantPid > 0);
    inFlightAbort.abort();
    const inFlightAbortError = await inFlightRead;
    assert.ok(inFlightAbortError instanceof GitRunnerError && inFlightAbortError.code === "GIT_OPERATION_ABORTED");
    assert.equal(isDefinitelyPreDispatchGitSyncFailure(inFlightAbortError), false);
    const cancelledFetchCommands = await readTrace();
    assert.equal(cancelledFetchCommands.filter((command) => /\bfetch\b/u.test(command)).length, 1);
    assert.equal(cancelledFetchCommands.some((command) => /\b(?:rev-parse|ls-tree|cat-file)\b/u.test(command)), false);
    await waitForProcessExit(blockedPid);
    await waitForProcessExit(blockedDescendantPid);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await assert.rejects(() => access(blockedDescendantMarkerPath), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    await assert.rejects(() => access(blockedTempRoot), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  } catch (error) {
    const commands = await readFile(tracePath, "utf8").catch(() => "");
    const stderr = await readFile(`${tracePath}.stderr`, "utf8").catch(() => "");
    process.stderr.write(`Git incremental command trace:\n${commands}\nGit stderr:\n${stderr}\n`);
    throw error;
  } finally {
    if (activeProcessGroupId !== undefined && process.platform !== "win32") {
      try {
        process.kill(-activeProcessGroupId, "SIGKILL");
      } catch {
        // The expected abort path already stopped the whole group.
      }
    }
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
