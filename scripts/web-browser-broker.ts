import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserResourceIdForJob,
  parseWebBrowserBrokerCancellation,
  parseWebBrowserBrokerRequest,
  parseWebBrowserBrokerResult,
  readPrivateWebBrowserBrokerFile,
  readWebBrowserBrokerKey,
  verifyWebBrowserBrokerRequestSignature,
  WEB_BROWSER_BROKER_MAX_REQUEST_BYTES,
  WEB_BROWSER_BROKER_MAX_RESPONSE_BYTES,
  type WebBrowserBrokerRequest,
  type WebBrowserBrokerResult,
} from "../src/lib/web-browser-broker-protocol";

const RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), "web-browser-one-shot.ts");
const MAX_PENDING = 4;
const MAX_LEDGER_FILES = 1000;
const LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;
const RUNNER_TIMEOUT_MS = 65_000;
const BROKER_PORT = 8443;

type BrokerJob = {
  request: WebBrowserBrokerRequest;
  response: ServerResponse;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
};

type Runner = (request: WebBrowserBrokerRequest, signal: AbortSignal) => Promise<WebBrowserBrokerResult>;
export type WebBrowserBrokerServer = HttpsServer & Readonly<{
  markReady(): void;
  shutdown(): Promise<void>;
}>;

function stableError(response: ServerResponse, status: number, code = "WEB_BROWSER_ISOLATION_UNAVAILABLE"): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify({ error: code }));
}

function stableSuccess(response: ServerResponse, result: WebBrowserBrokerResult): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify(result));
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

async function boundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > WEB_BROWSER_BROKER_MAX_REQUEST_BYTES) throw new Error("request-too-large");
    chunks.push(buffer);
  }
  if (bytes < 2) throw new Error("request-empty");
  return Buffer.concat(chunks);
}

async function prepareLedger(directory: string): Promise<void> {
  if (!isAbsolute(directory) || normalize(directory) !== directory) throw new Error("broker-ledger-invalid");
  const parent = await lstat(dirname(directory));
  const metadata = await lstat(directory);
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 || ![0, process.getuid?.()].includes(parent.uid)) {
    throw new Error("broker-ledger-insecure");
  }
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
    throw new Error("broker-ledger-insecure");
  }
  if ((await pruneExpiredLedgerEntries(directory, await readdir(directory))).length > MAX_LEDGER_FILES) throw new Error("broker-ledger-full");
}

async function pruneExpiredLedgerEntries(directory: string, entries: readonly string[]): Promise<string[]> {
  const now = Date.now();
  const retained: string[] = [];
  for (const name of entries) {
    if (!/^[0-9a-f-]{36}$/u.test(name)) throw new Error("broker-ledger-invalid");
    const path = join(directory, name);
    const item = await lstat(path);
    if (!item.isFile() || item.uid !== process.getuid?.() || (item.mode & 0o077) !== 0) throw new Error("broker-ledger-insecure");
    if (now - item.mtimeMs > LEDGER_RETENTION_MS) await unlink(path);
    else retained.push(name);
  }
  return retained;
}

async function recordJobId(directory: string, id: string): Promise<boolean> {
  const entries = await readdir(directory);
  if (entries.length >= MAX_LEDGER_FILES && (await pruneExpiredLedgerEntries(directory, entries)).length >= MAX_LEDGER_FILES) return false;
  try {
    const handle = await open(join(directory, id), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${Date.now()}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") return false;
    throw error;
  }
}

async function reserveCancellation(directory: string, id: string): Promise<void> {
  if (await recordJobId(directory, id)) return;
  const item = await lstat(join(directory, id));
  if (!item.isFile() || item.uid !== process.getuid?.() || (item.mode & 0o077) !== 0) throw new Error("broker-ledger-insecure");
}

function runnerEnvironment(imageDigest: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: "production",
    AI_PROJECT_OS_WEB_BROWSER_MODE: "pinned",
    AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: imageDigest,
  };
}

function runFixedRunner(args: readonly string[], input: string | null, imageDigest: string, signal?: AbortSignal, timeoutMs = RUNNER_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER_PATH, ...args], {
      cwd: dirname(dirname(RUNNER_PATH)),
      env: runnerEnvironment(imageDigest),
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(output.trim());
    };
    const signalGroup = (name: NodeJS.Signals) => {
      try { if (child.pid !== undefined) process.kill(-child.pid, name); }
      catch { child.kill(name); }
    };
    const abort = () => {
      signalGroup("SIGTERM");
      if (forceKill === undefined) forceKill = setTimeout(() => signalGroup("SIGKILL"), 5_000);
    };
    const timeout = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > WEB_BROWSER_BROKER_MAX_RESPONSE_BYTES) { child.kill("SIGTERM"); return; }
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(new Error("runner-unavailable")));
    child.once("close", (code) => code === 0 && !signal?.aborted && outputBytes <= WEB_BROWSER_BROKER_MAX_RESPONSE_BYTES
      ? finish()
      : finish(new Error("runner-failed")));
    child.stdin.end(input ?? undefined);
  });
}

async function cleanupOrphanJobs(imageDigest: string): Promise<void> {
  const raw = await runFixedRunner(["--list-owned-jobs"], null, imageDigest, undefined, 30_000);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("orphan-list-invalid");
  const ids = (parsed as Record<string, unknown>).jobIds;
  if (!Array.isArray(ids) || ids.length > MAX_LEDGER_FILES || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{24}$/u.test(id))) {
    throw new Error("orphan-list-invalid");
  }
  for (const id of ids) await runFixedRunner([`--cleanup-owned-job=${id}`], null, imageDigest, undefined, 20_000);
}

function hostRunner(imageDigest: string): Runner {
  return async (request, signal) => {
    const resourceId = browserResourceIdForJob(request.jobId);
    try {
      const raw = await runFixedRunner([], `${JSON.stringify({ jobId: request.jobId, url: request.url, expectedNetworkFingerprint: request.expectedNetworkFingerprint, ...(request.siteForm === undefined ? {} : { siteForm: request.siteForm }) })}\n`, imageDigest, signal);
      const parsed: unknown = JSON.parse(raw);
      return parseWebBrowserBrokerResult({ ...(parsed as object), jobId: request.jobId }, request.jobId, imageDigest);
    } finally {
      await runFixedRunner([`--cleanup-owned-job=${resourceId}`], null, imageDigest, undefined, 20_000);
    }
  };
}

export function createWebBrowserBrokerServer(input: Readonly<{
  certificate: Buffer;
  privateKey: Buffer;
  sharedKey: Buffer;
  ledgerDirectory: string;
  imageDigest: string;
  runJob: Runner;
}>): WebBrowserBrokerServer {
  const queue: BrokerJob[] = [];
  let active: BrokerJob | null = null;
  let ready = false;
  let ledgerAdmission: Promise<void> = Promise.resolve();

  const drain = () => {
    if (active !== null || queue.length === 0 || !ready) return;
    const next = queue.shift()!;
    active = next;
    void input.runJob(next.request, next.controller.signal).then(
      (result) => next.controller.signal.aborted ? stableError(next.response, 503) : stableSuccess(next.response, result),
      () => stableError(next.response, 502),
    ).finally(() => { active = null; next.finish(); drain(); });
  };

  const server = createHttpsServer({ cert: input.certificate, key: input.privateKey, maxHeaderSize: 16 * 1024 }, (request, response) => {
    void (async () => {
      if (!ready) return stableError(response, 503);
      const cancellation = request.url === "/v1/cancel";
      if (request.method !== "POST" || (!cancellation && request.url !== "/v1/render") || singleHeader(request, "content-type") !== "application/json") {
        return stableError(response, 404);
      }
      if (!cancellation && active !== null && queue.length >= MAX_PENDING) return stableError(response, 429);
      let body: Buffer;
      try { body = await boundedBody(request); } catch { return stableError(response, 413); }
      if (!verifyWebBrowserBrokerRequestSignature(
        input.sharedKey, body,
        singleHeader(request, "x-aipos-timestamp"),
        singleHeader(request, "x-aipos-nonce"),
        singleHeader(request, "x-aipos-signature"),
      )) return stableError(response, 401);
      if (cancellation) {
        let jobIds: readonly string[];
        try { jobIds = parseWebBrowserBrokerCancellation(JSON.parse(body.toString("utf8"))).jobIds; }
        catch { return stableError(response, 400); }
        try {
          const reservation = ledgerAdmission.then(async () => {
            for (const id of jobIds) await reserveCancellation(input.ledgerDirectory, id);
            const targets = new Set(jobIds);
            const running = active !== null && targets.has(active.request.jobId) ? active : null;
            for (const job of [...queue]) {
              if (!targets.has(job.request.jobId)) continue;
              const index = queue.indexOf(job);
              if (index >= 0) queue.splice(index, 1);
              job.controller.abort();
              stableError(job.response, 503);
              job.finish();
            }
            running?.controller.abort();
            return running?.done;
          });
          ledgerAdmission = reservation.then(() => undefined, () => undefined);
          await (await reservation);
          if (!response.destroyed && !response.writableEnded) {
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            response.end('{"cancelled":true}');
          }
        } catch { return stableError(response, 503); }
        return;
      }
      let parsed: WebBrowserBrokerRequest;
      try { parsed = parseWebBrowserBrokerRequest(JSON.parse(body.toString("utf8"))); }
      catch { return stableError(response, 400); }
      try {
        const reservation = ledgerAdmission.then(async (): Promise<200 | 409 | 429 | 503> => {
          if (!ready) return 503;
          if (active !== null && queue.length >= MAX_PENDING) return 429;
          if (active?.request.projectId === parsed.projectId || queue.some((job) => job.request.projectId === parsed.projectId)) return 429;
          if (!await recordJobId(input.ledgerDirectory, parsed.jobId)) return 409;
          let finish!: () => void;
          const done = new Promise<void>((resolve) => { finish = resolve; });
          const job: BrokerJob = { request: parsed, response, controller: new AbortController(), done, finish };
          response.once("close", () => {
            if (response.writableEnded) return;
            job.controller.abort();
            const index = queue.indexOf(job);
            if (index >= 0) { queue.splice(index, 1); job.finish(); }
          });
          queue.push(job);
          drain();
          return 200;
        });
        ledgerAdmission = reservation.then(() => undefined, () => undefined);
        const status = await reservation;
        if (status !== 200) return stableError(response, status);
      }
      catch { return stableError(response, 503); }
    })().catch(() => stableError(response, 503));
  });
  server.maxHeadersCount = 32;
  server.on("clientError", (_error, socket) => socket.destroy());
  return Object.assign(server, {
    markReady: () => { ready = true; drain(); },
    shutdown: async () => {
      ready = false;
      active?.controller.abort();
      for (const job of queue.splice(0)) {
        job.controller.abort();
        stableError(job.response, 503);
        job.finish();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

async function main(): Promise<void> {
  if (process.getuid?.() === undefined || process.getuid?.() === 0) throw new Error("broker-user-invalid");
  const keyPath = process.env.AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE;
  const certPath = process.env.AI_PROJECT_OS_WEB_BROWSER_BROKER_CERT_FILE;
  const tlsKeyPath = process.env.AI_PROJECT_OS_WEB_BROWSER_BROKER_TLS_KEY_FILE;
  const ledgerDirectory = process.env.AI_PROJECT_OS_WEB_BROWSER_BROKER_LEDGER_DIR;
  const imageDigest = process.env.AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST;
  if (!keyPath || !certPath || !tlsKeyPath || !ledgerDirectory || !imageDigest || !/^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/u.test(imageDigest)) {
    throw new Error("broker-configuration-invalid");
  }
  const [certificate, privateKey, sharedKey] = await Promise.all([
    readFile(certPath), readPrivateWebBrowserBrokerFile(tlsKeyPath, 64 * 1024), readWebBrowserBrokerKey(keyPath),
  ]);
  const server = createWebBrowserBrokerServer({ certificate, privateKey, sharedKey, ledgerDirectory, imageDigest, runJob: hostRunner(imageDigest) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(BROKER_PORT, "0.0.0.0", resolve);
  });
  try {
    await prepareLedger(ledgerDirectory);
    await cleanupOrphanJobs(imageDigest);
    server.markReady();
  } catch (error) {
    await server.shutdown();
    throw error;
  }
  const stop = () => { void server.shutdown().then(() => { process.exitCode = 0; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  void main().catch(() => { process.exitCode = 1; });
}
