import assert from "node:assert/strict";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const IMAGE = "ai-project-os-web-browser:0.7.0-dev.1";
const CONTRACT_LABEL = "0.7.0-dev.1-s1b-prototype";
const TEST_ENABLED = process.env.RUN_WEB_BROWSER_CONTAINER_TESTS === "1";
const TEST_CERTIFICATE_PATH = join(process.cwd(), "test/fixtures/web-browser-origin-test-cert.pem.fixture");
const TEST_PRIVATE_KEY_PATH = join(process.cwd(), "test/fixtures/web-browser-origin-test-key.pem.fixture");

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

async function imageReady(): Promise<boolean> {
  try {
    const [osType, version, label] = await Promise.all([
      docker(["info", "--format", "{{.OSType}}"]),
      docker(["version", "--format", "{{.Server.Version}}"]),
      docker(["image", "inspect", "--format", "{{index .Config.Labels \"io.ai-project-os.web-browser-contract\"}}", IMAGE]),
    ]);
    const major = Number(/^v?(\d+)/u.exec(version)?.[1]);
    return osType === "linux" && major >= 28 && label === CONTRACT_LABEL;
  } catch {
    return false;
  }
}

async function removeContainer(name: string): Promise<void> {
  try { await docker(["rm", "--force", name], 5000); } catch { /* generated test name */ }
}

async function removeNetwork(name: string): Promise<void> {
  try { await docker(["network", "rm", name], 5000); } catch { /* generated test name */ }
}

async function waitForFile(path: string, proxyContainer: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { /* wait for proxy startup */ }
    const state = await docker(["inspect", "--format", "{{.State.Status}}", proxyContainer], 5000);
    if (state !== "running") throw new Error("test-proxy-stopped");
    await delay(100);
  }
  throw new Error("test-proxy-timeout");
}

async function readRenderResult(directory: string): Promise<Readonly<{ url: string; text: string }>> {
  const raw = await readFile(join(directory, "result.json"));
  assert(raw.length <= 128 * 1024, "container result must remain within the encoded byte budget");
  const result: unknown = JSON.parse(raw.toString("utf8"));
  assert(typeof result === "object" && result !== null && !Array.isArray(result));
  const candidate = result as Record<string, unknown>;
  if (typeof candidate.error === "string") {
    const fixtureRequests = await readFile(join(directory, "source-requests.txt"), "utf8").catch(() => "<no-upstream-request>");
    const proxyLookups = await readFile(join(directory, "proxy-lookups.txt"), "utf8").catch(() => "<no-proxy-dns-lookup>");
    const proxyConnections = await readFile(join(directory, "proxy-connections.txt"), "utf8").catch(() => "<no-proxy-connection>");
    assert.fail(`browser returned ${candidate.error}; fixture requests: ${fixtureRequests.slice(0, 1024)}; proxy lookups: ${proxyLookups.slice(0, 1024)}; proxy connections: ${proxyConnections.slice(0, 1024)}`);
  }
  assert(typeof candidate.url === "string");
  assert(typeof candidate.text === "string");
  assert(candidate.text.length <= 20_000);
  return { url: candidate.url, text: candidate.text };
}

test("isolated browser logs in with one same-origin form, renders JS, and is removed", { skip: !TEST_ENABLED }, async () => {
  assert.equal(await imageReady(), true, "build the labeled prototype image on a Linux Docker 28+ engine first");
  const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
  const groupId = typeof process.getgid === "function" ? process.getgid() : undefined;
  assert(userId !== undefined && groupId !== undefined && userId !== 0, "run the integration test as a non-root POSIX user");

  const certificate = await readFile(TEST_CERTIFICATE_PATH);
  const cert = new X509Certificate(certificate);
  const certificateSpki = createHash("sha256")
    .update(cert.publicKey.export({ format: "der", type: "spki" }))
    .digest("base64");
  const id = randomBytes(8).toString("hex");
  const origin = "https://browser-source.example:8443";
  const observedUrl = `${origin}/js`;
  const browserNetwork = `aipos-browser-it-${id}`;
  const egressNetwork = `aipos-egress-it-${id}`;
  const sourceContainer = `aipos-source-it-${id}`;
  const proxyContainer = `aipos-proxy-it-${id}`;
  const browserContainer = `aipos-render-it-${id}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "aipos-browser-it-"));
  const outputDirectory = join(temporaryDirectory, "output");
  const configPath = join(temporaryDirectory, "job.json");
  const proxyConfigPath = join(temporaryDirectory, "proxy-job.json");
  const proxyScriptPath = join(process.cwd(), "test/fixtures/web-browser-container-test-proxy.ts");
  await chmod(temporaryDirectory, 0o700);
  await mkdir(outputDirectory, { mode: 0o700 });
  const proxyUsername = `browser-${id}`;
  const proxyPassword = randomBytes(32).toString("base64url");
  await writeFile(configPath, JSON.stringify({
    url: observedUrl,
    origin,
    proxyUsername,
    proxyPassword,
    certificateSpki,
    siteForm: {
      loginUrl: `${origin}/login`,
      submitUrl: `${origin}/login/submit`,
      usernameSelector: 'input[name="username"]',
      passwordSelector: 'input[name="password"]',
      submitSelector: 'button[type="submit"]',
      successSelector: "#signed-in",
      username: "fixture-user",
      password: "fixture-password",
    },
  }), { mode: 0o600, flag: "wx" });
  await writeFile(proxyConfigPath, JSON.stringify({
    origin, proxyUsername, proxyPassword, formPostUrl: `${origin}/login/submit`,
  }), { mode: 0o600, flag: "wx" });

  let browserNetworkCreated = false;
  let egressNetworkCreated = false;
  let sourceCreated = false;
  let proxyCreated = false;
  let browserCreated = false;
  try {
    await docker([
      "network", "create", "--driver", "bridge", "--internal", "--ipv6=false",
      "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", browserNetwork,
    ]);
    browserNetworkCreated = true;
    await docker(["network", "create", "--driver", "bridge", "--internal", "--ipv6=false", egressNetwork]);
    egressNetworkCreated = true;

    const originScriptPath = join(process.cwd(), "test/fixtures/web-browser-container-test-origin.mjs");
    await docker([
      "create", "--name", sourceContainer, "--network", egressNetwork, "--network-alias", "web-browser-test-origin",
      "--user", `${userId}:${groupId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "16", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.25", "--ulimit", "nofile=128:128",
      "--mount", `type=bind,src=${TEST_CERTIFICATE_PATH},dst=/run/web-browser/test-cert.pem,readonly`,
      "--mount", `type=bind,src=${TEST_PRIVATE_KEY_PATH},dst=/run/web-browser/test-key.pem,readonly`,
      "--mount", `type=bind,src=${originScriptPath},dst=/run/web-browser/test-origin.mjs,readonly`,
      "--mount", `type=bind,src=${outputDirectory},dst=/run/web-browser-output`,
      "--log-driver", "none",
      "--entrypoint", "node", IMAGE, "/run/web-browser/test-origin.mjs",
    ], 10000);
    sourceCreated = true;
    await docker(["start", sourceContainer], 5000);
    await waitForFile(join(outputDirectory, "source-ready"), sourceContainer);

    await docker([
      "create", "--name", proxyContainer, "--init", "--network", browserNetwork,
      "--user", `${userId}:${groupId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "48", "--memory", "192m", "--memory-swap", "192m", "--cpus", "1", "--ulimit", "nofile=256:256",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777,uid=${userId},gid=${groupId}`,
      "--mount", `type=bind,src=${proxyConfigPath},dst=/run/web-browser/job.json,readonly`,
      "--mount", `type=bind,src=${TEST_CERTIFICATE_PATH},dst=/run/web-browser/test-cert.pem,readonly`,
      "--mount", `type=bind,src=${TEST_PRIVATE_KEY_PATH},dst=/run/web-browser/test-key.pem,readonly`,
      "--mount", `type=bind,src=${proxyScriptPath},dst=/app/test/fixtures/web-browser-container-test-proxy.ts,readonly`,
      "--mount", `type=bind,src=${outputDirectory},dst=/run/web-browser-output`,
      "--log-driver", "none",
      "--entrypoint", "node", IMAGE, "--import", "tsx", "test/fixtures/web-browser-container-test-proxy.ts",
    ], 10000);
    proxyCreated = true;
    await docker(["start", proxyContainer], 5000);
    await docker(["network", "connect", "--gw-priority=1", egressNetwork, proxyContainer], 5000);
    const proxyNetworks = JSON.parse(await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", proxyContainer])) as Record<string, { IPAddress?: string }>;
    const proxyIp = proxyNetworks[browserNetwork]?.IPAddress;
    assert(typeof proxyIp === "string" && proxyIp.length > 0);
    assert.deepEqual(Object.keys(proxyNetworks).sort(), [browserNetwork, egressNetwork].sort());
    await waitForFile(join(outputDirectory, "proxy-ready"), proxyContainer);
    const tcpProbe = 'const net = require("node:net"); const socket = net.connect(3128, process.env.PROXY_IP); socket.once("connect", () => { process.stdout.write("proxy-connect-ok"); socket.destroy(); }); socket.once("error", (error) => { process.stdout.write("proxy-connect-error:" + (error.code ?? "unknown")); }); setTimeout(() => { socket.destroy(); process.stdout.write("proxy-connect-timeout"); }, 3000).unref();';
    assert.equal(await docker([
      "run", "--rm", "--network", browserNetwork, "--env", `PROXY_IP=${proxyIp}`,
      "--entrypoint", "node", IMAGE, "-e", tcpProbe,
    ], 5000), "proxy-connect-ok");

    await docker([
      "create", "--name", browserContainer, "--init", "--network", browserNetwork,
      "--dns", "127.0.0.1", "--user", `${userId}:${groupId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "128", "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--shm-size", "64m", "--ulimit", "nofile=256:256",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777,uid=${userId},gid=${groupId}`,
      "--mount", `type=bind,src=${configPath},dst=/run/web-browser/job.json,readonly`,
      "--mount", `type=bind,src=${outputDirectory},dst=/run/web-browser-output`,
      "--env", `HOME=/tmp/home-${id}`,
      "--env", "TMPDIR=/tmp",
      "--env", `AI_PROJECT_OS_WEB_BROWSER_PROXY_SERVER=http://${proxyIp}:3128`,
      "--log-driver", "none",
      IMAGE, "browser",
    ], 10000);
    browserCreated = true;
    const browserNetworks = JSON.parse(await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", browserContainer])) as Record<string, unknown>;
    assert.deepEqual(Object.keys(browserNetworks), [browserNetwork]);
    const network = JSON.parse(await docker(["network", "inspect", "--format", "{{json .}}", browserNetwork])) as Record<string, unknown>;
    const options = network.Options as Record<string, unknown>;
    const ipam = network.IPAM as Record<string, unknown>;
    const ipamConfig = (ipam.Config as Array<Record<string, unknown>>)[0];
    assert.equal(network.Internal, true);
    assert.equal(network.EnableIPv6, false);
    assert.equal(options["com.docker.network.bridge.gateway_mode_ipv4"], "isolated");
    assert.equal(ipamConfig.Gateway, undefined);

    await docker(["start", browserContainer], 5000);
    const exitCode = Number(await docker(["wait", browserContainer], 45_000));
    const result = await readRenderResult(outputDirectory);
    assert.equal(exitCode, 0);
    assert.equal(result.url, observedUrl);
    assert.match(result.text, /Rendered by JavaScript/u);
    const requests = await readFile(join(outputDirectory, "source-requests.txt"), "utf8");
    assert.match(requests, /^GET \/login$/mu);
    assert.match(requests, /^POST \/login\/submit$/mu);
    assert.match(requests, /^GET \/js$/mu);
  } finally {
    if (browserCreated) await removeContainer(browserContainer);
    if (proxyCreated) await removeContainer(proxyContainer);
    if (sourceCreated) await removeContainer(sourceContainer);
    if (egressNetworkCreated) await removeNetwork(egressNetwork);
    if (browserNetworkCreated) await removeNetwork(browserNetwork);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  for (const containerName of [sourceContainer, proxyContainer, browserContainer]) {
    await assert.rejects(docker(["inspect", containerName], 5000));
  }
});
