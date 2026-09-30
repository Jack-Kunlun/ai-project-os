import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ProjectItemRevisionAction, type AutomationRuleKind, type PrismaClient } from "@prisma/client";
import { AccessControlError, accessibleProjectWhere, authorizeApiRequest } from "../src/lib/access-control";
import { createSession } from "../src/lib/auth";
import { AutomationError, createProjectAutomationRule, listUserNotifications, openNotification, previewProjectAutomationRule, runAutomationWorkerCycle } from "../src/lib/automation";
import { getDb } from "../src/lib/db";
import { analyzeProjectMemoryQuality, resolveMemoryQualityIssue, updateProjectItemMemoryMetadata } from "../src/lib/memory-quality";
import { beginOidcIdentityLink, beginOidcLogin, completeOidcIdentityLink, completeOidcLogin, createOidcProvider, deleteOidcProvider, OidcError, updateOidcProvider } from "../src/lib/oidc";
import { appendProjectItemRevision, createPrimaryProjectItemEvidence } from "../src/lib/project-item-history";
import { updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { createProjectWebSource, syncProjectWebSource } from "../src/lib/web-sources";
import { acceptWorkspaceInvitation, createWorkspaceInvitation, updateWorkspaceMember, WorkspaceError } from "../src/lib/workspaces";
import { findConfirmedProjectMembership, findConfirmedWorkspaceMembership, grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership, revokeWorkspaceMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.V3_POSTGRES_GATE === "1";
const SEEDED_WORKSPACE_ID = "00000000-0000-4000-8000-000000000099";

function digest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }

async function createAutomationRuleWithPreview(
  projectId: string,
  input: Readonly<{ name: string; kind: AutomationRuleKind; intervalMinutes: number; config: unknown; startAt: string }>,
  actor: Readonly<{ id: string; role: "admin" | "user" }>,
  db: PrismaClient,
) {
  const preview = await previewProjectAutomationRule(projectId, input, actor, db);
  return createProjectAutomationRule(projectId, {
    name: preview.canonicalPayload.name,
    kind: preview.canonicalPayload.kind,
    intervalMinutes: preview.canonicalPayload.intervalMinutes,
    config: preview.canonicalPayload.config,
    startAt: preview.canonicalPayload.startAtUtc,
    expectedPreviewFingerprint: preview.previewFingerprint,
    previewPayload: preview.canonicalPayload,
  }, actor, db);
}

test("V3 persists RBAC, memory governance, automation, web sources and OIDC code flow", { skip: !shouldRun ? "V3_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const projectA = randomUUID();
  const projectB = randomUUID();
  const memberId = randomUUID();
  const outsiderUserId = randomUUID();
  const revokedLinkUserId = randomUUID();
  const unmemberedLinkUserId = randomUUID();
  const roleWorkspaceId = randomUUID();
  const masterKeyPath = `/tmp/ai-project-os-v3-${process.pid}-${suffix}.key`;
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;
  await unlink(masterKeyPath).catch(() => undefined);
  let oidcProviderId: string | null = null;
  let oidcProviderCredentialId: string | null = null;
  let collisionUserId: string | null = null;
  let failedFlowCredentialId: string | null = null;
  let disposableOidcProviderId: string | null = null;
  let disposableOidcCredentialId: string | null = null;
  let documentText = "<html><head><title>V3 文档</title></head><body><h1>首次版本</h1><p>连接器已启用。</p></body></html>";
  const expectedProofs = new Map<string, Readonly<{ nonce: string; challenge: string; email: string; subject: string }>>();
  let tokenEmail = `oidc-${suffix}@example.com`;
  let tokenSubject = `subject-${suffix}`;
  function expectOidcProof(flow: Readonly<{ authorizationUrl: string }>, code: string, email = tokenEmail, subject = tokenSubject) {
    const authorization = new URL(flow.authorizationUrl);
    expectedProofs.set(code, {
      nonce: authorization.searchParams.get("nonce")!,
      challenge: authorization.searchParams.get("code_challenge")!,
      email,
      subject,
    });
  }
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
      const code = form.get("code") ?? "";
      const proof = expectedProofs.get(code);
      assert.ok(proof, `unexpected OIDC code ${code}`);
      assert.equal(form.get("client_id"), null);
      assert.equal(form.get("client_secret"), null);
      assert.equal(Buffer.from((request.headers.authorization ?? "").replace(/^Basic\s+/u, ""), "base64").toString("utf8"), `client-${suffix}:secret-${suffix}-123456`);
      assert.equal(createHash("sha256").update(form.get("code_verifier") ?? "", "utf8").digest("base64url"), proof.challenge);
      const idToken = await new SignJWT({ nonce: proof.nonce, email: proof.email, email_verified: true, name: "OIDC Member", preferred_username: `oidc_${suffix}` })
        .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid }).setIssuer(issuer).setAudience(`client-${suffix}`).setSubject(proof.subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
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
    const owner = await db.appUser.findUniqueOrThrow({ where: { username: "postgres_gate_owner" } });
    assert.equal(owner.role, "user");
    const memberEmail = `v3-member-${suffix}@example.com`;
    await db.appUser.create({ data: { id: memberId, username: `v3_member_${suffix}`, email: memberEmail, emailVerifiedAt: new Date(), role: "user", passwordHash: null, passwordSalt: null } });
    await db.appUser.create({ data: { id: outsiderUserId, username: `v3_outsider_user_${suffix}`, role: "user", passwordHash: null, passwordSalt: null } });
    await db.project.createMany({ data: [
      { id: projectA, workspaceId: SEEDED_WORKSPACE_ID, name: `V3 A ${suffix}`, slug: `v3-a-${suffix}` },
      { id: projectB, workspaceId: SEEDED_WORKSPACE_ID, name: `V3 B ${suffix}`, slug: `v3-b-${suffix}` },
    ] });
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: roleWorkspaceId, name: `Role safety ${suffix}`, slug: `role-safety-${suffix}`, createdById: owner.id } });
      await grantWorkspaceMembership(tx, { workspaceId: SEEDED_WORKSPACE_ID, userId: memberId, role: "member", actorId: owner.id, reason: "v3_gate_fixture_default_workspace" });
      await grantWorkspaceMembership(tx, { workspaceId: roleWorkspaceId, userId: memberId, role: "owner", actorId: owner.id, reason: "v3_gate_fixture_role_workspace" });
      await grantProjectMembership(tx, { projectId: projectB, workspaceId: SEEDED_WORKSPACE_ID, userId: owner.id, role: "owner", actorId: owner.id, reason: "v3_gate_fixture_owner_direct_access_for_automation_and_web_source" });
      await grantProjectMembership(tx, { projectId: projectA, workspaceId: SEEDED_WORKSPACE_ID, userId: memberId, role: "viewer", actorId: owner.id, reason: "v3_gate_fixture_project_a" });
      await grantProjectMembership(tx, { projectId: projectB, workspaceId: SEEDED_WORKSPACE_ID, userId: memberId, role: "editor", actorId: owner.id, reason: "v3_gate_fixture_project_b" });
    });

    const member = { id: memberId, role: "user" as const, accountAccessVersion: 1 };
    const visible = await db.project.findMany({ where: accessibleProjectWhere(member), select: { id: true } });
    assert.deepEqual(new Set(visible.map((project) => project.id)), new Set([projectA, projectB]));
    await authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectA}`, { method: "GET" }), db);
    await assert.rejects(() => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectA}/items`, { method: "POST" }), db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");
    await authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectB}/items`, { method: "POST" }), db);
    await assert.rejects(() => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectB}/lifecycle`, { method: "PATCH" }), db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");
    await assert.rejects(() => authorizeApiRequest(member, new Request(`http://localhost/api/projects/${projectB}`, { method: "DELETE" }), db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");
    await assert.rejects(() => authorizeApiRequest(member, new Request("http://localhost/api/settings/providers", { method: "GET" }), db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");

    const platformNotification = await db.notification.create({ data: {
      userId: outsiderUserId,
      projectId: null,
      kind: "system",
      severity: "info",
      title: "平台通知",
      body: "平台维护窗口已安排。",
      actionHref: null,
      dedupeKey: digest(`v3-platform-notification-${suffix}`),
    } });
    const projectNotification = await db.notification.create({ data: {
      userId: outsiderUserId,
      projectId: projectB,
      kind: "consentRequired",
      severity: "warning",
      title: "项目需要确认",
      body: "项目来源需要人工确认。",
      actionHref: `/projects/${projectB}/automations`,
      dedupeKey: digest(`v3-project-notification-${suffix}`),
    } });
    const withoutMembership = await listUserNotifications(outsiderUserId, db);
    assert.deepEqual(withoutMembership.notifications.map((notification) => notification.id), [platformNotification.id]);
    await assert.rejects(
      () => openNotification(outsiderUserId, projectNotification.id, db),
      (error: unknown) => error instanceof AutomationError && error.code === "NOTIFICATION_NOT_FOUND",
    );
    await db.$transaction((tx) => grantProjectMembership(tx, { projectId: projectB, workspaceId: SEEDED_WORKSPACE_ID, userId: outsiderUserId, role: "viewer", actorId: owner.id, reason: "v3_gate_fixture_outsider_project" }));
    assert.deepEqual((await listUserNotifications(outsiderUserId, db)).notifications.map((notification) => notification.id).sort(), [platformNotification.id, projectNotification.id].sort());
    await db.$transaction(async (tx) => {
      await revokeProjectMembership(tx, projectB, outsiderUserId, SEEDED_WORKSPACE_ID, { actorId: owner.id, reason: "v3_gate_revoke_outsider_project" });
      await grantWorkspaceMembership(tx, { workspaceId: SEEDED_WORKSPACE_ID, userId: outsiderUserId, role: "admin", actorId: owner.id, reason: "v3_gate_fixture_outsider_workspace" });
    });
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: projectB }, select: { membershipInheritanceMode: true } })).membershipInheritanceMode, "projectOnly");
    assert.deepEqual((await listUserNotifications(outsiderUserId, db)).notifications.map((notification) => notification.id), [platformNotification.id]);
    await assert.rejects(
      () => openNotification(outsiderUserId, projectNotification.id, db),
      (error: unknown) => error instanceof AutomationError && error.code === "NOTIFICATION_NOT_FOUND",
    );
    await db.$transaction((tx) => revokeWorkspaceMembership(tx, SEEDED_WORKSPACE_ID, outsiderUserId, { actorId: owner.id, reason: "v3_gate_revoke_outsider_workspace" }));
    await db.notification.update({ where: { id: projectNotification.id }, data: { readAt: null } });
    assert.deepEqual((await listUserNotifications(outsiderUserId, db)).notifications.map((notification) => notification.id), [platformNotification.id]);
    await assert.rejects(
      () => openNotification(outsiderUserId, projectNotification.id, db),
      (error: unknown) => error instanceof AutomationError && error.code === "NOTIFICATION_NOT_FOUND",
    );
    await assert.rejects(() => updateWorkspaceMember(roleWorkspaceId, memberId, { workspaceRole: "viewer" }, member, db), (error: unknown) => error instanceof WorkspaceError && error.code === "WORKSPACE_ROLE_GOVERNANCE_REQUIRED");
    const invitation = await createWorkspaceInvitation(SEEDED_WORKSPACE_ID, { email: memberEmail, workspaceRole: "viewer", projectId: projectB, projectRole: "viewer", expiresInDays: 7, requestKey: randomUUID() }, owner, db);
    await acceptWorkspaceInvitation(invitation.token, { id: memberId, email: memberEmail, accountAccessVersion: member.accountAccessVersion }, "/dashboard", db);
    assert.equal((await findConfirmedWorkspaceMembership(db, SEEDED_WORKSPACE_ID, memberId))?.role, "member");
    assert.equal((await findConfirmedProjectMembership(db, projectB, memberId))?.role, "editor");

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
        await appendProjectItemRevision(tx, { item: created, action: ProjectItemRevisionAction.manualCreated, actorId: owner.id, evidences: [evidence], createdAt: created.createdAt });
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
    await updateProjectItemMemoryMetadata(projectB, first.id, { expectedUpdatedAt: first.updatedAt.toISOString(), importance: 90, confidence: 1, pinned: true, verifyNow: true }, owner, db);
    assert.equal((await db.projectItemRevision.findFirstOrThrow({ where: { projectId: projectB, projectItemId: first.id }, orderBy: { revisionNumber: "desc" } })).action, "metadataUpdated");
    const issueToResolve = quality.issues.find((issue) => issue.status === "open")!;
    await resolveMemoryQualityIssue(projectB, issueToResolve.id, { status: "resolved", note: "V3 集成测试人工处置" }, owner, db);

    const consentRule = await createAutomationRuleWithPreview(projectB, { name: `Index ${suffix}`, kind: "memoryIndex", intervalMinutes: 60, config: { mode: "incremental" }, startAt: new Date().toISOString() }, owner, db);
    await runAutomationWorkerCycle({ workerId: `v3-worker-${suffix}`, maximumRuns: 1 }, db);
    assert.equal((await db.automationRun.findFirstOrThrow({ where: { automationRuleId: consentRule.id } })).status, "waitingConsent");
    assert.equal(await db.notification.count({ where: { userId: owner.id, projectId: projectB, kind: "consentRequired" } }), 1);
    const qualityRule = await createAutomationRuleWithPreview(projectB, { name: `Quality ${suffix}`, kind: "memoryQuality", intervalMinutes: 60, config: {}, startAt: new Date().toISOString() }, owner, db);
    await runAutomationWorkerCycle({ workerId: `v3-worker-${suffix}`, maximumRuns: 1 }, db);
    assert.equal((await db.automationRun.findFirstOrThrow({ where: { automationRuleId: qualityRule.id } })).status, "succeeded");
    const recoveryRule = await createAutomationRuleWithPreview(projectB, { name: `Lease recovery ${suffix}`, kind: "memoryQuality", intervalMinutes: 60, config: {}, startAt: new Date(Date.now() + 3_600_000).toISOString() }, owner, db);
    await db.automationRule.update({ where: { id: recoveryRule.id }, data: { consecutiveFailures: 2 } });
    const expiredAt = new Date(Date.now() - 20 * 60_000);
    await db.automationRun.create({ data: { automationRuleId: recoveryRule.id, projectId: projectB, status: "running", scheduledFor: expiredAt, workerId: `expired-${suffix}`, leaseExpiresAt: expiredAt, startedAt: expiredAt } });
    const recovered = await runAutomationWorkerCycle({ workerId: `recovery-worker-${suffix}`, maximumRuns: 1 }, db);
    assert.deepEqual(recovered, { recovered: 1, claimed: 0, succeeded: 0, failed: 0 });
    const recoveredRule = await db.automationRule.findUniqueOrThrow({ where: { id: recoveryRule.id } });
    assert.equal(recoveredRule.status, "paused");
    assert.equal(recoveredRule.consecutiveFailures, 3);

    const webSource = await createProjectWebSource(projectB, { name: `Docs ${suffix}`, url: new URL("/doc", issuer).toString(), allowPrivateNetwork: true }, owner, db);
    assert.equal(webSource.pointer?.revision.title, "V3 文档");
    assert.equal(await db.projectSource.count({ where: { projectId: projectB, kind: "web", retiredAt: null } }), 1);
    documentText = "<html><head><title>V3 文档</title></head><body><h1>第二版本</h1><p>连接器与权限已经更新。</p></body></html>";
    await syncProjectWebSource(projectB, webSource.id, owner, db);
    assert.equal(await db.projectSource.count({ where: { projectId: projectB, kind: "web", retiredAt: null } }), 1);
    assert.equal(await db.projectSource.count({ where: { projectId: projectB, kind: "web", retiredAt: { not: null } } }), 1);

    const provider = await createOidcProvider(SEEDED_WORKSPACE_ID, { name: `OIDC ${suffix}`, issuerUrl: issuer, clientId: `client-${suffix}`, clientSecret: `secret-${suffix}-123456`, scopes: ["openid", "profile", "email"], allowPrivateNetwork: true, autoProvision: true, defaultWorkspaceRole: "viewer", allowedEmailDomains: ["example.com"] }, owner, db);
    oidcProviderId = provider.id;
    const persistedProvider = await db.oidcProvider.findUniqueOrThrow({ where: { id: provider.id }, select: { credentialId: true, tokenAuthMethod: true, tokenAddressFingerprint: true, jwksAddressFingerprint: true } });
    oidcProviderCredentialId = persistedProvider.credentialId;
    assert.equal(persistedProvider.tokenAuthMethod, "clientSecretBasic");
    assert.match(persistedProvider.tokenAddressFingerprint ?? "", /^[0-9a-f]{64}$/u);
    assert.match(persistedProvider.jwksAddressFingerprint ?? "", /^[0-9a-f]{64}$/u);
    const flow = await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/dashboard" }, db);
    expectOidcProof(flow, "valid-code");
    const completed = await completeOidcLogin({ code: "valid-code", state: flow.state, cookieState: flow.state }, db);
    assert.equal(completed.returnTo, "/dashboard");
    const oidcUser = await db.appUser.findUniqueOrThrow({ where: { email: `oidc-${suffix}@example.com` } });
    assert.equal(oidcUser.role, "user");
    assert.ok(oidcUser.emailVerifiedAt instanceof Date);
    assert.equal(oidcUser.passwordHash, null);
    const personalWorkspace = await db.workspace.findFirst({
      where: {
        createdById: oidcUser.id,
        memberships: { some: { userId: oidcUser.id, role: "owner", accessState: "confirmed" } },
      },
      select: { id: true, slug: true },
    });
    assert.ok(personalWorkspace !== null);
    assert.equal(personalWorkspace.slug, `user-${oidcUser.id}`);
    assert.equal((await findConfirmedWorkspaceMembership(db, personalWorkspace.id, oidcUser.id))?.role, "owner");
    assert.equal((await findConfirmedWorkspaceMembership(db, SEEDED_WORKSPACE_ID, oidcUser.id))?.role, "viewer");
    assert.equal(await db.appSession.count({ where: { userId: oidcUser.id, revokedAt: null } }), 1);

    await db.appUser.create({ data: { id: unmemberedLinkUserId, username: `oidc_unmembered_link_${suffix}`, role: "user", passwordHash: null, passwordSalt: null } });
    const unmembered = await db.appUser.findUniqueOrThrow({ where: { id: unmemberedLinkUserId } });
    const unmemberedSession = await createSession(db, { id: unmembered.id, username: unmembered.username, role: "user", accountAccessVersion: unmembered.accountAccessVersion });
    const unmemberedSessionRow = await db.appSession.findUniqueOrThrow({ where: { tokenHash: digest(unmemberedSession.token) }, select: { id: true } });
    await assert.rejects(
      () => beginOidcIdentityLink({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/link/callback", session: { user: unmemberedSession.user, sessionId: unmemberedSessionRow.id } }, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_LINK_ACCOUNT_NOT_ALLOWED",
    );

    const linkAccount = await db.appUser.findUniqueOrThrow({ where: { id: memberId } });
    const linkSession = await createSession(db, { id: linkAccount.id, username: linkAccount.username, role: "user", accountAccessVersion: linkAccount.accountAccessVersion });
    const linkSessionRow = await db.appSession.findUniqueOrThrow({ where: { tokenHash: digest(linkSession.token) }, select: { id: true } });
    const linkContext = { user: linkSession.user, sessionId: linkSessionRow.id };
    const accountBeforeLink = await db.appUser.findUniqueOrThrow({ where: { id: memberId }, select: { email: true, emailVerifiedAt: true, accountAccessVersion: true, updatedAt: true } });
    const membershipsBeforeLink = await db.workspaceMembership.count({ where: { userId: memberId } });
    const sessionsBeforeLink = await db.appSession.count({ where: { userId: memberId } });
    const linkFlow = await beginOidcIdentityLink({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/link/callback", session: linkContext });
    const linkedSubject = `explicit-link-${suffix}`;
    expectOidcProof(linkFlow, "oidc-link-code", memberEmail, linkedSubject);
    const linked = await completeOidcIdentityLink({ code: "oidc-link-code", state: linkFlow.state, cookieState: linkFlow.state, session: linkContext });
    assert.equal(linked.providerId, provider.id);
    assert.equal((await db.oidcIdentity.findUniqueOrThrow({ where: { providerId_subject: { providerId: provider.id, subject: linkedSubject } }, select: { userId: true, email: true } })).userId, memberId);
    assert.equal((await db.oidcIdentity.findUniqueOrThrow({ where: { providerId_subject: { providerId: provider.id, subject: linkedSubject } }, select: { email: true } })).email, memberEmail);
    assert.deepEqual(await db.appUser.findUniqueOrThrow({ where: { id: memberId }, select: { email: true, emailVerifiedAt: true, accountAccessVersion: true, updatedAt: true } }), accountBeforeLink);
    assert.equal(await db.workspaceMembership.count({ where: { userId: memberId } }), membershipsBeforeLink);
    assert.equal(await db.appSession.count({ where: { userId: memberId } }), sessionsBeforeLink);
    const linkAudit = await db.oidcIdentityLinkAudit.findMany({ where: { providerId: provider.id }, select: { userId: true, subjectFingerprint: true } });
    assert.deepEqual(linkAudit, [{ userId: memberId, subjectFingerprint: digest(`${provider.id}\u0000${linkedSubject}`) }]);
    assert.doesNotMatch(JSON.stringify(linkAudit), new RegExp(linkedSubject));
    await assert.rejects(
      () => completeOidcIdentityLink({ code: "oidc-link-code", state: linkFlow.state, cookieState: linkFlow.state, session: linkContext }, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_FLOW_INVALID",
    );
    await assert.rejects(
      () => beginOidcIdentityLink({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/link/callback", session: linkContext }, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_IDENTITY_CONFLICT",
    );

    const linkedLoginFlow = await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/profile" }, db);
    expectOidcProof(linkedLoginFlow, "oidc-linked-login-code", memberEmail, linkedSubject);
    const linkedLogin = await completeOidcLogin({ code: "oidc-linked-login-code", state: linkedLoginFlow.state, cookieState: linkedLoginFlow.state }, db);
    assert.equal(linkedLogin.session.user.id, memberId);

    await db.appUser.create({ data: { id: revokedLinkUserId, username: `oidc_revoked_link_${suffix}`, role: "user", passwordHash: null, passwordSalt: null } });
    await db.$transaction((tx) => grantWorkspaceMembership(tx, { workspaceId: SEEDED_WORKSPACE_ID, userId: revokedLinkUserId, role: "viewer", actorId: owner.id, reason: "v3_gate_oidc_link_revocation" }));
    const revokedLinkAccount = await db.appUser.findUniqueOrThrow({ where: { id: revokedLinkUserId } });
    const revokedLinkSession = await createSession(db, { id: revokedLinkAccount.id, username: revokedLinkAccount.username, role: "user", accountAccessVersion: revokedLinkAccount.accountAccessVersion });
    const revokedLinkSessionRow = await db.appSession.findUniqueOrThrow({ where: { tokenHash: digest(revokedLinkSession.token) }, select: { id: true } });
    const revokedLinkContext = { user: revokedLinkSession.user, sessionId: revokedLinkSessionRow.id };

    const emailCollisionFlow = await beginOidcIdentityLink({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/link/callback", session: revokedLinkContext }, db);
    const emailCollisionSubject = `email-owner-link-${suffix}`;
    expectOidcProof(emailCollisionFlow, "oidc-link-email-owner-code", memberEmail, emailCollisionSubject);
    await assert.rejects(
      () => completeOidcIdentityLink({ code: "oidc-link-email-owner-code", state: emailCollisionFlow.state, cookieState: emailCollisionFlow.state, session: revokedLinkContext }, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_ACCOUNT_NOT_ALLOWED",
    );
    assert.equal(await db.oidcIdentity.count({ where: { providerId: provider.id, subject: emailCollisionSubject } }), 0);

    const revokedLinkFlow = await beginOidcIdentityLink({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/link/callback", session: revokedLinkContext }, db);
    const revokedLinkSubject = `revoked-link-${suffix}`;
    expectOidcProof(revokedLinkFlow, "oidc-revoked-link-code", `revoked-link-${suffix}@example.com`, revokedLinkSubject);
    await db.appSession.update({ where: { id: revokedLinkSessionRow.id }, data: { revokedAt: new Date() } });
    await assert.rejects(
      () => completeOidcIdentityLink({ code: "oidc-revoked-link-code", state: revokedLinkFlow.state, cookieState: revokedLinkFlow.state, session: revokedLinkContext }, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_LINK_SESSION_INVALID",
    );
    assert.equal(await db.oidcIdentity.count({ where: { providerId: provider.id, subject: revokedLinkSubject } }), 0);

    const attemptBudgetSession = await createSession(db, { id: revokedLinkAccount.id, username: revokedLinkAccount.username, role: "user", accountAccessVersion: revokedLinkAccount.accountAccessVersion });
    const attemptBudgetSessionRow = await db.appSession.findUniqueOrThrow({ where: { tokenHash: digest(attemptBudgetSession.token) }, select: { id: true } });
    const attemptBudgetContext = { user: attemptBudgetSession.user, sessionId: attemptBudgetSessionRow.id };
    const existingLinkAttempts = await db.oidcIdentityLinkAttempt.count({ where: { providerId: provider.id, userId: revokedLinkUserId, expiresAt: { gt: new Date() } } });
    assert.equal(existingLinkAttempts, 2);
    for (let index = existingLinkAttempts; index < 40; index += 1) {
      const failedAttempt = await beginOidcIdentityLink({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/link/callback", session: attemptBudgetContext }, db);
      const attemptRow = await db.oidcIdentityLinkAttempt.findUniqueOrThrow({ where: { stateHash: digest(failedAttempt.state) }, select: { id: true, createdAt: true } });
      await db.oidcIdentityLinkAttempt.update({ where: { id: attemptRow.id }, data: { consumedAt: new Date(attemptRow.createdAt.getTime() + 1) } });
    }
    await assert.rejects(
      () => beginOidcIdentityLink({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/link/callback", session: attemptBudgetContext }, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_LINK_ATTEMPT_LIMIT",
    );

    // A legacy OIDC identity may already be admitted to the provider
    // workspace without the canonical personal workspace. The callback may
    // lazily create only that missing personal space; it must not regrant a
    // pre-existing/revoked Owner membership later.
    tokenEmail = `oidc-legacy-${suffix}@example.com`;
    tokenSubject = `legacy-subject-${suffix}`;
    const legacyUser = await db.appUser.create({ data: { username: `oidc_legacy_${suffix}`, email: tokenEmail, emailVerifiedAt: new Date(), role: "user", passwordHash: null, passwordSalt: null } });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId: SEEDED_WORKSPACE_ID, userId: legacyUser.id, role: "viewer", actorId: owner.id, reason: "v3_gate_legacy_oidc_provider_membership" });
      await tx.oidcIdentity.create({ data: { providerId: provider.id, userId: legacyUser.id, subject: tokenSubject, email: tokenEmail, displayName: "Legacy OIDC", lastLoginAt: new Date() } });
    });
    const legacyFlow = await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/dashboard" }, db);
    expectOidcProof(legacyFlow, "valid-code");
    await completeOidcLogin({ code: "valid-code", state: legacyFlow.state, cookieState: legacyFlow.state }, db);
    const lazyPersonalWorkspace = await db.workspace.findUniqueOrThrow({ where: { slug: `user-${legacyUser.id}` }, select: { id: true, createdById: true } });
    assert.equal(lazyPersonalWorkspace.createdById, legacyUser.id);
    assert.equal((await findConfirmedWorkspaceMembership(db, lazyPersonalWorkspace.id, legacyUser.id))?.role, "owner");
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId: lazyPersonalWorkspace.id, userId: owner.id, role: "owner", actorId: legacyUser.id, reason: "v3_gate_transfer_legacy_personal_owner" });
      await revokeWorkspaceMembership(tx, lazyPersonalWorkspace.id, legacyUser.id, { actorId: owner.id, reason: "v3_gate_revoke_legacy_personal_owner" });
    });
    const revokedLegacyFlow = await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/dashboard" }, db);
    expectOidcProof(revokedLegacyFlow, "valid-code");
    await assert.rejects(
      () => completeOidcLogin({ code: "valid-code", state: revokedLegacyFlow.state, cookieState: revokedLegacyFlow.state }, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_ACCOUNT_NOT_ALLOWED",
    );
    assert.equal(await findConfirmedWorkspaceMembership(db, lazyPersonalWorkspace.id, legacyUser.id), null);
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
    const collisionUser = await db.appUser.create({ data: { username: `collision_${suffix}`, email: tokenEmail, role: "user", passwordHash: null, passwordSalt: null } });
    collisionUserId = collisionUser.id;
    const collisionFlow = await beginOidcLogin({ providerId: provider.id, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback", returnTo: "/dashboard" }, db);
    expectOidcProof(collisionFlow, "valid-code");
    await updateOidcProvider(SEEDED_WORKSPACE_ID, provider.id, { enabled: false }, owner, db);
    await assert.rejects(() => completeOidcLogin({ code: "valid-code", state: collisionFlow.state, cookieState: collisionFlow.state }, db), (error: unknown) => error instanceof OidcError && error.code === "OIDC_PROVIDER_NOT_VERIFIED");
    await updateOidcProvider(SEEDED_WORKSPACE_ID, provider.id, { enabled: true }, owner, db);
    await assert.rejects(() => completeOidcLogin({ code: "valid-code", state: collisionFlow.state, cookieState: collisionFlow.state }, db), (error: unknown) => error instanceof OidcError && error.code === "OIDC_ACCOUNT_NOT_ALLOWED");
    failedFlowCredentialId = (await db.oidcLoginAttempt.findUniqueOrThrow({ where: { stateHash: digest(collisionFlow.state) }, select: { credentialId: true } })).credentialId;
    assert.equal(await db.oidcIdentity.count({ where: { providerId: provider.id, subject: tokenSubject } }), 0);

    const disabledInUseProvider = await updateOidcProvider(SEEDED_WORKSPACE_ID, provider.id, { enabled: false }, owner, db);
    await assert.rejects(
      () => deleteOidcProvider(SEEDED_WORKSPACE_ID, provider.id, {
        confirmationName: provider.name,
        expectedUpdatedAt: disabledInUseProvider.updatedAt.toISOString(),
      }, owner, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_PROVIDER_IN_USE",
    );

    const disposableProvider = await createOidcProvider(SEEDED_WORKSPACE_ID, {
      name: `Disposable OIDC ${suffix}`,
      issuerUrl: issuer,
      clientId: `disposable-client-${suffix}`,
      clientSecret: `disposable-secret-${suffix}-123456`,
      scopes: ["openid", "profile", "email"],
      allowPrivateNetwork: true,
      autoProvision: false,
      defaultWorkspaceRole: "viewer",
      allowedEmailDomains: [],
    }, owner, db);
    disposableOidcProviderId = disposableProvider.id;
    disposableOidcCredentialId = (await db.oidcProvider.findUniqueOrThrow({ where: { id: disposableProvider.id }, select: { credentialId: true } })).credentialId;
    const disposableDisabled = await updateOidcProvider(SEEDED_WORKSPACE_ID, disposableProvider.id, { enabled: false }, owner, db);
    await assert.rejects(
      () => deleteOidcProvider(SEEDED_WORKSPACE_ID, disposableProvider.id, {
        confirmationName: "wrong name",
        expectedUpdatedAt: disposableDisabled.updatedAt.toISOString(),
      }, owner, db),
      (error: unknown) => error instanceof OidcError && error.code === "OIDC_PROVIDER_CONFIRMATION_MISMATCH",
    );
    await deleteOidcProvider(SEEDED_WORKSPACE_ID, disposableProvider.id, {
      confirmationName: disposableProvider.name,
      expectedUpdatedAt: disposableDisabled.updatedAt.toISOString(),
    }, owner, db);
    assert.equal(await db.oidcProvider.count({ where: { id: disposableProvider.id } }), 0);
    assert.equal(await db.externalCredential.count({ where: { id: disposableOidcCredentialId } }), 0);
    disposableOidcProviderId = null;
    disposableOidcCredentialId = null;

    const activeProject = await db.project.findUniqueOrThrow({ where: { id: projectB }, select: { updatedAt: true } });
    const archived = await updateProjectLifecycle({ projectId: projectB, actor: owner, action: "archive", expectedUpdatedAt: activeProject.updatedAt }, db);
    assert.equal(await db.automationRule.count({ where: { projectId: projectB, status: "active" } }), 0);
    await updateProjectLifecycle({ projectId: projectB, actor: owner, action: "restore", expectedUpdatedAt: archived.project.updatedAt }, db);
    assert.equal(await db.automationRule.count({ where: { projectId: projectB, status: "active" } }), 0);
  } finally {
    try {
      const pendingOidcCredentials = oidcProviderId === null
        ? []
        : (await db.oidcLoginAttempt.findMany({ where: { providerId: oidcProviderId }, select: { credentialId: true } })).map((attempt) => attempt.credentialId);
      const pendingOidcLinkCredentials = oidcProviderId === null
        ? []
        : (await db.oidcIdentityLinkAttempt.findMany({ where: { providerId: oidcProviderId }, select: { credentialId: true } })).map((attempt) => attempt.credentialId);
      if (oidcProviderId !== null) await db.oidcProvider.deleteMany({ where: { id: oidcProviderId } });
      if (oidcProviderCredentialId !== null) await db.externalCredential.deleteMany({ where: { id: oidcProviderCredentialId } });
      if (failedFlowCredentialId !== null) await db.externalCredential.deleteMany({ where: { id: failedFlowCredentialId } });
      if (disposableOidcProviderId !== null) await db.oidcProvider.deleteMany({ where: { id: disposableOidcProviderId } });
      if (disposableOidcCredentialId !== null) await db.externalCredential.deleteMany({ where: { id: disposableOidcCredentialId } });
      if (pendingOidcCredentials.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: pendingOidcCredentials } } });
      if (pendingOidcLinkCredentials.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: pendingOidcLinkCredentials } } });
      await db.project.updateMany({ where: { id: { in: [projectA, projectB] } }, data: { archivedAt: new Date() } });
      await db.project.deleteMany({ where: { id: { in: [projectA, projectB] } } });
      // These OIDC fixtures create append-only AppSessions and identity-link
      // audit evidence. Keep their user/session chains intact; the disposable
      // database teardown owns their final cleanup.
      if (collisionUserId !== null) await db.appUser.deleteMany({ where: { id: collisionUserId } });
      await db.workspace.deleteMany({ where: { id: roleWorkspaceId } });
      await db.appUser.deleteMany({ where: { id: outsiderUserId } });
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
