import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { ProjectItemRevisionAction } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { POST as postMcp } from "../src/app/api/mcp/route";
import { POST as postOAuthToken } from "../src/app/oauth/token/route";
import { GET as getOAuthConsent } from "../src/app/mcp/authorize/route";
import { GET as getSource } from "../src/app/api/projects/[projectId]/sources/[sourceId]/route";
import { createSession, SESSION_COOKIE_NAME } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { POSTGRES_GATE_TEST_USER } from "../scripts/postgres-gate-contract";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { deleteArchivedProject, updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { appendProjectItemRevision, createPrimaryProjectItemEvidence } from "../src/lib/project-item-history";
import {
  McpExportGrantError,
  confirmMcpExportApproval,
  createMcpExportGrant,
  dispatchMcpExportProject,
  listMcpExportGrants,
  listMcpExportDispatchAudits,
  prepareMcpExportApproval,
  readMcpExportProject,
  revokeMcpExportGrant,
} from "../src/lib/mcp-export-grants";
import {
  bindMcpExportOAuthAuthorizationRequest,
  cleanupExpiredMcpExportOAuthState,
  createMcpExportOAuthAuthorizationRequest,
  decideMcpExportOAuthAuthorization,
  exchangeMcpExportOAuthAuthorizationCode,
  mcpExportOAuthClientAdmissionFingerprint,
  McpExportOAuthError,
  parseMcpExportOAuthAuthorizationParameters,
  parseMcpExportOAuthClientMetadata,
  parseMcpExportOAuthTokenRequest,
  reserveMcpExportOAuthAuthorizationAttempt,
} from "../src/lib/mcp-export-oauth";
import { getMcpExportOAuthCsrfCookieName } from "../src/lib/mcp-export-oauth-config";

const shouldRun = process.env.MCP_EXPORT_POSTGRES_GATE === "1";

test("outbound MCP grant is project scoped and fails closed after revoke, expiry, epoch mismatch and archive", {
  skip: !shouldRun ? "MCP_EXPORT_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const previousNodeEnv = mutableEnv.NODE_ENV;
  mutableEnv.NODE_ENV = "test";
  const previousFlag = process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED;
  const previousOAuthFlag = process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED;
  const previousOrigin = process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN;
  delete process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED;
  assert.equal((await postMcp(new Request("http://localhost/api/mcp", { method: "POST" }))).status, 404);
  process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED = "true";
  delete process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN;
  assert.equal((await postMcp(new Request("http://localhost/api/mcp", { method: "POST" }))).status, 503);
  process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN = "http://localhost";
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const otherUserId = randomUUID();
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error("MCP_EXPORT_POSTGRES_DATABASE_URL_REQUIRED");
  const replicaDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const oauthAdmissionFingerprints = new Set<string>();
  const globalBudgetFingerprint = "0".repeat(64);
  const actor = { id: userId, role: "user" as const, accountAccessVersion: 1 };
  const otherActor = { id: otherUserId, role: "user" as const, accountAccessVersion: 1 };

  try {
    await replicaDb.$connect();
    await db.appUser.create({ data: { id: userId, username: `mcp_export_${suffix}`, role: "user" } });
    await db.appUser.create({ data: { id: otherUserId, username: `mcp_export_other_${suffix}`, role: "user" } });
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: `MCP Export ${suffix}`, slug: `mcp-export-${suffix}`, createdById: userId } });
      await grantWorkspaceMembership(tx, { workspaceId, userId, role: "owner", actorId: userId, reason: "mcp_export_fixture" });
    });
    await db.project.create({ data: { id: projectId, workspaceId, name: `Export ${suffix}`, slug: `mcp-export-project-${suffix}`, description: "Allowed project" } });
    await db.$transaction(async (tx) => {
      await grantProjectMembership(tx, { projectId, workspaceId, userId, role: "owner", actorId: userId, reason: "mcp_export_fixture" });
    });

    process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED = "true";
    const oauthClientId = `https://client.example/oauth/${suffix}.json`;
    const oauthRedirectUri = "http://localhost:49152/oauth/callback";
    const otherOauthRedirectUri = "http://localhost:49153/oauth/callback";
    const sharedClientNamePrefix = `MCP client ${suffix}`.padEnd(80, "x");
    const oauthClientName = `${sharedClientNamePrefix} A`;
    const oauthVerifier = randomBytes(32).toString("base64url");
    const oauthChallenge = createHash("sha256").update(oauthVerifier, "ascii").digest("base64url");
    const oauthParams = parseMcpExportOAuthAuthorizationParameters(new URLSearchParams({
      response_type: "code", client_id: oauthClientId, redirect_uri: oauthRedirectUri,
      state: `state-${suffix}`, code_challenge: oauthChallenge, code_challenge_method: "S256",
      resource: "http://localhost/api/mcp", scope: "project:read",
    }));
    const oauthMetadata = parseMcpExportOAuthClientMetadata(oauthClientId, {
      client_id: oauthClientId, client_name: oauthClientName, redirect_uris: [oauthRedirectUri, otherOauthRedirectUri],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], extension: "ignored-v1",
    });
    const oauthAuthorizationRequest = await createMcpExportOAuthAuthorizationRequest(oauthParams, oauthMetadata, db);
    await assert.rejects(() => bindMcpExportOAuthAuthorizationRequest(actor, oauthAuthorizationRequest.requestId, "0".repeat(43), db),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_REQUEST");
    await bindMcpExportOAuthAuthorizationRequest(actor, oauthAuthorizationRequest.requestId, oauthAuthorizationRequest.csrfToken, db);
    await assert.rejects(() => bindMcpExportOAuthAuthorizationRequest(otherActor, oauthAuthorizationRequest.requestId, oauthAuthorizationRequest.csrfToken, db),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_REQUEST");
    await assert.rejects(() => decideMcpExportOAuthAuthorization(otherActor, {
      requestId: oauthAuthorizationRequest.requestId, csrfToken: oauthAuthorizationRequest.csrfToken,
      decision: "approve", projectId,
    }, db, { fetchClientMetadata: async () => oauthMetadata }),
    (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_REQUEST");
    const driftedMetadata = parseMcpExportOAuthClientMetadata(oauthClientId, {
      client_id: oauthClientId, client_name: `${oauthClientName} changed`, redirect_uris: [otherOauthRedirectUri, oauthRedirectUri],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
    });
    await assert.rejects(() => decideMcpExportOAuthAuthorization(actor, {
      requestId: oauthAuthorizationRequest.requestId, csrfToken: oauthAuthorizationRequest.csrfToken,
      decision: "approve", projectId,
    }, db, { fetchClientMetadata: async () => driftedMetadata }),
    (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_CLIENT");
    const driftedRedirectMetadata = parseMcpExportOAuthClientMetadata(oauthClientId, {
      client_id: oauthClientId, client_name: oauthClientName, redirect_uris: [oauthRedirectUri, "http://localhost:49154/changed"],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
    });
    await assert.rejects(() => decideMcpExportOAuthAuthorization(actor, {
      requestId: oauthAuthorizationRequest.requestId, csrfToken: oauthAuthorizationRequest.csrfToken,
      decision: "approve", projectId,
    }, db, { fetchClientMetadata: async () => driftedRedirectMetadata }),
    (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_CLIENT");
    const reorderedMetadata = parseMcpExportOAuthClientMetadata(oauthClientId, {
      extension: "ignored-v2", response_types: ["code"], grant_types: ["authorization_code"], token_endpoint_auth_method: "none",
      redirect_uris: [otherOauthRedirectUri, oauthRedirectUri], client_name: oauthClientName, client_id: oauthClientId,
    });
    const oauthDecision = await decideMcpExportOAuthAuthorization(actor, {
      requestId: oauthAuthorizationRequest.requestId, csrfToken: oauthAuthorizationRequest.csrfToken,
      decision: "approve", projectId,
    }, db, { fetchClientMetadata: async () => reorderedMetadata });
    assert.ok(oauthDecision.code);
    const oauthCodeHash = createHash("sha256").update(oauthDecision.code!, "utf8").digest("hex");
    const oauthCodeRow = await db.mcpExportOAuthCode.findUniqueOrThrow({ where: { codeHash: oauthCodeHash } });
    assert.notEqual(oauthCodeRow.codeHash, oauthDecision.code);
    assert.equal(JSON.stringify(oauthCodeRow).includes(oauthDecision.code!), false);
    const oauthGrant = await db.mcpExportGrant.findUniqueOrThrow({ where: { id: oauthCodeRow.grantId } });
    assert.equal(oauthGrant.grantType, "oauth");
    assert.equal(oauthGrant.oauthClientId, oauthClientId);
    assert.equal(oauthGrant.oauthClientName, oauthClientName);
    assert.equal(oauthGrant.label, sharedClientNamePrefix);
    assert.match(oauthGrant.tokenHash, /^[0-9a-f]{64}$/u);
    assert.notEqual(oauthGrant.tokenHash, oauthCodeRow.codeHash);
    const clientBudgetFingerprint = mcpExportOAuthClientAdmissionFingerprint(oauthClientId);
    oauthAdmissionFingerprints.add(clientBudgetFingerprint);
    const budgetNow = new Date();
    await db.mcpExportOAuthAdmissionBudget.upsert({
      where: { scope_keyFingerprint: { scope: "client_hour", keyFingerprint: clientBudgetFingerprint } },
      create: { scope: "client_hour", keyFingerprint: clientBudgetFingerprint, windowStartedAt: budgetNow,
        attemptCount: 19, createdAt: budgetNow, updatedAt: budgetNow },
      update: { windowStartedAt: budgetNow, attemptCount: 19 },
    });
    await db.mcpExportOAuthAdmissionBudget.upsert({
      where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: globalBudgetFingerprint } },
      create: { scope: "global_hour", keyFingerprint: globalBudgetFingerprint, windowStartedAt: budgetNow,
        attemptCount: 1, createdAt: budgetNow, updatedAt: budgetNow },
      update: { windowStartedAt: budgetNow, attemptCount: 1 },
    });
    await reserveMcpExportOAuthAuthorizationAttempt(oauthClientId, replicaDb);
    assert.equal((await db.mcpExportOAuthAdmissionBudget.findUniqueOrThrow({
      where: { scope_keyFingerprint: { scope: "client_hour", keyFingerprint: clientBudgetFingerprint } },
    })).attemptCount, 20);
    await assert.rejects(() => reserveMcpExportOAuthAuthorizationAttempt(oauthClientId, db),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_RATE_LIMITED");
    assert.equal((await db.mcpExportOAuthAdmissionBudget.findUniqueOrThrow({
      where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: globalBudgetFingerprint } },
    })).attemptCount, 2);

    await db.mcpExportOAuthAdmissionBudget.update({
      where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: globalBudgetFingerprint } },
      data: { attemptCount: 199, windowStartedAt: new Date() },
    });
    const globalRaceClientIds = [
      `https://client.example/oauth/global-race-a-${suffix}.json`,
      `https://client.example/oauth/global-race-b-${suffix}.json`,
    ];
    const globalRaceFingerprints = globalRaceClientIds.map((clientId) => mcpExportOAuthClientAdmissionFingerprint(clientId));
    globalRaceFingerprints.forEach((fingerprint) => oauthAdmissionFingerprints.add(fingerprint));
    const globalRace = await Promise.allSettled([
      reserveMcpExportOAuthAuthorizationAttempt(globalRaceClientIds[0], db),
      reserveMcpExportOAuthAuthorizationAttempt(globalRaceClientIds[1], replicaDb),
    ]);
    assert.equal(globalRace.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(globalRace.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await db.mcpExportOAuthAdmissionBudget.findUniqueOrThrow({
      where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: globalBudgetFingerprint } },
    })).attemptCount, 200);
    assert.equal(await db.mcpExportOAuthAdmissionBudget.count({
      where: { scope: "client_hour", keyFingerprint: { in: globalRaceFingerprints } },
    }), 1, "a rejected global reservation must not consume that client's bucket");

    const requestFor = (clientId: string, redirectUri: string, state: string) => parseMcpExportOAuthAuthorizationParameters(new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirectUri, state,
      code_challenge: "C".repeat(43), code_challenge_method: "S256",
      resource: "http://localhost/api/mcp", scope: "project:read",
    }));
    const outstandingClientId = `https://client.example/oauth/outstanding-${suffix}.json`;
    const outstandingRedirectUri = "https://client.example/oauth/callback";
    const outstandingMetadata = parseMcpExportOAuthClientMetadata(outstandingClientId, {
      client_id: outstandingClientId, client_name: "Outstanding request test", redirect_uris: [outstandingRedirectUri],
    });
    const concurrentRequestResults = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      createMcpExportOAuthAuthorizationRequest(
        requestFor(outstandingClientId, outstandingRedirectUri, `outstanding-${suffix}-${index}`),
        outstandingMetadata,
        index % 2 === 0 ? db : replicaDb,
      )));
    const acceptedOutstandingRequests = concurrentRequestResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rejectedOutstandingRequests = concurrentRequestResults.filter((result) => result.status === "rejected");
    assert.equal(acceptedOutstandingRequests.length, 5);
    assert.equal(rejectedOutstandingRequests.length, 1);
    assert.ok(rejectedOutstandingRequests[0]?.status === "rejected"
      && rejectedOutstandingRequests[0].reason instanceof McpExportOAuthError
      && rejectedOutstandingRequests[0].reason.code === "MCP_EXPORT_OAUTH_RATE_LIMITED");
    await db.mcpExportOAuthAuthorizationRequest.deleteMany({ where: { id: { in: acceptedOutstandingRequests.map((row) => row.requestId) } } });

    const globalOutstandingIds = Array.from({ length: 200 }, () => randomUUID());
    const globalOutstandingNow = new Date();
    const globalOutstandingExpiry = new Date(globalOutstandingNow.getTime() + 10 * 60 * 1_000);
    await db.mcpExportOAuthAuthorizationRequest.createMany({ data: globalOutstandingIds.map((id, index) => ({
      id,
      clientId: `https://client.example/oauth/pending-${suffix}-${index}.json`,
      clientName: "Global outstanding fixture",
      clientMetadataFingerprint: "e".repeat(64),
      redirectUri: "https://client.example/oauth/callback",
      state: `global-outstanding-${suffix}-${index}`,
      codeChallenge: "C".repeat(43),
      resource: "http://localhost/api/mcp",
      scopes: "project:read",
      csrfHash: "f".repeat(64),
      expiresAt: globalOutstandingExpiry,
      createdAt: globalOutstandingNow,
    })) });
    const overflowClientId = `https://client.example/oauth/global-overflow-${suffix}.json`;
    const overflowRedirectUri = "https://client.example/oauth/callback";
    const overflowMetadata = parseMcpExportOAuthClientMetadata(overflowClientId, {
      client_id: overflowClientId, client_name: "Global overflow test", redirect_uris: [overflowRedirectUri],
    });
    await assert.rejects(() => createMcpExportOAuthAuthorizationRequest(
      requestFor(overflowClientId, overflowRedirectUri, `global-overflow-${suffix}`), overflowMetadata, replicaDb,
    ), (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_RATE_LIMITED");
    await db.mcpExportOAuthAuthorizationRequest.deleteMany({ where: { id: { in: globalOutstandingIds } } });
    const tokenFields = (verifier: string) => new URLSearchParams({
      grant_type: "authorization_code", code: oauthDecision.code!, client_id: oauthClientId,
      redirect_uri: oauthRedirectUri, resource: "http://localhost/api/mcp", code_verifier: verifier,
    });
    const wrongVerifierRequest = parseMcpExportOAuthTokenRequest(tokenFields(randomBytes(32).toString("base64url")));
    await assert.rejects(() => exchangeMcpExportOAuthAuthorizationCode(wrongVerifierRequest, db),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_GRANT");
    const wrongClientRequest = parseMcpExportOAuthTokenRequest(new URLSearchParams({
      ...Object.fromEntries(tokenFields(oauthVerifier)), client_id: "https://other.example/client.json",
    }));
    await assert.rejects(() => exchangeMcpExportOAuthAuthorizationCode(wrongClientRequest, db),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_GRANT");
    const wrongRedirectRequest = parseMcpExportOAuthTokenRequest(new URLSearchParams({
      ...Object.fromEntries(tokenFields(oauthVerifier)), redirect_uri: "https://attacker.example/callback",
    }));
    await assert.rejects(() => exchangeMcpExportOAuthAuthorizationCode(wrongRedirectRequest, db),
      (error: unknown) => error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_INVALID_GRANT");
    const postToken = () => postOAuthToken(new Request("http://localhost/oauth/token", {
      method: "POST", headers: { host: "localhost", "content-type": "application/x-www-form-urlencoded" },
      body: tokenFields(oauthVerifier).toString(),
    }));
    const exchanged = await Promise.all([postToken(), postToken()]);
    assert.deepEqual(exchanged.map((response) => response.status).sort(), [200, 400]);
    const tokenResponse = exchanged.find((response) => response.status === 200)!;
    const tokenPayload = await tokenResponse.json() as { access_token: string; token_type: string; expires_in: number; scope: string; refresh_token?: string };
    assert.match(tokenPayload.access_token, /^apos_mcp_oauth_[A-Za-z0-9_-]{43}$/u);
    assert.equal(tokenPayload.token_type, "Bearer");
    assert.ok(tokenPayload.expires_in <= 15 * 60 && tokenPayload.expires_in > 0);
    assert.equal(tokenPayload.scope, "project:read");
    assert.equal(tokenPayload.refresh_token, undefined);
    const oauthTokenHash = createHash("sha256").update(tokenPayload.access_token, "utf8").digest("hex");
    const oauthTokenRow = await db.mcpExportOAuthAccessToken.findUniqueOrThrow({ where: { tokenHash: oauthTokenHash } });
    assert.notEqual(oauthTokenRow.tokenHash, tokenPayload.access_token);
    assert.equal(oauthTokenRow.expiresAt <= oauthGrant.expiresAt, true);
    assert.equal(JSON.stringify(oauthTokenRow).includes(tokenPayload.access_token), false);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: oauthGrant.id } }), 0,
      JSON.stringify({ grantId: oauthGrant.id, operation: "project_summary", auditCount: 0, stage: "before_content_approval" }));

    const oauthPreview = await prepareMcpExportApproval(actor, oauthGrant.id, {
      provider: "test OAuth client", model: "read-only model", operation: "project_summary",
    }, db);
    assert.equal(oauthPreview.oauthClientId, oauthClientId);
    assert.equal(oauthPreview.oauthClientName, oauthClientName);
    await confirmMcpExportApproval(actor, oauthGrant.id, {
      approvalId: oauthPreview.approvalId, contentFingerprint: oauthPreview.contentFingerprint, acknowledge: true,
    }, db);
    const oauthCall = await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST", headers: {
        authorization: `Bearer ${tokenPayload.access_token}`, accept: "application/json, text/event-stream",
        "content-type": "application/json", "mcp-protocol-version": "2025-11-25",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "project_summary", arguments: {} } }),
    }));
    const oauthWire = await oauthCall.text();
    const oauthPayloadText = oauthWire.startsWith("event:")
      ? oauthWire.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      : oauthWire;
    assert.equal(oauthCall.status, 200);
    assert.ok(oauthPayloadText);
    assert.equal((JSON.parse(oauthPayloadText!) as { result?: { structuredContent?: { project?: { id?: string } } } }).result?.structuredContent?.project?.id, projectId);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: oauthGrant.id } }), 1);
    const oauthAudit = await db.mcpExportDispatchAudit.findFirstOrThrow({
      where: { grantId: oauthGrant.id }, select: { approvalId: true, operation: true, oauthClientId: true, oauthClientName: true },
    });
    assert.deepEqual(oauthAudit, {
      approvalId: oauthPreview.approvalId, operation: "project_summary", oauthClientId, oauthClientName,
    });
    const oauthReplay = await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST", headers: {
        authorization: `Bearer ${tokenPayload.access_token}`, accept: "application/json, text/event-stream",
        "content-type": "application/json", "mcp-protocol-version": "2025-11-25",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "project_summary", arguments: {} } }),
    }));
    assert.match(await oauthReplay.text(), /approval required/u);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: oauthGrant.id } }), 1);
    assert.equal(await revokeMcpExportGrant(actor, oauthGrant.id, db), true);
    const revokedOAuthCall = await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST", headers: { authorization: `Bearer ${tokenPayload.access_token}` },
    }));
    assert.equal(revokedOAuthCall.status, 401);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: oauthGrant.id } }), 1,
      JSON.stringify({ grantId: oauthGrant.id, operation: "project_summary", auditCount: 1, stage: "after_replay_and_revoke" }));

    const issued = await createMcpExportGrant(actor, { projectId, label: "local client", lifetimeDays: 1 }, db);
    assert.match(issued.token, /^apos_mcp_[A-Za-z0-9_-]{43}$/u);
    const rows = await listMcpExportGrants(actor, db);
    assert.equal(rows.length, 2);
    assert.equal(JSON.stringify(rows).includes(issued.token), false);
    assert.equal((await readMcpExportProject(`Bearer ${issued.token}`, db)).project.id, projectId);
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const response = await postMcp(new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }));
      const wire = await response.text();
      const payload = wire.startsWith("event:")
        ? wire.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
        : wire;
      assert.ok(payload, wire);
      return { status: response.status, body: JSON.parse(payload) as { result?: Record<string, unknown> } };
    };
    const listed = await rpc("tools/list", {});
    assert.equal(listed.status, 200);
    assert.match(JSON.stringify(listed.body), /project_summary/u);
    const unapproved = await rpc("tools/call", { name: "project_summary", arguments: {} });
    assert.equal(unapproved.status, 200);
    assert.equal(unapproved.body.result?.isError, true);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: issued.grant.id } }), 0);
    const preparedLegacy = await prepareMcpExportApproval(actor, issued.grant.id, { provider: "test client", model: "legacy model", operation: "project_summary" }, db);
    await confirmMcpExportApproval(actor, issued.grant.id, {
      approvalId: preparedLegacy.approvalId, contentFingerprint: preparedLegacy.contentFingerprint, acknowledge: true,
    }, db);
    const called = await rpc("tools/call", { name: "project_summary", arguments: {} });
    assert.equal(called.status, 200);
    assert.equal((called.body.result?.structuredContent as { project?: { id?: string } } | undefined)?.project?.id, projectId);
    const repeated = await rpc("tools/call", { name: "project_summary", arguments: {} });
    assert.equal(repeated.body.result?.isError, true);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: issued.grant.id } }), 1);
    const stalePreview = await prepareMcpExportApproval(actor, issued.grant.id, { provider: "test client", model: "stale model", operation: "project_summary" }, db);
    await db.project.update({ where: { id: projectId }, data: { description: "Changed after preview" } });
    await assert.rejects(() => confirmMcpExportApproval(actor, issued.grant.id, {
      approvalId: stalePreview.approvalId, contentFingerprint: stalePreview.contentFingerprint, acknowledge: true,
    }, db), (error: unknown) => error instanceof McpExportGrantError && error.code === "MCP_EXPORT_APPROVAL_STALE");
    const preparedModern = await prepareMcpExportApproval(actor, issued.grant.id, { provider: "test client", model: "modern model", operation: "project_summary" }, db);
    await confirmMcpExportApproval(actor, issued.grant.id, {
      approvalId: preparedModern.approvalId, contentFingerprint: preparedModern.contentFingerprint, acknowledge: true,
    }, db);
    const modernEnvelope = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "mcp-export-gate", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const modern = await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernEnvelope } }),
    }));
    assert.equal(modern.status, 200);
    assert.match(await modern.text(), /project_summary/u);
    const modernCall = await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "project_summary",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project_summary", arguments: {}, _meta: modernEnvelope } }),
    }));
    assert.equal(modernCall.status, 200);
    assert.match(await modernCall.text(), new RegExp(projectId, "u"));
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: issued.grant.id } }), 2);
    const preparedConcurrent = await prepareMcpExportApproval(actor, issued.grant.id, { provider: "test client", model: "concurrent model", operation: "project_summary" }, db);
    await confirmMcpExportApproval(actor, issued.grant.id, {
      approvalId: preparedConcurrent.approvalId, contentFingerprint: preparedConcurrent.contentFingerprint, acknowledge: true,
    }, db);
    const concurrent = await Promise.all([
      rpc("tools/call", { name: "project_summary", arguments: {} }),
      rpc("tools/call", { name: "project_summary", arguments: {} }),
    ]);
    const concurrentRpcClasses = concurrent.map((item) => item.body.result?.isError === true ? "tool_error" : "success").sort();
    const concurrentAuditCount = await db.mcpExportDispatchAudit.count({ where: { grantId: issued.grant.id } });
    assert.deepEqual(concurrentRpcClasses, ["success", "tool_error"], JSON.stringify({
      approvalId: preparedConcurrent.approvalId, operation: "project_summary",
      auditCount: concurrentAuditCount, rpcClasses: concurrentRpcClasses,
    }));
    assert.equal(concurrentAuditCount, 3, JSON.stringify({
      approvalId: preparedConcurrent.approvalId, operation: "project_summary",
      auditCount: concurrentAuditCount, rpcClasses: concurrentRpcClasses,
    }));
    const projectAuditsAfterConcurrent = await listMcpExportDispatchAudits(actor, projectId, db);
    assert.equal(projectAuditsAfterConcurrent.filter((audit) => audit.grantId === oauthGrant.id).length, 1);
    assert.equal(projectAuditsAfterConcurrent.filter((audit) => audit.grantId === issued.grant.id).length, 3);
    assert.equal(projectAuditsAfterConcurrent.length, 4, JSON.stringify({
      approvalId: preparedConcurrent.approvalId, operation: "project_summary",
      auditCounts: { oauthGrant: 1, legacyGrant: 3, projectTotal: projectAuditsAfterConcurrent.length },
      rpcClasses: concurrentRpcClasses,
    }));
    const sourceText = `Reviewed source ${suffix}`;
    const sourceHash = createHash("sha256").update(sourceText).digest("hex");
    const source = await db.projectSource.create({ data: {
      projectId, kind: "manual", contentText: sourceText, contentHash: sourceHash, manualContentDedupeKey: sourceHash,
    } });
    const session = await createSession(db, await db.appUser.findUniqueOrThrow({ where: { id: userId } }));
    const sourceEndpoint = `http://localhost/api/projects/${projectId}/sources/${source.id}`;
    const sourceHeaders = { cookie: `${SESSION_COOKIE_NAME}=${session.token}`, host: "localhost" };
    const sourceContext = { params: Promise.resolve({ projectId, sourceId: source.id }) };
    const currentCitation = await getSource(new Request(`${sourceEndpoint}?contentHash=${sourceHash}`, { headers: sourceHeaders }), sourceContext);
    assert.equal(currentCitation.status, 200);
    assert.equal(currentCitation.headers.get("cache-control"), "private, no-store");
    const staleCitation = await getSource(new Request(`${sourceEndpoint}?contentHash=${"0".repeat(64)}`, { headers: sourceHeaders }), sourceContext);
    assert.equal(staleCitation.status, 409);
    assert.doesNotMatch(await staleCitation.text(), /Reviewed source/u);
    const duplicateCitation = await getSource(new Request(`${sourceEndpoint}?contentHash=${sourceHash}&contentHash=${sourceHash}`, { headers: sourceHeaders }), sourceContext);
    assert.equal(duplicateCitation.status, 400);
    await db.$transaction(async (tx) => {
      const item = await tx.projectItem.create({ data: {
        projectId, sourceId: source.id, type: "progress", reviewStatus: "confirmed", title: "Reviewed fact",
        content: "Verified delivery", sourceExcerpt: sourceText, confirmedAt: new Date(),
      } });
      const evidence = await createPrimaryProjectItemEvidence(tx, {
        projectId, projectItemId: item.id, projectSourceId: source.id, sourceText,
        sourceExcerpt: sourceText, createdAt: item.createdAt,
      });
      await appendProjectItemRevision(tx, {
        item, action: ProjectItemRevisionAction.manualCreated, actorId: userId,
        evidences: [evidence], createdAt: item.createdAt,
      });
    });
    const objective = await db.projectObjective.create({ data: {
      projectId, title: "Release objective", createdById: userId,
    } });
    const workItem = await db.projectWorkItem.create({ data: {
      projectId, objectiveId: objective.id, title: "Release work item", createdById: userId,
    } });
    const legacyText = `Historical MCP source ${suffix}`;
    const legacyHash = createHash("sha256").update(legacyText).digest("hex");
    // Reproduce a pre-quarantine row in this disposable database. Current
    // application writes correctly reject new MCP sources.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
      const legacySource = await tx.projectSource.create({ data: {
        projectId, kind: "mcp", contentText: legacyText, contentHash: legacyHash, retiredAt: new Date(),
      } });
      const legacyItem = await tx.projectItem.create({ data: {
        projectId, sourceId: legacySource.id, type: "progress", reviewStatus: "confirmed",
        title: "Legacy MCP fact must stay hidden", content: legacyText, confirmedAt: new Date(),
      } });
      await tx.projectItemEvidence.create({ data: {
        projectId, projectItemId: legacyItem.id, projectSourceId: legacySource.id,
        role: "primary", sourceExcerpt: legacyText,
      } });
      const contaminatedItem = await tx.projectItem.create({ data: {
        projectId, sourceId: source.id, type: "progress", reviewStatus: "confirmed",
        title: "Mixed lineage fact must stay hidden", content: sourceText, confirmedAt: new Date(),
      } });
      await tx.projectItemEvidence.createMany({ data: [
        { projectId, projectItemId: contaminatedItem.id, projectSourceId: source.id,
          role: "primary", sourceExcerpt: sourceText },
        { projectId, projectItemId: contaminatedItem.id, projectSourceId: legacySource.id,
          role: "supporting", sourceExcerpt: legacyText },
      ] });
      const legacyWorkItem = await tx.projectWorkItem.create({ data: {
        projectId, objectiveId: objective.id, title: "Legacy MCP task must stay hidden", createdById: userId,
      } });
      await tx.projectWorkItemEvidenceLink.create({ data: {
        projectId, workItemId: legacyWorkItem.id, kind: "projectSource", projectSourceId: legacySource.id,
        label: "Legacy MCP source", evidenceSnapshot: {}, evidenceFingerprint: legacyHash, createdById: userId,
      } });
      await tx.$executeRaw`SET LOCAL session_replication_role = 'origin'`;
    });
    const evidencePreview = await prepareMcpExportApproval(actor, issued.grant.id, {
      provider: "test client", model: "evidence model", operation: "project_evidence",
    }, db);
    assert.match(JSON.stringify(evidencePreview.content), /Reviewed fact/u);
    assert.doesNotMatch(JSON.stringify(evidencePreview.content), /Legacy MCP fact must stay hidden/u);
    assert.doesNotMatch(JSON.stringify(evidencePreview.content), /Mixed lineage fact must stay hidden/u);
    await confirmMcpExportApproval(actor, issued.grant.id, {
      approvalId: evidencePreview.approvalId, contentFingerprint: evidencePreview.contentFingerprint, acknowledge: true,
    }, db);
    assert.equal((await rpc("tools/call", { name: "project_plan", arguments: {} })).body.result?.isError, true);
    assert.equal((await rpc("tools/call", { name: "project_evidence", arguments: { unexpected: "value" } })).body.result?.isError, true);
    const evidenceCall = await rpc("tools/call", { name: "project_evidence", arguments: {} });
    assert.match(JSON.stringify(evidenceCall.body), /Reviewed fact/u);
    const stalePlanPreview = await prepareMcpExportApproval(actor, issued.grant.id, {
      provider: "test client", model: "plan model", operation: "project_plan",
    }, db);
    await db.projectWorkItem.update({ where: { id: workItem.id }, data: { title: "Release work item updated" } });
    await assert.rejects(() => confirmMcpExportApproval(actor, issued.grant.id, {
      approvalId: stalePlanPreview.approvalId, contentFingerprint: stalePlanPreview.contentFingerprint, acknowledge: true,
    }, db), (error: unknown) => error instanceof McpExportGrantError && error.code === "MCP_EXPORT_APPROVAL_STALE");
    const planPreview = await prepareMcpExportApproval(actor, issued.grant.id, {
      provider: "test client", model: "plan model", operation: "project_plan",
    }, db);
    assert.match(JSON.stringify(planPreview.content), /Release objective/u);
    assert.doesNotMatch(JSON.stringify(planPreview.content), /Legacy MCP task must stay hidden/u);
    await confirmMcpExportApproval(actor, issued.grant.id, {
      approvalId: planPreview.approvalId, contentFingerprint: planPreview.contentFingerprint, acknowledge: true,
    }, db);
    const planCall = await rpc("tools/call", { name: "project_plan", arguments: {} });
    assert.match(JSON.stringify(planCall.body), /Release work item updated/u);
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { grantId: issued.grant.id } }), 5);
    const projectAuditsAfterPlan = await listMcpExportDispatchAudits(actor, projectId, db);
    assert.equal(projectAuditsAfterPlan.filter((audit) => audit.grantId === oauthGrant.id).length, 1);
    assert.equal(projectAuditsAfterPlan.filter((audit) => audit.grantId === issued.grant.id).length, 5);
    assert.equal(projectAuditsAfterPlan.length, 6);
    const firstAudit = await db.mcpExportDispatchAudit.findFirstOrThrow({ where: { grantId: issued.grant.id } });
    assert.equal(firstAudit.operation, "project_summary");
    await assert.rejects(() => db.mcpExportDispatchAudit.update({ where: { id: firstAudit.id }, data: { model: "changed" } }));
    await assert.rejects(() => db.mcpExportDispatchAudit.delete({ where: { id: firstAudit.id } }));

    const secondOauthClientId = `https://client.example/oauth/${suffix}-second.json`;
    const secondOauthClientName = `${sharedClientNamePrefix} B`;
    const secondOauthMetadata = parseMcpExportOAuthClientMetadata(secondOauthClientId, {
      client_id: secondOauthClientId, client_name: secondOauthClientName, redirect_uris: [oauthRedirectUri],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
    });
    const secondOauthParams = parseMcpExportOAuthAuthorizationParameters(new URLSearchParams({
      response_type: "code", client_id: secondOauthClientId, redirect_uri: oauthRedirectUri,
      state: `state-${suffix}-second`, code_challenge: oauthChallenge, code_challenge_method: "S256",
      resource: "http://localhost/api/mcp", scope: "project:read",
    }));
    const secondOauthRequest = await createMcpExportOAuthAuthorizationRequest(secondOauthParams, secondOauthMetadata, db);
    await bindMcpExportOAuthAuthorizationRequest(actor, secondOauthRequest.requestId, secondOauthRequest.csrfToken, db);
    const oauthSession = await createSession(db, await db.appUser.findUniqueOrThrow({ where: { id: userId } }));
    const consentPage = await getOAuthConsent(new Request(
      `http://localhost/mcp/authorize?requestId=${encodeURIComponent(secondOauthRequest.requestId)}`,
      { headers: {
        host: "localhost",
        cookie: `${getMcpExportOAuthCsrfCookieName(secondOauthRequest.requestId)}=${secondOauthRequest.csrfToken}; ${SESSION_COOKIE_NAME}=${oauthSession.token}`,
      } },
    ));
    assert.equal(consentPage.status, 200);
    const consentHtml = await consentPage.text();
    assert.match(consentHtml, new RegExp(secondOauthClientName, "u"));
    assert.ok(consentHtml.includes(secondOauthClientId));
    assert.match(consentHtml, /回调主机名/u);
    assert.match(consentHtml, /localhost/u);
    const secondOauthDecision = await decideMcpExportOAuthAuthorization(actor, {
      requestId: secondOauthRequest.requestId, csrfToken: secondOauthRequest.csrfToken, decision: "approve", projectId,
    }, db, { fetchClientMetadata: async () => secondOauthMetadata });
    assert.ok(secondOauthDecision.code);
    const secondOauthToken = await exchangeMcpExportOAuthAuthorizationCode(parseMcpExportOAuthTokenRequest(new URLSearchParams({
      grant_type: "authorization_code", code: secondOauthDecision.code!, client_id: secondOauthClientId,
      redirect_uri: oauthRedirectUri, resource: "http://localhost/api/mcp", code_verifier: oauthVerifier,
    })), db);
    const secondOauthGrant = await db.mcpExportGrant.findFirstOrThrow({ where: {
      oauthClientId: secondOauthClientId, ownerUserId: userId,
    } });
    assert.equal(secondOauthGrant.label, sharedClientNamePrefix);
    assert.equal(secondOauthGrant.oauthClientName, secondOauthClientName);
    const secondOauthPreview = await prepareMcpExportApproval(actor, secondOauthGrant.id, {
      provider: "test OAuth client", model: "read-only model", operation: "project_summary",
    }, db);
    assert.equal(secondOauthPreview.oauthClientId, secondOauthClientId);
    assert.equal(secondOauthPreview.oauthClientName, secondOauthClientName);
    await confirmMcpExportApproval(actor, secondOauthGrant.id, {
      approvalId: secondOauthPreview.approvalId,
      contentFingerprint: secondOauthPreview.contentFingerprint, acknowledge: true,
    }, db);
    const secondOauthCall = await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST", headers: {
        authorization: `Bearer ${secondOauthToken.accessToken}`, accept: "application/json, text/event-stream",
        "content-type": "application/json", "mcp-protocol-version": "2025-11-25",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "project_summary", arguments: {} } }),
    }));
    const secondOauthWire = await secondOauthCall.text();
    const secondOauthPayloadText = secondOauthWire.startsWith("event:")
      ? secondOauthWire.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      : secondOauthWire;
    assert.ok(secondOauthPayloadText, "second OAuth MCP response must contain JSON-RPC payload");
    const secondOauthPayload = JSON.parse(secondOauthPayloadText!) as {
      error?: { message?: string };
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { project?: { id?: string } };
      };
    };
    assert.equal(secondOauthCall.status, 200);
    let directDispatchDiagnostic = "not-needed";
    if (secondOauthPayload.result?.isError === true) {
      try {
        await dispatchMcpExportProject(`Bearer ${secondOauthToken.accessToken}`, "project_summary", db);
        directDispatchDiagnostic = "direct-dispatch-succeeded";
      } catch (error) {
        directDispatchDiagnostic = error instanceof McpExportGrantError ? error.code : "unexpected-error";
      }
    }
    assert.notEqual(secondOauthPayload.result?.isError, true, JSON.stringify({
      rpcError: secondOauthPayload.error?.message,
      toolError: secondOauthPayload.result?.content?.map((item) => item.text?.slice(0, 200)),
      directDispatch: directDispatchDiagnostic,
      approvalId: secondOauthPreview.approvalId,
      auditCount: await db.mcpExportDispatchAudit.count({ where: { grantId: secondOauthGrant.id } }),
    }));
    assert.equal(secondOauthPayload.result?.structuredContent?.project?.id, projectId);
    const secondOauthAudit = await db.mcpExportDispatchAudit.findFirstOrThrow({
      where: { grantId: secondOauthGrant.id }, select: { id: true, approvalId: true, oauthClientId: true, oauthClientName: true },
    });
    assert.deepEqual({
      approvalId: secondOauthAudit.approvalId,
      oauthClientId: secondOauthAudit.oauthClientId,
      oauthClientName: secondOauthAudit.oauthClientName,
    }, {
      approvalId: secondOauthPreview.approvalId, oauthClientId: secondOauthClientId, oauthClientName: secondOauthClientName,
    });
    const visibleOauthAudits = await listMcpExportDispatchAudits(actor, projectId, db);
    const samePrefixOauthAudits = visibleOauthAudits.filter((audit) => audit.oauthClientId === oauthClientId
      || audit.oauthClientId === secondOauthClientId);
    assert.deepEqual(samePrefixOauthAudits.map(({ recipientLabel, oauthClientId: clientId, oauthClientName: clientName }) => ({
      recipientLabel, clientId, clientName,
    })).sort((left, right) => left.clientId!.localeCompare(right.clientId!)), [
      { recipientLabel: sharedClientNamePrefix, clientId: oauthClientId, clientName: oauthClientName },
      { recipientLabel: sharedClientNamePrefix, clientId: secondOauthClientId, clientName: secondOauthClientName },
    ].sort((left, right) => left.clientId.localeCompare(right.clientId)));

    const staleCutoff = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    const recentExpiry = new Date(Date.now() - 60 * 60 * 1_000);
    const staleFixtureCreatedAt = new Date(staleCutoff.getTime() - 60 * 60 * 1_000);
    const recentFixtureCreatedAt = new Date(recentExpiry.getTime() - 10 * 60 * 1_000);
    const oldRequestId = randomUUID();
    const recentRequestId = randomUUID();
    const staleRequestBase = {
      clientId: secondOauthClientId,
      clientName: secondOauthClientName,
      clientMetadataFingerprint: "e".repeat(64),
      redirectUri: oauthRedirectUri,
      codeChallenge: "C".repeat(43),
      resource: "http://localhost/api/mcp",
      scopes: "project:read",
      csrfHash: "f".repeat(64),
    };
    await db.mcpExportOAuthAuthorizationRequest.createMany({ data: [
      { id: oldRequestId, ...staleRequestBase, state: `old-${suffix}`, createdAt: staleFixtureCreatedAt,
        expiresAt: staleCutoff, resolvedAt: staleCutoff },
      { id: recentRequestId, ...staleRequestBase, state: `recent-${suffix}`, createdAt: recentFixtureCreatedAt,
        expiresAt: recentExpiry },
    ] });
    const oldCodeHash = randomBytes(32).toString("hex");
    const recentCodeHash = randomBytes(32).toString("hex");
    await db.mcpExportOAuthCode.createMany({ data: [
      { codeHash: oldCodeHash, grantId: secondOauthGrant.id, clientId: secondOauthClientId,
        redirectUri: oauthRedirectUri, resource: "http://localhost/api/mcp", scopes: "project:read",
        codeChallenge: "C".repeat(43), createdAt: staleFixtureCreatedAt, expiresAt: staleCutoff, consumedAt: staleCutoff },
      { codeHash: recentCodeHash, grantId: secondOauthGrant.id, clientId: secondOauthClientId,
        redirectUri: oauthRedirectUri, resource: "http://localhost/api/mcp", scopes: "project:read",
        codeChallenge: "C".repeat(43), createdAt: recentFixtureCreatedAt, expiresAt: recentExpiry },
    ] });
    const oldTokenHash = randomBytes(32).toString("hex");
    const recentTokenHash = randomBytes(32).toString("hex");
    await db.mcpExportOAuthAccessToken.createMany({ data: [
      { tokenHash: oldTokenHash, grantId: secondOauthGrant.id, clientId: secondOauthClientId,
        resource: "http://localhost/api/mcp", scopes: "project:read", createdAt: staleFixtureCreatedAt,
        expiresAt: staleCutoff, revokedAt: staleCutoff },
      { tokenHash: recentTokenHash, grantId: secondOauthGrant.id, clientId: secondOauthClientId,
        resource: "http://localhost/api/mcp", scopes: "project:read", createdAt: recentFixtureCreatedAt,
        expiresAt: recentExpiry },
    ] });
    const staleBudgetClientId = `https://client.example/oauth/stale-budget-${suffix}.json`;
    const staleBudgetFingerprint = mcpExportOAuthClientAdmissionFingerprint(staleBudgetClientId);
    const staleBudgetCreatedAt = new Date();
    oauthAdmissionFingerprints.add(staleBudgetFingerprint);
    await db.mcpExportOAuthAdmissionBudget.upsert({
      where: { scope_keyFingerprint: { scope: "client_hour", keyFingerprint: staleBudgetFingerprint } },
      create: { scope: "client_hour", keyFingerprint: staleBudgetFingerprint, windowStartedAt: staleCutoff,
        attemptCount: 1, createdAt: staleBudgetCreatedAt, updatedAt: staleBudgetCreatedAt },
      update: { windowStartedAt: staleCutoff, attemptCount: 1 },
    });
    const extraStaleBudgetFingerprints = Array.from({ length: 101 }, (_, index) => createHash("sha256")
      .update(`oauth-cleanup-${suffix}-${index}`, "utf8").digest("hex"));
    extraStaleBudgetFingerprints.forEach((fingerprint) => oauthAdmissionFingerprints.add(fingerprint));
    await db.mcpExportOAuthAdmissionBudget.createMany({ data: extraStaleBudgetFingerprints.map((keyFingerprint) => ({
      scope: "client_hour",
      keyFingerprint,
      windowStartedAt: staleCutoff,
      attemptCount: 1,
      createdAt: staleBudgetCreatedAt,
      updatedAt: staleBudgetCreatedAt,
    })) });
    await db.mcpExportOAuthAdmissionBudget.update({
      where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: globalBudgetFingerprint } },
      data: { windowStartedAt: new Date(), attemptCount: 1 },
    });
    const [databasePrincipal] = await replicaDb.$queryRaw<Array<{ principal: string }>>`SELECT current_user AS principal`;
    assert.equal(databasePrincipal?.principal, POSTGRES_GATE_TEST_USER,
      "the focused PostgreSQL test uses the dedicated gate principal; runtime ACLs are covered by the principal gate");
    const oauthEnabledBeforeCleanup = process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED;
    const cleanupResult = await (async () => {
      delete process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED;
      try {
        return await cleanupExpiredMcpExportOAuthState(replicaDb);
      } finally {
        if (oauthEnabledBeforeCleanup === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED;
        else process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED = oauthEnabledBeforeCleanup;
      }
    })();
    assert.equal(cleanupResult.acquired, true, "the independent maintenance pass obtains its cross-replica lock");
    assert.ok(cleanupResult.authorizationRequestsDeleted >= 1);
    assert.ok(cleanupResult.codesDeleted >= 1);
    assert.ok(cleanupResult.accessTokensDeleted >= 1);
    assert.ok(cleanupResult.admissionBudgetsDeleted >= extraStaleBudgetFingerprints.length + 1,
      "separate bounded transactions continue past the first 100-row batch");
    assert.equal(await db.mcpExportOAuthAuthorizationRequest.count({ where: { id: oldRequestId } }), 0);
    assert.equal(await db.mcpExportOAuthAuthorizationRequest.count({ where: { id: recentRequestId } }), 1);
    assert.equal(await db.mcpExportOAuthCode.count({ where: { codeHash: oldCodeHash } }), 0);
    assert.equal(await db.mcpExportOAuthCode.count({ where: { codeHash: recentCodeHash } }), 1);
    assert.equal(await db.mcpExportOAuthAccessToken.count({ where: { tokenHash: oldTokenHash } }), 0);
    assert.equal(await db.mcpExportOAuthAccessToken.count({ where: { tokenHash: recentTokenHash } }), 1);
    assert.equal(await db.mcpExportOAuthAdmissionBudget.count({
      where: { scope: "client_hour", keyFingerprint: staleBudgetFingerprint },
    }), 0, "independent cleanup prunes the stale admission bucket without creating a replacement");
    assert.equal(await db.mcpExportOAuthAdmissionBudget.count({
      where: { scope: "client_hour", keyFingerprint: { in: extraStaleBudgetFingerprints } },
    }), 0, "cleanup catches up across more than one bounded batch");
    assert.equal(await db.mcpExportOAuthAdmissionBudget.count({
      where: { scope: "global_hour", keyFingerprint: globalBudgetFingerprint },
    }), 1, "the active global admission bucket is retained");
    const liveSecondOauthTokenHash = createHash("sha256").update(secondOauthToken.accessToken, "utf8").digest("hex");
    assert.equal(await db.mcpExportOAuthAccessToken.count({
      where: { tokenHash: liveSecondOauthTokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    }), 1, "live OAuth access tokens are retained");
    assert.equal(await db.mcpExportGrant.count({
      where: { id: secondOauthGrant.id, revokedAt: null, expiresAt: { gt: new Date() } },
    }), 1, "live grants are retained");
    assert.equal(await db.mcpExportDispatchAudit.count({ where: { id: secondOauthAudit.id } }), 1,
      "immutable dispatch audit history is retained");
    const listen = await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "subscriptions/listen", params: { _meta: modernEnvelope } }),
    }));
    assert.equal(listen.status, 200);
    assert.match(await listen.text(), /Subscription limit reached/u);
    assert.equal((await postMcp(new Request("http://localhost/api/mcp", { method: "POST" }))).status, 401);
    assert.equal((await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST", headers: { origin: "https://untrusted.example", authorization: `Bearer ${issued.token}` },
    }))).status, 403);
    assert.equal((await postMcp(new Request("http://attacker.example/api/mcp", {
      method: "POST", headers: { authorization: `Bearer ${issued.token}` },
    }))).status, 403);
    assert.equal((await postMcp(new Request("http://attacker.example/api/mcp", {
      method: "POST", headers: { authorization: `Bearer ${issued.token}`, "x-forwarded-host": "localhost" },
    }))).status, 403);
    assert.equal(await revokeMcpExportGrant(actor, issued.grant.id, db), true);
    const denied = await postMcp(new Request("http://localhost/api/mcp", {
      method: "POST", headers: { authorization: `Bearer ${issued.token}` },
    }));
    assert.equal(denied.status, 401);
    await assert.rejects(() => readMcpExportProject(`Bearer ${issued.token}`, db), (error: unknown) =>
      error instanceof McpExportGrantError && error.code === "MCP_EXPORT_UNAUTHORIZED");

    const expired = await createMcpExportGrant(actor, { projectId, label: "expired", lifetimeDays: 1 }, db);
    await db.mcpExportGrant.update({ where: { id: expired.grant.id }, data: {
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
      expiresAt: new Date(Date.now() - 1_000),
    } });
    await assert.rejects(() => readMcpExportProject(`Bearer ${expired.token}`, db), (error: unknown) =>
      error instanceof McpExportGrantError && error.code === "MCP_EXPORT_UNAUTHORIZED");

    const stale = await createMcpExportGrant(actor, { projectId, label: "stale epoch", lifetimeDays: 1 }, db);
    await db.mcpExportGrant.update({ where: { id: stale.grant.id }, data: { ownerAccessVersion: 2 } });
    await assert.rejects(() => readMcpExportProject(`Bearer ${stale.token}`, db), (error: unknown) =>
      error instanceof McpExportGrantError && error.code === "MCP_EXPORT_UNAUTHORIZED");

    const raceText = `Retirement fence ${suffix}`;
    const raceHash = createHash("sha256").update(raceText).digest("hex");
    const raceSource = await db.projectSource.create({ data: {
      projectId, kind: "manual", contentText: raceText, contentHash: raceHash, manualContentDedupeKey: raceHash,
    } });
    let markLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const reader = db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"::text AS "id" FROM "ProjectSource"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${raceSource.id}::uuid
        FOR SHARE
      `;
      assert.equal(rows[0]?.id, raceSource.id);
      markLocked();
      await release;
    });
    await locked;
    let retired = false;
    const retirement = db.projectSource.update({
      where: { projectId_id: { projectId, id: raceSource.id } }, data: { retiredAt: new Date() },
    }).then(() => { retired = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(retired, false, "source retirement must wait for citation row-share lock");
    } finally {
      releaseLock();
    }
    await Promise.all([reader, retirement]);
    const retiredCitation = await getSource(new Request(
      `http://localhost/api/projects/${projectId}/sources/${raceSource.id}?contentHash=${raceHash}`,
      { headers: sourceHeaders },
    ), { params: Promise.resolve({ projectId, sourceId: raceSource.id }) });
    assert.equal(retiredCitation.status, 409);
    assert.doesNotMatch(await retiredCitation.text(), /Retirement fence/u);

    const archived = await createMcpExportGrant(actor, { projectId, label: "archive", lifetimeDays: 1 }, db);
    const current = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { updatedAt: true } });
    await updateProjectLifecycle({ projectId, actor, action: "archive", expectedUpdatedAt: current.updatedAt }, db);
    await assert.rejects(() => readMcpExportProject(`Bearer ${archived.token}`, db), (error: unknown) =>
      error instanceof McpExportGrantError && error.code === "MCP_EXPORT_UNAUTHORIZED");
    const projectForDeletion = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, updatedAt: true } });
    await deleteArchivedProject({
      projectId, actor, confirmationName: projectForDeletion.name, expectedUpdatedAt: projectForDeletion.updatedAt,
    }, db);
    const retainedOauthAudits = await db.mcpExportDispatchAudit.findMany({
      where: { projectId, oauthClientId: { in: [oauthClientId, secondOauthClientId] } },
      select: { oauthClientId: true, oauthClientName: true },
    });
    assert.deepEqual(retainedOauthAudits.map(({ oauthClientId: clientId, oauthClientName: clientName }) => ({ clientId, clientName }))
      .sort((left, right) => left.clientId!.localeCompare(right.clientId!)), [
      { clientId: oauthClientId, clientName: oauthClientName },
      { clientId: secondOauthClientId, clientName: secondOauthClientName },
    ].sort((left, right) => left.clientId.localeCompare(right.clientId)));
  } finally {
    const cleanupProject = await db.project.findUnique({ where: { id: projectId }, select: { name: true, archivedAt: true, updatedAt: true } });
    if (cleanupProject !== null) {
      if (cleanupProject.archivedAt === null) {
        await updateProjectLifecycle({ projectId, actor, action: "archive", expectedUpdatedAt: cleanupProject.updatedAt }, db);
      }
      const archivedProject = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, updatedAt: true } });
      await deleteArchivedProject({ projectId, actor, confirmationName: archivedProject.name, expectedUpdatedAt: archivedProject.updatedAt }, db);
    }
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.mcpExportOAuthAdmissionBudget.deleteMany({
      where: { keyFingerprint: { in: [...oauthAdmissionFingerprints, globalBudgetFingerprint] } },
    });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
      await tx.appSession.deleteMany({ where: { userId } });
      await tx.$executeRaw`SET LOCAL session_replication_role = 'origin'`;
    });
    await db.appUser.deleteMany({ where: { id: userId } });
    await db.appUser.deleteMany({ where: { id: otherUserId } });
    if (previousFlag === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_ENABLED = previousFlag;
    if (previousOAuthFlag === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED = previousOAuthFlag;
    if (previousOrigin === undefined) delete process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN;
    else process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN = previousOrigin;
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previousNodeEnv;
    await replicaDb.$disconnect();
  }
});
