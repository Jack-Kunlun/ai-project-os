import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import type { GitAuthKind, GitTransport } from "@prisma/client";
import type { GitCredentialPayload } from "./credentials";

const MAX_COMMAND_OUTPUT_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export type GitRunnerErrorCode =
  | "GIT_EXECUTABLE_UNAVAILABLE"
  | "GIT_REMOTE_UNAVAILABLE"
  | "GIT_AUTHENTICATION_FAILED"
  | "GIT_HOST_KEY_REJECTED"
  | "GIT_OPERATION_TIMEOUT"
  | "GIT_OPERATION_ABORTED"
  | "GIT_OUTPUT_TOO_LARGE"
  | "GIT_OPERATION_FAILED"
  | "GIT_REQUEST_BOUNDARY_REJECTED";

export class GitRunnerError extends Error {
  constructor(readonly code: GitRunnerErrorCode) {
    super(code);
    this.name = "GitRunnerError";
  }
}

function failureCode(stderr: string, fallback: GitRunnerErrorCode): GitRunnerErrorCode {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("authentication failed") || normalized.includes("permission denied") || normalized.includes("could not read username")) {
    return "GIT_AUTHENTICATION_FAILED";
  }
  if (normalized.includes("host key verification failed") || normalized.includes("no matching host key")) {
    return "GIT_HOST_KEY_REJECTED";
  }
  if (normalized.includes("could not resolve host") || normalized.includes("connection refused") || normalized.includes("repository not found")) {
    return "GIT_REMOTE_UNAVAILABLE";
  }
  return fallback;
}

async function runGitBytes(input: Readonly<{
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new GitRunnerError("GIT_OPERATION_ABORTED"));
      return;
    }
    let settled = false;
    let abortRequested = false;
    let stopRequested = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // Cancellation-capable POSIX invocations get their own process group so
    // Git transport helpers such as ssh cannot outlive the Git process.
    // Windows keeps Node's direct-child kill behavior as a safe fallback.
    const useDedicatedProcessGroup = input.signal !== undefined && process.platform !== "win32";
    const child = spawn("git", [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: useDedicatedProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    };
    const rejectOnce = (error: GitRunnerError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const killChild = () => {
      stopRequested = true;
      if (useDedicatedProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to the direct child if the group is already gone or
          // group signaling is unavailable in the current POSIX environment.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already have exited; its error/close events settle it.
      }
    };
    const abort = () => {
      if (settled || abortRequested) return;
      abortRequested = true;
      killChild();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      killChild();
      rejectOnce(new GitRunnerError("GIT_OPERATION_TIMEOUT"));
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const append = (target: Buffer[], chunk: Buffer) => {
      if (settled || abortRequested) return;
      outputBytes += chunk.length;
      if (outputBytes > (input.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES)) {
        killChild();
        rejectOnce(new GitRunnerError("GIT_OUTPUT_TOO_LARGE"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("spawn", () => {
      // An abort can race with process creation. Repeat the kill after spawn
      // if the earlier kill ran before the child had a PID.
      if (stopRequested) killChild();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (abortRequested) rejectOnce(new GitRunnerError("GIT_OPERATION_ABORTED"));
      else rejectOnce(new GitRunnerError(error.code === "ENOENT" ? "GIT_EXECUTABLE_UNAVAILABLE" : "GIT_OPERATION_FAILED"));
    });
    child.on("exit", () => {
      // The process has stopped even if a descendant still holds one of the
      // pipes open. Finish the cancelled command while the group kill handles
      // those descendants.
      if (abortRequested) rejectOnce(new GitRunnerError("GIT_OPERATION_ABORTED"));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (abortRequested) {
        rejectOnce(new GitRunnerError("GIT_OPERATION_ABORTED"));
        return;
      }
      settled = true;
      cleanup();
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new GitRunnerError(failureCode(Buffer.concat(stderr).toString("utf8").slice(0, 4096), "GIT_OPERATION_FAILED")));
    });
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitRunnerError("GIT_OPERATION_ABORTED");
}

async function configureWorkspace(input: Readonly<{
  root: string;
  transport: GitTransport;
  authKind: GitAuthKind;
  username: string | null;
  credential: GitCredentialPayload | null;
  tlsCaCertificate: string | null;
  sshKnownHost: string | null;
  pinnedEndpoint: Readonly<{ hostname: string; port: string; addresses: readonly string[] }>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ env: NodeJS.ProcessEnv; gitConfigArgs: readonly string[] }>> {
  const home = join(input.root, "home");
  await mkdir(home, { mode: 0o700 });
  throwIfAborted(input.signal);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ALLOW_PROTOCOL: input.transport,
  };
  if (input.transport === "https") {
    if (input.tlsCaCertificate !== null) {
      const caPath = join(input.root, "ca.pem");
      await writeFile(caPath, input.tlsCaCertificate, { encoding: "utf8", mode: 0o600 });
      throwIfAborted(input.signal);
      env.GIT_SSL_CAINFO = caPath;
    }
    if (input.credential !== null) {
      const askPassPath = join(input.root, "askpass.sh");
      await writeFile(askPassPath, [
        "#!/bin/sh",
        "case \"$1\" in",
        "  *Username*) printf '%s\\n' \"$AI_PROJECT_OS_GIT_USERNAME\" ;;",
        "  *) printf '%s\\n' \"$AI_PROJECT_OS_GIT_SECRET\" ;;",
        "esac",
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o700 });
      throwIfAborted(input.signal);
      await chmod(askPassPath, 0o700);
      throwIfAborted(input.signal);
      env.GIT_ASKPASS = askPassPath;
      env.GIT_ASKPASS_REQUIRE = "force";
      env.AI_PROJECT_OS_GIT_USERNAME = input.username ?? (input.credential.authKind === "token" ? "oauth2" : "git");
      env.AI_PROJECT_OS_GIT_SECRET = input.credential.authKind === "token"
        ? input.credential.token
        : input.credential.authKind === "basic"
          ? input.credential.password
          : "";
    }
    const addresses = input.pinnedEndpoint.addresses.map((address) => isIP(address) === 6 ? `[${address}]` : address).join(",");
    return Object.freeze({
      env,
      gitConfigArgs: Object.freeze([
        "-c", `http.curloptResolve=${input.pinnedEndpoint.hostname}:${input.pinnedEndpoint.port}:${addresses}`,
        "-c", "http.followRedirects=false",
      ]),
    });
  } else {
    if (input.credential?.authKind !== "sshKey" || input.sshKnownHost === null) {
      throw new GitRunnerError("GIT_AUTHENTICATION_FAILED");
    }
    const keyPath = join(input.root, "id_git");
    const knownHostsPath = join(input.root, "known_hosts");
    await writeFile(keyPath, input.credential.privateKey, { encoding: "utf8", mode: 0o600 });
    throwIfAborted(input.signal);
    await writeFile(knownHostsPath, `${input.sshKnownHost}\n`, { encoding: "utf8", mode: 0o600 });
    throwIfAborted(input.signal);
    await chmod(keyPath, 0o600);
    throwIfAborted(input.signal);
    const pinnedAddress = input.pinnedEndpoint.addresses[0];
    if (pinnedAddress === undefined) throw new GitRunnerError("GIT_REMOTE_UNAVAILABLE");
    env.GIT_SSH_COMMAND = `/usr/bin/ssh -F /dev/null -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsPath} -o HostKeyAlias=${input.pinnedEndpoint.hostname} -o HostName=${pinnedAddress} -o ConnectTimeout=15`;
  }
  return Object.freeze({ env, gitConfigArgs: Object.freeze([]) });
}

export function gitRemoteUrl(baseUrl: string, repositoryPath: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  return `${base}/${repositoryPath}.git`;
}

export async function withGitRunner<T>(input: Readonly<{
  transport: GitTransport;
  authKind: GitAuthKind;
  username: string | null;
  credential: GitCredentialPayload | null;
  /** Load a saved credential only after the caller's final admission fence. */
  credentialLoader?: () => Promise<GitCredentialPayload | null>;
  onBeforeCredentialRead?: () => void | boolean | Promise<void | boolean>;
  /** Re-check the database fence immediately before every Git process starts. */
  onBeforeRequest?: () => void | boolean | Promise<void | boolean>;
  signal?: AbortSignal;
  tlsCaCertificate: string | null;
  sshKnownHost: string | null;
  pinnedEndpoint: Readonly<{ hostname: string; port: string; addresses: readonly string[] }>;
}>, operation: (runner: Readonly<{
  root: string;
  runText(args: readonly string[], options?: Readonly<{ cwd?: string; timeoutMs?: number; maxOutputBytes?: number }>): Promise<string>;
  runBytes(args: readonly string[], options?: Readonly<{ cwd?: string; timeoutMs?: number; maxOutputBytes?: number }>): Promise<Buffer>;
}>) => Promise<T>): Promise<T> {
  throwIfAborted(input.signal);
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-git-"));
  try {
    throwIfAborted(input.signal);
    let credential = input.credential;
    if (input.credentialLoader !== undefined) {
      throwIfAborted(input.signal);
      const accepted = await input.onBeforeCredentialRead?.() ?? true;
      throwIfAborted(input.signal);
      if (!accepted) throw new GitRunnerError("GIT_REQUEST_BOUNDARY_REJECTED");
      credential = await input.credentialLoader();
      throwIfAborted(input.signal);
    }
    const { env, gitConfigArgs } = await configureWorkspace({
      root,
      transport: input.transport,
      authKind: input.authKind,
      username: input.username,
      credential,
      tlsCaCertificate: input.tlsCaCertificate,
      sshKnownHost: input.sshKnownHost,
      pinnedEndpoint: input.pinnedEndpoint,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    const runBytes = async (args: readonly string[], options: Readonly<{ cwd?: string; timeoutMs?: number; maxOutputBytes?: number }> = {}) => {
      throwIfAborted(input.signal);
      const accepted = await input.onBeforeRequest?.() ?? true;
      throwIfAborted(input.signal);
      if (!accepted) throw new GitRunnerError("GIT_REQUEST_BOUNDARY_REJECTED");
      return runGitBytes({ args: [...gitConfigArgs, ...args], cwd: options.cwd ?? root, env, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, signal: input.signal });
    };
    const result = await operation({
      root,
      runBytes,
      runText: async (args, options) => (await runBytes(args, options)).toString("utf8"),
    });
    throwIfAborted(input.signal);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
