import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AutomationRuleKind, PrismaClient } from "@prisma/client";
import { mapApiError } from "../src/lib/api-errors";
import { projectAutomationCapabilities } from "../src/lib/automation-capabilities";
import { automationPreviewFingerprint, AutomationError, buildAutomationPreviewPayload, safeAutomationJobIds } from "../src/lib/automation";
import { automationFailurePresentation } from "../src/lib/automation-failure-presentation";
import { projectAutomationRunResult } from "../src/lib/automation-result-projection";
import { buildAutomationScopePreview } from "../src/lib/automation-scope-preview";
import { buildAutomationSchedulePreview } from "../src/lib/automation-time";

test("automation capabilities keep rule mutations owner-only", () => {
  assert.deepEqual(projectAutomationCapabilities("view"), { permission: "view", canCreate: false, canManage: false, canRunNow: false });
  assert.deepEqual(projectAutomationCapabilities("edit"), { permission: "edit", canCreate: false, canManage: false, canRunNow: false });
  assert.deepEqual(projectAutomationCapabilities("owner"), { permission: "owner", canCreate: true, canManage: true, canRunNow: true });
});

test("automation preview exposes UTC and browser time without persisting a timezone promise", () => {
  const preview = buildAutomationSchedulePreview({ startAt: new Date("2026-09-08T02:04:00.000Z"), intervalMinutes: 1_440, browserTimeZone: "Asia/Shanghai" });
  assert.equal(preview.firstRunAtUtc, "2026-09-08T02:04:00.000Z");
  assert.match(preview.firstRunAtBrowserTime, /2026/u);
  assert.equal(preview.browserTimeZone, "Asia/Shanghai");
  assert.equal(buildAutomationSchedulePreview({ startAt: new Date("2026-09-08T02:04:00.000Z"), intervalMinutes: 60, browserTimeZone: "not/a-timezone" }).browserTimeZone, "UTC");
});

test("model automation scope preview is waitingConsent without external transfer", async () => {
  const db = {
    project: { findUnique: async () => ({ workspaceId: "workspace-1", membershipInheritanceMode: "projectOnly" }) },
    projectMembership: { findMany: async () => [] },
    workspaceMembership: { findMany: async () => [] },
  } as unknown as PrismaClient;
  const preview = await buildAutomationScopePreview("project-1", "memoryIndex" as AutomationRuleKind, db);
  assert.equal(preview.delivery, "waitingConsent");
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(preview.modelExternalTransfer, false);
  assert.equal(preview.sourceCount, 0);
  assert.deepEqual(preview.safeDomains, []);
  assert.deepEqual(preview.notification, { audience: "creator", condition: "waitingConsent", count: 1 });
  assert.match(preview.label, /待确认通知/u);
});

test("automation result projection keeps waiting consent and partial counts safe", () => {
  const waitingConsent = projectAutomationRunResult("memoryIndex", "waitingConsent", {
    delivery: "waitingConsent",
    modelSelection: "secret-provider",
    body: "project content must never reach this response",
  });
  assert.deepEqual(waitingConsent, {
    availability: "available",
    kind: "waitingConsent",
    delivery: "waitingConsent",
    modelSelection: "deferred_to_ai_workbench",
    billing: "none",
    externalTransfer: false,
    notificationOnly: true,
  });
  const partial = projectAutomationRunResult("webSourceSync", "failed", {
    successCount: 2,
    failedCount: 1,
    failures: [{ id: "source-secret", failureCode: "WEB_SOURCE_HTTP_STATUS", url: "https://secret.example" }],
  });
  assert.deepEqual(partial, {
    availability: "available",
    kind: "webSourceSync",
    successCount: 2,
    failedCount: 1,
    failures: [{ failureCode: "WEB_SOURCE_HTTP_STATUS" }],
  });
  assert.equal(projectAutomationRunResult("webSourceSync", "failed", { successCount: "2", failedCount: 1 })?.availability, "unavailable");
  const unknownFailure = projectAutomationRunResult("webSourceSync", "failed", {
    successCount: 0,
    failedCount: 1,
    failures: [{ failureCode: "SECRET_PROVIDER_FAILURE" }],
  });
  assert.deepEqual(unknownFailure && "failures" in unknownFailure ? unknownFailure.failures : null, [{ failureCode: "AUTOMATION_EXECUTION_FAILED" }]);
});

test("automation job id projection only exposes UUIDs", () => {
  const valid = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(safeAutomationJobIds([valid, "legacy-job-identifier", "x".repeat(128), 42]), [valid]);
  assert.deepEqual(safeAutomationJobIds([valid.toUpperCase()]), [valid.toUpperCase()]);
});

test("automation preview fingerprint changes with the frozen canonical payload", () => {
  const scope = {
    label: "项目本地资料范围",
    sourceCount: 0,
    safeDomains: [],
    notification: { audience: "creator" as const, condition: "always" as const, count: 1 },
    modelExternalTransfer: false,
    requiresConfirmation: false,
    delivery: "localNotification" as const,
  };
  const payload = buildAutomationPreviewPayload({
    name: "质量检查",
    kind: "memoryQuality",
    intervalMinutes: 1_440,
    config: {},
    startAt: new Date("2026-09-08T02:04:00.000Z"),
    scope,
  });
  assert.match(automationPreviewFingerprint(payload), /^[0-9a-f]{64}$/u);
  assert.notEqual(automationPreviewFingerprint(payload), automationPreviewFingerprint({ ...payload, name: "被篡改" }));
});

test("repository automation freeze uses the shared stable 409 mapping", async () => {
  const mapped = mapApiError(new AutomationError("AUTOMATION_REPOSITORY_SYNC_FROZEN"));
  assert.equal(mapped.status, 409);
  assert.deepEqual(mapped.body.error, { code: "AUTOMATION_REPOSITORY_SYNC_FROZEN", message: "代码仓库自动化尚未开放" });
  const stale = mapApiError(new AutomationError("AUTOMATION_PREVIEW_STALE"));
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.error, { code: "AUTOMATION_PREVIEW_STALE", message: "自动化预览已变化，请重新预览后确认" });
  for (const path of [
    "src/app/api/projects/[projectId]/automations/route.ts",
    "src/app/api/projects/[projectId]/automations/[ruleId]/route.ts",
    "src/app/api/projects/[projectId]/automations/[ruleId]/run/route.ts",
    "src/app/api/projects/[projectId]/automations/preview/route.ts",
  ]) {
    const source = await readFile(path, "utf8");
    assert.match(source, /handleApiError/u);
    assert.doesNotMatch(source, /automationApiError|instanceof AutomationError/u);
  }
});

test("automation failure presentation remains safe for unknown runtime codes", () => {
  const known = automationFailurePresentation("AUTOMATION_WEB_SOURCE_PARTIAL_FAILURE");
  assert.equal(known.code, "AUTOMATION_WEB_SOURCE_PARTIAL_FAILURE");
  assert.match(known.nextStep, /失败来源/u);
  const unknown = automationFailurePresentation("SENSITIVE_PROVIDER_ERROR");
  assert.equal(unknown.code, "SENSITIVE_PROVIDER_ERROR");
  assert.doesNotMatch(unknown.reason, /SENSITIVE_PROVIDER_ERROR/u);
});

test("automation routes and worker freeze Git and preserve run deep links", async () => {
  const automation = await readFile("src/lib/automation.ts", "utf8");
  const route = await readFile("src/app/api/projects/[projectId]/automations/route.ts", "utf8");
  const previewRoute = await readFile("src/app/api/projects/[projectId]/automations/preview/route.ts", "utf8");
  const client = await readFile("src/app/projects/[projectId]/automations/project-automations-client.tsx", "utf8");
  assert.match(automation, /required:\s*"owner"/u);
  assert.match(automation, /AUTOMATION_REPOSITORY_SYNC_FROZEN/u);
  assert.match(automation, /frozenRepositorySync:\s*true/u);
  assert.match(automation, /AUTOMATION_WEB_SOURCE_PARTIAL_FAILURE/u);
  assert.match(automation, /AutomationExecutionFailure/u);
  const webSyncStart = automation.indexOf('if (run.rule.kind === "webSourceSync")');
  const planHealthStart = automation.indexOf('if (run.rule.kind === "projectPlanHealth")');
  assert.ok(webSyncStart >= 0 && planHealthStart > webSyncStart);
  const webSyncBlock = automation.slice(webSyncStart, planHealthStart);
  assert.match(webSyncBlock, /throw new AutomationExecutionFailure/u);
  assert.doesNotMatch(webSyncBlock, /completeRun\(run,\s*\{\s*status:\s*"failed"/u);
  assert.match(automation, /automations\?run=\$\{run\.id\}/u);
  assert.match(route, /getProjectAutomationCapabilities/u);
  assert.match(route, /getProjectAutomationRun/u);
  assert.match(previewRoute, /previewProjectAutomationRule/u);
  assert.match(client, /\/automations\/preview/u);
  assert.match(client, /不选模型、不扣费、不发送项目内容/u);
  assert.match(client, /useSearchParams/u);
  const claimStart = automation.indexOf("async function claimDueRun");
  const claimEnd = automation.indexOf("function startAutomationHeartbeat", claimStart);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  const claim = automation.slice(claimStart, claimEnd);
  assert.ok(claim.indexOf("admitWebAiProjectAccess") < claim.indexOf("FOR UPDATE SKIP LOCKED"));
});
