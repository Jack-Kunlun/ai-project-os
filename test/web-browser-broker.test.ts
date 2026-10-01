import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebBrowserBrokerServer } from "../scripts/web-browser-broker";
import { createWebBrowserBrokerNonce, signWebBrowserBrokerRequest, type WebBrowserBrokerRequest } from "../src/lib/web-browser-broker-protocol";

const CERTIFICATE = readFileSync(join(process.cwd(), "test/fixtures/web-browser-origin-test-cert.pem.fixture"));
const PRIVATE_KEY = readFileSync(join(process.cwd(), "test/fixtures/web-browser-origin-test-key.pem.fixture"));
const IMAGE_DIGEST = `registry.example.test/team/web-browser@sha256:${"a".repeat(64)}`;

function job(projectId: string = randomUUID()): WebBrowserBrokerRequest {
  return { jobId: randomUUID(), projectId, sourceId: randomUUID(), revisionId: randomUUID(), url: "https://source.example/private", expectedNetworkFingerprint: "b".repeat(64) };
}

async function send(port: number, key: Buffer, value: unknown, signed = true, signal?: AbortSignal, path = "/v1/render"): Promise<{ status: number; value: Record<string, unknown> }> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const timestamp = Date.now();
  const nonce = createWebBrowserBrokerNonce();
  const signature = signWebBrowserBrokerRequest(key, body, timestamp, nonce);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1", port, path, method: "POST", rejectUnauthorized: false, signal,
      headers: {
        "content-type": "application/json", "content-length": String(body.length),
        ...(signed ? { "x-aipos-timestamp": String(timestamp), "x-aipos-nonce": nonce, "x-aipos-signature": signature } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("broker rejects unsigned requests and duplicate job IDs while returning only bounded result fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-test-"));
  const key = randomBytes(32);
  const server = createWebBrowserBrokerServer({
    certificate: CERTIFICATE, privateKey: PRIVATE_KEY, sharedKey: key,
    ledgerDirectory: directory, imageDigest: IMAGE_DIGEST,
    runJob: async (request) => ({
      jobId: request.jobId, url: request.url, text: "Rendered private text",
      networkFingerprint: "b".repeat(64), imageDigest: IMAGE_DIGEST,
    }),
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert(address && typeof address !== "string");
    const value = job();
    assert.equal((await send(address.port, key, value)).status, 503);
    server.markReady();
    assert.equal((await send(address.port, key, value, false)).status, 401);
    const accepted = await send(address.port, key, value);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.value.jobId, value.jobId);
    assert.equal(accepted.value.text, "Rendered private text");
    assert.equal((await send(address.port, key, value)).status, 409);
  } finally {
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("broker cancellation waits for active cleanup and fences queued or late jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-cancel-test-"));
  const key = randomBytes(32);
  let started = false;
  let cleaned = false;
  const server = createWebBrowserBrokerServer({
    certificate: CERTIFICATE, privateKey: PRIVATE_KEY, sharedKey: key,
    ledgerDirectory: directory, imageDigest: IMAGE_DIGEST,
    runJob: async (request, signal) => {
      started = true;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
      cleaned = true;
      throw new Error(`cancelled ${request.jobId}`);
    },
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.markReady();
    const address = server.address();
    assert(address && typeof address !== "string");
    const active = job();
    const queued = job();
    const late = job();
    assert.equal((await send(address.port, key, { jobIds: [late.jobId] }, false, undefined, "/v1/cancel")).status, 401);
    const activeResponse = send(address.port, key, active);
    for (let attempt = 0; attempt < 100 && !started; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(started, true);
    const queuedResponse = send(address.port, key, queued);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancellation = { jobIds: [active.jobId, queued.jobId, late.jobId] };
    assert.equal((await send(address.port, key, cancellation, true, undefined, "/v1/cancel")).status, 200);
    assert.equal(cleaned, true, "cancel ACK must follow runner cleanup");
    assert.equal((await activeResponse).status, 502);
    assert.equal((await queuedResponse).status, 503);
    assert.equal((await send(address.port, key, cancellation, true, undefined, "/v1/cancel")).status, 200);
    assert.equal((await send(address.port, key, active)).status, 409);
    assert.equal((await send(address.port, key, queued)).status, 409);
    assert.equal((await send(address.port, key, late)).status, 409);
  } finally {
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disconnecting a queued job preserves the next queued project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-disconnect-test-"));
  const key = randomBytes(32);
  let releaseFirst: (() => void) | undefined;
  const executed: string[] = [];
  const server = createWebBrowserBrokerServer({
    certificate: CERTIFICATE, privateKey: PRIVATE_KEY, sharedKey: key,
    ledgerDirectory: directory, imageDigest: IMAGE_DIGEST,
    runJob: async (request) => {
      executed.push(request.jobId);
      if (executed.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return { jobId: request.jobId, url: request.url, text: "done", networkFingerprint: "b".repeat(64), imageDigest: IMAGE_DIGEST };
    },
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.markReady();
    const address = server.address();
    assert(address && typeof address !== "string");
    const first = job();
    const canceled = job();
    const last = job();
    const firstPending = send(address.port, key, first);
    for (let attempt = 0; attempt < 100 && releaseFirst === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert(releaseFirst !== undefined);
    const controller = new AbortController();
    const canceledPending = send(address.port, key, canceled, true, controller.signal);
    const lastPending = send(address.port, key, last);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(canceledPending);
    releaseFirst();
    assert.equal((await firstPending).status, 200);
    assert.equal((await lastPending).status, 200);
    assert.equal(executed[0], first.jobId);
    assert.equal(executed.includes(last.jobId), true);
  } finally {
    releaseFirst?.();
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("broker prunes expired replay entries when the ledger reaches capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-ledger-test-"));
  const key = randomBytes(32);
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (let index = 0; index < 1000; index += 1) {
    const path = join(directory, randomUUID());
    await writeFile(path, "expired\n", { mode: 0o600 });
    await utimes(path, expired, expired);
  }
  const server = createWebBrowserBrokerServer({
    certificate: CERTIFICATE, privateKey: PRIVATE_KEY, sharedKey: key,
    ledgerDirectory: directory, imageDigest: IMAGE_DIGEST,
    runJob: async (request) => ({ jobId: request.jobId, url: request.url, text: "done", networkFingerprint: "b".repeat(64), imageDigest: IMAGE_DIGEST }),
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.markReady();
    const address = server.address();
    assert(address && typeof address !== "string");
    assert.equal((await send(address.port, key, job())).status, 200);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("broker admits only one active job per project and serializes independent projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-queue-test-"));
  const key = randomBytes(32);
  let releaseFirst: (() => void) | undefined;
  let running = 0;
  let peak = 0;
  const server = createWebBrowserBrokerServer({
    certificate: CERTIFICATE, privateKey: PRIVATE_KEY, sharedKey: key,
    ledgerDirectory: directory, imageDigest: IMAGE_DIGEST,
    runJob: async (request) => {
      running += 1;
      peak = Math.max(peak, running);
      if (releaseFirst === undefined) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      running -= 1;
      return { jobId: request.jobId, url: request.url, text: "done", networkFingerprint: "b".repeat(64), imageDigest: IMAGE_DIGEST };
    },
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.markReady();
    const address = server.address();
    assert(address && typeof address !== "string");
    const first = job();
    const firstPending = send(address.port, key, first);
    for (let attempt = 0; attempt < 100 && releaseFirst === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(releaseFirst !== undefined);
    assert.equal((await send(address.port, key, job(first.projectId))).status, 429);
    const secondPending = send(address.port, key, job());
    releaseFirst();
    assert.equal((await firstPending).status, 200);
    assert.equal((await secondPending).status, 200);
    assert.equal(peak, 1);
  } finally {
    releaseFirst?.();
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent admissions keep the broker queue at four jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-capacity-test-"));
  const key = randomBytes(32);
  let releaseFirst: (() => void) | undefined;
  let rejected = 0;
  const server = createWebBrowserBrokerServer({
    certificate: CERTIFICATE, privateKey: PRIVATE_KEY, sharedKey: key,
    ledgerDirectory: directory, imageDigest: IMAGE_DIGEST,
    runJob: async (request) => {
      if (releaseFirst === undefined) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return { jobId: request.jobId, url: request.url, text: "done", networkFingerprint: "b".repeat(64), imageDigest: IMAGE_DIGEST };
    },
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.markReady();
    const address = server.address();
    assert(address && typeof address !== "string");
    const firstPending = send(address.port, key, job());
    for (let attempt = 0; attempt < 100 && releaseFirst === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert(releaseFirst !== undefined);
    const concurrent = Array.from({ length: 8 }, () => send(address.port, key, job()).then((result) => {
      if (result.status === 429) rejected += 1;
      return result;
    }));
    for (let attempt = 0; attempt < 500 && rejected < 4; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(rejected, 4);
    releaseFirst();
    assert.equal((await firstPending).status, 200);
    const responses = await Promise.all(concurrent);
    assert.equal(responses.filter((result) => result.status === 200).length, 4);
    assert.equal(responses.filter((result) => result.status === 429).length, 4);
  } finally {
    releaseFirst?.();
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
