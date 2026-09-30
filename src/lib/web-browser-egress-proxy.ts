import { lookup as dnsLookup } from "node:dns/promises";
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import {
  assertWebBrowserExactOrigin,
  isPublicWebBrowserAddress,
  WebBrowserProxyError,
  type WebBrowserProxyErrorCode,
} from "./web-browser-policy";

const MAX_REQUESTS_DEFAULT = 64;
const MAX_REQUEST_BYTES_DEFAULT = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES_DEFAULT = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS_DEFAULT = 8_000;
const JOB_TIMEOUT_MS_DEFAULT = 30_000;
const MAX_PROXY_TUNNELS_DEFAULT = 32;
const MAX_RESOLVED_ADDRESSES = 32;
const PROXY_HEADER_BYTES = 16 * 1024;

type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

type Resolver = (hostname: string) => Promise<readonly Readonly<{ address: string; family: number }>[]>;

type TestOverrides = Readonly<{
  /** Test-only escape hatch for loopback TLS fixtures. Never pass in deployed code. */
  allowPrivateAddresses: boolean;
  resolveHostname: Resolver;
  upstreamCa?: string | Buffer;
}>;

export type WebBrowserEgressProxyOptions = Readonly<{
  sourceOrigin: string;
  username: string;
  password: string;
  certificate: string | Buffer;
  privateKey: string | Buffer;
  host?: string;
  port?: number;
  maxRequests?: number;
  maxRequestBytes?: number;
  maxTotalBytes?: number;
  requestTimeoutMs?: number;
  jobTimeoutMs?: number;
  maxTunnels?: number;
}>;

export type WebBrowserEgressProxy = Readonly<{
  server: HttpServer;
  address: Readonly<{ host: string; port: number }>;
  close(): Promise<void>;
}>;

type ProxyBudgets = Readonly<{
  maxRequests: number;
  maxRequestBytes: number;
  maxTotalBytes: number;
  requestTimeoutMs: number;
  jobTimeoutMs: number;
  maxTunnels: number;
}>;

function throwProxyError(code: WebBrowserProxyErrorCode): never {
  throw new WebBrowserProxyError(code);
}

function requestHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function normalizeHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseProxyAuthority(authority: string, expectedOrigin: string): URL {
  let target: URL;
  try {
    target = new URL(`https://${authority}`);
  } catch {
    return throwProxyError("WEB_BROWSER_TARGET_REJECTED");
  }
  if (
    target.username.length > 0 || target.password.length > 0 || target.pathname !== "/" ||
    target.search.length > 0 || target.hash.length > 0 || target.origin !== expectedOrigin
  ) {
    return throwProxyError("WEB_BROWSER_TARGET_REJECTED");
  }
  return target;
}

function createPinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
}

async function resolvePublicEndpoint(
  hostname: string,
  resolver: Resolver,
  allowPrivateAddresses: boolean,
): Promise<ResolvedAddress> {
  const normalizedHost = normalizeHost(hostname).toLowerCase();
  let rows: readonly Readonly<{ address: string; family: number }>[];
  try {
    rows = isIP(normalizedHost) === 0
      ? await resolver(normalizedHost)
      : [{ address: normalizedHost, family: isIP(normalizedHost) }];
  } catch {
    return throwProxyError("WEB_BROWSER_DNS_REJECTED");
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_RESOLVED_ADDRESSES) {
    return throwProxyError("WEB_BROWSER_DNS_REJECTED");
  }

  const normalized = [...new Map(rows.map((row) => [`${row.family}:${row.address.toLowerCase()}`, {
    address: row.address.toLowerCase(),
    family: row.family,
  }] as const)).values()]
    .sort((left, right) => `${left.family}:${left.address}`.localeCompare(`${right.family}:${right.address}`));

  if (
    normalized.length === 0 ||
    normalized.length > MAX_RESOLVED_ADDRESSES ||
    normalized.some((row) => (row.family !== 4 && row.family !== 6) || isIP(row.address) !== row.family) ||
    (!allowPrivateAddresses && normalized.some((row) => !isPublicWebBrowserAddress(row.address)))
  ) {
    return throwProxyError("WEB_BROWSER_DNS_REJECTED");
  }

  const first = normalized[0]!;
  if (first.family !== 4 && first.family !== 6) return throwProxyError("WEB_BROWSER_DNS_REJECTED");
  return Object.freeze({ address: first.address, family: first.family });
}

function authenticate(headers: IncomingHttpHeaders, username: string, password: string): boolean {
  const value = requestHeader(headers, "proxy-authorization");
  if (value === undefined || !value.startsWith("Basic ")) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value.slice("Basic ".length), "base64");
  } catch {
    return false;
  }
  const expected = Buffer.from(`${username}:${password}`, "utf8");
  return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}

function writeConnectError(socket: Duplex, status: number, reason: string, authenticate = false): void {
  const challenge = authenticate ? 'Proxy-Authenticate: Basic realm="web-browser"\r\n' : "";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${challenge}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}

function bodyLength(headers: IncomingHttpHeaders): number | null {
  if (requestHeader(headers, "transfer-encoding") !== undefined) return null;
  const value = requestHeader(headers, "content-length");
  if (value === undefined) return 0;
  if (!/^\d{1,12}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isUpgradeRequest(headers: IncomingHttpHeaders): boolean {
  if (requestHeader(headers, "upgrade") !== undefined) return true;
  return (requestHeader(headers, "connection") ?? "").split(",").some((value) => value.trim().toLowerCase() === "upgrade");
}

function requestHeadersForOrigin(headers: IncomingHttpHeaders, expectedHost: string): Readonly<Record<string, string | string[]>> {
  const blocked = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  ]);
  const result: Record<string, string | string[]> = { host: expectedHost, connection: "close" };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || blocked.has(name) || name === "host" || name === "content-length") continue;
    if (name === "authorization") continue;
    result[name] = value;
  }
  return result;
}

function sanitizedResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const blocked = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  ]);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name)) result[name] = value;
  }
  return result;
}

function applyResponse(
  response: ServerResponse,
  status: number,
  headers: Record<string, string | string[]>,
): void {
  response.statusCode = status;
  response.shouldKeepAlive = false;
  response.setHeader("connection", "close");
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "connection") continue;
    response.setHeader(name, value);
  }
}

function errorStatus(code: WebBrowserProxyErrorCode): number {
  switch (code) {
    case "WEB_BROWSER_METHOD_REJECTED": return 405;
    case "WEB_BROWSER_REDIRECT_REJECTED": return 451;
    case "WEB_BROWSER_RESOURCE_LIMIT": return 413;
    case "WEB_BROWSER_DNS_REJECTED":
    case "WEB_BROWSER_TARGET_REJECTED": return 403;
    default: return 502;
  }
}

/**
 * Create a fail-closed HTTP CONNECT proxy. It terminates the browser-side TLS
 * tunnel so every HTTPS request can be checked before a separately pinned
 * upstream TLS connection is opened. The test override is private to this
 * module's exported test factory and must never be used by a deployed runner.
 */
function createProxyServer(
  options: WebBrowserEgressProxyOptions,
  testOverrides?: TestOverrides,
): WebBrowserEgressProxy {
  let expected: URL;
  try {
    expected = new URL(options.sourceOrigin);
  } catch {
    return throwProxyError("WEB_BROWSER_INVALID_TARGET");
  }
  if (
    expected.protocol !== "https:" || expected.username !== "" || expected.password !== "" ||
    expected.pathname !== "/" || expected.search !== "" || expected.hash !== "" || expected.origin !== options.sourceOrigin
  ) return throwProxyError("WEB_BROWSER_INVALID_TARGET");
  const expectedOrigin = expected.origin;
  const expectedHost = expected.host.toLowerCase();
  const username = options.username;
  const password = options.password;
  if (username.length < 8 || password.length < 24 || username.includes(":") || /[\r\n]/u.test(username + password)) {
    throw new WebBrowserProxyError("WEB_BROWSER_INVALID_TARGET");
  }

  const budgets: ProxyBudgets = Object.freeze({
    maxRequests: options.maxRequests ?? MAX_REQUESTS_DEFAULT,
    maxRequestBytes: options.maxRequestBytes ?? MAX_REQUEST_BYTES_DEFAULT,
    maxTotalBytes: options.maxTotalBytes ?? MAX_TOTAL_BYTES_DEFAULT,
    requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS_DEFAULT,
    jobTimeoutMs: options.jobTimeoutMs ?? JOB_TIMEOUT_MS_DEFAULT,
    maxTunnels: options.maxTunnels ?? MAX_PROXY_TUNNELS_DEFAULT,
  });
  if (Object.values(budgets).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new WebBrowserProxyError("WEB_BROWSER_INVALID_TARGET");
  }

  const startedAt = Date.now();
  const resolveHostname = testOverrides?.resolveHostname ?? (async (hostname: string) =>
    await dnsLookup(hostname, { all: true, verbatim: true }));
  const allowPrivateAddresses = testOverrides?.allowPrivateAddresses === true;
  const requests = new Set<IncomingMessage>();
  const rawTunnels = new Set<Duplex>();
  const httpsServers = new Set<HttpsServer>();
  let requestCount = 0;
  let responseBytes = 0;
  let activeTunnels = 0;

  const proxy = createHttpServer({ maxHeaderSize: PROXY_HEADER_BYTES }, (_request, response) => {
    response.writeHead(405, { connection: "close" });
    response.end();
  });
  proxy.maxHeadersCount = 64;
  proxy.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  proxy.on("connect", (request, socket, head) => {
    void (async () => {
      if (!authenticate(request.headers, username, password)) {
        writeConnectError(socket, 407, "Proxy Authentication Required", true);
        return;
      }
      if (Date.now() - startedAt > budgets.jobTimeoutMs || activeTunnels >= budgets.maxTunnels) {
        writeConnectError(socket, 429, "Too Many Requests");
        return;
      }

      let target: URL;
      let pinned: ResolvedAddress;
      try {
        target = parseProxyAuthority(request.url ?? "", expectedOrigin);
        pinned = await resolvePublicEndpoint(target.hostname, resolveHostname, allowPrivateAddresses);
      } catch (error) {
        const code = error instanceof WebBrowserProxyError ? error.code : "WEB_BROWSER_TARGET_REJECTED";
        writeConnectError(socket, errorStatus(code), "Forbidden");
        return;
      }

      activeTunnels += 1;
      rawTunnels.add(socket);
      socket.once("close", () => {
        rawTunnels.delete(socket);
        activeTunnels = Math.max(0, activeTunnels - 1);
      });
      socket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: AI-Project-OS-Web-Browser\r\n\r\n");
      if (head.length > 0) socket.unshift(head);

      const tunnel = createHttpsServer({
        key: options.privateKey,
        cert: options.certificate,
        ALPNProtocols: ["http/1.1"],
        maxHeaderSize: PROXY_HEADER_BYTES,
      }, (originRequest, originResponse) => {
        void handleOriginRequest(originRequest, originResponse, target, pinned);
      });
      httpsServers.add(tunnel);
      tunnel.maxHeadersCount = 64;
      tunnel.on("secureConnection", (tlsSocket) => {
        const servername = typeof tlsSocket.servername === "string" ? tlsSocket.servername.toLowerCase() : undefined;
        const destinationHost = normalizeHost(target.hostname).toLowerCase();
        if (servername !== undefined && servername !== destinationHost) tlsSocket.destroy();
      });
      tunnel.on("connect", (_nestedRequest, nestedSocket) => {
        nestedSocket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      tunnel.on("upgrade", (_originRequest, originSocket) => {
        originSocket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      tunnel.on("clientError", (_error, clientSocket) => {
        clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      tunnel.on("close", () => httpsServers.delete(tunnel));
      tunnel.emit("connection", socket as Socket);
    })().catch(() => writeConnectError(socket, 502, "Bad Gateway"));
  });

  async function handleOriginRequest(
    request: IncomingMessage,
    response: ServerResponse,
    connectedTarget: URL,
    pinned: ResolvedAddress,
  ): Promise<void> {
    requests.add(request);
    response.once("close", () => requests.delete(request));

    const reject = (code: WebBrowserProxyErrorCode) => {
      const status = errorStatus(code);
      applyResponse(response, status, { "content-length": "0" });
      response.end();
      // Do not drain attacker-controlled request bodies. A rejected request
      // closes its one-shot TLS tunnel after the bounded error response.
      response.once("finish", () => request.socket.destroy());
    };

    if (
      Date.now() - startedAt > budgets.jobTimeoutMs ||
      requestCount >= budgets.maxRequests ||
      requests.size > budgets.maxTunnels
    ) {
      reject("WEB_BROWSER_RESOURCE_LIMIT");
      return;
    }
    requestCount += 1;

    if (request.method !== "GET" && request.method !== "HEAD") {
      reject("WEB_BROWSER_METHOD_REJECTED");
      return;
    }
    if (isUpgradeRequest(request.headers) || requestHeader(request.headers, "authorization") !== undefined) {
      reject("WEB_BROWSER_METHOD_REJECTED");
      return;
    }
    const requestBodyLength = bodyLength(request.headers);
    if (requestBodyLength === null || requestBodyLength > 0) {
      reject("WEB_BROWSER_METHOD_REJECTED");
      return;
    }

    const host = requestHeader(request.headers, "host")?.toLowerCase();
    if (host !== expectedHost) {
      reject("WEB_BROWSER_TARGET_REJECTED");
      return;
    }

    let target: URL;
    try {
      target = assertWebBrowserExactOrigin(request.url ?? "", expectedOrigin);
    } catch {
      reject("WEB_BROWSER_TARGET_REJECTED");
      return;
    }
    if (target.hostname.toLowerCase() !== connectedTarget.hostname.toLowerCase() || target.port !== connectedTarget.port) {
      reject("WEB_BROWSER_TARGET_REJECTED");
      return;
    }

    const upstream = httpsRequest(target, {
      method: request.method,
      headers: requestHeadersForOrigin(request.headers, expectedHost),
      agent: false,
      lookup: createPinnedLookup(pinned),
      servername: isIP(normalizeHost(target.hostname)) === 0 ? normalizeHost(target.hostname) : undefined,
      rejectUnauthorized: true,
      ca: testOverrides?.upstreamCa,
      signal: AbortSignal.timeout(budgets.requestTimeoutMs),
      maxHeaderSize: PROXY_HEADER_BYTES,
    }, (upstreamResponse) => {
      const location = requestHeader(upstreamResponse.headers, "location");
      if (upstreamResponse.statusCode !== undefined && [301, 302, 303, 307, 308].includes(upstreamResponse.statusCode) && location !== undefined) {
        try {
          assertWebBrowserExactOrigin(location, expectedOrigin);
        } catch {
          upstreamResponse.destroy();
          reject("WEB_BROWSER_REDIRECT_REJECTED");
          return;
        }
      }

      const disposition = requestHeader(upstreamResponse.headers, "content-disposition") ?? "";
      if (/^\s*attachment(?:\s*;|\s*$)/iu.test(disposition)) {
        upstreamResponse.destroy();
        reject("WEB_BROWSER_RESOURCE_LIMIT");
        return;
      }

      const declaredLength = Number(requestHeader(upstreamResponse.headers, "content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > budgets.maxRequestBytes) {
        upstreamResponse.destroy();
        reject("WEB_BROWSER_RESOURCE_LIMIT");
        return;
      }

      applyResponse(response, upstreamResponse.statusCode ?? 502, sanitizedResponseHeaders(upstreamResponse.headers));
      let requestBytes = 0;
      upstreamResponse.on("data", (chunk: Buffer) => {
        requestBytes += chunk.length;
        responseBytes += chunk.length;
        if (requestBytes > budgets.maxRequestBytes || responseBytes > budgets.maxTotalBytes) {
          upstreamResponse.destroy();
          response.destroy(new WebBrowserProxyError("WEB_BROWSER_RESOURCE_LIMIT"));
          return;
        }
        if (!response.write(chunk)) upstreamResponse.pause();
      });
      response.on("drain", () => upstreamResponse.resume());
      upstreamResponse.once("end", () => response.end());
      upstreamResponse.once("error", () => response.destroy());
      response.once("close", () => upstreamResponse.destroy());
    });

    upstream.once("error", (error: NodeJS.ErrnoException) => {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const code = error instanceof WebBrowserProxyError ? error.code : "WEB_BROWSER_UPSTREAM_FAILED";
      reject(code);
    });
    upstream.end();
  }

  return {
    server: proxy,
    address: { host: options.host ?? "0.0.0.0", port: options.port ?? 3128 },
    async close() {
      for (const request of requests) request.destroy();
      for (const socket of rawTunnels) socket.destroy();
      for (const server of httpsServers) server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        if (!proxy.listening) return resolve();
        proxy.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

export function createWebBrowserEgressProxy(options: WebBrowserEgressProxyOptions): WebBrowserEgressProxy {
  return createProxyServer(options);
}

/** @internal Test-only constructor; the production runner never exposes these overrides. */
export function createWebBrowserEgressProxyForTest(
  options: WebBrowserEgressProxyOptions,
  overrides: TestOverrides,
): WebBrowserEgressProxy {
  return createProxyServer(options, overrides);
}
