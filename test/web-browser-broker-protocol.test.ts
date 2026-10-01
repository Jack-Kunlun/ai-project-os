import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWebBrowserBrokerNonce,
  parseWebBrowserBrokerCancellation,
  parseWebBrowserBrokerRequest,
  parseWebBrowserBrokerResult,
  readWebBrowserBrokerKey,
  readPrivateWebBrowserBrokerFile,
  signWebBrowserBrokerRequest,
  verifyWebBrowserBrokerRequestSignature,
} from "../src/lib/web-browser-broker-protocol";

const IMAGE_DIGEST = `registry.example.test/team/web-browser@sha256:${"a".repeat(64)}`;

function request(siteForm?: Record<string, string>) {
  return {
    jobId: randomUUID(), projectId: randomUUID(), sourceId: randomUUID(), revisionId: randomUUID(),
    url: "https://source.example/private", expectedNetworkFingerprint: "b".repeat(64),
    ...(siteForm === undefined ? {} : { siteForm }),
  };
}

test("broker request accepts only source-bound URLs and a restricted same-origin login form", () => {
  const siteForm = {
    loginUrl: "https://source.example/login", submitUrl: "https://source.example/login/submit",
    usernameSelector: 'input[name="username"]', passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]', successSelector: "#signed-in",
    username: "fixture-user", password: "fixture-password",
  };
  const valid = request(siteForm);
  assert.deepEqual(parseWebBrowserBrokerRequest(valid), valid);
  for (const invalid of [
    { ...valid, dockerArgs: ["--privileged"] },
    { ...valid, jobId: "not-a-uuid" },
    { ...valid, expectedNetworkFingerprint: "not-a-fingerprint" },
    { ...valid, siteForm: { ...siteForm, submitUrl: "https://other.example/post" } },
    { ...valid, siteForm: { ...siteForm, passwordSelector: "input:has-text(secret)" } },
  ]) assert.throws(() => parseWebBrowserBrokerRequest(invalid));
});

test("broker cancellation accepts only a bounded unique set of job IDs", () => {
  const jobIds = [randomUUID(), randomUUID()];
  assert.deepEqual(parseWebBrowserBrokerCancellation({ jobIds }), { jobIds });
  for (const invalid of [
    { jobIds: [] },
    { jobIds: [jobIds[0], jobIds[0]] },
    { jobIds: ["not-a-uuid"] },
    { jobIds: Array.from({ length: 101 }, () => randomUUID()) },
    { jobIds, extra: true },
  ]) assert.throws(() => parseWebBrowserBrokerCancellation(invalid));
});

test("broker signature binds exact body, timestamp and nonce with a short clock window", () => {
  const key = randomBytes(32);
  const body = Buffer.from(JSON.stringify(request()), "utf8");
  const now = Date.now();
  const nonce = createWebBrowserBrokerNonce();
  const signature = signWebBrowserBrokerRequest(key, body, now, nonce);
  assert.equal(verifyWebBrowserBrokerRequestSignature(key, body, String(now), nonce, signature, now), true);
  assert.equal(verifyWebBrowserBrokerRequestSignature(key, Buffer.concat([body, Buffer.from(" ")]), String(now), nonce, signature, now), false);
  assert.equal(verifyWebBrowserBrokerRequestSignature(key, body, String(now - 30_001), nonce, signature, now), false);
  assert.equal(verifyWebBrowserBrokerRequestSignature(key, body, String(now), createWebBrowserBrokerNonce(), signature, now), false);
  assert.equal(verifyWebBrowserBrokerRequestSignature(key, body, String(now), nonce, "0".repeat(64), now), false);
});

test("broker result binds job, digest, bounded text and network evidence", () => {
  const jobId = randomUUID();
  const valid = {
    jobId, url: "https://source.example/private", text: "Visible text",
    networkFingerprint: "b".repeat(64), imageDigest: IMAGE_DIGEST,
  };
  assert.deepEqual(parseWebBrowserBrokerResult(valid, jobId, IMAGE_DIGEST), valid);
  for (const invalid of [
    { ...valid, jobId: randomUUID() },
    { ...valid, imageDigest: "latest" },
    { ...valid, networkFingerprint: "not-a-fingerprint" },
    { ...valid, text: "" },
    { ...valid, text: "x".repeat(20_001) },
  ]) assert.throws(() => parseWebBrowserBrokerResult(invalid, jobId, IMAGE_DIGEST));
});

test("broker HMAC key must be a private canonical 32-byte file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-key-test-"));
  const keyPath = join(directory, "broker.key");
  const key = randomBytes(32);
  try {
    await writeFile(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600 });
    assert.deepEqual(await readWebBrowserBrokerKey(keyPath), key);
    await rm(keyPath);
    await writeFile(keyPath, key.toString("base64url"), { mode: 0o644 });
    await assert.rejects(() => readWebBrowserBrokerKey(keyPath));
    await rm(keyPath);
    await writeFile(join(directory, "original.key"), key.toString("base64url"), { mode: 0o600 });
    await symlink(join(directory, "original.key"), keyPath);
    await assert.rejects(() => readWebBrowserBrokerKey(keyPath));
    await assert.rejects(() => readPrivateWebBrowserBrokerFile(keyPath, 128));
    await rm(keyPath);
    await writeFile(keyPath, key.toString("base64url"), { mode: 0o600 });
    await chmod(directory, 0o777);
    await assert.rejects(() => readWebBrowserBrokerKey(keyPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
