import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupOwnedJobDirectory,
  cleanupOwnedJobResources,
  browserJobContainerConfigs,
  listOwnedJobIds,
  parseOneShotInput,
  resolveBrowserImageConfiguration,
  verifyBrowserImageInspection,
} from "../scripts/web-browser-one-shot";
import { browserResourceIdForJob } from "../src/lib/web-browser-broker-protocol";
import { parseWebBrowserContainerJobConfig } from "../scripts/web-browser-container";

test("proxy container config excludes site account credentials", () => {
  const job = parseOneShotInput({
    url: "https://source.example/private", expectedNetworkFingerprint: "b".repeat(64),
    siteForm: {
      loginUrl: "https://source.example/login", submitUrl: "https://source.example/login/submit",
      usernameSelector: 'input[name="username"]', passwordSelector: 'input[name="password"]',
      submitSelector: 'button[type="submit"]', successSelector: "#signed-in",
      username: "fixture-user", password: "fixture-password",
    },
  });
  const configs = browserJobContainerConfigs(job, "https://source.example", "proxy-user", "proxy-password-with-enough-characters", "a".repeat(43) + "=");
  assert.equal(configs.proxy.formPostUrl, "https://source.example/login/submit");
  assert.equal(JSON.stringify(configs.proxy).includes("fixture-password"), false);
  assert.equal(JSON.stringify(configs.proxy).includes("fixture-user"), false);
  assert.equal(JSON.stringify(configs.browser).includes("fixture-password"), true);
  assert.equal(parseWebBrowserContainerJobConfig(configs.proxy, "proxy").formPostUrl, "https://source.example/login/submit");
  assert.equal(parseWebBrowserContainerJobConfig(configs.browser, "browser").siteForm?.password, "fixture-password");
  assert.throws(() => parseWebBrowserContainerJobConfig(configs.browser, "proxy"));
  assert.throws(() => parseWebBrowserContainerJobConfig(configs.proxy, "browser"));
});

const JOB_ID = "a".repeat(24);
const DIGEST = `registry.example.test/ai-project-os/web-browser@sha256:${"b".repeat(64)}`;
const MANAGED_BY_LABEL = "io.ai-project-os.web-browser.managed-by";
const JOB_LABEL = "io.ai-project-os.web-browser.job";
const RESOURCE_LABEL = "io.ai-project-os.web-browser.resource";
const CONTRACT_LABEL = "io.ai-project-os.web-browser-contract";

type FakeResource = Record<string, unknown>;

function fakeDockerState() {
  const containers = new Map<string, FakeResource>();
  const networks = new Map<string, FakeResource>();
  const removed: string[] = [];
  let preserveOnRemove = false;
  let failRemovalFor: string | undefined;

  const labels = (resource: string, jobId = JOB_ID) => ({
    [MANAGED_BY_LABEL]: "one-shot-v1",
    [JOB_LABEL]: jobId,
    [RESOURCE_LABEL]: resource,
  });
  const container = (id: string, name: string, resource: string, jobId = JOB_ID) => ({
    Id: id,
    Name: `/${name}`,
    Config: { Labels: labels(resource, jobId) },
  });
  const network = (id: string, name: string, resource: string, jobId = JOB_ID) => ({
    Id: id,
    Name: name,
    Labels: labels(resource, jobId),
  });

  const proxyId = "c".repeat(64);
  const browserId = "d".repeat(64);
  const browserNetworkId = "e".repeat(64);
  const egressNetworkId = "f".repeat(64);
  containers.set(proxyId, container(proxyId, `aipos-web-proxy-${JOB_ID}`, "proxy"));
  containers.set(browserId, container(browserId, `aipos-web-render-${JOB_ID}`, "browser"));
  networks.set(browserNetworkId, network(browserNetworkId, `aipos-web-browser-${JOB_ID}`, "browser-network"));
  networks.set(egressNetworkId, network(egressNetworkId, `aipos-web-egress-${JOB_ID}`, "egress-network"));
  const unrelatedId = "1".repeat(64);
  const unrelated = container(unrelatedId, "unrelated-container", "other", "9".repeat(24));
  ((unrelated.Config as { Labels: Record<string, unknown> }).Labels)[MANAGED_BY_LABEL] = "unrelated-owner";
  containers.set(unrelatedId, unrelated);

  async function command(args: readonly string[]): Promise<string> {
    if (args[0] === "ps") {
      const onlyManaged = args.includes(`label=${MANAGED_BY_LABEL}=one-shot-v1`);
      const jobFilter = args.find((arg) => arg.startsWith(`label=${JOB_LABEL}=`));
      const jobId = jobFilter?.slice(`label=${JOB_LABEL}=`.length);
      const result = [...containers.entries()].filter(([, value]) => {
        const containerLabels = (value.Config as { Labels: Record<string, unknown> }).Labels;
        return (!onlyManaged || containerLabels[MANAGED_BY_LABEL] === "one-shot-v1") &&
          (jobId === undefined || containerLabels[JOB_LABEL] === jobId);
      }).map(([id]) => id);
      return result.join("\n");
    }
    if (args[0] === "network" && args[1] === "ls") {
      const onlyManaged = args.includes(`label=${MANAGED_BY_LABEL}=one-shot-v1`);
      const jobFilter = args.find((arg) => arg.startsWith(`label=${JOB_LABEL}=`));
      const jobId = jobFilter?.slice(`label=${JOB_LABEL}=`.length);
      const result = [...networks.entries()].filter(([, value]) => {
        const networkLabels = value.Labels as Record<string, unknown>;
        return (!onlyManaged || networkLabels[MANAGED_BY_LABEL] === "one-shot-v1") &&
          (jobId === undefined || networkLabels[JOB_LABEL] === jobId);
      }).map(([id]) => id);
      return result.join("\n");
    }
    if (args[0] === "inspect") {
      const value = containers.get(args.at(-1)!);
      if (value === undefined) throw new Error("missing fake container");
      return JSON.stringify(value);
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const value = networks.get(args.at(-1)!);
      if (value === undefined) throw new Error("missing fake network");
      return JSON.stringify(value);
    }
    if (args[0] === "rm") {
      const id = args.at(-1)!;
      removed.push(id);
      if (id === failRemovalFor) throw new Error("simulated remove failure");
      if (!preserveOnRemove) containers.delete(args.at(-1)!);
      return "";
    }
    if (args[0] === "network" && args[1] === "rm") {
      const id = args.at(-1)!;
      removed.push(id);
      if (id === failRemovalFor) throw new Error("simulated remove failure");
      if (!preserveOnRemove) networks.delete(args.at(-1)!);
      return "";
    }
    throw new Error(`unexpected command ${args[0]}`);
  }

  return {
    command,
    containers,
    networks,
    removed,
    setPreserveOnRemove(value: boolean) { preserveOnRemove = value; },
    setFailRemovalFor(value: string) { failRemovalFor = value; },
    addForeignOwnedCandidate() {
      const id = "2".repeat(64);
      containers.set(id, container(id, "not-a-job-resource", "proxy"));
      return id;
    },
  };
}

test("operator image configuration requires an immutable digest outside prototype mode", () => {
  assert.deepEqual(resolveBrowserImageConfiguration({}), {
    mode: "prototype",
    image: "ai-project-os-web-browser:0.7.0-dev.1",
    immutable: false,
  });
  assert.deepEqual(resolveBrowserImageConfiguration({ AI_PROJECT_OS_WEB_BROWSER_MODE: "prototype", NODE_ENV: "development" }), {
    mode: "prototype",
    image: "ai-project-os-web-browser:0.7.0-dev.1",
    immutable: false,
  });
  assert.deepEqual(resolveBrowserImageConfiguration({ AI_PROJECT_OS_WEB_BROWSER_MODE: "pinned", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: DIGEST }), {
    mode: "pinned",
    image: DIGEST,
    immutable: true,
  });
  assert.deepEqual(resolveBrowserImageConfiguration({ NODE_ENV: "production", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: DIGEST }), {
    mode: "pinned",
    image: DIGEST,
    immutable: true,
  });
  for (const environment of [
    { NODE_ENV: "production" },
    { NODE_ENV: "production", AI_PROJECT_OS_WEB_BROWSER_MODE: "prototype" },
    { NODE_ENV: "production", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: "registry.example.test/image:latest" },
    { NODE_ENV: "production", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: DIGEST.replace("b".repeat(64), "B".repeat(64)) },
    { NODE_ENV: "production", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: `${DIGEST.slice(0, -1)}` },
    { NODE_ENV: "production", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: `registry..example.test/team/web-browser@sha256:${"b".repeat(64)}` },
    { NODE_ENV: "production", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: `registry.example.test:70000/team/web-browser@sha256:${"b".repeat(64)}` },
    { AI_PROJECT_OS_WEB_BROWSER_MODE: "pinned" },
    { AI_PROJECT_OS_WEB_BROWSER_MODE: "prototype", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: DIGEST },
    { AI_PROJECT_OS_WEB_BROWSER_MODE: "unexpected" },
  ]) assert.throws(() => resolveBrowserImageConfiguration(environment), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
});

test("pinned image inspection must prove the exact immutable RepoDigest and contract label", () => {
  const configuration = resolveBrowserImageConfiguration({ AI_PROJECT_OS_WEB_BROWSER_MODE: "pinned", AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: DIGEST });
  const inspection = {
    Id: `sha256:${"c".repeat(64)}`,
    RepoDigests: [DIGEST],
    Config: { Labels: { [CONTRACT_LABEL]: "0.7.0-dev.1-s1b-prototype" } },
  };
  assert.equal(verifyBrowserImageInspection(inspection, configuration), inspection.Id);
  assert.throws(() => verifyBrowserImageInspection({ ...inspection, RepoDigests: [] }, configuration), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
  assert.throws(() => verifyBrowserImageInspection({ ...inspection, Config: { Labels: {} } }, configuration), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
  assert.throws(() => verifyBrowserImageInspection({ ...inspection, Id: "sha256:tagged" }, configuration), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
});

test("stdin accepts a URL or one bounded same-origin form and rejects runner controls", () => {
  assert.deepEqual(parseOneShotInput({ url: "https://example.com/path" }), { url: "https://example.com/path" });
  const siteForm = {
    loginUrl: "https://example.com/login",
    submitUrl: "https://example.com/login/submit",
    usernameSelector: 'input[name="username"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successSelector: "#signed-in",
    username: "alice@example.com",
    password: "example-password-123",
  };
  assert.deepEqual(parseOneShotInput({ url: "https://example.com/private", siteForm }), {
    url: "https://example.com/private", siteForm,
  });
  assert.deepEqual(parseOneShotInput({ url: "https://example.com/private", expectedNetworkFingerprint: "a".repeat(64) }), {
    url: "https://example.com/private", expectedNetworkFingerprint: "a".repeat(64),
  });
  const brokerJobId = randomUUID();
  assert.deepEqual(parseOneShotInput({ url: "https://example.com/private", jobId: brokerJobId }), {
    url: "https://example.com/private", jobId: brokerJobId,
  });
  for (const invalidForm of [
    { ...siteForm, loginUrl: "https://other.example/login" },
    { ...siteForm, submitUrl: "https://example.com/login/submit?token=1" },
    { ...siteForm, usernameSelector: "input[name=anything]" },
    { ...siteForm, dockerArgs: ["--privileged"] },
  ]) assert.throws(() => parseOneShotInput({ url: "https://example.com/private", siteForm: invalidForm }));
  for (const value of [
    { url: "https://example.com", image: DIGEST },
    { url: "https://example.com", dockerArgs: ["--privileged"] },
    { url: "https://example.com", env: { TOKEN: "secret" } },
    { url: "https://example.com", command: "sh" },
    { url: "https://example.com", credential: "secret" },
    { url: "https://example.com", expectedNetworkFingerprint: "not-a-fingerprint" },
    { url: "https://example.com", jobId: "not-a-uuid" },
    [],
    null,
  ]) assert.throws(() => parseOneShotInput(value), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
});

test("broker job ID derives an exact cleanup directory and removes mounted secrets", async () => {
  const resourceId = browserResourceIdForJob(randomUUID());
  const path = join(tmpdir(), `aipos-web-job-${resourceId}`);
  await mkdir(path, { mode: 0o700 });
  try {
    await writeFile(join(path, "job.json"), "private fixture", { mode: 0o600 });
    await cleanupOwnedJobDirectory(resourceId);
    await assert.rejects(() => stat(path), { code: "ENOENT" });
  } finally {
    await cleanupOwnedJobDirectory(resourceId);
  }
  await mkdir(path, { mode: 0o700 });
  try {
    await chmod(path, 0o755);
    await assert.rejects(() => cleanupOwnedJobDirectory(resourceId), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
  } finally {
    await chmod(path, 0o700);
    await cleanupOwnedJobDirectory(resourceId);
  }
});

test("job cleanup removes only exact labeled resources and confirms they are gone", async () => {
  const state = fakeDockerState();
  await cleanupOwnedJobResources(JOB_ID, state.command);
  assert.equal(state.containers.size, 1, "the unrelated container remains");
  assert.equal(state.networks.size, 0);
  assert.equal(state.removed.length, 4);
});

test("job cleanup fails closed when a matching label points to a resource with another identity", async () => {
  const state = fakeDockerState();
  const foreignId = state.addForeignOwnedCandidate();
  await assert.rejects(() => cleanupOwnedJobResources(JOB_ID, state.command), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
  assert.equal(state.removed.length, 0);
  assert.equal(state.containers.has(foreignId), true);
});

test("job cleanup reports a stable failure when Docker leaves owned resources behind", async () => {
  const state = fakeDockerState();
  state.setPreserveOnRemove(true);
  await assert.rejects(() => cleanupOwnedJobResources(JOB_ID, state.command), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
});

test("job cleanup attempts remaining owned resources after one Docker removal fails", async () => {
  const state = fakeDockerState();
  const failedId = "c".repeat(64);
  state.setFailRemovalFor(failedId);
  await assert.rejects(() => cleanupOwnedJobResources(JOB_ID, state.command), { code: "WEB_BROWSER_ISOLATION_UNAVAILABLE" });
  assert.equal(state.removed.length, 4);
  assert.equal(state.containers.size, 2, "the unrelated container and failed job container remain");
  assert.equal(state.networks.size, 0);
});

test("orphan listing returns only validated one-shot job identities", async () => {
  const state = fakeDockerState();
  assert.deepEqual(await listOwnedJobIds(state.command), [JOB_ID]);
});
