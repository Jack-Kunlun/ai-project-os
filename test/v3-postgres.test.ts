import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ProjectItemRevisionAction } from "@prisma/client";
import { AccessControlError, accessibleProjectWhere, authorizeApiRequest } from "../src/lib/access-control";
import { createProjectAutomationRule, runAutomationWorkerCycle } from "../src/lib/automation";
import { DEFAULT_WORKSPACE_ID } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { analyzeProjectMemoryQuality, resolveMemoryQualityIssue, updateProjectItemMemoryMetadata } from "../src/lib/memory-quality";
import { beginOidcLogin, completeOidcLogin, createOidcProvider, deleteOidcProvider, OidcError, updateOidcProvider } from "../src/lib/oidc";
import { appendProjectItemRevision, createPrimaryProjectItemEvidence } from "../src/lib/project-item-history";
import { updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { createProjectWebSource, syncProjectWebSource } from "../src/lib/web-sources";
import { acceptWorkspaceInvitation, createWorkspaceInvitation, updateWorkspaceMember, WorkspaceError } from "../src/lib/workspaces";

const shouldRun = process.env.V3_POSTGRES_GATE === "1";

function digest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }

test("V3 persists RBAC, memory governance, automation, web sources and OIDC code flow", { skip: !shouldRun ? "V3_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const projectA = randomUUID();
  const projectB = randomUUID();
  const memberId = randomUUID();
  const roleWorkspaceId = randomUUID();
  const masterKeyPath = `/tmp/ai-project-os-v3-${process.pid}-${suffix}.key`;
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;
  await unlink(masterKeyPath).catch(() => undefined);
  let oidcProviderId: string | null = null;
  let oidcProviderCredentialId: string | null = null;
  let oidcUserId: string | null = null;
  let collisionUserId: string | null = null;
  let failedFlowCredentialId: string | null = null;
  let disposableOidcProviderId: string | null = null;
  let disposableOidcCredentialId: string | null = null;
  let documentText = "<html><head><title>V3 文档</title></head><body><h1>首次版本</h1><p>连接器已启用。</p></body></html>";
  let expectedNonce = "";
  let expectedChallenge = "";
  let tokenEmail = `oidc-${suffix}@example.com`;
  let tokenSubject = `subject-${suffix}`;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(publicKey)), kid: `v3-${suffix}`, use: "sig", alg: "RS256" };
  let issuer = "";
  const server = createServer(async (request, response) => {
    if (request.url === `${new URL(issuer).pathname}/.well-known/openid-configuration`) {
      response.writeHead(200, { "content-type": "application/json" });
      const endpointOrigin = new URL(issuer).origin;
      response.end(JSON.stringify({ issuer, authorization_endpoint: `${endpointOrigin}/authorize`, token_endpoint: `${endpointOrigin}/token`, jwks_uri: `${endpointOrigin}/jwks`, response_types_supported: ["code"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"] }));
      return;
    }
    if (request.url === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ keys: [publicJwk] })); return;
    }
    if (request.url === "/token" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      assert.equal(form.get("code"), "valid-code");
      assert.equal(form.get("client_id"), null);
      assert.equal(form.get("client_secret"), null);
      assert.equal(Buffer.from((request.headers.authorization ?? "").replace(/^Basic\s+/u, ""), "base64").toString("utf8"), `client-${suffix}:secret-${suffix}-123456`);
      assert.equal(createHash("sha256").update(form.get("code_verifier") ?? "", "utf8").digest("base64url"), expectedChallenge);
      const idToken = await new SignJWT({ nonce: expectedNonce, email: tokenEmail, email_verified: true, name: "OIDC Member", preferred_username: `oidc_${suffix}` })
        .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid }).setIssuer(issuer).setAudience(`client-${suffix}`).setSubject(tokenSubject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id_token: idToken, token_type: "Bearer" })); return;
    }
    if (request.url === "/doc") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(documentText); return;
    }
    response.writeHead(404, { "content-type": "text/plain" }); response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  issuer = `http://127.0.0.1:${address.port}/tenant-${suffix}`;

  try {
    const admin = await db.appUser.findFirstOrThrow({ where: { role: "admin" } });
    const memberEmail = `v3-member-${suffix}@example.com`;
    await db.appUser.create({ data: { id: memberId, username: `v3_member_${suffix}`, email: memberEmail, role: "member", passwordHash: null, passwordSalt: null } });
    await db.workspace.create({ data: { id: roleWorkspaceId, name: `Role safety ${suffix}`, slug: `role-safety-${suffix}`, createdById: admin.id } });
    await db.workspaceMembership.create({ data: { workspaceId: DEFAULT_WORKSPACE_ID, userId: memberId, role: "member" } });
    await db.workspaceMembership.create({ data: { workspaceId: roleWorkspaceId, userId: memberId, role: "owner" } });
    await db.project.createMany({ data: [
      { id: projectA, workspaceId: DEFAULT_WORKSPACE_ID, name: `V3 A ${suffix}`, slug: `v3-a-${suffix}` },
      { id: projectB, workspaceId: DEFAULT_WORKSPACE_ID, name: `V3 B ${suffix}`, slug: `v3-b-${suffix}` },
    ] });
    await db.projectMembership.createMany({ data: [
      { projectId: projectA, userId: memberId, role: "viewer" },
      { projectId: projectB, userId: memberId, role: "editor" },
    ] });

    const member = { id: memberId, role: "member" as const };
    const visible = await db.project.findMany({ where: accessibleProjectWhere(member), select: { id: true } });
    assert.deepEqual(new Set(visible.map((project) => project.id)), new Set([projectA, projectB]));
    await authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectA}`, { method: "GET" }), db);
    await assert.rejects(() => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectA}/items`, { method: "POST" }), db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");
    await authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectB}/items`, { method: "POST" }), db);
    await assert.rejects(() => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectB}/lifecycle`, { method: "PATCH" }), db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");
    await assert.rejects(() => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectB}`, { method: "DELETE" }), db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");
    await assert.rejects(() => authorizeApiRequest(member, new Request("http://localhost/api/settings/providers", { method: "GET" }), db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");
    await assert.rejects(() => updateWorkspaceMember(roleWorkspaceId, memberId, { workspaceRole: "viewer" }, admin, db), (error: unknown) => error instanceof WorkspaceError && error.code === "WORKSPACE_LAST_OWNER_REQUIRED");
    const invitation = await createWorkspaceInvitation(DEFAULT_WORKSPACE_ID, { email: memberEmail, workspaceRole: "viewer", projectId: projectB, projectRole: "viewer", expiresInDays: 7 }, admin, db);
    await acceptWorkspaceInvitation(invitation.token, { id: memberId, email: memberEmail }, "/dashboard", db);
    assert.equal((await db.workspaceMembership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: DEFAULT_WORKSPACE_ID, userId: memberId } } })).role, "member");
    assert.equal((await db.projectMembership.findUniqueOrThrow({ where: { projectId_userId: { projectId: projectB, userId: memberId } } })).role, "editor");

    const sourceText = "数据库选择 PostgreSQL。自动同步已启用。风险需要复核。";
    const sourceHash = digest(sourceText);
    const source = await db.projectSource.create({ data: { projectId: projectB, kind: "manual", contentText: sourceText, contentHash: sourceHash, manualContentDedupeKey: sourceHash } });
    const importedContent = `相同正文，保留不同来源。${suffix}`;
    const importedHash = digest(importedContent);
    await db.projectSource.createMany({ data: [
      { projectId: projectB, kind: "git", contentText: importedContent, contentHash: importedHash, externalRef: `https://git.example.com/a/${suffix}` },
      { projectId: projectB, kind: "git", contentText: importedContent, contentHash: importedHash, externalRef: `https://git.example.com/b/${suffix}` },
    ] });
    assert.equal(await db.projectSource.count({ where: { projectId: projectB, kind: "git", contentHash: importedHash } }), 2);
    async function item(input: { type: "decision" | "progress" | "issue" | "risk"; title: string; content: string; confidence?: number; lastVerifiedAt?: Date }) {
      return db.$transaction(async (tx) => {
        const excerpt = "数据库选择 PostgreSQL";
        const created = await tx.projectItem.create({ data: { projectId: projectB, sourceId: source.id, type: input.type, reviewStatus: "confirmed", title: input.title, content: input.content, sourceExcerpt: excerpt, confirmedAt: new Date(), confidence: input.confidence, lastVerifiedAt: input.lastVerifiedAt } });
        const evidence = await createPrimaryProjectItemEvidence(tx, { projectId: projectB, projectItemId: created.id, projectSourceId: source.id, sourceText: source.contentText, sourceExcerpt: excerpt, createdAt: created.createdAt });
        await appendProjectItemRevision(tx, { item: created, action: ProjectItemRevisionAction.manualCreated, actorId: admin.id, evidences: [evidence], createdAt: created.createdAt });
        return created;
      });
    }
    const first = await item({ type: "decision", title: "数据库选择", content: "决定采用 PostgreSQL 作为主数据库", confidence: 0.95 });
    await item({ type: "decision", title: "数据库选择。", content: "决定：采用 PostgreSQL 作为主数据库。", confidence: 0.92 });
    await item({ type: "decision", title: "部署策略", content: "生产环境允许自动发布", confidence: 0.9 });
    await item({ type: "decision", title: "部署策略", content: "生产环境严格禁止自动发布并要求人工审批", confidence: 0.9 });
    await item({ type: "risk", title: "旧风险", content: "需要重新核对", confidence: 0.4, lastVerifiedAt: new Date(Date.now() - 200 * 86_400_000) });
    const quality = await analyzeProjectMemoryQuality(projectB, db);
    assert.ok(quality.counts.duplicate >= 1);
    assert.ok(quality.counts.conflict >= 1);
    assert.ok(quality.counts.stale >= 1);
    assert.ok(quality.counts.lowConfidence >= 1);
    await updateProjectItemMemoryMetadata(projectB, first.id, { expectedUpdatedAt: first.updatedAt.toISOString(), importance: 90, confidence: 1, pinned: true, verifyNow: true }, admin, db);
    assert.equal((await db.projectItemRevision.findFirstOrThrow({ where: { projectId: projectB, projectItemId: first.id }, orderBy: { revisionNumber: "desc" } })).action, "metadataUpdated");
    const issueToResolve = quality.issues.find((issue) => issue.status === "open")!;
    await resolveMemoryQualityIssue(projectB, issueToResolve.id, { status: "resolved", note: "V3 集成测试人工处置" }, admin, db);

    const consentRule = await createProjectAutomationRule(projectB, { name: `Index ${suffix}`, kind: "memoryIndex", intervalMinutes: 60, config: { mode: "incremental" }, startAt: new Date().toISOString() }, admin, db);
    await runAutomationWorkerCycle({ workerId: `v3-worker-${suffix}`, maximumRuns: 1 }, db);
    assert.equal((await db.automationRun.findFirstOrThrow({ where: { automationRuleId: consentRule.id } })).status, "waitingConsent");
    assert.equal(await db.notification.count({ where: { userId: admin.id, projectId: projectB, kind: "consentRequired" } }), 1);
    const qualityRule = await createProjectAutomationRule(projectB, { name: `Quality ${suffix}`, kind: "memoryQuality", intervalMinutes: 60, config: {}, startAt: new Date().toISOString() }, admin, db);
    await runAutomationWorkerCycle({ workerId: `v3-worker-${suffix}`, maximumRuns: 1 }, db);
    assert.equal((await db.automationRun.findFirstOrThrow({ where: { automationRuleId: qualityRule.id } })).status, "succeeded");
    const recoveryRule = await createProjectAutomationRule(projectB, { name: `Lease recovery ${suffix}`, kind: "memoryQuality", intervalMinutes: 60, config: {}, startAt: new Date(Date.now() + 3_600_000).toISOString() }, admin, db);
    await db.automationRule.update({ where: { id: recoveryRule.id }, data: { consecutiveFailures: 2 } });
    const expiredAt = new Date(Date.now() - 20 * 60_000);
    await db.automationRun.create({ data: { automationRuleId: recoveryRule.id, projectId: projectB, status: "running", scheduledFor: expiredAt, workerId: `expired-${suffix}`, leaseExpiresAt: expiredAt, startedAt: expiredAt } });
    const recovered = await runAutomationWorkerCycle({ workerId: `recovery-worker-${suffix}`, maximumRuns: 1 }, db);
    assert.deepEqual(recovered, { recovered: 1, claimed: 0, succeeded: 0, failed: 0 });
    const recoveredRule = await db.automationRule.findUniqueOrThrow({ where: { id: recoveryRule.id } });
    assert.equal(recoveredRule.status, "paused");
    assert.equal(recoveredRule.consecutiveFailures, 3);

    const webSource = await createProjectWebSource(projectB, { name: `Docs ${suffix}`, url: new URL("/doc", issuer).toString(), allowPrivateNetwork: true }, admin, db);
    assert.equal(webSource.pointer?.revision.title, "V3 文档");
    assert.equal(await db.projectSource.count({ where: { projectId: projectB, kind: "web", retiredAt: null } }), 1);
    documentText = "<html><head><title>V3 文档</title></head><body><h1>第二版本</h1><p>连接器与权限已经更新。</p></body></html>";
    await syncProjectWebSource(projectB, webSource.id, admin, db);
    assert.equal(await db.projectSource.count({ where: { projectId: projectB, kind: "web", retiredAt: null } }), 1);
    assert.equal(await db.projectSource.count({ where: { projectId: projectB, kind: "web", retiredAt: { not: null } } }), 1);

    const provider = await createOidcProvider(DEFAULT_WORKSPACE_ID, { name: `OIDC ${suffix}`, issuerUrl: issuer, clientId: `client-${suffix}`, clientSecret: `secret-${suffix}-123456`, scopes: ["openid", "profile", "email"], allowPrivateNetwork: true, autoProvision: true, defaultWorkspaceRole: "viewer", allowedEmailDomains: ["example.com"] }, admin, db);
    oidcProviderId = provider.id;
    const persistedProvider = await db.oidcProvider.findUniqueOrThrow({ where: { id: provider.id }, select: { credentialId: true, tokenAuthMethod: true, tokenAddressFingerprint: true, jwksAddressFingerprint: true } });
    oidcProviderCredentialId = persistedProvider.credentialId;
    assert.equal(persistedProvider.tokenAuthMethod, "clientSecretBasic");
    assert.match(persistedProvider.tokenAddressFingerprint ?? "", /^[0-9a-f]{64}$/u);
    assert.match(persistedProvider.jwksAddressFingerprint ?? "", /^[0-9a-f]{64}$/u);
    const flow = await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/dashboard" }, db);
    const authorization = new URL(flow.authorizationUrl);
    expectedNonce = authorization.searchParams.get("nonce")!;
    expectedChallenge = authorization.searchParams.get("code_challenge")!;
    const completed = await completeOidcLogin({ code: "valid-code", state: flow.state, cookieState: flow.state }, db);
    assert.equal(completed.returnTo, "/dashboard");
    const oidcUser = await db.appUser.findUniqueOrThrow({ where: { email: `oidc-${suffix}@example.com` } });
    oidcUserId = oidcUser.id;
    assert.equal(oidcUser.passwordHash, null);
    assert.equal((await db.workspaceMembership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: DEFAULT_WORKSPACE_ID, userId: oidcUser.id } } })).role, "viewer");
    assert.equal(await db.appSession.count({ where: { userId: oidcUser.id, revokedAt: null } }), 1);
    await assert.rejects(() => completeOidcLogin({ code: "valid-code", state: flow.state, cookieState: flow.state }, db), (error: unknown) => error instanceof OidcError && error.code === "OIDC_FLOW_INVALID");

    const capacityStates: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      capacityStates.push((await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/dashboard" }, db)).state);
    }
    assert.equal(await db.oidcLoginAttempt.count({ where: { providerId: provider.id, consumedAt: null } }), 200);
    await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/dashboard" }, db);
    assert.equal(await db.oidcLoginAttempt.count({ where: { providerId: provider.id, consumedAt: null } }), 200);
    assert.equal(await db.oidcLoginAttempt.count({ where: { providerId: provider.id, stateHash: digest(capacityStates[0]!), consumedAt: null } }), 0);

    tokenEmail = `collision-${suffix}@example.com`;
    tokenSubject = `collision-subject-${suffix}`;
    const collisionUser = await db.appUser.create({ data: { username: `collision_${suffix}`, email: tokenEmail, role: "member", passwordHash: null, passwordSalt: null } });
    collisionUserId = collisionUser.id;
    const collisionFlow = await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/dashboard" }, db);
    const collisionAuthorization = new URL(collisionFlow.authorizationUrl);
    expectedNonce = collisionAuthorization.searchParams.get("nonce")!;
    expectedChallenge = collisionAuthorization.searchParams.get("code_challenge")!;
    await updateOidcProvider(DEFAULT_WORKSPACE_ID, provider.id, { enabled: false }, admin, db);
    await assert.rejects(() => completeOidcLogin({ code: "valid-code", state: collisionFlow.state, cookieState: collisionFlow.state }, db), (error: unknown) => error instanceof OidcError && error.code === "OIDC_PROVIDER_NOT_VERIFIED");
    await updateOidcProvider(DEFAULT_WORKSPACE_ID, provider.id, { enabled: true }, admin, db);
    await assert.rejects(() => completeOidcLogin({ code: "valid-code", state: collisionFlow.state, cookieState: collisionFlow.state }, db), (error: unknown) => error instanceof OidcError && error.code === "OIDC_ACCOUNT_NOT_ALLOWED");
    failedFlowCredentialId = (await db.oidcLoginAttempt.findUniqueOrThrow({ where: { stateHash: digest(collisionFlow.state) }, select: { credentialId: true } })).credentialId;
    assert.equal(await db.oidcIdentity.count({ where: { providerId: provider.id, subject: tokenSubject } }), 0);

    const disabledInUseProvider = await updateOidcProvider(DEFAULT_WORKSPACE_ID, provider.id, { enabled: false }, admin, db);
    await assert.rejects(
      () => deleteOidcProvider(DEFAULT_WORKSPACE_ID, provider.id, {
        confirmationName: provider.name,
        expectedUpdatedAt: disabledInUseProvider.updatedAt.toISOString(),
      }, admin, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_PROVIDER_IN_USE",
    );

    const disposableProvider = await createOidcProvider(DEFAULT_WORKSPACE_ID, {
      name: `Disposable OIDC ${suffix}`,
      issuerUrl: issuer,
      clientId: `disposable-client-${suffix}`,
      clientSecret: `disposable-secret-${suffix}-123456`,
      scopes: ["openid", "profile", "email"],
      allowPrivateNetwork: true,
      autoProvision: false,
      defaultWorkspaceRole: "viewer",
      allowedEmailDomains: [],
    }, admin, db);
    disposableOidcProviderId = disposableProvider.id;
    disposableOidcCredentialId = (await db.oidcProvider.findUniqueOrThrow({ where: { id: disposableProvider.id }, select: { credentialId: true } })).credentialId;
    const disposableDisabled = await updateOidcProvider(DEFAULT_WORKSPACE_ID, disposableProvider.id, { enabled: false }, admin, db);
    await assert.rejects(
      () => deleteOidcProvider(DEFAULT_WORKSPACE_ID, disposableProvider.id, {
        confirmationName: "wrong name",
        expectedUpdatedAt: disposableDisabled.updatedAt.toISOString(),
      }, admin, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_PROVIDER_CONFIRMATION_MISMATCH",
    );
    await deleteOidcProvider(DEFAULT_WORKSPACE_ID, disposableProvider.id, {
      confirmationName: disposableProvider.name,
      expectedUpdatedAt: disposableDisabled.updatedAt.toISOString(),
    }, admin, db);
    assert.equal(await db.oidcProvider.count({ where: { id: disposableProvider.id } }), 0);
    assert.equal(await db.externalCredential.count({ where: { id: disposableOidcCredentialId } }), 0);
    disposableOidcProviderId = null;
    disposableOidcCredentialId = null;

    const activeProject = await db.project.findUniqueOrThrow({ where: { id: projectB }, select: { updatedAt: true } });
    const archived = await updateProjectLifecycle({ projectId: projectB, actorId: admin.id, action: "archive", expectedUpdatedAt: activeProject.updatedAt }, db);
    assert.equal(await db.automationRule.count({ where: { projectId: projectB, status: "active" } }), 0);
    await updateProjectLifecycle({ projectId: projectB, actorId: admin.id, action: "restore", expectedUpdatedAt: archived.project.updatedAt }, db);
    assert.equal(await db.automationRule.count({ where: { projectId: projectB, status: "active" } }), 0);
  } finally {
    try {
      const pendingOidcCredentials = oidcProviderId === null
        ? []
        : (await db.oidcLoginAttempt.findMany({ where: { providerId: oidcProviderId }, select: { credentialId: true } })).map((attempt) => attempt.credentialId);
      if (oidcProviderId !== null) await db.oidcProvider.deleteMany({ where: { id: oidcProviderId } });
      if (oidcProviderCredentialId !== null) await db.externalCredential.deleteMany({ where: { id: oidcProviderCredentialId } });
      if (failedFlowCredentialId !== null) await db.externalCredential.deleteMany({ where: { id: failedFlowCredentialId } });
      if (disposableOidcProviderId !== null) await db.oidcProvider.deleteMany({ where: { id: disposableOidcProviderId } });
      if (disposableOidcCredentialId !== null) await db.externalCredential.deleteMany({ where: { id: disposableOidcCredentialId } });
      if (pendingOidcCredentials.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: pendingOidcCredentials } } });
      await db.project.deleteMany({ where: { id: { in: [projectA, projectB] } } });
      if (oidcUserId !== null) {
        await db.platformTokenLedgerEntry.deleteMany({ where: { userId: oidcUserId } });
        await db.platformTokenGrant.deleteMany({ where: { userId: oidcUserId } });
        await db.appUser.deleteMany({ where: { id: oidcUserId } });
      }
      if (collisionUserId !== null) await db.appUser.deleteMany({ where: { id: collisionUserId } });
      await db.workspace.deleteMany({ where: { id: roleWorkspaceId } });
      await db.appUser.deleteMany({ where: { id: memberId } });
    } finally {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      await unlink(masterKeyPath).catch(() => undefined);
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    }
  }
});
