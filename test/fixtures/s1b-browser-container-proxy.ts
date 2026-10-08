import { lookup as dnsLookup } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { createWebBrowserEgressProxyForTest } from "../../src/lib/web-browser-egress-proxy";

const CONFIG_PATH = "/run/web-browser/job.json";
const CERTIFICATE_PATH = "/run/web-browser/test-cert.pem";
const PRIVATE_KEY_PATH = "/run/web-browser/test-key.pem";
const OUTPUT_DIRECTORY = "/run/web-browser-output";

async function main(): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid-test-config");
  const job = parsed as Record<string, unknown>;
  if (typeof job.origin !== "string" || typeof job.proxyUsername !== "string" ||
      typeof job.proxyPassword !== "string" || typeof job.formPostUrl !== "string" ||
      typeof job.expectedNetworkFingerprint !== "string" ||
      Object.keys(job).some((key) => !["origin", "proxyUsername", "proxyPassword", "formPostUrl", "expectedNetworkFingerprint"].includes(key))) {
    throw new Error("invalid-test-config");
  }
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
    expectedNetworkFingerprint: job.expectedNetworkFingerprint,
  }, {
    // This fixture resolves exactly one synthetic hostname to its private
    // source container. Production egress has no private-address exception.
    allowPrivateAddresses: true,
    resolveHostname: async (hostname) => {
      if (hostname.toLowerCase() !== expectedHostname) throw new Error("unexpected-test-host");
      return dnsLookup("s1b-test-origin", { all: true, verbatim: true });
    },
    upstreamCa: certificate,
  });
  await new Promise<void>((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(3128, "0.0.0.0", resolve);
  });
  await writeFile(`${OUTPUT_DIRECTORY}/proxy-ready`, "ready\n", { flag: "wx", mode: 0o600 });
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  await proxy.close();
  const networkFingerprint = proxy.networkFingerprint();
  if (networkFingerprint === null) throw new Error("test-network-fingerprint-missing");
  await writeFile(`${OUTPUT_DIRECTORY}/network.json`, JSON.stringify({ networkFingerprint }), { flag: "wx", mode: 0o600 });
}

main().catch(() => { process.exitCode = 1; });
