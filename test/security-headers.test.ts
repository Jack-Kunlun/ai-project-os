import assert from "node:assert/strict";
import test from "node:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { sendResponse } from "next/dist/server/send-response";

import nextConfig, { buildContentSecurityPolicy, SECURITY_HEADERS } from "../next.config";
import { MCP_EXPORT_OAUTH_CONSENT_CSP } from "../src/lib/mcp-export-oauth-consent-security";

type HeaderRule = {
  source: string;
  headers: readonly { key: string; value: string }[];
};

function getGlobalHeadersForPath(rules: readonly HeaderRule[], pathname: string) {
  const headers = new Map<string, string>();
  for (const rule of rules) {
    const matchesPath = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true });
    if (!matchesPath(pathname)) continue;
    for (const { key, value } of rule.headers) headers.set(key.toLowerCase(), value);
  }
  return headers;
}

async function mergeNextRouteHeaders(globalHeaders: Map<string, string>, routeHeaders: Record<string, string>) {
  const responseHeaders = new Map(globalHeaders);
  const nodeResponse = {
    statusCode: 200,
    statusMessage: "",
    getHeader(name: string) {
      return responseHeaders.get(name.toLowerCase());
    },
    appendHeader(name: string, value: string) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    originalResponse: { end() {} },
  };

  await sendResponse(
    { method: "GET" } as unknown as Parameters<typeof sendResponse>[0],
    nodeResponse as unknown as Parameters<typeof sendResponse>[1],
    new Response(null, { headers: routeHeaders }),
  );

  return responseHeaders;
}

test("production CSP keeps executable and network sources local", () => {
  const policy = buildContentSecurityPolicy("production");

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /form-action 'self'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /https?:\/\//);
});

test("security header baseline lets the consent route set its exact CSP and referrer policy", async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  assert.ok(nextConfig.headers);

  const rules = await nextConfig.headers();
  assert.equal(rules.length, 2);
  assert.equal(rules[0]?.source, "/:path*");
  assert.deepEqual(
    rules[0]?.headers,
    SECURITY_HEADERS.filter(({ key }) => key !== "Content-Security-Policy" && key !== "Referrer-Policy"),
  );
  assert.equal(rules[1]?.source, "/:path((?!mcp/authorize$).*)");
  assert.deepEqual(
    rules[1]?.headers,
    SECURITY_HEADERS.filter(({ key }) => key === "Content-Security-Policy" || key === "Referrer-Policy"),
  );

  const headers = new Map(SECURITY_HEADERS.map(({ key, value }) => [key, value]));
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");

  const consentGlobalHeaders = getGlobalHeadersForPath(rules, "/mcp/authorize");
  assert.equal(consentGlobalHeaders.get("x-frame-options"), "DENY");
  assert.equal(consentGlobalHeaders.has("content-security-policy"), false);
  assert.equal(consentGlobalHeaders.has("referrer-policy"), false);
  const trailingSlashGlobalHeaders = getGlobalHeadersForPath(rules, "/mcp/authorize/");
  assert.equal(trailingSlashGlobalHeaders.get("content-security-policy"), SECURITY_HEADERS[0]?.value);
  assert.equal(trailingSlashGlobalHeaders.get("referrer-policy"), "no-referrer");

  const dashboardGlobalHeaders = getGlobalHeadersForPath(rules, "/dashboard");
  assert.equal(dashboardGlobalHeaders.get("content-security-policy"), SECURITY_HEADERS[0]?.value);
  assert.equal(dashboardGlobalHeaders.get("referrer-policy"), "no-referrer");
  const ordinaryRouteResponse = await mergeNextRouteHeaders(dashboardGlobalHeaders, {
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "same-origin",
  });
  assert.equal(ordinaryRouteResponse.get("referrer-policy"), "no-referrer");
  assert.equal(ordinaryRouteResponse.get("content-security-policy"), SECURITY_HEADERS[0]?.value);

  const callbackCsp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://client.example:8443; frame-ancestors 'none'; base-uri 'none'; script-src 'none'";
  const consentSuccessResponse = await mergeNextRouteHeaders(consentGlobalHeaders, {
    "Content-Security-Policy": callbackCsp,
    "Referrer-Policy": "same-origin",
  });
  assert.equal(consentSuccessResponse.get("referrer-policy"), "same-origin");
  assert.equal(consentSuccessResponse.get("content-security-policy"), callbackCsp);
  const consentErrorResponse = await mergeNextRouteHeaders(consentGlobalHeaders, {
    "Content-Security-Policy": MCP_EXPORT_OAUTH_CONSENT_CSP,
    "Referrer-Policy": "no-referrer",
  });
  assert.equal(consentErrorResponse.get("referrer-policy"), "no-referrer");
  assert.equal(consentErrorResponse.get("content-security-policy"), MCP_EXPORT_OAUTH_CONSENT_CSP);
});
