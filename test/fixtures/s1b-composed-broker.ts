import assert from "node:assert/strict";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LookupFunction } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  browserResourceIdForJob,
  parseWebBrowserBrokerResult,
  type WebBrowserBrokerRequest,
  type WebBrowserBrokerResult,
} from "../../src/lib/web-browser-broker-protocol";
import { securePinnedHttpRequest } from "../../src/lib/web-sources";
import { createWebBrowserBrokerServer, WebBrowserCleanupError, WebBrowserJobFailedError, type WebBrowserBrokerServer } from "../../scripts/web-browser-broker";

const IMAGE = "ai-project-os-web-browser:0.7.0-dev.1";
const CONTRACT_LABEL = "0.7.0-dev.1-s1b-prototype";
const HOSTNAME = "browser-source.example";
const CERTIFICATE_PATH = join(process.cwd(), "test/fixtures/web-browser-origin-test-cert.pem.fixture");
const PRIVATE_KEY_PATH = join(process.cwd(), "test/fixtures/web-browser-origin-test-key.pem.fixture");
const ORIGIN_SCRIPT_PATH = join(process.cwd(), "test/fixtures/s1b-browser-container-origin.mjs");
const PROXY_SCRIPT_PATH = join(process.cwd(), "test/fixtures/s1b-browser-container-proxy.ts");

function run(command: string, args: readonly string[], timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(stdout.trim());
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 64 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("command-output-limit"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.once("error", () => finish(new Error("command-unavailable")));
    child.once("close", (code) => code === 0 ? finish() : finish(new Error("command-failed")));
  });
}

function docker(args: readonly string[], timeoutMs?: number): Promise<string> {
  return run("docker", args, timeoutMs);
}

async function imageReady(): Promise<void> {
  const [osType, version, label] = await Promise.all([
    docker(["info", "--format", "{{.OSType}}"]),
    docker(["version", "--format", "{{.Server.Version}}"]),
    docker(["image", "inspect", "--format", '{{index .Config.Labels "io.ai-project-os.web-browser-contract"}}', IMAGE]),
  ]);
  assert.equal(osType, "linux", "S1b composition requires a Linux Docker engine");
  assert(Number(/^v?(\d+)/u.exec(version)?.[1]) >= 28, "Docker engine must be version 28 or later");
  assert.equal(label, CONTRACT_LABEL, "the fixture must use the labeled local browser prototype image");
}

async function waitForFile(path: string, container: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("browser-job-cancelled");
    try { await readFile(path); return; } catch { /* wait for fixture startup */ }
    const state = await docker(["inspect", "--format", "{{.State.Status}}", container], 5000);
    if (state !== "running") throw new Error("s1b-fixture-stopped");
    await delay(100);
  }
  throw new Error("s1b-fixture-timeout");
}

async function containerNetworkMap(name: string): Promise<Record<string, { IPAddress?: string }>> {
  return JSON.parse(await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", name])) as Record<string, { IPAddress?: string }>;
}

async function removeContainer(name: string): Promise<void> {
  try { await docker(["rm", "--force", name], 8_000); } catch { /* deterministic test resource */ }
}

async function removeNetwork(name: string): Promise<void> {
  try { await docker(["network", "rm", name], 8_000); } catch { /* deterministic test resource */ }
}

async function assertAbsent(command: "container" | "network", name: string): Promise<void> {
  await assert.rejects(
    docker(command === "container" ? ["inspect", name] : ["network", "inspect", name], 5_000),
    /command-failed/u,
  );
}

async function waitForExit(name: string, signal: AbortSignal): Promise<number> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("browser-job-cancelled");
    const [status, code] = (await docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name], 5000)).split(" ");
    if (status === "exited") {
      const parsed = Number(code);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) throw new Error("browser-exit-code-invalid");
      return parsed;
    }
    if (status !== "running") throw new Error("browser-container-state-invalid");
    await delay(100);
  }
  throw new Error("browser-container-timeout");
}

function secureFixtureBrokerTransport(certificate: Buffer, port: number): typeof securePinnedHttpRequest {
  const pinnedLookup: LookupFunction = (hostname, options, callback) => {
    if (hostname.toLowerCase() !== HOSTNAME) {
      const error = new Error("unexpected-broker-host");
      if (options.all) callback(error, []);
      else callback(error, "127.0.0.1", 4);
      return;
    }
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };
  return async (input) => {
    const url = new URL(input.url);
    if (url.protocol !== "https:" || url.hostname !== HOSTNAME || Number(url.port) !== port || url.search || url.hash) {
      throw new Error("fixture-broker-url-invalid");
    }
    if (input.method !== "POST") throw new Error("fixture-broker-method-invalid");
    let headers = input.headers;
    let body = input.body;
    if (input.onRequestBodyWriteStart !== undefined) {
      const dispatch = await input.onRequestBodyWriteStart();
      if (dispatch === false) throw new Error("fixture-broker-dispatch-denied");
      if (typeof dispatch === "object") {
        headers = dispatch.headers ?? headers;
        body = dispatch.body ?? body;
      }
    }
    const maximumResponseBytes = input.maximumResponseBytes ?? 128 * 1024;
    const timeoutMs = input.requestTimeoutMs ?? 10_000;
    return await new Promise((resolve, reject) => {
      const request = httpsRequest(url, {
        method: input.method,
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          connection: "close",
          ...headers,
        },
        agent: false,
        ca: certificate,
        lookup: pinnedLookup,
        servername: HOSTNAME,
        signal: AbortSignal.timeout(timeoutMs),
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximumResponseBytes) {
            response.destroy(new Error("fixture-broker-response-too-large"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve(Object.freeze({
            status: response.statusCode ?? 0,
            headers: Object.freeze(responseHeaders),
            body: Buffer.concat(chunks),
            finalUrl: input.url,
            fingerprint: createHash("sha256").update(certificate).digest("hex"),
          }));
        });
        response.once("error", reject);
      });
      request.once("error", reject);
      request.end(body);
    });
  };
}

function createChromiumRunner(input: Readonly<{
  imageDigest: string;
  certificate: Buffer;
  privateKeyPath: string;
  sourceFingerprint: string;
  sourceRequestsPath: string;
  sourceNetworkName: string;
}>): Readonly<{
  runJob(request: WebBrowserBrokerRequest, signal: AbortSignal): Promise<WebBrowserBrokerResult>;
  waitForOriginRequest(requestLine: string): Promise<void>;
  waitForCleanup(jobId: string): Promise<void>;
  assertJobResourcesRemoved(jobId: string): Promise<void>;
  close(): Promise<void>;
}> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
  assert(uid !== undefined && gid !== undefined && uid !== 0, "the test runner must use a non-root POSIX identity");
  const certificate = new X509Certificate(input.certificate);
  const certificateSpki = createHash("sha256").update(certificate.publicKey.export({ format: "der", type: "spki" })).digest("base64");
  const cleanupPromises = new Map<string, Promise<void>>();
  const cleanupResolvers = new Map<string, () => void>();
  const idFor = (jobId: string) => browserResourceIdForJob(jobId);
  const resourceNames = (jobId: string) => {
    const id = idFor(jobId);
    return Object.freeze({
      id,
      browser: `aipos-s1b-browser-${id}`,
      proxy: `aipos-s1b-proxy-${id}`,
      browserNetwork: `aipos-s1b-browser-net-${id}`,
    });
  };

  const waitForOriginRequest = async (requestLine: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const content = await readFile(input.sourceRequestsPath, "utf8").catch(() => "");
      if (content.split(/\r?\n/u).includes(requestLine)) return;
      await delay(50);
    }
    throw new Error("s1b-request-not-observed");
  };

  const waitForCleanup = async (jobId: string): Promise<void> => {
    const cleanup = cleanupPromises.get(jobId);
    if (cleanup === undefined) throw new Error("s1b-job-cleanup-not-registered");
    await cleanup;
  };

  const assertJobResourcesRemoved = async (jobId: string): Promise<void> => {
    await waitForCleanup(jobId);
    const resources = resourceNames(jobId);
    await Promise.all([
      assertAbsent("container", resources.browser),
      assertAbsent("container", resources.proxy),
      assertAbsent("network", resources.browserNetwork),
    ]);
  };

  const runJob = async (request: WebBrowserBrokerRequest, signal: AbortSignal): Promise<WebBrowserBrokerResult> => {
    const resources = resourceNames(request.jobId);
    const directory = await mkdtemp(join(tmpdir(), `aipos-s1b-job-${resources.id}-`));
    cleanupPromises.set(request.jobId, new Promise<void>((resolve) => cleanupResolvers.set(request.jobId, resolve)));
    const outputDirectory = join(directory, "output");
    const configPath = join(directory, "job.json");
    const proxyConfigPath = join(directory, "proxy-job.json");
    const proxyUsername = `s1b-${resources.id}`;
    const proxyPassword = randomBytes(32).toString("base64url");
    const targetOrigin = new URL(request.url).origin;
    const proxyUrl = `${targetOrigin}/login/submit`;
    let browserNetworkCreated = false;
    let proxyCreated = false;
    let browserCreated = false;

    try {
      await chmod(directory, 0o700);
      await mkdir(outputDirectory, { mode: 0o700 });
      await writeFile(configPath, JSON.stringify({
        url: request.url,
        origin: targetOrigin,
        proxyUsername,
        proxyPassword,
        certificateSpki,
        ...(request.siteForm === undefined ? {} : { siteForm: request.siteForm }),
      }), { mode: 0o600, flag: "wx" });
      await writeFile(proxyConfigPath, JSON.stringify({
        origin: targetOrigin,
        proxyUsername,
        proxyPassword,
        formPostUrl: proxyUrl,
        expectedNetworkFingerprint: input.sourceFingerprint,
      }), { mode: 0o600, flag: "wx" });
      if (signal.aborted) throw new Error("browser-job-cancelled");
      await docker([
        "network", "create", "--driver", "bridge", "--internal", "--ipv6=false",
        "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
        "--label", `io.ai-project-os.s1b-test.job=${resources.id}`,
        resources.browserNetwork,
      ]);
      browserNetworkCreated = true;
      await docker([
        "create", "--name", resources.proxy, "--init", "--network", resources.browserNetwork,
        "--label", `io.ai-project-os.s1b-test.job=${resources.id}`,
        "--user", `${uid}:${gid}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "48", "--memory", "192m", "--memory-swap", "192m", "--cpus", "1", "--ulimit", "nofile=256:256",
        "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777,uid=${uid},gid=${gid}`,
        "--mount", `type=bind,src=${proxyConfigPath},dst=/run/web-browser/job.json,readonly`,
        "--mount", `type=bind,src=${CERTIFICATE_PATH},dst=/run/web-browser/test-cert.pem,readonly`,
        "--mount", `type=bind,src=${input.privateKeyPath},dst=/run/web-browser/test-key.pem,readonly`,
        "--mount", `type=bind,src=${PROXY_SCRIPT_PATH},dst=/app/test/fixtures/s1b-browser-container-proxy.ts,readonly`,
        "--mount", `type=bind,src=${outputDirectory},dst=/run/web-browser-output`,
        "--log-driver", "none",
        "--entrypoint", "node", IMAGE, "--import", "tsx", "test/fixtures/s1b-browser-container-proxy.ts",
      ], 10_000);
      proxyCreated = true;
      await docker(["start", resources.proxy], 5000);
      await docker(["network", "connect", input.sourceNetworkName, resources.proxy], 5000);
      const proxyNetworks = await containerNetworkMap(resources.proxy);
      const proxyIp = proxyNetworks[resources.browserNetwork]?.IPAddress;
      assert(typeof proxyIp === "string" && proxyIp.length > 0);
      assert.deepEqual(Object.keys(proxyNetworks).sort(), [input.sourceNetworkName, resources.browserNetwork].sort());
      await waitForFile(join(outputDirectory, "proxy-ready"), resources.proxy, signal);

      await docker([
        "create", "--name", resources.browser, "--init", "--network", resources.browserNetwork,
        "--dns", "127.0.0.1", "--label", `io.ai-project-os.s1b-test.job=${resources.id}`,
        "--user", `${uid}:${gid}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "128", "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--shm-size", "64m", "--ulimit", "nofile=256:256",
        "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777,uid=${uid},gid=${gid}`,
        "--mount", `type=bind,src=${configPath},dst=/run/web-browser/job.json,readonly`,
        "--mount", `type=bind,src=${outputDirectory},dst=/run/web-browser-output`,
        "--env", `HOME=/tmp/home-${resources.id}`,
        "--env", "TMPDIR=/tmp",
        "--env", `AI_PROJECT_OS_WEB_BROWSER_PROXY_SERVER=http://${proxyIp}:3128`,
        "--log-driver", "none", IMAGE, "browser",
      ], 10_000);
      browserCreated = true;
      const browserNetworks = await containerNetworkMap(resources.browser);
      assert.deepEqual(Object.keys(browserNetworks), [resources.browserNetwork], "Chromium may join only its per-job isolated bridge");
      const browserNetwork = JSON.parse(await docker(["network", "inspect", "--format", "{{json .}}", resources.browserNetwork])) as Record<string, unknown>;
      assert.equal(browserNetwork.Internal, true);
      assert.equal(browserNetwork.EnableIPv6, false);
      assert.equal((browserNetwork.Options as Record<string, unknown>)["com.docker.network.bridge.gateway_mode_ipv4"], "isolated");
      const ipamConfig = ((browserNetwork.IPAM as Record<string, unknown>).Config as Array<Record<string, unknown>>)[0];
      assert.equal(ipamConfig.Gateway, undefined);

      if (signal.aborted) throw new Error("browser-job-cancelled");
      await docker(["start", resources.browser], 5000);
      const exitCode = await waitForExit(resources.browser, signal);
      if (exitCode !== 0) throw new Error("browser-container-failed");
      const raw = await readFile(join(outputDirectory, "result.json"));
      assert(raw.length <= 128 * 1024);
      const rendered: unknown = JSON.parse(raw.toString("utf8"));
      assert(typeof rendered === "object" && rendered !== null && !Array.isArray(rendered));
      const renderedRecord = rendered as Record<string, unknown>;
      if (typeof renderedRecord.error === "string") throw new Error("browser-render-failed");
      assert.equal(renderedRecord.url, request.url);
      assert.equal(typeof renderedRecord.text, "string");
      assert((renderedRecord.text as string).length <= 20_000);

      await docker(["stop", "--time", "3", resources.proxy], 6000);
      const evidence = JSON.parse(await readFile(join(outputDirectory, "network.json"), "utf8")) as Record<string, unknown>;
      assert.equal(evidence.networkFingerprint, input.sourceFingerprint);
      return parseWebBrowserBrokerResult({
        jobId: request.jobId,
        url: renderedRecord.url,
        text: renderedRecord.text,
        networkFingerprint: evidence.networkFingerprint,
        imageDigest: input.imageDigest,
      }, request.jobId, input.imageDigest);
    } catch {
      // Propagated only after the cleanup finally block succeeds.
      throw new WebBrowserJobFailedError();
    } finally {
      let cleanupError: unknown;
      try {
        await Promise.all([
          ...(browserCreated ? [removeContainer(resources.browser)] : []),
          ...(proxyCreated ? [removeContainer(resources.proxy)] : []),
        ]);
        if (browserNetworkCreated) await removeNetwork(resources.browserNetwork);
        await Promise.all([
          assertAbsent("container", resources.browser),
          assertAbsent("container", resources.proxy),
          assertAbsent("network", resources.browserNetwork),
        ]);
      } catch (error) {
        cleanupError = error;
      } finally {
        try { await rm(directory, { recursive: true, force: true }); }
        finally { cleanupResolvers.get(request.jobId)?.(); }
      }
      if (cleanupError !== undefined) throw new WebBrowserCleanupError();
    }
  };

  const close = async (): Promise<void> => {
    for (const cleanup of cleanupPromises.values()) await cleanup;
  };

  return Object.freeze({ runJob, waitForOriginRequest, waitForCleanup, assertJobResourcesRemoved, close });
}

export type S1bComposedBroker = Readonly<{
  environment: Readonly<Record<string, string>>;
  request: typeof securePinnedHttpRequest;
  sourceFingerprint: string;
  waitForOriginRequest(requestLine: string): Promise<void>;
  waitForCleanup(jobId: string): Promise<void>;
  assertJobResourcesRemoved(jobId: string): Promise<void>;
  close(): Promise<void>;
}>;

export async function createS1bComposedBroker(imageDigest: string): Promise<S1bComposedBroker> {
  await imageReady();
  const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
  const groupId = typeof process.getgid === "function" ? process.getgid() : undefined;
  assert(userId !== undefined && groupId !== undefined && userId !== 0, "run this test as a non-root POSIX user");
  const certificate = await readFile(CERTIFICATE_PATH);
  const privateKey = await readFile(PRIVATE_KEY_PATH);
  const keyDirectory = await mkdtemp(join(tmpdir(), "aipos-s1b-broker-"));
  const suffix = randomBytes(8).toString("hex");
  const sourceNetworkName = `s1b-source-egress-${suffix}`;
  const sourceContainerName = `aipos-s1b-source-${suffix}`;
  let sourceNetworkCreated = false;
  let sourceContainerCreated = false;
  let runner: ReturnType<typeof createChromiumRunner> | undefined;
  let server: WebBrowserBrokerServer | undefined;
  try {
  await chmod(keyDirectory, 0o700);
  const sourceOutputDirectory = join(keyDirectory, "source-output");
  await mkdir(sourceOutputDirectory, { mode: 0o700 });
  const sharedKey = randomBytes(32);
  const brokerKeyPath = join(keyDirectory, "broker.key");
  const ledgerDirectory = join(keyDirectory, "ledger");
  await writeFile(brokerKeyPath, `${sharedKey.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  await mkdir(ledgerDirectory, { mode: 0o700 });

    await docker([
      "network", "create", "--driver", "bridge", "--internal", "--ipv6=false",
      "--label", "io.ai-project-os.s1b-test.fixture=source",
      sourceNetworkName,
    ]);
    sourceNetworkCreated = true;
    await docker([
      "create", "--name", sourceContainerName, "--network", sourceNetworkName, "--network-alias", "s1b-test-origin",
      "--label", "io.ai-project-os.s1b-test.fixture=source",
      "--user", `${userId}:${groupId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "16", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.25", "--ulimit", "nofile=128:128",
      "--mount", `type=bind,src=${CERTIFICATE_PATH},dst=/run/web-browser/test-cert.pem,readonly`,
      "--mount", `type=bind,src=${PRIVATE_KEY_PATH},dst=/run/web-browser/test-key.pem,readonly`,
      "--mount", `type=bind,src=${ORIGIN_SCRIPT_PATH},dst=/run/web-browser/s1b-origin.mjs,readonly`,
      "--mount", `type=bind,src=${sourceOutputDirectory},dst=/run/web-browser-output`,
      "--log-driver", "none", "--entrypoint", "node", IMAGE, "/run/web-browser/s1b-origin.mjs",
    ]);
    sourceContainerCreated = true;
    await docker(["start", sourceContainerName], 5000);
    await waitForFile(join(sourceOutputDirectory, "source-ready"), sourceContainerName);
    const sourceNetworks = await containerNetworkMap(sourceContainerName);
    const sourceIp = sourceNetworks[sourceNetworkName]?.IPAddress;
    assert(typeof sourceIp === "string" && sourceIp.length > 0);
    const sourceFingerprint = createHash("sha256")
      .update(`${HOSTNAME}:8443:4:${sourceIp}`, "utf8")
      .digest("hex");

    const browserRunner = createChromiumRunner({
      imageDigest,
      certificate,
      privateKeyPath: PRIVATE_KEY_PATH,
      sourceFingerprint,
      sourceRequestsPath: join(sourceOutputDirectory, "source-requests.txt"),
      sourceNetworkName,
    });
    runner = browserRunner;
    const brokerServer = createWebBrowserBrokerServer({
      certificate,
      privateKey,
      sharedKey,
      ledgerDirectory,
      imageDigest,
      runJob: browserRunner.runJob,
    });
    server = brokerServer;
    await new Promise<void>((resolve, reject) => {
      brokerServer.once("error", reject);
      brokerServer.listen(0, "127.0.0.1", resolve);
    });
    const address = brokerServer.address();
    assert(typeof address === "object" && address !== null);
    const port = address.port;
    brokerServer.markReady();
    return Object.freeze({
      environment: Object.freeze({
        AI_PROJECT_OS_WEB_BROWSER_ENABLED: "1",
        AI_PROJECT_OS_WEB_BROWSER_BROKER_URL: `https://${HOSTNAME}:${port}/v1/render`,
        AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE: brokerKeyPath,
        AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST: imageDigest,
        AI_PROJECT_OS_WEB_BROWSER_BROKER_ALLOW_PRIVATE: "1",
      }),
      request: secureFixtureBrokerTransport(certificate, port),
      sourceFingerprint,
      waitForOriginRequest: browserRunner.waitForOriginRequest,
      waitForCleanup: browserRunner.waitForCleanup,
      assertJobResourcesRemoved: browserRunner.assertJobResourcesRemoved,
      async close() {
        try {
          await brokerServer.shutdown();
          await browserRunner.close();
        } finally {
          if (sourceContainerCreated) {
            await removeContainer(sourceContainerName);
            await assertAbsent("container", sourceContainerName);
          }
          if (sourceNetworkCreated) {
            await removeNetwork(sourceNetworkName);
            await assertAbsent("network", sourceNetworkName);
          }
          await rm(keyDirectory, { recursive: true, force: true });
        }
      },
    });
  } catch (error) {
    await server?.shutdown().catch(() => undefined);
    await runner?.close().catch(() => undefined);
    if (sourceContainerCreated) await removeContainer(sourceContainerName);
    if (sourceNetworkCreated) await removeNetwork(sourceNetworkName);
    await rm(keyDirectory, { recursive: true, force: true });
    throw error;
  }
}
