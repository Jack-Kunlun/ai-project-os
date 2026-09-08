import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AutomationRuleKind, PrismaClient } from "@prisma/client";
import {
  AutomationError,
  createProjectAutomationRule,
  getProjectAutomationRun,
  listProjectAutomationRules,
  previewProjectAutomationRule,
  runAutomationWorkerCycle,
} from "../src/lib/automation";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { resolveSecureEndpointFingerprint, syncProjectWebSource, updateProjectWebSource, WebSourceError } from "../src/lib/web-sources";

const shouldRun = process.env.AUTOMATION_GOVERNANCE_POSTGRES_GATE === "1";

type Actor = Readonly<{ id: string; role: "admin" | "member" | "user"; accountAccessVersion: number }>;

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

async function createRuleWithPreview(
  projectId: string,
  input: Readonly<{ name: string; kind: AutomationRuleKind; intervalMinutes: number; config: unknown; startAt: string }>,
  actor: Actor,
  db: PrismaClient,
) {
  const preview = await previewProjectAutomationRule(projectId, input, actor, db);
  const rule = await createProjectAutomationRule(projectId, {
    name: preview.canonicalPayload.name,
    kind: preview.canonicalPayload.kind,
    intervalMinutes: preview.canonicalPayload.intervalMinutes,
    config: preview.canonicalPayload.config,
    startAt: preview.canonicalPayload.startAtUtc,
    expectedPreviewFingerprint: preview.previewFingerprint,
    previewPayload: preview.canonicalPayload,
  }, actor, db);
  return { preview, rule };
}

async function startFixtureServer(): Promise<Readonly<{
  close: () => Promise<void>;
  baseUrl: string;
  holdStarted: Promise<void>;
  releaseHold: () => void;
  redirectStarted: Promise<void>;
  releaseRedirect: () => void;
  requestCount: (path: string) => number;
}>> {
  const holdStarted = deferred();
  const holdRelease = deferred();
  const redirectStarted = deferred();
  const redirectRelease = deferred();
  const requestCounts = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    if (request.url === "/hold") {
      holdStarted.resolve();
      void holdRelease.promise.then(() => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("fixture held source");
      });
      return;
    }
    if (request.url === "/redirect") {
      redirectStarted.resolve();
      void redirectRelease.promise.then(() => {
        response.writeHead(302, { location: "/ok" });
        response.end();
      });
      return;
    }
    if (request.url === "/ok") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("fixture source is safe to read");
      return;
    }
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end("fixture failure");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("AUTOMATION_GOVERNANCE_FIXTURE_SERVER_ADDRESS_INVALID");
  }
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
    holdStarted: holdStarted.promise,
    releaseHold: holdRelease.resolve,
    redirectStarted: redirectStarted.promise,
    releaseRedirect: redirectRelease.resolve,
    requestCount: (path) => requestCounts.get(path) ?? 0,
  });
}

test(
  "automation governance freezes stale principals, binds previews and projects runs",
  { skip: !shouldRun ? "AUTOMATION_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    const ownerId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const secondProjectId = randomUUID();
    const owner: Actor = { id: ownerId, role: "user", accountAccessVersion: 1 };
    const fixture = await startFixtureServer();

    await db.appUser.createMany({ data: [
      { id: adminId, username: `automation_admin_${suffix}`, role: "admin" },
      { id: ownerId, username: `automation_owner_${suffix}`, role: "user" },
      { id: editorId, username: `automation_editor_${suffix}`, role: "user" },
      { id: viewerId, username: `automation_viewer_${suffix}`, role: "user" },
    ] });
    await db.workspace.create({ data: { id: workspaceId, name: `Automation governance ${suffix}`, slug: `automation-governance-${suffix}`, createdById: adminId } });
    await db.project.createMany({ data: [
      { id: projectId, workspaceId, name: `Automation project ${suffix}`, slug: `automation-project-${suffix}` },
      { id: secondProjectId, workspaceId, name: `Automation second project ${suffix}`, slug: `automation-second-${suffix}` },
    ] });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "automation_governance_fixture_admin" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "member", actorId: adminId, reason: "automation_governance_fixture_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: editorId, role: "member", actorId: adminId, reason: "automation_governance_fixture_editor" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: viewerId, role: "member", actorId: adminId, reason: "automation_governance_fixture_viewer" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: adminId, reason: "automation_governance_fixture_project_owner" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: adminId, reason: "automation_governance_fixture_project_editor" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: viewerId, role: "viewer", actorId: adminId, reason: "automation_governance_fixture_project_viewer" });
      await grantProjectMembership(tx, { projectId: secondProjectId, workspaceId, userId: ownerId, role: "owner", actorId: adminId, reason: "automation_governance_fixture_second_owner" });
    });

    try {
      // A legacy rule created by an Editor must be paused before the worker
      // can create a run or enter any source/model/Git execution path.
      const historicalEditorRule = await db.automationRule.create({
        data: {
          projectId,
          name: `Historical editor ${suffix}`,
          kind: "webSourceSync",
          intervalMinutes: 60,
          config: {},
          nextRunAt: new Date(Date.now() - 1_000),
          createdById: editorId,
        },
        select: { id: true },
      });
      const historicalCycle = await runAutomationWorkerCycle({ workerId: `automation-editor-${suffix}`, maximumRuns: 1 }, db);
      assert.equal(historicalCycle.claimed, 0);
      assert.equal(await db.automationRun.count({ where: { automationRuleId: historicalEditorRule.id } }), 0);
      assert.equal((await db.automationRule.findUniqueOrThrow({ where: { id: historicalEditorRule.id }, select: { status: true } })).status, "paused");

      // A formerly valid Owner loses runtime authority after the role epoch is
      // replaced with Editor. The worker must make the same locked decision.
      const downgraded = await createRuleWithPreview(projectId, {
        name: `Downgraded owner ${suffix}`,
        kind: "memoryQuality",
        intervalMinutes: 60,
        config: {},
        startAt: new Date(Date.now() + 5_000).toISOString(),
      }, owner, db);
      await db.automationRule.update({ where: { id: downgraded.rule.id }, data: { nextRunAt: new Date(Date.now() - 1_000) } });
      await db.$transaction((tx) => grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "editor", actorId: adminId, reason: "automation_governance_owner_downgrade" }));
      const downgradedCycle = await runAutomationWorkerCycle({ workerId: `automation-downgrade-${suffix}`, maximumRuns: 1 }, db);
      assert.equal(downgradedCycle.claimed, 0);
      assert.equal(await db.automationRun.count({ where: { automationRuleId: downgraded.rule.id } }), 0);
      assert.equal((await db.automationRule.findUniqueOrThrow({ where: { id: downgraded.rule.id }, select: { status: true } })).status, "paused");
      await db.$transaction((tx) => grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: adminId, reason: "automation_governance_owner_restore" }));

      // Workspace inheritance grants owner-equivalent runtime authority only
      // to a confirmed workspace owner/admin. A global admin with no project
      // membership is admitted here; projectOnly is restored immediately.
      await db.project.update({ where: { id: projectId }, data: { membershipInheritanceMode: "workspaceInherited" } });
      const inheritedAdminRule = await db.automationRule.create({
        data: {
          projectId,
          name: `Inherited admin ${suffix}`,
          kind: "memoryIndex",
          intervalMinutes: 60,
          config: { mode: "incremental" },
          nextRunAt: new Date(Date.now() - 1_000),
          createdById: adminId,
        },
        select: { id: true },
      });
      const inheritedCycle = await runAutomationWorkerCycle({ workerId: `automation-inherited-${suffix}`, maximumRuns: 1 }, db);
      assert.equal(inheritedCycle.succeeded, 1);
      assert.equal((await db.automationRule.findUniqueOrThrow({ where: { id: inheritedAdminRule.id }, select: { status: true } })).status, "active");
      assert.equal((await db.automationRun.findFirstOrThrow({ where: { automationRuleId: inheritedAdminRule.id } })).status, "waitingConsent");
      await db.project.update({ where: { id: projectId }, data: { membershipInheritanceMode: "projectOnly" } });

      // Adding a source after preview changes the server-owned scope. The
      // frozen fingerprint rejects the stale create and leaves no rule.
      const sourceOne = `${fixture.baseUrl}/ok`;
      const sourceTwo = `${fixture.baseUrl}/fail`;
      await db.webSource.create({ data: { projectId, name: `Fixture success ${suffix}`, url: sourceOne, allowPrivateNetwork: true, createdById: ownerId } });
      const stalePreview = await previewProjectAutomationRule(projectId, {
        name: `Web stale ${suffix}`,
        kind: "webSourceSync",
        intervalMinutes: 60,
        config: {},
        startAt: new Date(Date.now() + 5_000).toISOString(),
      }, owner, db);
      const beforeStaleCreate = await db.automationRule.count({ where: { projectId } });
      await db.webSource.create({ data: { projectId, name: `Fixture failure ${suffix}`, url: sourceTwo, allowPrivateNetwork: true, createdById: ownerId } });
      await assert.rejects(
        () => createProjectAutomationRule(projectId, {
          name: stalePreview.canonicalPayload.name,
          kind: stalePreview.canonicalPayload.kind,
          intervalMinutes: stalePreview.canonicalPayload.intervalMinutes,
          config: stalePreview.canonicalPayload.config,
          startAt: stalePreview.canonicalPayload.startAtUtc,
          expectedPreviewFingerprint: stalePreview.previewFingerprint,
          previewPayload: stalePreview.canonicalPayload,
        }, owner, db),
        (error: unknown) => error instanceof AutomationError && error.code === "AUTOMATION_PREVIEW_STALE",
      );
      assert.equal(await db.automationRule.count({ where: { projectId } }), beforeStaleCreate);

      const fresh = await createRuleWithPreview(projectId, {
        name: `Web partial ${suffix}`,
        kind: "webSourceSync",
        intervalMinutes: 60,
        config: {},
        startAt: new Date(Date.now() + 5_000).toISOString(),
      }, owner, db);
      await db.automationRule.update({ where: { id: fresh.rule.id }, data: { nextRunAt: new Date(Date.now() - 1_000) } });
      const partialCycle = await runAutomationWorkerCycle({ workerId: `automation-partial-${suffix}`, maximumRuns: 1 }, db);
      assert.equal(partialCycle.claimed, 1);
      assert.equal(partialCycle.failed, 1);
      const partialRun = await db.automationRun.findFirstOrThrow({ where: { automationRuleId: fresh.rule.id }, orderBy: { createdAt: "desc" } });
      assert.equal(partialRun.status, "failed");
      assert.equal(partialRun.failureCode, "AUTOMATION_WEB_SOURCE_PARTIAL_FAILURE");
      assert.deepEqual(partialRun.result && typeof partialRun.result === "object" ? { successCount: (partialRun.result as { successCount?: unknown }).successCount, failedCount: (partialRun.result as { failedCount?: unknown }).failedCount } : null, { successCount: 1, failedCount: 1 });
      assert.equal((await db.automationRule.findUniqueOrThrow({ where: { id: fresh.rule.id }, select: { consecutiveFailures: true } })).consecutiveFailures, 1);
      const projectedPartial = await getProjectAutomationRun(projectId, partialRun.id, owner, db);
      assert.deepEqual(projectedPartial?.result, {
        availability: "available",
        kind: "webSourceSync",
        successCount: 1,
        failedCount: 1,
        failures: [{ failureCode: "WEB_SOURCE_HTTP_STATUS" }],
      });
      assert.equal(JSON.stringify(projectedPartial?.result).includes("127.0.0.1"), false);
      const listed = await listProjectAutomationRules(projectId, owner, db);
      const listedPartial = listed.find((rule) => rule.id === fresh.rule.id);
      assert.deepEqual(listedPartial?.runs[0]?.result, projectedPartial?.result);

      // Waiting-consent runs expose only the explicit local notification
      // contract, never the historical arbitrary JSON payload.
      const consent = await createRuleWithPreview(projectId, {
        name: `Consent ${suffix}`,
        kind: "memoryIndex",
        intervalMinutes: 60,
        config: { mode: "incremental" },
        startAt: new Date(Date.now() + 5_000).toISOString(),
      }, owner, db);
      await db.automationRule.update({ where: { id: consent.rule.id }, data: { nextRunAt: new Date(Date.now() - 1_000) } });
      const consentCycle = await runAutomationWorkerCycle({ workerId: `automation-consent-${suffix}`, maximumRuns: 1 }, db);
      assert.equal(consentCycle.succeeded, 1);
      const consentRun = await db.automationRun.findFirstOrThrow({ where: { automationRuleId: consent.rule.id } });
      assert.equal(consentRun.status, "waitingConsent");
      assert.deepEqual((await getProjectAutomationRun(projectId, consentRun.id, owner, db))?.result, {
        availability: "available",
        kind: "waitingConsent",
        delivery: "waitingConsent",
        modelSelection: "deferred_to_ai_workbench",
        billing: "none",
        externalTransfer: false,
        notificationOnly: true,
      });

      // A source can be disabled while its network fetch is in flight. The
      // completion fence must preserve that disable state and must not turn
      // it back into an error source eligible for a later automation run.
      const heldUrl = `${fixture.baseUrl}/hold`;
      const heldEndpoint = await resolveSecureEndpointFingerprint({ url: heldUrl, allowPrivateNetwork: true });
      const heldSource = await db.webSource.create({
        data: { projectId, name: `Fixture held ${suffix}`, url: heldEndpoint.url, allowPrivateNetwork: true, resolvedAddressFingerprint: heldEndpoint.fingerprint, createdById: ownerId },
        select: { id: true },
      });
      const heldSync = syncProjectWebSource(projectId, heldSource.id, owner, db);
      await fixture.holdStarted;
      await updateProjectWebSource(projectId, heldSource.id, { enabled: false }, owner, db);
      fixture.releaseHold();
      await assert.rejects(
        heldSync,
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_DISABLED",
      );
      const disabledHeldSource = await db.webSource.findUniqueOrThrow({ where: { id: heldSource.id }, select: { status: true, disabledAt: true } });
      assert.equal(disabledHeldSource.status, "disabled");
      assert.notEqual(disabledHeldSource.disabledAt, null);
      assert.equal(await db.webSourceRevision.count({ where: { webSourceId: heldSource.id, status: "failed" } }), 1);

      // A redirect hop must re-enter the source fence. Disable the source
      // after the first hop is received but before its redirect response is
      // released; the second-hop /ok request must never be constructed.
      const redirectUrl = `${fixture.baseUrl}/redirect`;
      const redirectEndpoint = await resolveSecureEndpointFingerprint({ url: redirectUrl, allowPrivateNetwork: true });
      const redirectSource = await db.webSource.create({
        data: { projectId, name: `Fixture redirect ${suffix}`, url: redirectEndpoint.url, allowPrivateNetwork: true, resolvedAddressFingerprint: redirectEndpoint.fingerprint, createdById: ownerId },
        select: { id: true },
      });
      const okCountBeforeRedirect = fixture.requestCount("/ok");
      const redirectSync = syncProjectWebSource(projectId, redirectSource.id, owner, db);
      await fixture.redirectStarted;
      await updateProjectWebSource(projectId, redirectSource.id, { enabled: false }, owner, db);
      fixture.releaseRedirect();
      await assert.rejects(
        redirectSync,
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_DISABLED",
      );
      assert.equal(fixture.requestCount("/redirect"), 1);
      assert.equal(fixture.requestCount("/ok"), okCountBeforeRedirect);

      // The same run id is not readable through another project, even for a
      // user who owns both projects; projection is scoped by project id.
      assert.equal(await getProjectAutomationRun(secondProjectId, partialRun.id, owner, db), null);
    } finally {
      fixture.releaseHold();
      await fixture.close();
      await db.project.deleteMany({ where: { id: { in: [projectId, secondProjectId] } } });
      await db.workspace.deleteMany({ where: { id: workspaceId } });
      await db.appUser.deleteMany({ where: { id: { in: [adminId, ownerId, editorId, viewerId] } } });
    }
  },
);
