import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  buildSystemFailureInboxEntry,
  failureInboxStatusForAction,
  failureInboxStatusForAutomation,
  failureInboxStatusForBackgroundJob,
  failureInboxStatusForIndex,
  failureInboxStatusForMcpAttempt,
  failureInboxStatusForMemoryIndex,
  listSystemFailureInbox,
  parseSystemFailureInboxQuery,
  safeFailureErrorCode,
  SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS,
  SYSTEM_FAILURE_INBOX_LIFECYCLES,
  type SystemFailureInboxQuery,
} from "../src/lib/system-failure-inbox";

const projectId = "11111111-1111-4111-8111-111111111111";
const pausedAutomationRuleId = "30303030-3030-4303-8303-303030303030";
const activeAutomationRuleId = "31313131-3131-4313-8313-313131313131";
const now = new Date("2026-09-13T00:00:00.000Z");
const recent = new Date("2026-09-12T23:00:00.000Z");
const old = new Date("2026-09-01T00:00:00.000Z");

test("failure inbox lifecycle catalog includes only the safe failure states", () => {
  assert.deepEqual(SYSTEM_FAILURE_INBOX_LIFECYCLES, ["observed_failure", "requires_reconciliation", "requires_owner_review"]);
  assert.equal(SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS.requires_owner_review, "需责任人复核");
  assert.equal(failureInboxStatusForBackgroundJob("unknown", true), "requires_reconciliation");
  assert.equal(failureInboxStatusForBackgroundJob("unknown", false), "requires_reconciliation");
  assert.equal(failureInboxStatusForBackgroundJob("failed", false), "observed_failure");
  assert.equal(failureInboxStatusForBackgroundJob("failed", true), "requires_reconciliation");
  assert.equal(failureInboxStatusForBackgroundJob("cancelled", false), null);

  assert.equal(failureInboxStatusForMemoryIndex("unknown", false), "requires_reconciliation");
  assert.equal(failureInboxStatusForMemoryIndex("complete", true), "requires_reconciliation");
  assert.equal(failureInboxStatusForMemoryIndex("failed", false), "observed_failure");
  assert.equal(failureInboxStatusForMemoryIndex("superseded", false), null);
  assert.equal(failureInboxStatusForIndex("unknown"), "requires_reconciliation");
  assert.equal(failureInboxStatusForIndex("failed"), "observed_failure");
  assert.equal(failureInboxStatusForIndex("cancelled"), null);

  assert.equal(failureInboxStatusForAutomation("failed", "paused", 3), "requires_owner_review");
  assert.equal(failureInboxStatusForAutomation("failed", "paused", 2), "observed_failure");
  assert.equal(failureInboxStatusForAutomation("succeeded", "paused", 3), null);
  assert.equal(failureInboxStatusForAction("failed"), "observed_failure");
  assert.equal(failureInboxStatusForAction("cancelled"), null);
  assert.equal(failureInboxStatusForMcpAttempt("unknown"), "requires_reconciliation");
  assert.equal(failureInboxStatusForMcpAttempt("expired"), "observed_failure");
  assert.equal(failureInboxStatusForMcpAttempt("reserved"), null);
});

test("failure inbox projection normalizes unsafe codes and destinations", () => {
  const entry = buildSystemFailureInboxEntry({
    source: "connection",
    id: "22222222-2222-4222-8222-222222222222",
    lifecycle: "observed_failure",
    occurredAt: recent,
    safeErrorCode: "not a code",
    destination: "//untrusted.example/secret",
  });
  assert.equal(entry.safeErrorCode, "UNCLASSIFIED_FAILURE");
  assert.equal(entry.destination, null);
  assert.equal(entry.nextStep, "由连接所有者在个人连接设置中处理该连接。");
  assert.equal(safeFailureErrorCode(null), "UNCLASSIFIED_FAILURE");
  assert.equal(safeFailureErrorCode("MCP_TRANSPORT_FAILED"), "MCP_TRANSPORT_FAILED");
});

type FakeDbOptions = Readonly<{
  readableProjectIds?: readonly string[];
  currentOverflow?: boolean;
}>;

type FakeBackgroundJobRow = {
  id: string;
  projectId: string | null;
  kind: string;
  status: string;
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: Date;
  completedAt: Date | null;
};

function fakeDb(options: FakeDbOptions = {}): PrismaClient {
  const providerHeld = [{ id: "33333333-3333-4333-8333-333333333333", status: "held", safeErrorCode: "PROBE_HELD", updatedAt: recent }];
  const backgroundJobs: FakeBackgroundJobRow[] = [
    { id: "44444444-4444-4444-8444-444444444444", projectId, kind: "memoryIndex", status: "unknown", failureCode: null, reconciliationRequired: true, createdAt: recent, completedAt: null },
    { id: "55555555-5555-4555-8555-555555555555", projectId: null, kind: "autoExtract", status: "failed", failureCode: "JOB_FAILED", reconciliationRequired: false, createdAt: recent, completedAt: recent },
    { id: "12121212-1212-4121-8121-121212121212", projectId: null, kind: "autoExtract", status: "failed", failureCode: "JOB_COMPLETED_RECENT", reconciliationRequired: false, createdAt: old, completedAt: recent },
    { id: "13131313-1313-4131-8131-131313131313", projectId: null, kind: "autoExtract", status: "failed", failureCode: "JOB_COMPLETED_OLD", reconciliationRequired: false, createdAt: recent, completedAt: old },
  ];
  const memoryIndexes = [
    { id: "66666666-6666-4666-8666-666666666666", projectId, jobId: "44444444-4444-4444-8444-444444444444", status: "unknown", failureCode: null, reconciliationRequired: false, createdAt: recent, completedAt: null },
    { id: "14141414-1414-4141-8141-141414141414", projectId, jobId: null, status: "failed", failureCode: "MEMORY_COMPLETED_RECENT", reconciliationRequired: false, createdAt: old, completedAt: recent },
    { id: "15151515-1515-4151-8151-151515151515", projectId, jobId: null, status: "failed", failureCode: "MEMORY_COMPLETED_OLD", reconciliationRequired: false, createdAt: recent, completedAt: old },
  ];
  const indexes = [
    { id: "77777777-7777-4777-8777-777777777777", projectId, status: "failed", failureCode: "INDEX_FAILED", createdAt: recent, completedAt: recent },
    { id: "16161616-1616-4161-8161-161616161616", projectId, status: "failed", failureCode: "INDEX_COMPLETED_RECENT", createdAt: old, completedAt: recent },
    { id: "17171717-1717-4171-8171-171717171717", projectId, status: "failed", failureCode: "INDEX_COMPLETED_OLD", createdAt: recent, completedAt: old },
  ];
  const connections = [
    { id: "88888888-8888-4888-8888-888888888888", status: "error", lastErrorCode: null, updatedAt: recent },
    { id: "18181818-1818-4181-8181-181818181818", status: "error", lastErrorCode: "GIT_CONNECTION_FAILED", updatedAt: recent },
  ];
  const automationRuns = [
    { id: "99999999-9999-4999-8999-999999999999", automationRuleId: pausedAutomationRuleId, projectId, status: "failed", failureCode: "AUTOMATION_FAILED", createdAt: recent, completedAt: recent, rule: { status: "paused", consecutiveFailures: 3 } },
    { id: "19191919-1919-4191-8191-191919191919", automationRuleId: activeAutomationRuleId, projectId, status: "failed", failureCode: "AUTOMATION_LEASE_EXPIRED", createdAt: old, completedAt: recent, rule: { status: "active", consecutiveFailures: 1 } },
    { id: "27272727-2727-4272-8272-272727272727", automationRuleId: activeAutomationRuleId, projectId, status: "failed", failureCode: "INTERNAL_AUTOMATION_SECRET_MARKER", createdAt: old, completedAt: recent, rule: { status: "active", consecutiveFailures: 1 } },
    { id: "20202020-2020-4202-8202-202020202020", automationRuleId: activeAutomationRuleId, projectId, status: "failed", failureCode: "AUTOMATION_COMPLETED_OLD", createdAt: recent, completedAt: old, rule: { status: "active", consecutiveFailures: 1 } },
  ];
  const automationRules = [
    { id: pausedAutomationRuleId, projectId, status: "paused", consecutiveFailures: 3, updatedAt: old },
  ];
  const actions = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId, status: "failed", failureCode: "ACTION_FAILED", createdAt: recent, completedAt: recent },
    { id: "21212121-2121-4121-8121-212121212121", projectId, status: "failed", failureCode: "ACTION_COMPLETED_RECENT", createdAt: old, completedAt: recent },
    { id: "22222222-2222-4222-8222-222222222222", projectId, status: "failed", failureCode: "ACTION_COMPLETED_OLD", createdAt: recent, completedAt: old },
  ];
  const mcpAttempts = [
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId, actionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "unknown", safeErrorCode: null, createdAt: old, completedAt: null },
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", projectId, actionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", status: "expired", safeErrorCode: "MCP_DISPATCH_APPROVAL_EXPIRED", createdAt: recent, completedAt: recent },
    { id: "23232323-2323-4232-8232-232323232323", projectId, actionId: "24242424-2424-4242-8242-242424242424", status: "failed", safeErrorCode: "MCP_COMPLETED_RECENT", createdAt: old, completedAt: recent },
    { id: "25252525-2525-4252-8252-252525252525", projectId, actionId: "26262626-2626-4262-8262-262626262626", status: "invalidated", safeErrorCode: "MCP_COMPLETED_OLD", createdAt: recent, completedAt: old },
  ];
  if (options.currentOverflow === true) {
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(6, "0");
      backgroundJobs.push({
        id: `${suffix}00-0000-4000-8000-000000000000`,
        projectId: null,
        kind: "autoExtract",
        status: "unknown",
        failureCode: null,
        reconciliationRequired: false,
        createdAt: old,
        completedAt: null,
      });
    }
    backgroundJobs.push({
      id: "deadbeef-dead-4eef-8ead-deadbeef0000",
      projectId: null,
      kind: "autoExtract",
      status: "failed",
      failureCode: "BACKGROUND_RECENT_AFTER_CURRENT_OVERFLOW",
      reconciliationRequired: false,
      createdAt: old,
      completedAt: recent,
    });
  }
  const backgroundRows = (args: { where?: { status?: string } }) => args.where?.status === "failed"
    ? backgroundJobs.filter((row) => row.status === "failed" && row.reconciliationRequired === false)
    : backgroundJobs.filter((row) => row.status === "unknown" || row.reconciliationRequired === true);
  const memoryRows = (args: { where?: { status?: string } }) => args.where?.status === "failed"
    ? memoryIndexes.filter((row) => row.status === "failed" && row.reconciliationRequired === false)
    : memoryIndexes.filter((row) => row.status === "unknown" || row.reconciliationRequired === true);
  const indexRows = (args: { where?: { status?: string } }) => args.where?.status === "failed"
    ? indexes.filter((row) => row.status === "failed")
    : indexes.filter((row) => row.status === "unknown");
  const mcpRows = (args: { where?: { status?: unknown } }) => args.where?.status === "unknown"
    ? mcpAttempts.filter((row) => row.status === "unknown")
    : mcpAttempts.filter((row) => ["failed", "expired", "invalidated"].includes(row.status));
  const db = {
    platformProviderProbeAttempt: { findMany: async () => providerHeld },
    backgroundJob: { findMany: async (args: { where?: { status?: string } }) => backgroundRows(args) },
    memoryIndexGeneration: { findMany: async (args: { where?: { status?: string } }) => memoryRows(args) },
    indexGeneration: { findMany: async (args: { where?: { status?: string } }) => indexRows(args) },
    gitConnection: { findMany: async () => connections },
    mcpConnection: { findMany: async () => [] },
    automationRule: { findMany: async () => automationRules },
    automationRun: { findMany: async () => automationRuns },
    projectAction: { findMany: async () => actions },
    projectMcpActionDispatchAttempt: { findMany: async (args: { where?: { status?: unknown } }) => mcpRows(args) },
    workerRuntime: { findUnique: async () => ({ status: "degraded", heartbeatAt: new Date(now.getTime() - 5_000), consecutiveFailures: 1 }) },
    project: { findMany: async () => (options.readableProjectIds ?? []).map((id) => ({ id })) },
  };
  return db as unknown as PrismaClient;
}

test("failure inbox applies window, index-over-job dedupe, stable paging, and no project deep link without access", async () => {
  const query = parseSystemFailureInboxQuery({ pageSize: "3" });
  const key = new Uint8Array(32).fill(7);
  const first = await listSystemFailureInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", query, fakeDb(), { now, cursorKey: key });
  assert.equal(first.pageSize, 3);
  assert.equal(first.entries.length, 3);
  assert.notEqual(first.nextCursor, null);
  assert.equal(first.entries.every((entry) => entry.destination === null || entry.destination.startsWith("/")), true);

  const all = await listSystemFailureInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { ...query, pageSize: 50 }, fakeDb(), { now, cursorKey: key });
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "PROBE_HELD"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "INDEX_FAILED"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "MCP_DISPATCH_APPROVAL_EXPIRED"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "JOB_FAILED"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "JOB_COMPLETED_RECENT"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "MEMORY_COMPLETED_RECENT"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "INDEX_COMPLETED_RECENT"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "AUTOMATION_LEASE_EXPIRED"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "AUTOMATION_EXECUTION_FAILED"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "INTERNAL_AUTOMATION_SECRET_MARKER"), false);
  assert.equal(JSON.stringify(all).includes("INTERNAL_AUTOMATION_SECRET_MARKER"), false);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "ACTION_COMPLETED_RECENT"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "MCP_COMPLETED_RECENT"), true);
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "AUTOMATION_RULE_PAUSED"), true);
  assert.equal(all.entries.find((entry) => entry.safeErrorCode === "AUTOMATION_RULE_PAUSED")?.lifecycle, "requires_owner_review");
  assert.equal(all.entries.find((entry) => entry.safeErrorCode === "AUTOMATION_RULE_PAUSED")?.occurredAt, old.toISOString());
  assert.equal(all.entries.some((entry) => entry.safeErrorCode === "AUTOMATION_FAILED"), false);
  for (const code of ["JOB_COMPLETED_OLD", "MEMORY_COMPLETED_OLD", "INDEX_COMPLETED_OLD", "AUTOMATION_COMPLETED_OLD", "ACTION_COMPLETED_OLD", "MCP_COMPLETED_OLD"]) {
    assert.equal(all.entries.some((entry) => entry.safeErrorCode === code), false, code);
  }
  assert.equal(all.entries.find((entry) => entry.safeErrorCode === "WORKER_DEGRADED")?.lifecycle, "requires_owner_review");
  assert.equal(all.entries.find((entry) => entry.safeErrorCode === "PROBE_HELD")?.lifecycle, "requires_reconciliation");
  assert.equal(all.entries.find((entry) => entry.safeErrorCode === "AUTOMATION_LEASE_EXPIRED")?.lifecycle, "observed_failure");
  assert.equal(all.entries.find((entry) => entry.safeErrorCode === "MCP_DISPATCH_APPROVAL_EXPIRED")?.lifecycle, "observed_failure");
  assert.equal(all.entries.filter((entry) => entry.source === "connection").every((entry) => entry.lifecycle === "requires_owner_review"), true);
  assert.equal(all.entries.filter((entry) => entry.safeErrorCode === "UNCLASSIFIED_FAILURE").length >= 1, true);
  assert.equal(all.entries.every((entry) => entry.destination === null || (entry.source === "providerHeld" && entry.destination === "/admin/models")), true);
  assert.equal(JSON.stringify(all).includes("44444444-4444-4444-8444-444444444444"), false);
  assert.equal(JSON.stringify(all).includes("endpointUrl"), false);
  assert.equal(JSON.stringify(all).includes("toolName"), false);
  assert.equal(JSON.stringify(all).includes("payload"), false);

  const second = await listSystemFailureInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { ...query, cursor: first.nextCursor ?? undefined }, fakeDb(), { now, cursorKey: key });
  assert.equal(second.entries.some((entry) => entry.entryId === first.entries.at(-1)?.entryId), false);
  await assert.rejects(
    () => listSystemFailureInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { ...query, lifecycle: "requires_reconciliation", cursor: first.nextCursor ?? undefined }, fakeDb(), { now, cursorKey: key }),
    (error: unknown) => error instanceof Error && error.message === "失败收件箱分页游标与筛选条件不匹配",
  );

  const paged = await collectPages({ pageSize: 1 }, fakeDb(), key);
  assert.deepEqual(paged.map((entry) => entry.entryId), all.entries.map((entry) => entry.entryId));
  assert.equal(new Set(paged.map((entry) => entry.entryId)).size, paged.length);

  const readable = await listSystemFailureInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { ...query, pageSize: 50 }, fakeDb({ readableProjectIds: [projectId] }), { now, cursorKey: key });
  assert.equal(readable.entries.filter((entry) => entry.source === "indexGeneration").every((entry) => entry.destination === `/projects/${projectId}/memory`), true);
  assert.equal(readable.entries.find((entry) => entry.safeErrorCode === "AUTOMATION_RULE_PAUSED")?.destination, `/projects/${projectId}/automations`);
  assert.equal(readable.entries.filter((entry) => entry.safeErrorCode?.startsWith("MCP_")).every((entry) => entry.destination === null), true);

  const overflow = await listSystemFailureInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { ...query, pageSize: 50 }, fakeDb({ currentOverflow: true }), { now, cursorKey: key });
  assert.equal(overflow.entries.some((entry) => entry.safeErrorCode === "BACKGROUND_RECENT_AFTER_CURRENT_OVERFLOW"), true);
  assert.deepEqual(overflow.partialSources, ["workerBackgroundJob"]);

  const connectionFull = await listSystemFailureInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { source: "connection", pageSize: 50 }, fakeDb(), { now, cursorKey: key });
  const connectionPaged = await collectPages({ source: "connection", pageSize: 1 }, fakeDb(), key);
  assert.deepEqual(connectionPaged.map((entry) => entry.entryId), connectionFull.entries.map((entry) => entry.entryId));
});

async function collectPages(query: Pick<SystemFailureInboxQuery, "pageSize" | "source" | "lifecycle">, db: PrismaClient, key: Uint8Array) {
  const entries = [] as Awaited<ReturnType<typeof listSystemFailureInbox>>["entries"][number][];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const result = await listSystemFailureInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { ...query, cursor }, db, { now, cursorKey: key });
    entries.push(...result.entries);
    if (result.nextCursor === null) return entries;
    cursor = result.nextCursor;
  }
  throw new Error("failure inbox pagination did not terminate");
}

test("API authorizes the stored enabled administrator before failure source reads", async () => {
  const source = await readFile(new URL("../src/app/api/admin/operations/failures/handler.ts", import.meta.url), "utf8");
  const sessionCheck = source.indexOf("await requireApiSession");
  const adminCheck = source.indexOf("await assertSystemFailureInboxAdmin");
  const projection = source.indexOf("await listSystemFailureInbox");
  assert.ok(sessionCheck >= 0);
  assert.ok(adminCheck > sessionCheck);
  assert.ok(projection > adminCheck);
  assert.doesNotMatch(source.slice(0, projection), /(?:platformProviderProbeAttempt|backgroundJob|memoryIndexGeneration|indexGeneration|gitConnection|mcpConnection|automationRun|projectAction|projectMcpActionDispatchAttempt)\.findMany/u);
});

test("static source selectors exclude personal and sensitive payload fields", async () => {
  const source = await readFile(new URL("../src/lib/system-failure-inbox.ts", import.meta.url), "utf8");
  const selectorStart = source.indexOf("const providerHeldSelect");
  const selectorEnd = source.indexOf("type FailureInboxDb");
  assert.ok(selectorStart >= 0 && selectorEnd > selectorStart);
  const selectors = source.slice(selectorStart, selectorEnd);
  for (const field of ["payload", "result", "endpointUrl", "baseUrl", "username", "credentialId", "credentialFingerprint", "inputSchema", "toolDefinitions", "actorId", "ownerUserId"]) {
    assert.equal(selectors.includes(field), false, field);
  }
  const ruleSelectorStart = source.indexOf("const automationRuleSelect");
  const ruleSelectorEnd = source.indexOf("type FailureInboxDb");
  assert.ok(ruleSelectorStart >= 0 && ruleSelectorEnd > ruleSelectorStart);
  const ruleSelector = source.slice(ruleSelectorStart, ruleSelectorEnd);
  for (const field of ["name", "config", "createdById"]) assert.equal(ruleSelector.includes(`${field}: true`), false, field);
  assert.match(ruleSelector, /consecutiveFailures: true/u);
  assert.doesNotMatch(source, /status: "failed", createdAt: \{ gte: from, lte: now \}/u);
  assert.match(source, /status: "failed", completedAt: \{ gte: from, lte: now \}/u);
});

test("R09 admin UI is gated, read-only, live-measured, and exposes all lifecycle filters", async () => {
  const [page, client, route, handler, shell, overview] = await Promise.all([
    readFile(new URL("../src/app/admin/operations/failures/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/admin/operations/failures/failure-inbox-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/admin/operations/failures/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/admin/operations/failures/handler.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/admin-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/admin-overview-client.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /requireSystemAdminPage/u);
  assert.match(handler, /requireApiSession/u);
  assert.match(handler, /assertSystemFailureInboxAdmin/u);
  assert.match(route, /force-dynamic/u);
  assert.match(shell, /failures.*\/admin\/operations\/failures/u);
  assert.match(overview, /\/admin\/operations\/failures/u);
  assert.match(client, /SYSTEM_FAILURE_INBOX_LIFECYCLES/u);
  assert.match(client, /SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS/u);
  assert.match(client, /partialSources/u);
  assert.match(client, /安全查询上限提示/u);
  assert.match(client, /实时测量结果，不承诺跨页严格历史快照/u);
  assert.match(client, /tabIndex=\{0\}/u);
  assert.doesNotMatch(client, /(?:POST|PUT|PATCH|DELETE|重试|重新运行|恢复|dispatch)/u);
});

test("failure inbox client contract stays free of server-only imports", async () => {
  const [client, contract] = await Promise.all([
    readFile(new URL("../src/app/admin/operations/failures/failure-inbox-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/system-failure-inbox-contract.ts", import.meta.url), "utf8"),
  ]);
  assert.match(client, /from "@\/lib\/system-failure-inbox-contract"/u);
  assert.doesNotMatch(client, /from "@\/lib\/system-failure-inbox"/u);
  assert.doesNotMatch(contract, /node:|next\/headers|credential-vault|api-errors|(?:^|[\s"'\/])db(?:$|[\s"'\/])|Prisma/u);
});
