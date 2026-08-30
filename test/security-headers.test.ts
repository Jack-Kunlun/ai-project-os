import assert from "node:assert/strict";
import test from "node:test";

import nextConfig, { buildContentSecurityPolicy, SECURITY_HEADERS } from "../next.config";

test("production CSP keeps executable and network sources local", () => {
  const policy = buildContentSecurityPolicy("production");

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /form-action 'self'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /https?:\/\//);
});

test("security header baseline covers every route and suppresses framework disclosure", async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  assert.ok(nextConfig.headers);

  const rules = await nextConfig.headers();
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.source, "/:path*");
  assert.deepEqual(rules[0]?.headers, [...SECURITY_HEADERS]);

  const headers = new Map(SECURITY_HEADERS.map(({ key, value }) => [key, value]));
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
});
