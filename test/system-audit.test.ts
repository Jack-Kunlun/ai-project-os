import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleSystemAuditDetailGet } from "@/app/api/system/audit/[source]/[auditId]/handler";
import { handleSystemAuditGet } from "@/app/api/system/audit/handler";
import {
  getSystemAuditDetail,
  listSystemAudit,
  parseSystemAuditQuery,
  SYSTEM_AUDIT_ACTIONS,
  SYSTEM_AUDIT_DENYLIST_KEYS,
  SYSTEM_AUDIT_RESULTS,
  SYSTEM_AUDIT_REGISTRY,
  SYSTEM_AUDIT_SOURCES,
} from "@/lib/system-audit";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const sessionToken = "a".repeat(48);

type FakeRow = Record<string, unknown>;
type FakeWhere = Record<string, unknown>;

function asDate(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

function matchesDate(value: Date, condition: FakeWhere): boolean {
  const equals = asDate(condition.equals);
  const lt = asDate(condition.lt);
  const lte = asDate(condition.lte);
  const gte = asDate(condition.gte);
  return (equals === null || value.getTime() === equals.getTime())
    && (lt === null || value < lt)
    && (lte === null || value <= lte)
    && (gte === null || value >= gte);
}

function matches(where: FakeWhere | undefined, row: FakeRow): boolean {
  if (where === undefined) return true;
  if (where.AND !== undefined && Array.isArray(where.AND) && !where.AND.every((item) => matches(item as FakeWhere, row))) return false;
  if (where.OR !== undefined && Array.isArray(where.OR) && !where.OR.some((item) => matches(item as FakeWhere, row))) return false;
  const createdAt = where.createdAt;
  if (createdAt !== undefined) {
    const value = asDate(row.createdAt);
    if (value === null) return false;
    if (createdAt instanceof Date ? value.getTime() !== createdAt.getTime() : !matchesDate(value, createdAt as FakeWhere)) return false;
  }
  if (typeof where.id === "string" && row.id !== where.id) return false;
  if (where.id !== undefined && typeof where.id === "object" && where.id !== null) {
    const idFilter = where.id as FakeWhere;
    if (typeof idFilter.lt === "string" && !(String(row.id) < idFilter.lt)) return false;
    if (Array.isArray(idFilter.in) && !idFilter.in.includes(row.id)) return false;
  }
  for (const [key, expected] of Object.entries(where)) {
    if (key === "AND" || key === "OR" || key === "createdAt" || key === "id") continue;
    const actual = row[key];
    if (expected !== null && typeof expected === "object") {
      const filter = expected as FakeWhere;
      if (Array.isArray(filter.in) && !filter.in.includes(actual)) return false;
      if ("equals" in filter && filter.equals !== actual) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function delegate(source: (typeof SYSTEM_AUDIT_SOURCES)[number], rows: FakeRow[], calls: Map<string, number>) {
  const registry = SYSTEM_AUDIT_REGISTRY[source];
  return {
    findMany: async ({ where, take }: { where?: FakeWhere; take?: number }) => {
      const actionFilter = where?.[registry.actionField];
      const actionValues = typeof actionFilter === "string"
        ? [actionFilter]
        : actionFilter !== null && typeof actionFilter === "object" && Array.isArray((actionFilter as FakeWhere).in)
          ? (actionFilter as FakeWhere).in as string[]
          : [];
      for (const value of actionValues) assert.ok(registry.allowedActions.includes(value), `${source} received an invalid action enum: ${value}`);
      calls.set(source, (calls.get(source) ?? 0) + 1);
      return rows
        .filter((row) => matches(where, row))
        .sort((left, right) => {
        const leftDate = asDate(left.createdAt)?.getTime() ?? 0;
        const rightDate = asDate(right.createdAt)?.getTime() ?? 0;
        return rightDate - leftDate || String(right.id).localeCompare(String(left.id));
        })
        .slice(0, take ?? rows.length);
    },
  };
}

function makeRows(): Readonly<Record<string, FakeRow[]>> {
  const at = new Date("2026-09-09T01:00:00.000Z");
  const base = { createdAt: at, actorId: ADMIN_ID, reason: "do not expose this text" };
  return {
    platformDefaultAiRouteAudit: [{ ...base, id: "51111111-1111-4111-8111-111111111111", action: "activated", routeId: "61111111-1111-4111-8111-111111111111", operation: "chat", routeVersion: 2, providerConnectionId: "71111111-1111-4111-8111-111111111111", providerConfigurationVersion: 3 }],
    aiProviderOwnershipAudit: [{ ...base, id: "52111111-1111-4111-8111-111111111111", providerConnectionId: "72111111-1111-4111-8111-111111111111", action: "legacyOwnershipConfirmed", oldScope: "platform", newScope: "platform", oldOwnershipState: "legacyPending", newOwnershipState: "confirmed", oldWorkspacePresent: false, newWorkspacePresent: false, oldOwnerPresent: false, newOwnerPresent: false }],
    membershipSubscriptionAudit: [{ ...base, id: "53111111-1111-4111-8111-111111111111", subscriptionId: "63111111-1111-4111-8111-111111111111", userId: USER_ID, actorId: ADMIN_ID, eventKind: "grant", versionBefore: null, versionAfter: 1, statusBefore: null, statusAfter: "active" }],
    accountAccessAudit: [{ ...base, id: "54111111-1111-4111-8111-111111111111", userId: USER_ID, actorId: ADMIN_ID, event: "disabled", versionBefore: 1, versionAfter: 2, disabledAtBefore: null, disabledAtAfter: at, previewId: "64111111-1111-4111-8111-111111111111" }],
    membershipAccessAudit: [{ ...base, id: "55111111-1111-4111-8111-111111111111", membershipKind: "project", membershipId: "65111111-1111-4111-8111-111111111111", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, userId: USER_ID, action: "confirmed", previousState: "pending", newState: "confirmed", roleSnapshot: "viewer" }],
    workspaceInvitationAudit: [{ ...base, id: "56111111-1111-4111-8111-111111111111", invitationId: "66111111-1111-4111-8111-111111111111", workspaceId: WORKSPACE_ID, event: "created", versionBefore: null, versionAfter: 1, statusBefore: null, statusAfter: "pending", actorId: ADMIN_ID }],
    mcpToolAttestationAudit: [{ ...base, id: "57111111-1111-4111-8111-111111111111", attestationId: "67111111-1111-4111-8111-111111111111", connectionId: "77111111-1111-4111-8111-111111111111", toolDefinitionId: "87111111-1111-4111-8111-111111111111", event: "attested", controlPlaneVersion: 2, attestationVersion: 1, statusBefore: null, statusAfter: "active", connectionConfigurationRevision: 4, details: { metadata: "secret" }, definitionFingerprint: "fingerprint" }],
    projectAiProviderDelegationAudit: [{ ...base, id: "58111111-1111-4111-8111-111111111111", projectId: PROJECT_ID, operation: "chat", entity: "delegation", action: "activated", delegationId: "68111111-1111-4111-8111-111111111111", selectionId: null, delegationVersion: 1, selectionVersion: null, statusBefore: "ownerConfirmed", statusAfter: "active", selectionSource: null, selectedDelegationId: null, selectedByProjectMembershipId: null, providerConnectionId: "78111111-1111-4111-8111-111111111111", connectionOwnerId: USER_ID, providerConfigurationVersion: 2, connectionOwnerAccountAccessVersion: 1, actorKind: "user", actorProjectMembershipId: null }],
    projectGitRepositoryDelegationAudit: [{ ...base, id: "59111111-1111-4111-8111-111111111111", projectId: PROJECT_ID, gitConnectionId: "79111111-1111-4111-8111-111111111111", delegationId: "69111111-1111-4111-8111-111111111111", connectionOwnerId: USER_ID, action: "activated", delegationVersion: 1, statusBefore: "ownerConfirmed", statusAfter: "active", actorKind: "user", actorProjectMembershipId: null, ownerProjectMembershipId: "65111111-1111-4111-8111-111111111111", connectionConfigurationVersion: 2, connectionOwnerAccountAccessVersion: 1 }],
    projectMcpConnectionDelegationAudit: [{ ...base, id: "5a111111-1111-4111-8111-111111111111", projectId: PROJECT_ID, mcpConnectionId: "7a111111-1111-4111-8111-111111111111", delegationId: "6a111111-1111-4111-8111-111111111111", connectionOwnerId: USER_ID, action: "activated", delegationVersion: 1, statusBefore: "ownerConfirmed", statusAfter: "active", actorKind: "user", actorProjectMembershipId: null, ownerProjectMembershipId: "65111111-1111-4111-8111-111111111111", connectionConfigurationRevision: 2, connectionOwnerAccountAccessVersion: 1 }],
    projectMcpToolGrantLedger: [{ ...base, id: "5b111111-1111-4111-8111-111111111111", projectId: PROJECT_ID, grantId: "6b111111-1111-4111-8111-111111111111", connectionId: "7b111111-1111-4111-8111-111111111111", delegationId: "6c111111-1111-4111-8111-111111111111", toolDefinitionId: "8b111111-1111-4111-8111-111111111111", attestationId: "6d111111-1111-4111-8111-111111111111", connectionOwnerId: USER_ID, controlPlaneVersion: 2, grantVersion: 1, event: "granted", statusBefore: null, statusAfter: "active", actorProjectMembershipId: "65111111-1111-4111-8111-111111111111", delegationVersion: 1, connectionConfigurationRevision: 2, grantorProjectMembershipId: "65111111-1111-4111-8111-111111111111", revokerProjectMembershipId: null, acknowledgedAt: at, transactionId: BigInt(1), transitionAt: at }],
  };
}

function uuidFor(seed: number): string {
  return `90000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`;
}

function makeDenseRows(): Readonly<Record<string, FakeRow[]>> {
  const rows = makeRows();
  const first = rows.platformDefaultAiRouteAudit[0]!;
  return {
    ...rows,
    platformDefaultAiRouteAudit: Array.from({ length: 123 }, (_, index) => ({
      ...first,
      id: uuidFor(0x1000 + index),
    })),
  };
}

const PRIVATE_RESOURCE_IDS = [
  "61111111-1111-4111-8111-111111111111",
  "71111111-1111-4111-8111-111111111111",
  "72111111-1111-4111-8111-111111111111",
  "63111111-1111-4111-8111-111111111111",
  "64111111-1111-4111-8111-111111111111",
  "65111111-1111-4111-8111-111111111111",
  "66111111-1111-4111-8111-111111111111",
  "67111111-1111-4111-8111-111111111111",
  "77111111-1111-4111-8111-111111111111",
  "87111111-1111-4111-8111-111111111111",
  "68111111-1111-4111-8111-111111111111",
  "78111111-1111-4111-8111-111111111111",
  "79111111-1111-4111-8111-111111111111",
  "69111111-1111-4111-8111-111111111111",
  "7a111111-1111-4111-8111-111111111111",
  "6a111111-1111-4111-8111-111111111111",
  "7b111111-1111-4111-8111-111111111111",
  "6c111111-1111-4111-8111-111111111111",
  "8b111111-1111-4111-8111-111111111111",
  "6d111111-1111-4111-8111-111111111111",
];

function fakeDb(
  rows: Readonly<Record<string, FakeRow[]>>,
  role: "admin" | "member" = "admin",
  calls: Map<string, number> = new Map(),
  disabledAdmin = false,
): PrismaClient {
  const users = [{ id: ADMIN_ID, username: "admin", displayName: "平台管理员", disabledAt: disabledAdmin ? new Date("2026-09-08T00:00:00.000Z") : null, accountAccessVersion: 1, role }, { id: USER_ID, username: "member", displayName: "普通用户", disabledAt: null, accountAccessVersion: 1, role: "user" }];
  const appUser = {
    findUnique: async () => users[0],
    findMany: async ({ where }: { where?: FakeWhere }) => users.filter((user) => matches(where, user)),
  };
  const appSession = {
    findUnique: async () => ({ id: "91111111-1111-4111-8111-111111111111", accountAccessVersion: 1, revokedAt: null, expiresAt: new Date("2030-01-01T00:00:00.000Z"), lastSeenAt: new Date("2026-09-09T00:00:00.000Z"), user: users[0] }),
    updateMany: async () => ({ count: 0 }),
  };
  return {
    appUser,
    appSession,
    platformDefaultAiRouteAudit: delegate("platformDefaultAiRoute", rows.platformDefaultAiRouteAudit, calls),
    aiProviderOwnershipAudit: delegate("aiProviderOwnership", rows.aiProviderOwnershipAudit, calls),
    membershipSubscriptionAudit: delegate("membershipSubscription", rows.membershipSubscriptionAudit, calls),
    accountAccessAudit: delegate("accountAccess", rows.accountAccessAudit, calls),
    membershipAccessAudit: delegate("membershipAccess", rows.membershipAccessAudit, calls),
    workspaceInvitationAudit: delegate("workspaceInvitation", rows.workspaceInvitationAudit, calls),
    mcpToolAttestationAudit: delegate("mcpToolAttestation", rows.mcpToolAttestationAudit, calls),
    projectAiProviderDelegationAudit: delegate("projectAiProviderDelegation", rows.projectAiProviderDelegationAudit, calls),
    projectGitRepositoryDelegationAudit: delegate("projectGitRepositoryDelegation", rows.projectGitRepositoryDelegationAudit, calls),
    projectMcpConnectionDelegationAudit: delegate("projectMcpConnectionDelegation", rows.projectMcpConnectionDelegationAudit, calls),
    projectMcpToolGrantLedger: delegate("projectMcpToolGrantLedger", rows.projectMcpToolGrantLedger, calls),
  } as unknown as PrismaClient;
}

test("registry covers exactly the eleven safe control-plane sources", () => {
  assert.equal(SYSTEM_AUDIT_SOURCES.length, 11);
  assert.deepEqual(Object.keys(SYSTEM_AUDIT_REGISTRY).sort(), [...SYSTEM_AUDIT_SOURCES].sort());
  for (const source of SYSTEM_AUDIT_SOURCES) {
    const registry = SYSTEM_AUDIT_REGISTRY[source];
    assert.ok(registry.selectedFields.includes("id"));
    assert.ok(registry.selectedFields.includes("createdAt"));
    assert.ok(registry.referenceFields.length > 0);
    assert.deepEqual(Object.keys(registry.actionMap).sort(), [...registry.allowedActions].sort());
    for (const action of registry.allowedActions) assert.ok(SYSTEM_AUDIT_ACTIONS.includes(action as (typeof SYSTEM_AUDIT_ACTIONS)[number]));
    for (const [result, mappedActions] of Object.entries(registry.resultMap)) {
      assert.ok(SYSTEM_AUDIT_RESULTS.includes(result as (typeof SYSTEM_AUDIT_RESULTS)[number]));
      for (const action of mappedActions ?? []) assert.ok(registry.allowedActions.includes(action));
    }
  }
  assert.ok(SYSTEM_AUDIT_ACTIONS.includes("revoked"));
  assert.ok(!SYSTEM_AUDIT_REGISTRY.projectMcpToolGrantLedger.table.includes("GrantAudit"));
});

test("system audit merge is stable across sources and cursor pages", async () => {
  const rows = makeRows();
  const db = fakeDb(rows);
  const first = await listSystemAudit({ pageSize: 4 }, db, new Date("2026-09-09T02:00:00.000Z"));
  assert.equal(first.events.length, 4);
  assert.ok(first.nextCursor);
  assert.equal(new Set(first.events.map((event) => `${event.source}:${event.id}`)).size, 4);
  const second = await listSystemAudit({ pageSize: 4, cursor: first.nextCursor ?? undefined }, db, new Date("2026-09-09T03:00:00.000Z"));
  assert.equal(second.events.length, 4);
  assert.deepEqual(first.events.map((event) => event.id).filter((id) => second.events.some((item) => item.id === id)), []);
  const all = [...first.events, ...second.events];
  for (let index = 1; index < all.length; index += 1) {
    assert.ok(all[index - 1]!.occurredAt >= all[index]!.occurredAt);
  }
});

test("system audit pagination covers dense single-source and cross-source pages without gaps", async () => {
  const rows = makeDenseRows();
  const db = fakeDb(rows);
  const now = new Date("2026-09-09T02:00:00.000Z");
  const expectedCount = Object.values(rows).reduce((count, sourceRows) => count + sourceRows.length, 0);
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  while (true) {
    const page = await listSystemAudit({ pageSize: 7, ...(cursor === undefined ? {} : { cursor }) }, db, now);
    pageCount += 1;
    for (const event of page.events) {
      const key = `${event.source}:${event.id}`;
      assert.equal(seen.has(key), false, `duplicate audit event ${key}`);
      seen.add(key);
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    assert.ok(pageCount < 30, "pagination did not converge");
  }
  assert.ok(pageCount >= 3);
  assert.equal(seen.size, expectedCount);
  assert.equal([...seen].filter((key) => key.startsWith("platformDefaultAiRoute:")).length, rows.platformDefaultAiRouteAudit.length);
});

test("source-specific action/result filters only invoke delegates with real source enums", async () => {
  const rows = makeRows();
  const calls = new Map<string, number>();
  const db = fakeDb(rows, "admin", calls);
  const now = new Date("2026-09-09T02:00:00.000Z");
  for (const source of SYSTEM_AUDIT_SOURCES) {
    const registry = SYSTEM_AUDIT_REGISTRY[source];
    for (const action of registry.allowedActions) {
      await listSystemAudit({ source, action: action as (typeof SYSTEM_AUDIT_ACTIONS)[number], pageSize: 1 }, db, now);
    }
    for (const result of Object.keys(registry.resultMap)) {
      await listSystemAudit({ source, result: result as (typeof SYSTEM_AUDIT_RESULTS)[number], pageSize: 1 }, db, now);
    }
    const invalidAction = SYSTEM_AUDIT_ACTIONS.find((action) => !registry.allowedActions.includes(action));
    if (invalidAction !== undefined) {
      const before = calls.get(source) ?? 0;
      const page = await listSystemAudit({ source, action: invalidAction, pageSize: 1 }, db, now);
      assert.deepEqual(page.events, []);
      assert.equal(calls.get(source) ?? 0, before, `${source} queried for an inapplicable action`);
    }
    const invalidResult = SYSTEM_AUDIT_RESULTS.find((result) => registry.resultMap[result] === undefined);
    if (invalidResult !== undefined) {
      const before = calls.get(source) ?? 0;
      const page = await listSystemAudit({ source, result: invalidResult, pageSize: 1 }, db, now);
      assert.deepEqual(page.events, []);
      assert.equal(calls.get(source) ?? 0, before, `${source} queried for an inapplicable result`);
    }
  }
});

test("cursor integrity, filter binding, time bounds and resource limits fail closed", async () => {
  const db = fakeDb(makeRows());
  const now = new Date("2026-09-09T02:00:00.000Z");
  const first = await listSystemAudit({ pageSize: 1 }, db, now);
  assert.ok(first.nextCursor);
  const cursor = first.nextCursor!;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
  const isCode = (code: string) => (error: unknown): boolean => error instanceof ApiError && error.code === code;
  await assert.rejects(() => listSystemAudit({ pageSize: 1, cursor: tampered }, db, now), isCode("SYSTEM_AUDIT_CURSOR_INVALID"));
  await assert.rejects(() => listSystemAudit({ pageSize: 1, cursor, action: "activated" }, db, now), isCode("SYSTEM_AUDIT_CURSOR_INVALID"));
  await assert.rejects(() => listSystemAudit({ pageSize: 1, cursor }, db, new Date("2026-12-10T02:00:00.000Z")), isCode("SYSTEM_AUDIT_TIME_INVALID"));

  const future = await listSystemAudit({ pageSize: 1 }, db, new Date("2026-09-10T02:00:00.000Z"));
  assert.ok(future.nextCursor);
  await assert.rejects(() => listSystemAudit({ pageSize: 1, cursor: future.nextCursor! }, db, now), isCode("SYSTEM_AUDIT_TIME_INVALID"));
  await assert.rejects(() => listSystemAudit({ to: new Date("2026-09-09T03:00:00.000Z") }, db, now), isCode("SYSTEM_AUDIT_TIME_INVALID"));
  await assert.rejects(() => listSystemAudit({ from: new Date("2026-01-01T00:00:00.000Z"), to: now }, db, now), isCode("SYSTEM_AUDIT_TIME_RANGE_TOO_LARGE"));
  await assert.rejects(() => listSystemAudit({ pageSize: 51 }, db, now), isCode("SYSTEM_AUDIT_PAGE_SIZE_INVALID"));
});

test("actor and subject lookups accept only exact UUID or unique username", async () => {
  const rows = makeRows();
  const calls = new Map<string, number>();
  const db = fakeDb(rows, "admin", calls);
  const now = new Date("2026-09-09T02:00:00.000Z");
  const byUsername = await listSystemAudit({ actor: "admin", pageSize: 50 }, db, now);
  assert.equal(byUsername.events.length, 11);
  const byDisplayName = await listSystemAudit({ actor: "平台管理员", pageSize: 50 }, db, now);
  assert.deepEqual(byDisplayName.events, []);
});

test("safe projection omits denylisted payload keys and values", async () => {
  const db = fakeDb(makeRows());
  const response = await handleSystemAuditGet(new Request("http://127.0.0.1:3000/api/system/audit?pageSize=50", { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } }), { db });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = await response.json() as unknown;
  const text = JSON.stringify(payload).toLowerCase();
  for (const key of SYSTEM_AUDIT_DENYLIST_KEYS) assert.equal(text.includes(key.toLowerCase()), false, key);
  assert.equal(text.includes("do not expose this text"), false);
  assert.equal(text.includes("fingerprint"), false);
  for (const privateId of PRIVATE_RESOURCE_IDS) assert.equal(text.includes(privateId), false, privateId);
});

test("detail projection uses the same safe source registry as the list", async () => {
  const db = fakeDb(makeRows());
  const listed = (await listSystemAudit({ source: "mcpToolAttestation", pageSize: 50 }, db, new Date("2026-09-09T02:00:00.000Z"))).events[0];
  assert.ok(listed);
  const event = await getSystemAuditDetail("mcpToolAttestation", "57111111-1111-4111-8111-111111111111", db);
  assert.equal(event.source, "mcpToolAttestation");
  assert.equal(event.action, "attested");
  assert.equal(event.evidence.reasonRecorded, false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, "details"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, "metadata"), false);
  assert.deepEqual(event, listed);
  const detailText = JSON.stringify(event).toLowerCase();
  for (const privateId of PRIVATE_RESOURCE_IDS) assert.equal(detailText.includes(privateId), false, privateId);
});

test("cursor and query filters reject malformed or non-whitelisted input", () => {
  assert.throws(() => parseSystemAuditQuery({ relation: "appUser" }), /Unrecognized key/u);
  assert.throws(() => parseSystemAuditQuery({ pageSize: "51" }), /Too big/u);
  assert.throws(() => parseSystemAuditQuery({ from: "2026-09-10T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z" }), /from must be before to/u);
});

test("system audit API fails closed for non-admin sessions", async () => {
  const db = fakeDb(makeRows(), "member");
  const response = await handleSystemAuditGet(new Request("http://127.0.0.1:3000/api/system/audit", { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } }), { db });
  assert.equal(response.status, 403);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "ACCESS_FORBIDDEN");
});

test("system audit API fails closed for disabled administrators", async () => {
  const db = fakeDb(makeRows(), "admin", new Map(), true);
  const response = await handleSystemAuditGet(new Request("http://127.0.0.1:3000/api/system/audit", { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } }), { db });
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.equal(text.includes("51111111-1111-4111-8111-111111111111"), false);
});

test("system audit detail hides record existence from non-admin sessions", async () => {
  const db = fakeDb(makeRows(), "member");
  const response = await handleSystemAuditDetailGet(
    new Request("http://127.0.0.1:3000/api/system/audit/mcpToolAttestation/57111111-1111-4111-8111-111111111111", { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } }),
    { params: Promise.resolve({ source: "mcpToolAttestation", auditId: "57111111-1111-4111-8111-111111111111" }) },
    { db },
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const text = await response.text();
  assert.equal(text.includes("57111111-1111-4111-8111-111111111111"), false);
});

test("system audit API error responses do not expose validation detail objects", async () => {
  const db = fakeDb(makeRows());
  const response = await handleSystemAuditGet(
    new Request("http://127.0.0.1:3000/api/system/audit?relation=appUser", { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } }),
    { db },
  );
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text.includes("details"), false);
  assert.equal(text.includes("appUser"), false);
});

test("system audit UI consumes only safe references and protects detail request ordering", async () => {
  const source = await readFile(new URL("../src/app/admin/audit/audit-client.tsx", import.meta.url), "utf8");
  for (const privateField of ["routeId", "providerConnectionId", "subscriptionId", "previewId", "invitationId", "attestationId", "connectionId", "toolDefinitionId", "delegationId", "gitConnectionId", "mcpConnectionId", "grantId"]) {
    assert.equal(source.includes(privateField), false, privateField);
  }
  assert.match(source, /allowedActionsBySource/u);
  assert.match(source, /allowedResultsBySource/u);
  assert.match(source, /AbortController/u);
});
