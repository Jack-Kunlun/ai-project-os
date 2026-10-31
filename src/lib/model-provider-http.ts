import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import {
  Agent,
  request as httpsRequest,
  type AgentOptions as HttpsAgentOptions,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import { Readable } from "node:stream";

export const OPENAI_PROXY_ENV = "AI_PROJECT_OS_OPENAI_PROXY_URL" as const;

type ProxyEnvironment = Readonly<{
  HTTPS_PROXY: string;
  HTTP_PROXY: string;
  NO_PROXY: "";
}>;

type ProxyAgentOptions = HttpsAgentOptions & Readonly<{ proxyEnv: ProxyEnvironment }>;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const OFFICIAL_OPENAI_ENDPOINTS = new Map<string, string>([
  ["https://api.openai.com/v1/chat/completions", "/v1/chat/completions"],
  ["https://api.openai.com/v1/embeddings", "/v1/embeddings"],
  ["https://api.openai.com/v1/responses", "/v1/responses"],
]);

const PROXY_AUTHORITY_PATTERN = /^http:\/\/[^/?#\s]+$/iu;

/** Safe, detail-free error for invalid local OpenAI proxy configuration. */
export class OpenAiProxyConfigurationError extends Error {
  constructor() {
    super("OPENAI_PROXY_CONFIGURATION_INVALID");
    this.name = "OpenAiProxyConfigurationError";
  }
}

/**
 * Node added per-Agent proxyEnv support in 24.5.0 and 22.21.0. Reject older
 * runtimes instead of silently making an OpenAI request without the proxy.
 */
export function supportsNativeProxyEnv(nodeVersion = process.versions.node): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(nodeVersion);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return false;
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

function isAllowedIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4) return false;
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return false;
  return first === 10 || first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isAllowedProxyHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "host.docker.internal" || host === "openai-egress") {
    return true;
  }
  const unbracketed = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  return unbracketed === "::1" || isAllowedIpv4(unbracketed);
}

function validateProxyUrl(proxyUrl: string): string {
  if (!PROXY_AUTHORITY_PATTERN.test(proxyUrl)) {
    throw new OpenAiProxyConfigurationError();
  }
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new OpenAiProxyConfigurationError();
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !isAllowedProxyHost(parsed.hostname)
  ) {
    throw new OpenAiProxyConfigurationError();
  }
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new OpenAiProxyConfigurationError();
  }
  try {
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    if (/[\u0000-\u001f\u007f]/u.test(username) || /[\u0000-\u001f\u007f]/u.test(password)) {
      throw new OpenAiProxyConfigurationError();
    }
  } catch {
    throw new OpenAiProxyConfigurationError();
  }
  return parsed.toString();
}

function buildProxyEnvironment(proxyUrl: string): ProxyEnvironment {
  return Object.freeze({
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "",
  });
}

function assertProxyAgentSupport(proxyEnv: ProxyEnvironment): void {
  if (!supportsNativeProxyEnv()) {
    throw new OpenAiProxyConfigurationError();
  }
  const options: ProxyAgentOptions = { proxyEnv, keepAlive: false, maxSockets: 1 };
  const probe = new Agent(options);
  const retainedProxyEnv = (
    probe.options as HttpsAgentOptions & { proxyEnv?: Partial<ProxyEnvironment> }
  ).proxyEnv;
  probe.destroy();
  if (
    retainedProxyEnv?.HTTPS_PROXY !== proxyEnv.HTTPS_PROXY ||
    retainedProxyEnv.HTTP_PROXY !== proxyEnv.HTTP_PROXY ||
    retainedProxyEnv.NO_PROXY !== ""
  ) {
    throw new OpenAiProxyConfigurationError();
  }
}

function outgoingHeaders(input: HeadersInit | undefined): Record<string, string> {
  const headers = new Headers(input);
  // The destination is always the fixed official OpenAI host, regardless of
  // any caller-supplied value.
  headers.set("host", "api.openai.com");
  const output: Record<string, string> = {};
  headers.forEach((value, name) => {
    output[name] = value;
  });
  return output;
}

function incomingHeaders(input: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function requestOpenAiThroughProxy(
  endpointPath: string,
  proxyEnv: ProxyEnvironment,
  init: RequestInit | undefined,
): Promise<Response> {
  const method = init?.method ?? "GET";
  if (method !== "POST" || typeof init?.body !== "string") {
    return Promise.reject(new OpenAiProxyConfigurationError());
  }

  const agentOptions: ProxyAgentOptions = {
    proxyEnv,
    keepAlive: false,
    maxSockets: 1,
  };
  const agent = new Agent(agentOptions);
  const configuredProxyEnv = (
    agent.options as HttpsAgentOptions & { proxyEnv?: Partial<ProxyEnvironment> }
  ).proxyEnv;
  if (
    configuredProxyEnv?.HTTPS_PROXY !== proxyEnv.HTTPS_PROXY ||
    configuredProxyEnv.HTTP_PROXY !== proxyEnv.HTTP_PROXY ||
    configuredProxyEnv.NO_PROXY !== ""
  ) {
    agent.destroy();
    return Promise.reject(new OpenAiProxyConfigurationError());
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let agentDestroyed = false;
    const destroyAgent = (): void => {
      if (agentDestroyed) return;
      agentDestroyed = true;
      agent.destroy();
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      destroyAgent();
      reject(error);
    };

    const options: HttpsRequestOptions = {
      protocol: "https:",
      hostname: "api.openai.com",
      servername: "api.openai.com",
      port: 443,
      path: endpointPath,
      method,
      headers: outgoingHeaders(init.headers),
      agent,
      rejectUnauthorized: true,
      ...(init.signal === null || init.signal === undefined ? {} : { signal: init.signal }),
    };

    const request = httpsRequest(options, (incoming) => {
      const status = incoming.statusCode;
      if (status === undefined || status < 200 || status > 599) {
        incoming.destroy();
        rejectOnce(new Error("OPENAI_PROXY_TRANSPORT_FAILED"));
        return;
      }

      incoming.once("end", destroyAgent);
      incoming.once("close", destroyAgent);
      incoming.once("aborted", destroyAgent);
      incoming.once("error", destroyAgent);

      try {
        const hasNoBody = status === 204 || status === 205 || status === 304;
        const body = hasNoBody
          ? null
          : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        const response = new Response(body, {
          status,
          ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
          headers: incomingHeaders(incoming),
        });
        settled = true;
        resolve(response);
      } catch {
        incoming.destroy();
        rejectOnce(new Error("OPENAI_PROXY_TRANSPORT_FAILED"));
      }
    });

    request.once("error", rejectOnce);
    request.end(init.body);
  });
}

/**
 * Builds a one-request fetch adapter only for fixed official OpenAI endpoints.
 * An unset or exactly empty environment variable returns undefined so the
 * existing fetch path remains byte-for-byte unchanged. A malformed non-empty
 * value fails closed.
 */
export function prepareModelProviderFetch(
  endpoint: string,
): FetchImplementation | undefined {
  const proxyUrl = process.env[OPENAI_PROXY_ENV];
  if (proxyUrl === undefined || proxyUrl === "") return undefined;
  const endpointPath = OFFICIAL_OPENAI_ENDPOINTS.get(endpoint);
  if (endpointPath === undefined) throw new OpenAiProxyConfigurationError();
  const normalizedProxyUrl = validateProxyUrl(proxyUrl);
  const proxyEnv = buildProxyEnvironment(normalizedProxyUrl);
  assertProxyAgentSupport(proxyEnv);

  return (input, init) => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (requestUrl !== endpoint) {
      return Promise.reject(new OpenAiProxyConfigurationError());
    }
    return requestOpenAiThroughProxy(endpointPath, proxyEnv, init);
  };
}
