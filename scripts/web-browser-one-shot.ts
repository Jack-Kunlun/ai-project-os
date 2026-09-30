import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeWebBrowserTarget, WebBrowserProxyError } from "../src/lib/web-browser-policy";

const IMAGE = "ai-project-os-web-browser:0.7.0-dev.1";
const CONTRACT_LABEL = "0.7.0-dev.1-s1b-prototype";
const MAX_STDIN_BYTES = 4096;
const MAX_RESULT_BYTES = 128 * 1024;
const JOB_TIMEOUT_MS = 35_000;
const PROXY_READY_TIMEOUT_MS = 12_000;
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;

type DockerResult = Readonly<{ code: number; stdout: string }>;
type RenderResult = Readonly<{ url: string; text: string }>;

let interrupted = false;
process.once("SIGINT", () => { interrupted = true; });
process.once("SIGTERM", () => { interrupted = true; });

function failIsolation(): never {
  throw new WebBrowserProxyError("WEB_BROWSER_ISOLATION_UNAVAILABLE");
}

function runCommand(command: string, args: readonly string[], options: Readonly<{ timeoutMs?: number; maxOutputBytes?: number }> = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let settled = false;
    const limit = options.maxOutputBytes ?? MAX_DOCKER_OUTPUT_BYTES;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 10_000);
    const finish = (error?: Error, result?: DockerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(result!);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limit) {
        child.kill("SIGKILL");
        finish(new Error("output-limit"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) child.kill("SIGKILL");
      // Docker and OpenSSL diagnostics may include attacker-controlled hosts;
      // intentionally do not retain or print them.
    });
    child.once("error", () => finish(new Error("command-unavailable")));
    child.once("close", (code) => {
      if (code === 0) finish(undefined, { code: 0, stdout: stdout.trim() });
      else finish(new Error("command-failed"));
    });
  });
}

async function docker(args: readonly string[], options: Readonly<{ timeoutMs?: number; maxOutputBytes?: number }> = {}): Promise<string> {
  const result = await runCommand("docker", args, options);
  return result.stdout;
}

function dockerErrorCode(error: unknown): string {
  return error instanceof WebBrowserProxyError ? error.code : "WEB_BROWSER_ISOLATION_UNAVAILABLE";
}

async function readInputUrl(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) return failIsolation();
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return failIsolation();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failIsolation();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "url")) return failIsolation();
  return normalizeWebBrowserTarget(record.url).url;
}

async function verifyDockerRuntime(): Promise<void> {
  const [osType, version, labelsRaw] = await Promise.all([
    docker(["info", "--format", "{{.OSType}}"]),
    docker(["version", "--format", "{{.Server.Version}}"]),
    docker(["image", "inspect", "--format", "{{json .Config.Labels}}", IMAGE]),
  ]);
  const major = Number(/^v?(\d+)/u.exec(version)?.[1]);
  let labels: Record<string, string> | null = null;
  try { labels = JSON.parse(labelsRaw) as Record<string, string>; } catch { /* missing image */ }
  if (osType !== "linux" || !Number.isInteger(major) || major < 28 || labels?.["io.ai-project-os.web-browser-contract"] !== CONTRACT_LABEL) {
    return failIsolation();
  }
}

async function writeJobCertificate(directory: string, hostname: string): Promise<Readonly<{ certPath: string; keyPath: string; spki: string }>> {
  const certPath = join(directory, "proxy-cert.pem");
  const keyPath = join(directory, "proxy-key.pem");
  const configPath = join(directory, "openssl.cnf");
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const safeHost = bareHost.toLowerCase();
  if (!/^[a-z0-9.:-]+$/u.test(safeHost)) return failIsolation();
  const alternative = (await import("node:net")).isIP(safeHost) === 0 ? `DNS.1 = ${safeHost}` : `IP.1 = ${safeHost}`;
  const config = [
    "[req]",
    "distinguished_name = distinguished_name",
    "x509_extensions = server_extensions",
    "prompt = no",
    "[distinguished_name]",
    `CN = ${safeHost}`,
    "[server_extensions]",
    "basicConstraints = critical,CA:FALSE",
    "keyUsage = critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = @subject_alt_names",
    "[subject_alt_names]",
    alternative,
    "",
  ].join("\n");
  await writeFile(configPath, config, { mode: 0o600, flag: "wx" });
  await runCommand("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-subj", `/CN=${safeHost}`, "-config", configPath,
  ], { timeoutMs: 10_000, maxOutputBytes: 4096 });
  await Promise.all([chmod(keyPath, 0o600), chmod(certPath, 0o600)]);
  const x509 = new X509Certificate(await readFile(certPath));
  const spki = createHash("sha256").update(x509.publicKey.export({ format: "der", type: "spki" })).digest("base64");
  await rm(configPath, { force: true });
  return Object.freeze({ certPath, keyPath, spki });
}

function parseNetworkInspect(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failIsolation();
    return parsed as Record<string, unknown>;
  } catch {
    return failIsolation();
  }
}

async function verifyBrowserNetwork(name: string): Promise<void> {
  const network = parseNetworkInspect(await docker(["network", "inspect", "--format", "{{json .}}", name]));
  const options = typeof network.Options === "object" && network.Options !== null
    ? network.Options as Record<string, unknown>
    : {};
  const ipam = typeof network.IPAM === "object" && network.IPAM !== null
    ? network.IPAM as Record<string, unknown>
    : {};
  const config = Array.isArray(ipam.Config) ? ipam.Config[0] as Record<string, unknown> | undefined : undefined;
  if (
    network.Internal !== true ||
    options["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
    config?.Gateway !== undefined && config.Gateway !== "" ||
    network.EnableIPv6 === true
  ) return failIsolation();
}

async function containerNetworkMap(name: string): Promise<Record<string, { IPAddress?: string }>> {
  const inspect = parseNetworkInspect(await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", name]));
  return inspect as Record<string, { IPAddress?: string }>;
}

type ContainerExpectation = Readonly<{
  user: string;
  network: string;
  memoryBytes: number;
  pidsLimit: number;
  mounts: ReadonlyArray<Readonly<{ destination: string; readOnly: boolean }>>;
}>;

async function verifyContainerIsolation(name: string, expected: ContainerExpectation): Promise<void> {
  const container = parseNetworkInspect(await docker(["inspect", "--format", "{{json .}}", name]));
  const config = typeof container.Config === "object" && container.Config !== null
    ? container.Config as Record<string, unknown>
    : {};
  const host = typeof container.HostConfig === "object" && container.HostConfig !== null
    ? container.HostConfig as Record<string, unknown>
    : {};
  const securityOptions = Array.isArray(host.SecurityOpt) ? host.SecurityOpt : [];
  const droppedCapabilities = Array.isArray(host.CapDrop) ? host.CapDrop : [];
  const mounts = Array.isArray(container.Mounts) ? container.Mounts as Array<Record<string, unknown>> : [];
  const actualMounts = mounts.map((mount) => ({
    destination: mount.Destination,
    readOnly: mount.RW === false,
    type: mount.Type,
  })).sort((left, right) => String(left.destination).localeCompare(String(right.destination)));
  const expectedMounts = [...expected.mounts]
    .map((mount) => ({ ...mount, type: "bind" }))
    .sort((left, right) => left.destination.localeCompare(right.destination));
  const devices = Array.isArray(host.Devices) ? host.Devices : [];
  const deviceRequests = Array.isArray(host.DeviceRequests) ? host.DeviceRequests : [];
  const portBindings = typeof host.PortBindings === "object" && host.PortBindings !== null
    ? Object.values(host.PortBindings as Record<string, unknown>).some((value) => Array.isArray(value) && value.length > 0)
    : false;

  if (
    config.User !== expected.user || host.NetworkMode !== expected.network ||
    host.ReadonlyRootfs !== true || host.Privileged !== false ||
    host.Memory !== expected.memoryBytes || host.MemorySwap !== expected.memoryBytes ||
    host.PidsLimit !== expected.pidsLimit || host.NanoCpus !== 1_000_000_000 ||
    host.LogConfig === null || typeof host.LogConfig !== "object" || (host.LogConfig as Record<string, unknown>).Type !== "none" ||
    host.Binds !== null && host.Binds !== undefined && (!Array.isArray(host.Binds) || host.Binds.length > 0) ||
    !droppedCapabilities.includes("ALL") || !securityOptions.includes("no-new-privileges:true") ||
    devices.length > 0 || deviceRequests.length > 0 || portBindings ||
    JSON.stringify(actualMounts) !== JSON.stringify(expectedMounts)
  ) return failIsolation();
}

async function waitForProxyHealth(name: string): Promise<void> {
  const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (interrupted) return failIsolation();
    try {
      const health = await docker(["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}", name]);
      if (health === "healthy") return;
      if (health === "unhealthy" || health === "missing") return failIsolation();
    } catch {
      // The first healthcheck can race container startup.
    }
    await delay(250);
  }
  return failIsolation();
}

async function startBrowserAndReadResult(containerName: string, outputDirectory: string): Promise<RenderResult> {
  await docker(["start", containerName], { timeoutMs: 5000 });
  if (interrupted) return failIsolation();
  let containerExitCode: number;
  try {
    const exitCode = await docker(["wait", containerName], { timeoutMs: JOB_TIMEOUT_MS + 5000, maxOutputBytes: 1024 });
    containerExitCode = Number(exitCode);
    if (!Number.isInteger(containerExitCode) || containerExitCode < 0 || containerExitCode > 255) return failIsolation();
  } catch {
    try { await docker(["kill", containerName], { timeoutMs: 5000, maxOutputBytes: 1024 }); } catch { /* cleanup below */ }
    return failIsolation();
  }
  const raw = await readFile(join(outputDirectory, "result.json"));
  if (raw.length > MAX_RESULT_BYTES) return failIsolation();
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { return failIsolation(); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failIsolation();
  const result = parsed as Record<string, unknown>;
  if (typeof result.error === "string") {
    const code = [
      "WEB_BROWSER_INVALID_TARGET", "WEB_BROWSER_PROXY_AUTH_REQUIRED", "WEB_BROWSER_TARGET_REJECTED",
      "WEB_BROWSER_DNS_REJECTED", "WEB_BROWSER_METHOD_REJECTED", "WEB_BROWSER_REDIRECT_REJECTED",
      "WEB_BROWSER_RESOURCE_LIMIT", "WEB_BROWSER_UPSTREAM_FAILED", "WEB_BROWSER_RENDER_FAILED",
      "WEB_BROWSER_ISOLATION_UNAVAILABLE",
    ].includes(result.error) ? result.error : "WEB_BROWSER_RENDER_FAILED";
    throw new WebBrowserProxyError(code as never);
  }
  if (containerExitCode !== 0) return failIsolation();
  if (typeof result.url !== "string" || typeof result.text !== "string" || result.text.length > 20_000) return failIsolation();
  return Object.freeze({ url: result.url, text: result.text });
}

async function removeContainer(name: string): Promise<void> {
  try { await docker(["rm", "--force", name], { timeoutMs: 5000, maxOutputBytes: 1024 }); } catch { /* exact generated name */ }
}

async function removeNetwork(name: string): Promise<void> {
  try { await docker(["network", "rm", name], { timeoutMs: 5000, maxOutputBytes: 1024 }); } catch { /* exact generated name */ }
}

async function runOneShot(url: string): Promise<RenderResult> {
  const userId = process.getuid?.();
  const groupId = process.getgid?.();
  if (userId === undefined || groupId === undefined || userId === 0 || interrupted) return failIsolation();

  const id = randomBytes(12).toString("hex");
  const browserNetwork = `aipos-web-browser-${id}`;
  const egressNetwork = `aipos-web-egress-${id}`;
  const proxyContainer = `aipos-web-proxy-${id}`;
  const browserContainer = `aipos-web-render-${id}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-web-browser-"));
  const outputDirectory = join(temporaryDirectory, "output");
  const configPath = join(temporaryDirectory, "job.json");
  await chmod(temporaryDirectory, 0o700);
  await mkdir(outputDirectory, { mode: 0o700 });

  let browserNetworkCreated = false;
  let egressNetworkCreated = false;
  let proxyCreated = false;
  let browserCreated = false;
  try {
    await verifyDockerRuntime();
    const target = normalizeWebBrowserTarget(url);
    const certificate = await writeJobCertificate(temporaryDirectory, target.hostname);
    const proxyUsername = `browser-${id}`;
    const proxyPassword = randomBytes(32).toString("base64url");
    const config = JSON.stringify({
      url: target.url,
      origin: target.origin,
      proxyUsername,
      proxyPassword,
      certificateSpki: certificate.spki,
    });
    if (Buffer.byteLength(config, "utf8") > MAX_STDIN_BYTES * 2) return failIsolation();
    await writeFile(configPath, config, { mode: 0o600, flag: "wx" });

    await docker([
      "network", "create", "--driver", "bridge", "--internal", "--ipv6=false",
      "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      browserNetwork,
    ]);
    browserNetworkCreated = true;
    await verifyBrowserNetwork(browserNetwork);
    await docker(["network", "create", "--driver", "bridge", "--ipv6=false", egressNetwork]);
    egressNetworkCreated = true;

    await docker([
      "create", "--name", proxyContainer, "--init", "--network", browserNetwork,
      "--user", `${userId}:${groupId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "48", "--memory", "192m", "--memory-swap", "192m", "--cpus", "1", "--ulimit", "nofile=256:256",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777,uid=${userId},gid=${groupId}`,
      "--mount", `type=bind,src=${configPath},dst=/run/web-browser/job.json,readonly`,
      "--mount", `type=bind,src=${certificate.certPath},dst=/run/web-browser/proxy-cert.pem,readonly`,
      "--mount", `type=bind,src=${certificate.keyPath},dst=/run/web-browser/proxy-key.pem,readonly`,
      "--log-driver", "none",
      "--health-cmd", "node --import tsx scripts/web-browser-container.ts health",
      "--health-interval", "1s", "--health-timeout", "1s", "--health-retries", "10",
      "--health-start-period", "1s",
      IMAGE, "proxy",
    ], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    proxyCreated = true;
    await verifyContainerIsolation(proxyContainer, {
      user: `${userId}:${groupId}`,
      network: browserNetwork,
      memoryBytes: 192 * 1024 * 1024,
      pidsLimit: 48,
      mounts: [
        { destination: "/run/web-browser/job.json", readOnly: true },
        { destination: "/run/web-browser/proxy-cert.pem", readOnly: true },
        { destination: "/run/web-browser/proxy-key.pem", readOnly: true },
      ],
    });
    await docker(["start", proxyContainer], { timeoutMs: 5000, maxOutputBytes: 4096 });
    await waitForProxyHealth(proxyContainer);
    await docker(["network", "connect", "--gw-priority=1", egressNetwork, proxyContainer], { timeoutMs: 5000, maxOutputBytes: 4096 });
    const proxyNetworks = await containerNetworkMap(proxyContainer);
    const proxyIp = proxyNetworks[browserNetwork]?.IPAddress;
    if (typeof proxyIp !== "string" || proxyIp.length === 0 || Object.keys(proxyNetworks).sort().join(",") !== [browserNetwork, egressNetwork].sort().join(",")) {
      return failIsolation();
    }

    await docker([
      "create", "--name", browserContainer, "--init", "--network", browserNetwork,
      "--dns", "127.0.0.1", "--user", `${userId}:${groupId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "128", "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--shm-size", "64m", "--ulimit", "nofile=256:256",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777,uid=${userId},gid=${groupId}`,
      "--mount", `type=bind,src=${configPath},dst=/run/web-browser/job.json,readonly`,
      "--mount", `type=bind,src=${outputDirectory},dst=/run/web-browser-output`,
      "--env", `HOME=/tmp/home-${id}`,
      "--env", `TMPDIR=/tmp`,
      "--env", `AI_PROJECT_OS_WEB_BROWSER_PROXY_SERVER=http://${proxyIp}:3128`,
      "--log-driver", "none",
      IMAGE, "browser",
    ], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    browserCreated = true;
    await verifyContainerIsolation(browserContainer, {
      user: `${userId}:${groupId}`,
      network: browserNetwork,
      memoryBytes: 768 * 1024 * 1024,
      pidsLimit: 128,
      mounts: [
        { destination: "/run/web-browser/job.json", readOnly: true },
        { destination: "/run/web-browser-output", readOnly: false },
      ],
    });

    const browserNetworks = await containerNetworkMap(browserContainer);
    if (Object.keys(browserNetworks).join(",") !== browserNetwork || browserNetworks[browserNetwork]?.IPAddress === undefined) {
      return failIsolation();
    }

    return await startBrowserAndReadResult(browserContainer, outputDirectory);
  } finally {
    if (browserCreated) await removeContainer(browserContainer);
    if (proxyCreated) await removeContainer(proxyContainer);
    if (egressNetworkCreated) await removeNetwork(egressNetwork);
    if (browserNetworkCreated) await removeNetwork(browserNetwork);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    const url = await readInputUrl();
    const result = await runOneShot(url);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: dockerErrorCode(error) })}\n`);
    process.exitCode = 1;
  }
}

main();
