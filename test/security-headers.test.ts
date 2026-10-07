import assert from "node:assert/strict";
import test from "node:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { sendResponse } from "next/dist/server/send-response";

import nextConfig, { buildContentSecurityPolicy, SECURITY_HEADERS } from "../next.config";

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

async function mergeNextRouteHeaders(globalHeaders: Map<string, string>, routeReferrerPolicy: string) {
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
    new Response(null, { headers: { "Referrer-Policy": routeReferrerPolicy } }),
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

test("security header baseline preserves the consent route policy through Next header merging", async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  assert.ok(nextConfig.headers);

  const rules = await nextConfig.headers();
  assert.equal(rules.length, 2);
  assert.equal(rules[0]?.source, "/:path*");
  assert.deepEqual(
    rules[0]?.headers,
    SECURITY_HEADERS.filter(({ key }) => key !== "Referrer-Policy"),
  );
  assert.equal(rules[1]?.source, "/:path((?!mcp/authorize$).*)");
  assert.deepEqual(rules[1]?.headers, [{ key: "Referrer-Policy", value: "no-referrer" }]);

  const headers = new Map(SECURITY_HEADERS.map(({ key, value }) => [key, value]));
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");

  const consentGlobalHeaders = getGlobalHeadersForPath(rules, "/mcp/authorize");
  assert.equal(consentGlobalHeaders.get("content-security-policy"), SECURITY_HEADERS[0]?.value);
  assert.equal(consentGlobalHeaders.get("x-frame-options"), "DENY");
  assert.equal(consentGlobalHeaders.has("referrer-policy"), false);
  assert.equal(getGlobalHeadersForPath(rules, "/mcp/authorize/").get("referrer-policy"), "no-referrer");

  const dashboardGlobalHeaders = getGlobalHeadersForPath(rules, "/dashboard");
  assert.equal(dashboardGlobalHeaders.get("referrer-policy"), "no-referrer");
  const ordinaryRouteResponse = await mergeNextRouteHeaders(dashboardGlobalHeaders, "same-origin");
  assert.equal(ordinaryRouteResponse.get("referrer-policy"), "no-referrer");

  const consentSuccessResponse = await mergeNextRouteHeaders(consentGlobalHeaders, "same-origin");
  assert.equal(consentSuccessResponse.get("referrer-policy"), "same-origin");
  const consentErrorResponse = await mergeNextRouteHeaders(consentGlobalHeaders, "no-referrer");
  assert.equal(consentErrorResponse.get("referrer-policy"), "no-referrer");
});
