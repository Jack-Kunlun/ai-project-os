import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { browserResourceIdForJob } from "../src/lib/web-browser-broker-protocol";
import {
  assertWebBrowserCredentialAbsent,
  normalizeWebBrowserSiteForm,
  normalizeWebBrowserTarget,
  WebBrowserProxyError,
  type WebBrowserSiteForm,
} from "../src/lib/web-browser-policy";

const PROTOTYPE_IMAGE = "ai-project-os-web-browser:0.7.0-dev.1";
const CONTRACT_LABEL = "0.7.0-dev.1-s1b-prototype";
const MANAGED_BY_LABEL = "io.ai-project-os.web-browser.managed-by";
const MANAGED_BY_VALUE = "one-shot-v1";
const JOB_LABEL = "io.ai-project-os.web-browser.job";
const RESOURCE_LABEL = "io.ai-project-os.web-browser.resource";
const IMAGE_DIGEST_ENV = "AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST";
const MODE_ENV = "AI_PROJECT_OS_WEB_BROWSER_MODE";
const MAX_STDIN_BYTES = 8192;
const MAX_RESULT_BYTES = 128 * 1024;
const JOB_TIMEOUT_MS = 35_000;
const PROXY_READY_TIMEOUT_MS = 12_000;
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;

type DockerResult = Readonly<{ code: number; stdout: string }>;
type RenderResult = Readonly<{ url: string; text: string }>;
type BrowserJobResult = RenderResult & Readonly<{ networkFingerprint: string; imageDigest: string }>;
export type BrowserJobInput = Readonly<{ url: string; siteForm?: WebBrowserSiteForm; expectedNetworkFingerprint?: string; jobId?: string }>;
type BrowserImageConfiguration = Readonly<{ mode: "prototype" | "pinned"; image: string; immutable: boolean }>;
export type BrowserJobContainerConfigs = Readonly<{
  browser: Readonly<Record<string, unknown>>;
  proxy: Readonly<Record<string, unknown>>;
}>;
type DockerCommand = (args: readonly string[], options?: Readonly<{ timeoutMs?: number; maxOutputBytes?: number }>) => Promise<string>;

const RESOURCE_NAMES = Object.freeze({
  proxy: (id: string) => `aipos-web-proxy-${id}`,
  browser: (id: string) => `aipos-web-render-${id}`,
  browserNetwork: (id: string) => `aipos-web-browser-${id}`,
  egressNetwork: (id: string) => `aipos-web-egress-${id}`,
});

export function resolveBrowserImageConfiguration(environment: Readonly<Record<string, string | undefined>>): BrowserImageConfiguration {
  const requestedMode = environment[MODE_ENV];
  const productionIntent = environment.NODE_ENV === "production" || requestedMode === "pinned";
  if (requestedMode !== undefined && requestedMode !== "prototype" && requestedMode !== "pinned") return failIsolation();
  if (productionIntent && requestedMode === "prototype") return failIsolation();

  if (productionIntent) {
    const image = environment[IMAGE_DIGEST_ENV];
    if (typeof image !== "string" || !isImmutableImageReference(image)) return failIsolation();
    return Object.freeze({ mode: "pinned", image, immutable: true });
  }

  if (environment[IMAGE_DIGEST_ENV] !== undefined) return failIsolation();
  return Object.freeze({ mode: "prototype", image: PROTOTYPE_IMAGE, immutable: false });
}

function isImmutableImageReference(value: string): boolean {
  const separator = value.lastIndexOf("@sha256:");
  if (separator < 0) return false;
  const repository = value.slice(0, separator);
  const digest = value.slice(separator + "@sha256:".length);
  if (!/^[a-f0-9]{64}$/u.test(digest)) return false;
  const [registry, ...repositoryParts] = repository.split("/");
  if (registry === undefined || repositoryParts.length === 0) return false;
  const registryMatch = /^(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::([1-9][0-9]{0,4}))?$/u.exec(registry);
  const validRepositoryParts = repositoryParts.every((part) => /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/u.test(part));
  if (registryMatch === null || !validRepositoryParts) return false;
  const port = registryMatch[1];
  return port === undefined || Number(port) <= 65_535;
}

export function parseOneShotInput(value: unknown): BrowserJobInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failIsolation();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.includes("url") || keys.some((key) => !["url", "siteForm", "expectedNetworkFingerprint", "jobId"].includes(key)) || keys.length > 4) return failIsolation();
  if (record.jobId !== undefined &&
      (typeof record.jobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.jobId))) return failIsolation();
  if (record.expectedNetworkFingerprint !== undefined &&
      (typeof record.expectedNetworkFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(record.expectedNetworkFingerprint))) return failIsolation();
  const url = normalizeWebBrowserTarget(record.url).url;
  return Object.freeze({
    url,
    ...(record.expectedNetworkFingerprint === undefined ? {} : { expectedNetworkFingerprint: record.expectedNetworkFingerprint as string }),
    ...(record.jobId === undefined ? {} : { jobId: record.jobId as string }),
    ...(record.siteForm === undefined ? {} : { siteForm: normalizeWebBrowserSiteForm(record.siteForm, url) }),
  });
}

export function browserJobContainerConfigs(
  job: BrowserJobInput,
  origin: string,
  proxyUsername: string,
  proxyPassword: string,
  certificateSpki: string,
): BrowserJobContainerConfigs {
  const common = {
    origin, proxyUsername, proxyPassword,
    ...(job.expectedNetworkFingerprint === undefined ? {} : { expectedNetworkFingerprint: job.expectedNetworkFingerprint }),
  };
  return Object.freeze({
    browser: Object.freeze({ url: job.url, ...common, certificateSpki, ...(job.siteForm === undefined ? {} : { siteForm: job.siteForm }) }),
    proxy: Object.freeze({ ...common, ...(job.siteForm === undefined ? {} : { formPostUrl: job.siteForm.submitUrl }) }),
  });
}

export function verifyBrowserImageInspection(value: unknown, expected: BrowserImageConfiguration): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failIsolation();
  const image = value as Record<string, unknown>;
  const config = typeof image.Config === "object" && image.Config !== null && !Array.isArray(image.Config)
    ? image.Config as Record<string, unknown>
    : {};
  const labels = typeof config.Labels === "object" && config.Labels !== null && !Array.isArray(config.Labels)
    ? config.Labels as Record<string, unknown>
    : {};
  if (
    typeof image.Id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(image.Id) ||
    labels["io.ai-project-os.web-browser-contract"] !== CONTRACT_LABEL
  ) return failIsolation();

  if (expected.immutable) {
    const repoDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
    if (!repoDigests.includes(expected.image)) return failIsolation();
  }
  return image.Id;
}

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

async function readInputJob(): Promise<BrowserJobInput> {
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
  return parseOneShotInput(value);
}

async function verifyDockerRuntime(configuration: BrowserImageConfiguration): Promise<string> {
  const [osType, version, labelsRaw] = await Promise.all([
    docker(["info", "--format", "{{.OSType}}"]),
    docker(["version", "--format", "{{.Server.Version}}"]),
    docker(["image", "inspect", "--format", "{{json .}}", configuration.image]),
  ]);
  const major = Number(/^v?(\d+)/u.exec(version)?.[1]);
  if (osType !== "linux" || !Number.isInteger(major) || major < 28) return failIsolation();
  let imageInspection: unknown;
  try { imageInspection = JSON.parse(labelsRaw) as unknown; } catch { return failIsolation(); }
  return verifyBrowserImageInspection(imageInspection, configuration);
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

function expectedResourceLabels(id: string, resource: string): Readonly<Record<string, string>> {
  return Object.freeze({
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [JOB_LABEL]: id,
    [RESOURCE_LABEL]: resource,
  });
}

function dockerLabels(id: string, resource: string): string[] {
  return Object.entries(expectedResourceLabels(id, resource)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function hasExactResourceIdentity(
  actual: unknown,
  expected: Readonly<{ id: string; name: string; resource: string }>,
  isNetwork: boolean,
): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const record = actual as Record<string, unknown>;
  const labels = isNetwork
    ? record.Labels
    : typeof record.Config === "object" && record.Config !== null && !Array.isArray(record.Config)
      ? (record.Config as Record<string, unknown>).Labels
      : undefined;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return false;
  const expectedLabels = expectedResourceLabels(expected.id, expected.resource);
  return record.Name === (isNetwork ? expected.name : `/${expected.name}`) &&
    Object.entries(expectedLabels).every(([key, value]) => (labels as Record<string, unknown>)[key] === value) &&
    typeof record.Id === "string" && /^[a-f0-9]{64}$/u.test(record.Id);
}

async function verifyBrowserNetwork(name: string, id: string, resource: string): Promise<void> {
  const network = parseNetworkInspect(await docker(["network", "inspect", "--format", "{{json .}}", name]));
  const options = typeof network.Options === "object" && network.Options !== null
    ? network.Options as Record<string, unknown>
    : {};
  const ipam = typeof network.IPAM === "object" && network.IPAM !== null
    ? network.IPAM as Record<string, unknown>
    : {};
  const config = Array.isArray(ipam.Config) ? ipam.Config[0] as Record<string, unknown> | undefined : undefined;
  if (
    !hasExactResourceIdentity(network, { id, name, resource }, true) ||
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
  id: string;
  name: string;
  resource: string;
  imageId: string;
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
    !hasExactResourceIdentity(container, expected, false) || container.Image !== expected.imageId ||
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
      "WEB_BROWSER_LOGIN_FAILED", "WEB_BROWSER_CREDENTIAL_REFLECTION",
      "WEB_BROWSER_ISOLATION_UNAVAILABLE",
    ].includes(result.error) ? result.error : "WEB_BROWSER_RENDER_FAILED";
    throw new WebBrowserProxyError(code as never);
  }
  if (containerExitCode !== 0) return failIsolation();
  if (typeof result.url !== "string" || typeof result.text !== "string" || result.text.length > 20_000) return failIsolation();
  return Object.freeze({ url: result.url, text: result.text });
}

type OwnedResource = Readonly<{ id: string; name: string; resource: string; network: boolean }>;

function labelsOf(record: Record<string, unknown>, network: boolean): Record<string, unknown> {
  if (network) return typeof record.Labels === "object" && record.Labels !== null && !Array.isArray(record.Labels)
    ? record.Labels as Record<string, unknown>
    : {};
  const config = typeof record.Config === "object" && record.Config !== null && !Array.isArray(record.Config)
    ? record.Config as Record<string, unknown>
    : {};
  return typeof config.Labels === "object" && config.Labels !== null && !Array.isArray(config.Labels)
    ? config.Labels as Record<string, unknown>
    : {};
}

function parseResourceIds(value: string): string[] {
  if (value.length === 0) return [];
  const ids = value.split(/\s+/u).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{64}$/u.test(id))) return failIsolation();
  return [...new Set(ids)];
}

function resourceIdentityForName(name: string, id: string): Readonly<{ name: string; resource: string }> | undefined {
  const resources = [
    { resource: "proxy", name: RESOURCE_NAMES.proxy(id) },
    { resource: "browser", name: RESOURCE_NAMES.browser(id) },
    { resource: "browser-network", name: RESOURCE_NAMES.browserNetwork(id) },
    { resource: "egress-network", name: RESOURCE_NAMES.egressNetwork(id) },
  ];
  const match = resources.find((item) => item.name === name);
  if (match !== undefined) return Object.freeze(match);
  return undefined;
}

async function discoverOwnedResources(id: string, command: DockerCommand): Promise<OwnedResource[]> {
  if (!/^[a-f0-9]{24}$/u.test(id)) return failIsolation();
  const labelFilter = [`--filter`, `label=${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`, `--filter`, `label=${JOB_LABEL}=${id}`];
  const [containerOutput, networkOutput] = await Promise.all([
    command(["ps", "--all", "--quiet", "--no-trunc", ...labelFilter]),
    command(["network", "ls", "--quiet", "--no-trunc", ...labelFilter]),
  ]);
  const owned: OwnedResource[] = [];

  for (const containerId of parseResourceIds(containerOutput)) {
    const raw = await command(["inspect", "--format", "{{json .}}", containerId]);
    const inspect = parseNetworkInspect(raw);
    const name = typeof inspect.Name === "string" ? inspect.Name.replace(/^\//u, "") : "";
    const identity = resourceIdentityForName(name, id);
    if (identity === undefined || !hasExactResourceIdentity(inspect, { ...identity, id }, false) || inspect.Id !== containerId) return failIsolation();
    owned.push(Object.freeze({ id: containerId, name, resource: identity.resource, network: false }));
  }

  for (const networkId of parseResourceIds(networkOutput)) {
    const raw = await command(["network", "inspect", "--format", "{{json .}}", networkId]);
    const inspect = parseNetworkInspect(raw);
    const name = typeof inspect.Name === "string" ? inspect.Name : "";
    const identity = resourceIdentityForName(name, id);
    if (identity === undefined || !hasExactResourceIdentity(inspect, { ...identity, id }, true) || inspect.Id !== networkId) return failIsolation();
    owned.push(Object.freeze({ id: networkId, name, resource: identity.resource, network: true }));
  }
  return owned;
}

export async function cleanupOwnedJobResources(id: string, command: DockerCommand = docker): Promise<void> {
  const resources = await discoverOwnedResources(id, command);
  let removalFailed = false;
  for (const resource of resources.filter((item) => !item.network)) {
    try { await command(["rm", "--force", resource.id], { timeoutMs: 5000, maxOutputBytes: 1024 }); }
    catch { removalFailed = true; }
  }
  for (const resource of resources.filter((item) => item.network)) {
    try { await command(["network", "rm", resource.id], { timeoutMs: 5000, maxOutputBytes: 1024 }); }
    catch { removalFailed = true; }
  }
  let remaining: OwnedResource[];
  try { remaining = await discoverOwnedResources(id, command); }
  catch { return failIsolation(); }
  if (removalFailed || remaining.length > 0) return failIsolation();
}

export async function listOwnedJobIds(command: DockerCommand = docker): Promise<string[]> {
  const labelFilter = ["--filter", `label=${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`];
  const [containerOutput, networkOutput] = await Promise.all([
    command(["ps", "--all", "--quiet", "--no-trunc", ...labelFilter]),
    command(["network", "ls", "--quiet", "--no-trunc", ...labelFilter]),
  ]);
  const ids = new Set<string>();
  for (const [resourceIds, network] of [
    [parseResourceIds(containerOutput), false],
    [parseResourceIds(networkOutput), true],
  ] as const) {
    for (const resourceId of resourceIds) {
      const raw = network
        ? await command(["network", "inspect", "--format", "{{json .}}", resourceId])
        : await command(["inspect", "--format", "{{json .}}", resourceId]);
      const inspect = parseNetworkInspect(raw);
      const labels = labelsOf(inspect, network);
      const jobId = labels[JOB_LABEL];
      const name = typeof inspect.Name === "string" ? inspect.Name.replace(/^\//u, "") : "";
      const identity = typeof jobId === "string" && /^[a-f0-9]{24}$/u.test(jobId)
        ? resourceIdentityForName(name, jobId)
        : undefined;
      if (
        labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE || identity === undefined ||
        !hasExactResourceIdentity(inspect, { ...identity, id: jobId as string }, network) ||
        inspect.Id !== resourceId
      ) return failIsolation();
      ids.add(jobId as string);
    }
  }
  return [...ids].sort();
}

function managedJobDirectory(id: string): string {
  if (!/^[a-f0-9]{24}$/u.test(id)) return failIsolation();
  return join(tmpdir(), `aipos-web-job-${id}`);
}

export async function cleanupOwnedJobDirectory(id: string): Promise<void> {
  const path = managedJobDirectory(id);
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    return failIsolation();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o700) return failIsolation();
  await rm(path, { recursive: true });
}

async function listOwnedJobDirectories(): Promise<string[]> {
  const ids: string[] = [];
  for (const name of await readdir(tmpdir())) {
    const match = /^aipos-web-job-([a-f0-9]{24})$/u.exec(name);
    if (match === null) continue;
    const metadata = await lstat(join(tmpdir(), name));
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o777) !== 0o700) return failIsolation();
    ids.push(match[1]!);
  }
  return ids;
}

async function runOneShot(job: BrowserJobInput, configuration: BrowserImageConfiguration): Promise<BrowserJobResult> {
  const userId = process.getuid?.();
  const groupId = process.getgid?.();
  if (userId === undefined || groupId === undefined || userId === 0 || interrupted) return failIsolation();

  const id = job.jobId === undefined ? randomBytes(12).toString("hex") : browserResourceIdForJob(job.jobId);
  const browserNetwork = RESOURCE_NAMES.browserNetwork(id);
  const egressNetwork = RESOURCE_NAMES.egressNetwork(id);
  const proxyContainer = RESOURCE_NAMES.proxy(id);
  const browserContainer = RESOURCE_NAMES.browser(id);
  const temporaryDirectory = job.jobId === undefined
    ? await mkdtemp(join(tmpdir(), "ai-project-os-web-browser-"))
    : managedJobDirectory(id);
  if (job.jobId !== undefined) await mkdir(temporaryDirectory, { mode: 0o700 });
  const outputDirectory = join(temporaryDirectory, "output");
  const evidenceDirectory = join(temporaryDirectory, "evidence");
  const configPath = join(temporaryDirectory, "job.json");
  const proxyConfigPath = join(temporaryDirectory, "proxy-job.json");

  try {
    await chmod(temporaryDirectory, 0o700);
    await mkdir(outputDirectory, { mode: 0o700 });
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const imageId = await verifyDockerRuntime(configuration);
    const target = normalizeWebBrowserTarget(job.url);
    const certificate = await writeJobCertificate(temporaryDirectory, target.hostname);
    const proxyUsername = `browser-${id}`;
    const proxyPassword = randomBytes(32).toString("base64url");
    const configs = browserJobContainerConfigs(job, target.origin, proxyUsername, proxyPassword, certificate.spki);
    const browserConfig = JSON.stringify(configs.browser);
    const proxyConfig = JSON.stringify(configs.proxy);
    if (Buffer.byteLength(browserConfig, "utf8") > MAX_STDIN_BYTES * 2 || Buffer.byteLength(proxyConfig, "utf8") > MAX_STDIN_BYTES) return failIsolation();
    await writeFile(configPath, browserConfig, { mode: 0o600, flag: "wx" });
    await writeFile(proxyConfigPath, proxyConfig, { mode: 0o600, flag: "wx" });

    await docker([
      "network", "create", "--driver", "bridge", "--internal", "--ipv6=false",
      "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      ...dockerLabels(id, "browser-network"),
      browserNetwork,
    ]);
    await verifyBrowserNetwork(browserNetwork, id, "browser-network");
    await docker(["network", "create", "--driver", "bridge", "--ipv6=false", ...dockerLabels(id, "egress-network"), egressNetwork]);
    const egressNetworkRecord = parseNetworkInspect(await docker(["network", "inspect", "--format", "{{json .}}", egressNetwork]));
    if (!hasExactResourceIdentity(egressNetworkRecord, { id, name: egressNetwork, resource: "egress-network" }, true)) return failIsolation();

    await docker([
      "create", "--name", proxyContainer, "--init", "--network", browserNetwork,
      ...dockerLabels(id, "proxy"),
      "--user", `${userId}:${groupId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "48", "--memory", "192m", "--memory-swap", "192m", "--cpus", "1", "--ulimit", "nofile=256:256",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777,uid=${userId},gid=${groupId}`,
      "--mount", `type=bind,src=${proxyConfigPath},dst=/run/web-browser/job.json,readonly`,
      "--mount", `type=bind,src=${certificate.certPath},dst=/run/web-browser/proxy-cert.pem,readonly`,
      "--mount", `type=bind,src=${certificate.keyPath},dst=/run/web-browser/proxy-key.pem,readonly`,
      "--mount", `type=bind,src=${evidenceDirectory},dst=/run/web-browser-evidence`,
      "--log-driver", "none",
      "--health-cmd", "node --import tsx scripts/web-browser-container.ts health",
      "--health-interval", "1s", "--health-timeout", "1s", "--health-retries", "10",
      "--health-start-period", "1s",
      configuration.image, "proxy",
    ], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    await verifyContainerIsolation(proxyContainer, {
      id,
      name: proxyContainer,
      resource: "proxy",
      imageId,
      user: `${userId}:${groupId}`,
      network: browserNetwork,
      memoryBytes: 192 * 1024 * 1024,
      pidsLimit: 48,
      mounts: [
        { destination: "/run/web-browser/job.json", readOnly: true },
        { destination: "/run/web-browser/proxy-cert.pem", readOnly: true },
        { destination: "/run/web-browser/proxy-key.pem", readOnly: true },
        { destination: "/run/web-browser-evidence", readOnly: false },
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
      ...dockerLabels(id, "browser"),
      "--dns", "127.0.0.1", "--user", `${userId}:${groupId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "128", "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--shm-size", "64m", "--ulimit", "nofile=256:256",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777,uid=${userId},gid=${groupId}`,
      "--mount", `type=bind,src=${configPath},dst=/run/web-browser/job.json,readonly`,
      "--mount", `type=bind,src=${outputDirectory},dst=/run/web-browser-output`,
      "--env", `HOME=/tmp/home-${id}`,
      "--env", `TMPDIR=/tmp`,
      "--env", `AI_PROJECT_OS_WEB_BROWSER_PROXY_SERVER=http://${proxyIp}:3128`,
      "--log-driver", "none",
      configuration.image, "browser",
    ], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    await verifyContainerIsolation(browserContainer, {
      id,
      name: browserContainer,
      resource: "browser",
      imageId,
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

    const result = await startBrowserAndReadResult(browserContainer, outputDirectory);
    if (job.siteForm !== undefined) assertWebBrowserCredentialAbsent([result.url, result.text], job.siteForm);
    await docker(["stop", "--time", "3", proxyContainer], { timeoutMs: 6000, maxOutputBytes: 1024 });
    const evidenceRaw = await readFile(join(evidenceDirectory, "network.json"));
    if (evidenceRaw.length > 256) return failIsolation();
    let evidence: unknown;
    try { evidence = JSON.parse(evidenceRaw.toString("utf8")); } catch { return failIsolation(); }
    if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return failIsolation();
    const networkFingerprint = (evidence as Record<string, unknown>).networkFingerprint;
    if (typeof networkFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(networkFingerprint)) return failIsolation();
    return Object.freeze({ ...result, networkFingerprint, imageDigest: configuration.image });
  } finally {
    let cleanupFailed = false;
    try { await cleanupOwnedJobResources(id); } catch { cleanupFailed = true; }
    try { await rm(temporaryDirectory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed) return failIsolation();
  }
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--list-owned-jobs") {
      const jobIds = new Set([...await listOwnedJobIds(), ...await listOwnedJobDirectories()]);
      process.stdout.write(`${JSON.stringify({ jobIds: [...jobIds].sort() })}\n`);
      return;
    }
    if (args.length === 1 && args[0].startsWith("--cleanup-owned-job=")) {
      const jobId = args[0].slice("--cleanup-owned-job=".length);
      await cleanupOwnedJobResources(jobId);
      await cleanupOwnedJobDirectory(jobId);
      process.stdout.write(`${JSON.stringify({ cleaned: true })}\n`);
      return;
    }
    if (args.length !== 0) return failIsolation();
    const configuration = resolveBrowserImageConfiguration(process.env);
    const job = await readInputJob();
    const result = await runOneShot(job, configuration);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: dockerErrorCode(error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) void main();
