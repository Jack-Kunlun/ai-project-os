import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { connect as connectTcp, isIP } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  createWebBrowserEgressProxy,
  type WebBrowserEgressProxy,
} from "../src/lib/web-browser-egress-proxy";
import {
  isPublicWebBrowserAddress,
  normalizeWebBrowserTarget,
  normalizeWebBrowserSiteForm,
  assertWebBrowserCredentialAbsent,
  WebBrowserProxyError,
  type WebBrowserSiteForm,
  type WebBrowserProxyErrorCode,
} from "../src/lib/web-browser-policy";
import { normalizeWebBrowserVisibleText } from "../src/lib/web-browser-visible-text";

const CONFIG_PATH = "/run/web-browser/job.json";
const PROXY_CERTIFICATE_PATH = "/run/web-browser/proxy-cert.pem";
const PROXY_PRIVATE_KEY_PATH = "/run/web-browser/proxy-key.pem";
const OUTPUT_PATH = "/run/web-browser-output/result.json";
const PROXY_EVIDENCE_PATH = "/run/web-browser-evidence/network.json";
const MAX_RESULT_BYTES = 128 * 1024;
const PROXY_PORT = 3128;
const HEALTH_PORT = 3129;

type ProxyJobConfig = Readonly<{
  origin: string;
  proxyUsername: string;
  proxyPassword: string;
  expectedNetworkFingerprint?: string;
  formPostUrl?: string;
}>;
type BrowserJobConfig = ProxyJobConfig & Readonly<{
  url: string;
  certificateSpki: string;
  siteForm?: WebBrowserSiteForm;
}>;

type RenderResult = Readonly<{ url: string; text: string }>;

function fail(code: WebBrowserProxyErrorCode): never {
  throw new WebBrowserProxyError(code);
}

async function readJobConfig(mode: "proxy"): Promise<ProxyJobConfig>;
async function readJobConfig(mode: "browser"): Promise<BrowserJobConfig>;
async function readJobConfig(mode: "proxy" | "browser"): Promise<ProxyJobConfig | BrowserJobConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return fail("WEB_BROWSER_INVALID_TARGET");
  }
  return parseWebBrowserContainerJobConfig(parsed, mode);
}

export function parseWebBrowserContainerJobConfig(value: unknown, mode: "proxy"): ProxyJobConfig;
export function parseWebBrowserContainerJobConfig(value: unknown, mode: "browser"): BrowserJobConfig;
export function parseWebBrowserContainerJobConfig(value: unknown, mode: "proxy" | "browser"): ProxyJobConfig | BrowserJobConfig;
export function parseWebBrowserContainerJobConfig(value: unknown, mode: "proxy" | "browser"): ProxyJobConfig | BrowserJobConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("WEB_BROWSER_INVALID_TARGET");
  const candidate = value as Record<string, unknown>;
  const allowed = mode === "proxy"
    ? ["origin", "proxyUsername", "proxyPassword", "expectedNetworkFingerprint", "formPostUrl"]
    : ["url", "origin", "proxyUsername", "proxyPassword", "certificateSpki", "expectedNetworkFingerprint", "siteForm"];
  if (Object.keys(candidate).some((key) => !allowed.includes(key))) return fail("WEB_BROWSER_INVALID_TARGET");
  const target = normalizeWebBrowserTarget(mode === "proxy" ? candidate.origin : candidate.url);
  if (
    candidate.origin !== target.origin || (mode === "proxy" && target.url !== target.origin + "/") ||
    typeof candidate.proxyUsername !== "string" || candidate.proxyUsername.length < 8 ||
    typeof candidate.proxyPassword !== "string" || candidate.proxyPassword.length < 24 ||
    (mode === "browser" && (typeof candidate.certificateSpki !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(candidate.certificateSpki))) ||
    (candidate.expectedNetworkFingerprint !== undefined &&
      (typeof candidate.expectedNetworkFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.expectedNetworkFingerprint)))
  ) return fail("WEB_BROWSER_INVALID_TARGET");
  const common = {
    origin: target.origin,
    proxyUsername: candidate.proxyUsername,
    proxyPassword: candidate.proxyPassword,
    ...(candidate.expectedNetworkFingerprint === undefined ? {} : { expectedNetworkFingerprint: candidate.expectedNetworkFingerprint as string }),
  };
  if (mode === "proxy") {
    if (candidate.formPostUrl !== undefined) {
      const formTarget = normalizeWebBrowserTarget(candidate.formPostUrl);
      if (formTarget.origin !== target.origin) return fail("WEB_BROWSER_INVALID_TARGET");
      return Object.freeze({ ...common, formPostUrl: formTarget.url });
    }
    return Object.freeze(common);
  }
  return Object.freeze({
    ...common, url: target.url, certificateSpki: candidate.certificateSpki as string,
    ...(candidate.siteForm === undefined ? {} : { siteForm: normalizeWebBrowserSiteForm(candidate.siteForm, target.url) }),
  });
}

async function atomicWriteResult(result: Readonly<{ url?: string; text?: string; error?: string; stage?: string }>): Promise<void> {
  const encoded = Buffer.from(`${JSON.stringify(result)}\n`, "utf8");
  if (encoded.length > MAX_RESULT_BYTES) return fail("WEB_BROWSER_RESOURCE_LIMIT");
  const temporary = join("/run/web-browser-output", `.result-${randomUUID()}.tmp`);
  await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
  await rename(temporary, OUTPUT_PATH);
}

async function startHealthEndpoint(): Promise<ReturnType<typeof createHttpServer>> {
  const health = createHttpServer((_request, response) => {
    response.writeHead(204, { connection: "close" });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    health.once("error", reject);
    health.listen(HEALTH_PORT, "127.0.0.1", resolve);
  });
  return health;
}

async function runHealthCheck(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: HEALTH_PORT, path: "/health", method: "GET", timeout: 500 }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 204 ? resolve() : reject(new Error("unready")));
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", reject);
    request.end();
  });
}

async function runProxy(): Promise<void> {
  const job = await readJobConfig("proxy");
  const [certificate, privateKey] = await Promise.all([
    readFile(PROXY_CERTIFICATE_PATH),
    readFile(PROXY_PRIVATE_KEY_PATH),
  ]);
  const proxy: WebBrowserEgressProxy = createWebBrowserEgressProxy({
    sourceOrigin: job.origin,
    username: job.proxyUsername,
    password: job.proxyPassword,
    certificate,
    privateKey,
    host: "0.0.0.0",
    port: PROXY_PORT,
    maxRequests: 64,
    maxRequestBytes: 4 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    requestTimeoutMs: 8_000,
    jobTimeoutMs: 30_000,
    maxTunnels: 32,
    ...(job.expectedNetworkFingerprint === undefined ? {} : { expectedNetworkFingerprint: job.expectedNetworkFingerprint }),
    ...(job.formPostUrl === undefined ? {} : { formPostUrl: job.formPostUrl, maxFormPostBytes: 8192 }),
  });
  await new Promise<void>((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(PROXY_PORT, "0.0.0.0", resolve);
  });
  const health = await startHealthEndpoint();

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  await proxy.close();
  await new Promise<void>((resolve) => health.close(() => resolve()));
  const networkFingerprint = proxy.networkFingerprint();
  if (networkFingerprint === null) return fail("WEB_BROWSER_DNS_REJECTED");
  await writeFile(PROXY_EVIDENCE_PATH, JSON.stringify({ networkFingerprint }), { flag: "wx", mode: 0o600 });
}

function allowedProxyServer(value: string | undefined): string {
  if (value === undefined) return fail("WEB_BROWSER_INVALID_TARGET");
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch {
    return fail("WEB_BROWSER_INVALID_TARGET");
  }
  const address = proxy.hostname.startsWith("[") ? proxy.hostname.slice(1, -1) : proxy.hostname;
  if (proxy.protocol !== "http:" || proxy.port !== String(PROXY_PORT) || isIP(address) !== 4 || isPublicWebBrowserAddress(address)) {
    return fail("WEB_BROWSER_INVALID_TARGET");
  }
  return proxy.origin;
}

async function assertDirectEgressBlocked(): Promise<void> {
  const probes: ReadonlyArray<readonly [string, number]> = [
    ["1.1.1.1", 443],
    ["169.254.169.254", 80],
  ];
  for (const [host, port] of probes) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connectTcp({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 400);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (connected) return fail("WEB_BROWSER_ISOLATION_UNAVAILABLE");
  }
}

async function render(): Promise<RenderResult> {
  const job = await readJobConfig("browser");
  const proxyServer = allowedProxyServer(process.env.AI_PROJECT_OS_WEB_BROWSER_PROXY_SERVER);
  const proxyAddress = new URL(proxyServer).hostname;
  await assertDirectEgressBlocked();
  if (process.env.HOME !== undefined) await mkdir(process.env.HOME, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({
    headless: true,
    proxy: {
      server: proxyServer,
      username: job.proxyUsername,
      password: job.proxyPassword,
    },
    args: [
      `--ignore-certificate-errors-spki-list=${job.certificateSpki}`,
      "--proxy-bypass-list=<-loopback>",
      `--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE ${proxyAddress}`,
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    timeout: 8_000,
  });

  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      javaScriptEnabled: true,
      viewport: { width: 1280, height: 800 },
    });
    let credentialLeakBlocked = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      try {
        const url = new URL(request.url());
        if (job.siteForm !== undefined && request.method() !== "POST") {
          try {
            assertWebBrowserCredentialAbsent([request.url(), request.headers().referer ?? ""], job.siteForm);
          } catch {
            credentialLeakBlocked = true;
            await route.abort("blockedbyclient");
            return;
          }
        }
        if (
          url.origin !== job.origin || url.protocol !== "https:" ||
          (request.method() !== "GET" && request.method() !== "HEAD" && !(
            job.siteForm !== undefined && request.method() === "POST" && url.toString() === job.siteForm.submitUrl
          )) ||
          request.headers().authorization !== undefined
        ) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket("**/*", (webSocket) => webSocket.close({ code: 1008, reason: "WebSocket disabled" }));

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(12_000);
    page.setDefaultTimeout(5_000);
    if (job.siteForm !== undefined) {
      const loginResponse = await page.goto(job.siteForm.loginUrl, { waitUntil: "domcontentloaded" });
      if (loginResponse === null || loginResponse.status() >= 400) return fail("WEB_BROWSER_LOGIN_FAILED");
      const usernameInput = page.locator(job.siteForm.usernameSelector);
      const passwordInput = page.locator(job.siteForm.passwordSelector);
      const submitButton = page.locator(job.siteForm.submitSelector);
      if (await usernameInput.count() !== 1 || await passwordInput.count() !== 1 || await submitButton.count() !== 1) {
        return fail("WEB_BROWSER_LOGIN_FAILED");
      }
      const formValid = await page.evaluate(({ usernameSelector, passwordSelector, submitSelector, submitUrl }) => {
        const username = document.querySelector(usernameSelector);
        const password = document.querySelector(passwordSelector);
        const submit = document.querySelector(submitSelector);
        if (!(username instanceof HTMLInputElement) || !(password instanceof HTMLInputElement)) return false;
        if (!(submit instanceof HTMLButtonElement) && !(submit instanceof HTMLInputElement)) return false;
        const form = password.form;
        return form !== null && username.form === form && submit.form === form &&
          ["text", "email", "tel"].includes(username.type) && password.type === "password" &&
          submit.type === "submit" &&
          form.method.toUpperCase() === "POST" && form.enctype === "application/x-www-form-urlencoded" &&
          new URL(form.action).toString() === submitUrl;
      }, {
        usernameSelector: job.siteForm.usernameSelector,
        passwordSelector: job.siteForm.passwordSelector,
        submitSelector: job.siteForm.submitSelector,
        submitUrl: job.siteForm.submitUrl,
      });
      if (!formValid) return fail("WEB_BROWSER_LOGIN_FAILED");
      if (await page.locator(job.siteForm.successSelector).first().isVisible()) return fail("WEB_BROWSER_LOGIN_FAILED");
      await usernameInput.fill(job.siteForm.username);
      await passwordInput.fill(job.siteForm.password);
      await submitButton.click();
      try {
        await page.locator(job.siteForm.successSelector).first().waitFor({ state: "visible", timeout: 5_000 });
      } catch {
        return fail("WEB_BROWSER_LOGIN_FAILED");
      }
      if (new URL(page.url()).origin !== job.origin) return fail("WEB_BROWSER_LOGIN_FAILED");
    }
    const response = await page.goto(job.url, { waitUntil: "domcontentloaded" });
    if (response === null || response.status() >= 500) return fail("WEB_BROWSER_UPSTREAM_FAILED");
    await page.waitForTimeout(300);

    const finalUrl = new URL(page.url());
    if (finalUrl.origin !== job.origin || finalUrl.username || finalUrl.password) return fail("WEB_BROWSER_REDIRECT_REJECTED");
    finalUrl.hash = "";
    if (finalUrl.toString() !== job.url) return fail("WEB_BROWSER_REDIRECT_REJECTED");
    if (job.siteForm !== undefined && !(await page.locator(job.siteForm.successSelector).first().isVisible())) {
      return fail("WEB_BROWSER_LOGIN_FAILED");
    }
    const rawText = await page.evaluate(() => document.body?.innerText ?? "");
    const text = normalizeWebBrowserVisibleText(rawText);
    if (text.length === 0) return fail("WEB_BROWSER_UPSTREAM_FAILED");
    if (credentialLeakBlocked) return fail("WEB_BROWSER_CREDENTIAL_REFLECTION");
    if (job.siteForm !== undefined) {
      assertWebBrowserCredentialAbsent([finalUrl.toString(), await page.title(), text], job.siteForm);
    }
    await context.close();
    return Object.freeze({ url: finalUrl.toString(), text });
  } finally {
    await browser.close();
  }
}

async function runBrowser(): Promise<void> {
  try {
    await atomicWriteResult(await render());
  } catch (error) {
    const errorCode = error instanceof WebBrowserProxyError ? error.code : "WEB_BROWSER_UPSTREAM_FAILED";
    const result: { error: string } = {
      error: errorCode === "WEB_BROWSER_UPSTREAM_FAILED" ? "WEB_BROWSER_RENDER_FAILED" : errorCode,
    };
    await atomicWriteResult(result);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "proxy": await runProxy(); return;
    case "browser": await runBrowser(); return;
    case "health": await runHealthCheck(); return;
    default: process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch(async (error: unknown) => {
    const code = error instanceof WebBrowserProxyError ? error.code : "WEB_BROWSER_RENDER_FAILED";
    if (process.argv[2] === "browser") {
      try {
        await atomicWriteResult({ error: code });
      } catch { /* The host timeout remains authoritative. */ }
    }
    process.exitCode = 1;
  });
}
