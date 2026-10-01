import { lookup as dnsLookup } from "node:dns/promises";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createWebBrowserEgressProxyForTest } from "../../src/lib/web-browser-egress-proxy";

const CONFIG_PATH = "/run/web-browser/job.json";
const CERTIFICATE_PATH = "/run/web-browser/test-cert.pem";
const PRIVATE_KEY_PATH = "/run/web-browser/test-key.pem";
const OUTPUT_PATH = "/run/web-browser-output/proxy-ready";
const LOOKUPS_PATH = "/run/web-browser-output/proxy-lookups.txt";
const CONNECTIONS_PATH = "/run/web-browser-output/proxy-connections.txt";

async function main(): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid-test-config");
  const job = parsed as Record<string, unknown>;
  if (
    typeof job.origin !== "string" || typeof job.proxyUsername !== "string" ||
    typeof job.proxyPassword !== "string" || typeof job.formPostUrl !== "string" ||
    Object.keys(job).some((key) => !["origin", "proxyUsername", "proxyPassword", "formPostUrl"].includes(key))
  ) throw new Error("invalid-test-config");
  const expectedHostname = new URL(job.origin).hostname.toLowerCase();
  const [certificate, privateKey] = await Promise.all([
    readFile(CERTIFICATE_PATH),
    readFile(PRIVATE_KEY_PATH),
  ]);
  const proxy = createWebBrowserEgressProxyForTest({
    sourceOrigin: job.origin,
    username: job.proxyUsername,
    password: job.proxyPassword,
    certificate,
    privateKey,
    host: "0.0.0.0",
    port: 3128,
    maxRequests: 64,
    maxRequestBytes: 4 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    requestTimeoutMs: 8_000,
    jobTimeoutMs: 30_000,
    maxTunnels: 32,
    formPostUrl: job.formPostUrl,
    maxFormPostBytes: 8192,
  }, {
    // This test-only container maps the one expected fixture hostname to the
    // local source container on a private internal network. The production
    // proxy has no private-address escape.
    allowPrivateAddresses: true,
    resolveHostname: async (hostname) => {
      if (hostname.toLowerCase() !== expectedHostname) throw new Error("unexpected-test-host");
      await appendFile(LOOKUPS_PATH, `lookup ${hostname}\n`, { mode: 0o600 });
      const addresses = await dnsLookup("web-browser-test-origin", { all: true, verbatim: true });
      await appendFile(LOOKUPS_PATH, `${JSON.stringify(addresses)}\n`, { mode: 0o600 });
      return addresses;
    },
    upstreamCa: certificate,
  });
  proxy.server.on("connection", async (socket) => {
    await appendFile(CONNECTIONS_PATH, `tcp ${socket.remoteAddress ?? "unknown"}\n`, { mode: 0o600 });
  });
  proxy.server.on("connect", async (request) => {
    await appendFile(CONNECTIONS_PATH, `connect ${request.url ?? "unknown"} auth=${typeof request.headers["proxy-authorization"] === "string"}\n`, { mode: 0o600 });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(3128, "0.0.0.0", resolve);
  });
  await writeFile(OUTPUT_PATH, "ready\n", { flag: "wx", mode: 0o600 });
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  await proxy.close();
}

main().catch(() => { process.exitCode = 1; });
