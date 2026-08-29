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
  | "GIT_OUTPUT_TOO_LARGE"
  | "GIT_OPERATION_FAILED";

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
}>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn("git", [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new GitRunnerError("GIT_OPERATION_TIMEOUT"));
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const append = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > (input.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES)) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGKILL");
        reject(new GitRunnerError("GIT_OUTPUT_TOO_LARGE"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new GitRunnerError(error.code === "ENOENT" ? "GIT_EXECUTABLE_UNAVAILABLE" : "GIT_OPERATION_FAILED"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new GitRunnerError(failureCode(Buffer.concat(stderr).toString("utf8").slice(0, 4096), "GIT_OPERATION_FAILED")));
    });
  });
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
}>): Promise<Readonly<{ env: NodeJS.ProcessEnv; gitConfigArgs: readonly string[] }>> {
  const home = join(input.root, "home");
  await mkdir(home, { mode: 0o700 });
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
      await chmod(askPassPath, 0o700);
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
        "-c", `http.curloptResolve=+${input.pinnedEndpoint.hostname}:${input.pinnedEndpoint.port}:${addresses}`,
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
    await writeFile(knownHostsPath, `${input.sshKnownHost}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(keyPath, 0o600);
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
  tlsCaCertificate: string | null;
  sshKnownHost: string | null;
  pinnedEndpoint: Readonly<{ hostname: string; port: string; addresses: readonly string[] }>;
}>, operation: (runner: Readonly<{
  root: string;
  runText(args: readonly string[], options?: Readonly<{ cwd?: string; timeoutMs?: number; maxOutputBytes?: number }>): Promise<string>;
  runBytes(args: readonly string[], options?: Readonly<{ cwd?: string; timeoutMs?: number; maxOutputBytes?: number }>): Promise<Buffer>;
}>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-git-"));
  try {
    const { env, gitConfigArgs } = await configureWorkspace({ root, ...input });
    const runBytes = (args: readonly string[], options: Readonly<{ cwd?: string; timeoutMs?: number; maxOutputBytes?: number }> = {}) =>
      runGitBytes({ args: [...gitConfigArgs, ...args], cwd: options.cwd ?? root, env, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes });
    return await operation({
      root,
      runBytes,
      runText: async (args, options) => (await runBytes(args, options)).toString("utf8"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
