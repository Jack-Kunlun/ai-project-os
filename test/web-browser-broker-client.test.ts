import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callWebBrowserBroker, cancelWebBrowserBrokerJobs, webBrowserBrokerCancellationConfiguration, webBrowserBrokerConfiguration } from "../src/lib/web-browser-broker-client";
import { verifyWebBrowserBrokerRequestSignature } from "../src/lib/web-browser-broker-protocol";
import { securePinnedHttpRequest } from "../src/lib/web-sources";

const IMAGE_DIGEST = `registry.example.test/team/web-browser@sha256:${"a".repeat(64)}`;

test("broker client stays disabled without explicit operator configuration", () => {
  assert.throws(() => webBrowserBrokerConfiguration({}), { code: "WEB_SOURCE_AUTHENTICATED_DISABLED" });
  assert.throws(() => webBrowserBrokerConfiguration({ AI_PROJECT_OS_WEB_BROWSER_ENABLED: "1" }), { code: "WEB_SOURCE_FETCH_FAILED" });
});

test("signed cancellation works with rendering disabled and rejects an uncertain ACK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-cancel-client-test-"));
  const keyPath = join(directory, "broker.key");
  const key = randomBytes(32);
  await writeFile(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600 });
  try {
    const configuration = webBrowserBrokerCancellationConfiguration({
      AI_PROJECT_OS_WEB_BROWSER_ENABLED: "0",
      AI_PROJECT_OS_WEB_BROWSER_BROKER_URL: "https://broker.example/v1/render",
      AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE: keyPath,
      AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: IMAGE_DIGEST,
      AI_PROJECT_OS_WEB_BROWSER_BROKER_ALLOW_PRIVATE: "0",
    });
    const jobIds = [randomUUID()];
    const fakeRequest: typeof securePinnedHttpRequest = async (input) => {
      assert.equal(input.url, "https://broker.example/v1/cancel");
      assert.equal(input.requestTimeoutMs, 100_000);
      const dispatch = await input.onRequestBodyWriteStart?.();
      assert(dispatch && typeof dispatch === "object");
      const body = Buffer.from(dispatch.body ?? "", "utf8");
      assert.deepEqual(JSON.parse(body.toString("utf8")), { jobIds });
      assert.equal(verifyWebBrowserBrokerRequestSignature(key, body, dispatch.headers?.["x-aipos-timestamp"], dispatch.headers?.["x-aipos-nonce"], dispatch.headers?.["x-aipos-signature"]), true);
      return { status: 200, headers: { "content-type": "application/json" }, finalUrl: input.url, fingerprint: "f".repeat(64), body: Buffer.from('{"cancelled":true}') };
    };
    await cancelWebBrowserBrokerJobs(configuration, jobIds, fakeRequest);
    await assert.rejects(() => cancelWebBrowserBrokerJobs(configuration, jobIds, async (input) => ({
      status: 503, headers: { "content-type": "application/json" }, finalUrl: input.url, fingerprint: "f".repeat(64), body: Buffer.from('{"error":"unavailable"}'),
    })), { code: "WEB_SOURCE_FETCH_FAILED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("broker client signs only at dispatch and checks response job, image and secret reflection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-broker-client-test-"));
  const keyPath = join(directory, "broker.key");
  const key = randomBytes(32);
  await writeFile(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600 });
  try {
    const configuration = webBrowserBrokerConfiguration({
      AI_PROJECT_OS_WEB_BROWSER_ENABLED: "1",
      AI_PROJECT_OS_WEB_BROWSER_BROKER_URL: "https://broker.example/v1/render",
      AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE: keyPath,
      AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: IMAGE_DIGEST,
      AI_PROJECT_OS_WEB_BROWSER_BROKER_ALLOW_PRIVATE: "0",
    });
    const job = {
      jobId: randomUUID(), projectId: randomUUID(), sourceId: randomUUID(), revisionId: randomUUID(),
      url: "https://source.example/private", expectedNetworkFingerprint: "b".repeat(64),
      siteForm: {
        loginUrl: "https://source.example/login", submitUrl: "https://source.example/login/submit",
        usernameSelector: 'input[name="username"]', passwordSelector: 'input[name="password"]',
        submitSelector: 'button[type="submit"]', successSelector: "#signed-in",
        username: "fixture-user", password: "fixture-password",
      },
    };
    let dispatchCount = 0;
    const fakeRequest: typeof securePinnedHttpRequest = async (input) => {
      assert.equal(dispatchCount, 0);
      assert.equal(input.requestTimeoutMs, 100_000);
      assert.equal(input.allowPrivateNetwork, false);
      const dispatch = await input.onRequestBodyWriteStart?.();
      assert(dispatch && typeof dispatch === "object");
      assert.equal(dispatchCount, 1);
      const body = Buffer.from(dispatch.body ?? "", "utf8");
      const timestamp = dispatch.headers?.["x-aipos-timestamp"];
      const nonce = dispatch.headers?.["x-aipos-nonce"];
      const signature = dispatch.headers?.["x-aipos-signature"];
      assert.equal(verifyWebBrowserBrokerRequestSignature(key, body, timestamp, nonce, signature), true);
      assert.deepEqual(JSON.parse(body.toString("utf8")), job);
      return {
        status: 200, headers: { "content-type": "application/json" }, finalUrl: input.url, fingerprint: "f".repeat(64),
        body: Buffer.from(JSON.stringify({
          jobId: job.jobId, url: job.url, text: "Private visible text",
          networkFingerprint: "b".repeat(64), imageDigest: IMAGE_DIGEST,
        })),
      };
    };
    const result = await callWebBrowserBroker(configuration, async () => { dispatchCount += 1; return job; }, fakeRequest);
    assert.equal(result.text, "Private visible text");

    const reflected: typeof securePinnedHttpRequest = async (input) => {
      await input.onRequestBodyWriteStart?.();
      return {
        status: 200, headers: { "content-type": "application/json" }, finalUrl: input.url, fingerprint: "f".repeat(64),
        body: Buffer.from(JSON.stringify({
          jobId: job.jobId, url: job.url, text: "fixture-password",
          networkFingerprint: "b".repeat(64), imageDigest: IMAGE_DIGEST,
        })),
      };
    };
    await assert.rejects(() => callWebBrowserBroker(configuration, async () => job, reflected), { code: "WEB_BROWSER_CREDENTIAL_REFLECTION" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
