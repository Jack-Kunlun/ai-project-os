import assert from "node:assert/strict";
import test from "node:test";
import { GET as getAuthorizationServerMetadata } from "../src/app/.well-known/oauth-authorization-server/route";
import { GET as getProtectedResourceMetadata } from "../src/app/.well-known/oauth-protected-resource/api/mcp/route";
import { POST as postMcp } from "../src/app/api/mcp/route";
import { GET as getMcpOAuthConsent, POST as postMcpOAuthConsent } from "../src/app/mcp/authorize/route";
import { GET as getOAuthAuthorize } from "../src/app/oauth/authorize/route";
import { POST as postOAuthToken } from "../src/app/oauth/token/route";
import { getDb } from "../src/lib/db";
import {
  canonicalRedirectUri,
  isMcpExportOAuthRedirectUriRegistered,
  mcpExportOAuthClientAdmissionFingerprint,
  McpExportOAuthError,
  parseMcpExportOAuthAuthorizationParameters,
  parseMcpExportOAuthClientMetadata,
  parseMcpExportOAuthTokenRequest,
  withMcpExportOAuthCimdFetchSlot,
} from "../src/lib/mcp-export-oauth";
import {
  buildMcpExportOAuthManualCallbackResponse,
  getMcpExportOAuthConsentCallbackPolicy,
  MCP_EXPORT_OAUTH_CONSENT_CSP,
} from "../src/lib/mcp-export-oauth-consent-security";
import {
  getMcpExportOAuthCsrfCookieName,
  hasMcpExportOAuthCsrfCookieCapacity,
  isMcpExportFeatureEnabled,
  isMcpExportLegacyBearerEnabled,
  isMcpExportOAuthEnabled,
} from "../src/lib/mcp-export-oauth-config";

const CLIENT_ID = "https://client.example/oauth/client.json";
const REDIRECT_URI = "http://localhost:49152/oauth/callback";
const RESOURCE = "https://mcp.example/api/mcp";
const VERIFIER = "A".repeat(43);
const CHALLENGE = "B".repeat(43);

test("MCP OAuth parsing enforces CIMD identity, exact redirect, fixed resource and S256", () => {
  const metadata = parseMcpExportOAuthClientMetadata(CLIENT_ID, {
    client_id: CLIENT_ID,
    client_name: "Desktop MCP",
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
  assert.equal(metadata.clientName, "Desktop MCP");
  assert.deepEqual(metadata.redirectUris, [REDIRECT_URI]);
  assert.equal(isMcpExportOAuthRedirectUriRegistered(metadata, REDIRECT_URI), true);
  assert.equal(isMcpExportOAuthRedirectUriRegistered(metadata, "https://attacker.example/callback"), false);
  for (const redirectUri of ["http://localhost:49152/callback", "http://127.0.0.1:49152/callback", "http://[::1]:49152/callback"]) {
    const loopbackMetadata = parseMcpExportOAuthClientMetadata(CLIENT_ID, {
      client_id: CLIENT_ID, client_name: "Loopback client", redirect_uris: [redirectUri],
    });
    assert.deepEqual(loopbackMetadata.redirectUris, [redirectUri]);
  }
  assert.throws(() => parseMcpExportOAuthClientMetadata(CLIENT_ID, {
    client_id: CLIENT_ID, client_name: "Private Scheme", redirect_uris: ["com.example.desktop:/oauth/callback"],
  }), (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_CLIENT");
  assert.throws(() => parseMcpExportOAuthClientMetadata(CLIENT_ID, {
    client_id: CLIENT_ID, client_name: "Public HTTP", redirect_uris: ["http://client.example/oauth/callback"],
  }), (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_CLIENT");
  const otherRedirect = "https://client.example/oauth/complete";
  const semanticA = parseMcpExportOAuthClientMetadata(CLIENT_ID, {
    client_id: CLIENT_ID, client_name: "Desktop MCP", redirect_uris: [REDIRECT_URI, otherRedirect],
    grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", extension: { version: 1 },
  });
  const semanticB = parseMcpExportOAuthClientMetadata(CLIENT_ID, {
    extension: { version: 99 }, token_endpoint_auth_method: "none", response_types: ["code"], grant_types: ["authorization_code"],
    redirect_uris: [otherRedirect, REDIRECT_URI], client_name: "Desktop MCP", client_id: CLIENT_ID,
  });
  assert.equal(semanticA.fingerprint, semanticB.fingerprint);
  assert.notEqual(semanticA.fingerprint, parseMcpExportOAuthClientMetadata(CLIENT_ID, {
    client_id: CLIENT_ID, client_name: "Different Name", redirect_uris: [REDIRECT_URI, otherRedirect],
    grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
  }).fingerprint);
  assert.notEqual(semanticA.fingerprint, parseMcpExportOAuthClientMetadata(CLIENT_ID, {
    client_id: CLIENT_ID, client_name: "Desktop MCP", redirect_uris: [REDIRECT_URI, "https://client.example/oauth/changed"],
    grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
  }).fingerprint);
  assert.throws(() => parseMcpExportOAuthClientMetadata(CLIENT_ID, {
    client_id: "https://other.example/oauth/client.json", client_name: "Mismatch", redirect_uris: [REDIRECT_URI],
  }), (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_CLIENT");
  const previousFeature = process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED;
  const previousOauth = process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED;
  const previousOrigin = process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN;
  process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED = "true";
  process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED = "true";
  process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN = "https://mcp.example";
  try {
    const query = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      state: "opaque-state", code_challenge: CHALLENGE, code_challenge_method: "S256", resource: RESOURCE, scope: "project:read" });
    assert.equal(parseMcpExportOAuthAuthorizationParameters(query).resource, RESOURCE);
    query.append("client_id", CLIENT_ID);
    assert.throws(() => parseMcpExportOAuthAuthorizationParameters(query),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_REQUEST");

    const tokenForm = new URLSearchParams({ grant_type: "authorization_code", code: `apos_mcp_code_${"C".repeat(43)}`,
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, resource: RESOURCE, code_verifier: VERIFIER });
    assert.equal(parseMcpExportOAuthTokenRequest(tokenForm).grantType, "authorization_code");
    tokenForm.set("resource", "https://mcp.example/other");
    assert.throws(() => parseMcpExportOAuthTokenRequest(tokenForm),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_GRANT");
  } finally {
    if (previousFeature === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED = previousFeature;
    if (previousOauth === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED = previousOauth;
    if (previousOrigin === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN = previousOrigin;
  }
});

test("OAuth admission fingerprints normalize client IDs and the consent cookie cap is bounded", () => {
  assert.match(mcpExportOAuthClientAdmissionFingerprint(CLIENT_ID), /^[0-9a-f]{64}$/u);
  const ids = Array.from({ length: 4 }, (_, index) => getMcpExportOAuthCsrfCookieName(
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  ));
  assert.equal(hasMcpExportOAuthCsrfCookieCapacity(null), true);
  assert.equal(hasMcpExportOAuthCsrfCookieCapacity(ids.slice(0, 3).map((name) => `${name}=secret`).join("; ")), true);
  assert.equal(hasMcpExportOAuthCsrfCookieCapacity(ids.map((name) => `${name}=secret`).join("; ")), false);
  assert.equal(hasMcpExportOAuthCsrfCookieCapacity(`${ids[0]}=secret; ${ids[0]}=another`), true);
});

test("consent callback policy binds exact CSP origins and falls back for unsupported IP hosts", () => {
  for (const [redirectUri, origin] of [
    ["https://client.example/oauth/callback", "https://client.example"],
    ["https://localhost:8443/oauth/callback", "https://localhost:8443"],
    ["http://localhost:49152/oauth/callback", "http://localhost:49152"],
    ["http://127.0.0.1:49152/oauth/callback", "http://127.0.0.1:49152"],
  ]) {
    const policy = getMcpExportOAuthConsentCallbackPolicy(redirectUri);
    assert.equal(policy.mode, "redirect");
    assert.equal(policy.origin, origin);
    assert.ok(policy.contentSecurityPolicy.includes(`form-action 'self' ${origin};`));
  }

  for (const redirectUri of [
    "http://[::1]:49152/oauth/callback",
    "https://192.0.2.25:8443/oauth/callback",
    "https://client_name.example/oauth/callback",
  ]) {
    const policy = getMcpExportOAuthConsentCallbackPolicy(redirectUri);
    assert.equal(policy.mode, "manual");
    assert.equal(policy.contentSecurityPolicy, MCP_EXPORT_OAUTH_CONSENT_CSP);
    assert.doesNotMatch(policy.contentSecurityPolicy, /192\.0\.2\.25|\[::1\]/u);
  }

  for (const unsafe of [
    "ftp://client.example/oauth/callback",
    "https://*.client.example/oauth/callback",
    "https://client.example/oauth/callback\r\nX-Injected: yes",
  ]) {
    assert.throws(() => canonicalRedirectUri(unsafe),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_CLIENT");
  }
});

test("manual callback fallback is no-store, no-referrer, static-CSP, escaped, and clears CSRF", async () => {
  const csrfDeletion = "__Host-mcp-export-oauth-00000000-0000-4000-8000-000000000001=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
  const approval = buildMcpExportOAuthManualCallbackResponse({
    redirectUri: "http://[::1]:49152/oauth/callback",
    state: "state</a><script>bad()</script>",
    issuer: "https://mcp.example",
    code: `apos_mcp_code_${"A".repeat(43)}`,
    error: null,
  }, csrfDeletion);
  const approvalHtml = await approval.text();
  assert.equal(approval.status, 200);
  assert.equal(approval.headers.get("cache-control"), "no-store");
  assert.equal(approval.headers.get("referrer-policy"), "no-referrer");
  assert.equal(approval.headers.get("content-security-policy"), MCP_EXPORT_OAUTH_CONSENT_CSP);
  assert.equal(approval.headers.get("set-cookie"), csrfDeletion);
  assert.match(approvalHtml, /rel="noreferrer" href="http:\/\/\[::1\]:49152\/oauth\/callback\?code=apos_mcp_code_/u);
  assert.doesNotMatch(approvalHtml, /<script>/u);

  const denial = buildMcpExportOAuthManualCallbackResponse({
    redirectUri: "http://[::1]:49152/oauth/callback",
    state: "denied-state",
    issuer: "https://mcp.example",
    code: null,
    error: "access_denied",
  }, csrfDeletion);
  assert.match(await denial.text(), /error=access_denied/u);
  assert.equal(denial.headers.get("set-cookie"), csrfDeletion);
});

test("CIMD fetch concurrency is capped per process and slots are released", async () => {
  const releases: Array<() => void> = [];
  const active = Array.from({ length: 8 }, () => withMcpExportOAuthCimdFetchSlot(() => new Promise<void>((resolve) => releases.push(resolve))));
  assert.equal(releases.length, 8);
  await assert.rejects(() => withMcpExportOAuthCimdFetchSlot(async () => undefined),
    (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_RATE_LIMITED");
  releases.forEach((release) => release());
  await Promise.all(active);
  assert.equal(await withMcpExportOAuthCimdFetchSlot(async () => "available"), "available");
});

test("OAuth metadata and MCP challenge are advertised only when the full chain is enabled", async () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const testDatabaseUrl = "postgresql://runtime:runtime@127.0.0.1:59999/mcp_export_oauth_unit";
  const previous = {
    nodeEnv: mutableEnv.NODE_ENV,
    exportEnabled: process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED,
    oauthEnabled: process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED,
    origin: process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN,
    databaseUrl: process.env.DATABASE_URL,
  };
  try {
    mutableEnv.NODE_ENV = "production";
    delete process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED;
    process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED = "true";
    process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN = "https://mcp.example";
    assert.equal(isMcpExportOAuthEnabled(), false);
    assert.equal(isMcpExportFeatureEnabled(), false);
    assert.equal(isMcpExportLegacyBearerEnabled(), false);
    assert.equal((await getAuthorizationServerMetadata(new Request("https://mcp.example/.well-known/oauth-authorization-server", {
      headers: { host: "mcp.example" },
    }))).status, 404);

    process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED = "true";
    assert.equal(isMcpExportOAuthEnabled(), true);
    process.env.DATABASE_URL = testDatabaseUrl;
    const invalidConsentPage = await getMcpOAuthConsent(new Request("https://mcp.example/mcp/authorize?requestId=first&requestId=second", {
      headers: { host: "mcp.example" },
    }));
    assert.equal(invalidConsentPage.status, 400);
    assert.equal(invalidConsentPage.headers.get("referrer-policy"), "no-referrer");
    assert.equal(invalidConsentPage.headers.get("content-security-policy"), MCP_EXPORT_OAUTH_CONSENT_CSP);
    assert.equal(invalidConsentPage.headers.get("cache-control"), "no-store");

    for (const origin of ["null", "https://attacker.example"]) {
      const rejectedConsent = await postMcpOAuthConsent(new Request("https://mcp.example/mcp/authorize", {
        method: "POST",
        headers: { host: "mcp.example", origin, "content-type": "application/x-www-form-urlencoded" },
        body: "requestId=invalid&decision=deny",
      }));
      assert.equal(rejectedConsent.status, 403);
      assert.equal(rejectedConsent.headers.get("referrer-policy"), "no-referrer");
      assert.equal(rejectedConsent.headers.get("content-security-policy"), MCP_EXPORT_OAUTH_CONSENT_CSP);
    }

    const invalidConsentContentType = await postMcpOAuthConsent(new Request("https://mcp.example/mcp/authorize", {
      method: "POST",
      headers: { host: "mcp.example", origin: "https://mcp.example", "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(invalidConsentContentType.status, 415);
    assert.equal(invalidConsentContentType.headers.get("referrer-policy"), "no-referrer");
    assert.equal(invalidConsentContentType.headers.get("content-security-policy"), MCP_EXPORT_OAUTH_CONSENT_CSP);

    const unauthenticatedConsentPost = await postMcpOAuthConsent(new Request("https://mcp.example/mcp/authorize", {
      method: "POST",
      headers: { host: "mcp.example", origin: "https://mcp.example", "content-type": "application/x-www-form-urlencoded" },
      body: "requestId=invalid&decision=deny",
    }));
    assert.equal(unauthenticatedConsentPost.status, 400);
    assert.equal(unauthenticatedConsentPost.headers.get("referrer-policy"), "no-referrer");
    assert.equal(unauthenticatedConsentPost.headers.get("content-security-policy"), MCP_EXPORT_OAUTH_CONSENT_CSP);

    const authorizationResponse = await getAuthorizationServerMetadata(new Request("https://mcp.example/.well-known/oauth-authorization-server", {
      headers: { host: "mcp.example" },
    }));
    assert.equal(authorizationResponse.status, 200);
    const authorizationMetadata = await authorizationResponse.json() as Record<string, unknown>;
    assert.equal(authorizationMetadata.issuer, "https://mcp.example");
    assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ["S256"]);
    assert.equal(authorizationMetadata.authorization_response_iss_parameter_supported, true);

    const protectedResponse = await getProtectedResourceMetadata(new Request("https://mcp.example/.well-known/oauth-protected-resource/api/mcp", {
      headers: { host: "mcp.example" },
    }));
    assert.equal(protectedResponse.status, 200);
    const protectedMetadata = await protectedResponse.json() as Record<string, unknown>;
    assert.equal(protectedMetadata.resource, RESOURCE);
    assert.deepEqual(protectedMetadata.authorization_servers, ["https://mcp.example"]);
    assert.deepEqual(protectedMetadata.scopes_supported, ["project:read"]);

    const invalidAuthorize = await getOAuthAuthorize(new Request("https://mcp.example/oauth/authorize", {
      headers: { host: "mcp.example" },
    }));
    assert.equal(invalidAuthorize.status, 400);
    assert.deepEqual(await invalidAuthorize.json(), { error: "invalid_request" });

    const invalidToken = await postOAuthToken(new Request("https://mcp.example/oauth/token", {
      method: "POST", headers: { host: "mcp.example", "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=password",
    }));
    assert.equal(invalidToken.status, 400);
    assert.deepEqual(await invalidToken.json(), { error: "invalid_grant" });

    const challenged = await postMcp(new Request("https://mcp.example/api/mcp", {
      method: "POST", headers: { host: "mcp.example", "content-type": "application/json" }, body: "{}",
    }));
    assert.equal(challenged.status, 401);
    assert.match(challenged.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/mcp\.example\/.well-known\/oauth-protected-resource\/api\/mcp"/u);
    assert.match(challenged.headers.get("www-authenticate") ?? "", /scope="project:read"/u);
    const legacyCredential = await postMcp(new Request("https://mcp.example/api/mcp", {
      method: "POST", headers: { host: "mcp.example", authorization: `Bearer apos_mcp_${"A".repeat(43)}` },
    }));
    assert.equal(legacyCredential.status, 401);
    assert.equal((await postMcp(new Request("https://attacker.example/api/mcp", {
      method: "POST", headers: { host: "attacker.example" },
    }))).status, 403);
  } finally {
    if (process.env.DATABASE_URL === testDatabaseUrl) await getDb().$disconnect();
    if (previous.nodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previous.nodeEnv;
    if (previous.exportEnabled === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED = previous.exportEnabled;
    if (previous.oauthEnabled === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED = previous.oauthEnabled;
    if (previous.origin === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN = previous.origin;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});
