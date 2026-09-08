import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  createProjectAutomationRule,
  listProjectAutomationRules,
  triggerProjectAutomationRule,
  updateProjectAutomationRule,
} from "../src/lib/automation";
import { assertWebAiProjectAccess, WebAiAccessError, type WebAiActor } from "../src/lib/web-ai-access";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_B = "44444444-4444-4444-8444-444444444444";
const USER_A = "55555555-5555-4555-8555-555555555555";
const USER_B = "66666666-6666-4666-8666-666666666666";

function isolatedAccessDb(): PrismaClient {
  const projects = new Map([
    [PROJECT_A, { id: PROJECT_A, workspaceId: WORKSPACE_A, membershipInheritanceMode: "projectOnly" as const }],
    [PROJECT_B, { id: PROJECT_B, workspaceId: WORKSPACE_B, membershipInheritanceMode: "projectOnly" as const }],
  ]);
  const users = new Map([
    [USER_A, { id: USER_A, role: "user" as const, disabledAt: null }],
    [USER_B, { id: USER_B, role: "user" as const, disabledAt: null }],
  ]);
  const projectMemberships = new Map([
    [`${PROJECT_A}:${USER_A}`, { role: "viewer" as const, accessState: "confirmed" as const }],
    [`${PROJECT_B}:${USER_B}`, { role: "viewer" as const, accessState: "confirmed" as const }],
  ]);
  const db = {
    appUser: {
      findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      count: async ({ where }: { where: { id: string } }) => projects.has(where.id) ? 1 : 0,
    },
    workspaceMembership: {
      findMany: async () => [],
    },
    projectMembership: {
      findMany: async ({ where }: { where: { projectId: string; userId: string } }) => {
        const membership = projectMemberships.get(`${where.projectId}:${where.userId}`);
        return membership === undefined ? [] : [{
          ...membership,
          projectId: where.projectId,
          userId: where.userId,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          id: `${where.projectId}:${where.userId}`,
        }];
      },
    },
  } as unknown as PrismaClient;
  return db;
}

function actor(id: string): WebAiActor {
  return { id, role: "user" };
}

type FakeAutomationRule = {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  status: string;
  intervalMinutes: number;
  config: unknown;
  nextRunAt: Date;
  lastRunAt: Date | null;
  consecutiveFailures: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  runs: unknown[];
};

function automationAccessDb(): PrismaClient & { automationRuleReads: number } {
  const projects = new Map([
    [PROJECT_A, { id: PROJECT_A, workspaceId: WORKSPACE_A, archivedAt: null, membershipInheritanceMode: "projectOnly" as const }],
    [PROJECT_B, { id: PROJECT_B, workspaceId: WORKSPACE_B, archivedAt: null, membershipInheritanceMode: "projectOnly" as const }],
  ]);
  const users = new Map([
    [USER_A, { id: USER_A, role: "user" as const, disabledAt: null }],
    [USER_B, { id: USER_B, role: "user" as const, disabledAt: null }],
  ]);
  const memberships = new Map([
    [`${PROJECT_A}:${USER_A}`, "owner" as const],
    [`${PROJECT_B}:${USER_B}`, "owner" as const],
  ]);
  const rules = new Map<string, FakeAutomationRule>([
    [PROJECT_A, { id: "77777777-7777-4777-8777-777777777777", projectId: PROJECT_A, name: "A rule", kind: "memoryQuality", status: "active", intervalMinutes: 60, config: {}, nextRunAt: new Date(Date.now() + 60_000), lastRunAt: null, consecutiveFailures: 0, createdById: USER_A, createdAt: new Date(), updatedAt: new Date(), runs: [] }],
    [PROJECT_B, { id: "88888888-8888-4888-8888-888888888888", projectId: PROJECT_B, name: "B rule", kind: "memoryQuality", status: "active", intervalMinutes: 60, config: {}, nextRunAt: new Date(Date.now() + 60_000), lastRunAt: null, consecutiveFailures: 0, createdById: USER_B, createdAt: new Date(), updatedAt: new Date(), runs: [] }],
  ]);
  let automationRuleReads = 0;
  const automationRule = {
    findMany: async ({ where }: { where: { projectId: string } }) => {
      const rule = rules.get(where.projectId);
      return rule === undefined ? [] : [rule];
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const projectId = String(data.projectId);
      const current = rules.get(projectId);
      const rule: FakeAutomationRule = {
        id: "99999999-9999-4999-8999-999999999999",
        projectId,
        name: String(data.name ?? "Authorized rule"),
        kind: String(data.kind ?? "memoryQuality"),
        status: "active",
        intervalMinutes: Number(data.intervalMinutes ?? current?.intervalMinutes ?? 60),
        config: data.config ?? current?.config ?? {},
        nextRunAt: data.nextRunAt instanceof Date ? data.nextRunAt : new Date(),
        lastRunAt: null,
        consecutiveFailures: 0,
        createdById: String(data.createdById ?? current?.createdById ?? USER_B),
        createdAt: current?.createdAt ?? new Date(),
        updatedAt: new Date(),
        runs: [],
      };
      rules.set(rule.projectId, rule);
      return rule;
    },
    findFirst: async ({ where }: { where: { id: string; projectId: string } }) => {
      const rule = rules.get(where.projectId);
      return rule?.id === where.id ? rule : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const current = [...rules.values()].find((rule) => rule.id === where.id);
      if (current === undefined) throw new Error("RULE_NOT_FOUND");
      const updated: FakeAutomationRule = { ...current, ...(data as Partial<FakeAutomationRule>), updatedAt: new Date() };
      rules.set(updated.projectId, updated);
      return updated;
    },
    updateMany: async ({ where, data }: { where: { id: string; projectId: string; status: string }; data: Record<string, unknown> }) => {
      const current = rules.get(where.projectId);
      if (current?.id !== where.id || current.status !== where.status) return { count: 0 };
      rules.set(where.projectId, { ...current, ...(data as Partial<FakeAutomationRule>), updatedAt: new Date() });
      return { count: 1 };
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const rule = [...rules.values()].find((candidate) => candidate.id === where.id);
      if (rule === undefined) throw new Error("RULE_NOT_FOUND");
      return rule;
    },
  };
  const db = {
    appUser: {
      findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
    },
    workspaceMembership: {
      findMany: async () => [],
    },
    projectMembership: {
      findMany: async ({ where }: { where: { projectId: string; userId: string } }) => {
        const role = memberships.get(`${where.projectId}:${where.userId}`);
        return role === undefined ? [] : [{
          id: `${where.projectId}:${where.userId}`,
          projectId: where.projectId,
          userId: where.userId,
          role,
          accessState: "confirmed" as const,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }];
      },
    },
    $executeRaw: async (..._args: unknown[]) => {
      void _args;
      return 0;
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(db),
  } as Record<string, unknown>;
  Object.defineProperty(db, "automationRule", {
    enumerable: true,
    get: () => {
      automationRuleReads += 1;
      return automationRule;
    },
  });
  Object.defineProperty(db, "automationRuleReads", {
    enumerable: true,
    get: () => automationRuleReads,
  });
  return db as unknown as PrismaClient & { automationRuleReads: number };
}

test("project access remains isolated for two users and two projects", async () => {
  const db = isolatedAccessDb();
  await assert.doesNotReject(() => assertWebAiProjectAccess(actor(USER_A), PROJECT_A, "view", db));
  await assert.rejects(
    () => assertWebAiProjectAccess(actor(USER_A), PROJECT_B, "view", db),
    (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
  );
  await assert.doesNotReject(() => assertWebAiProjectAccess(actor(USER_B), PROJECT_B, "view", db));
  await assert.rejects(
    () => assertWebAiProjectAccess(actor(USER_B), PROJECT_A, "view", db),
    (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
  );
});

test("automation service rejects cross-project reads and writes before touching rules", async () => {
  const operations: Array<[
    string,
    (projectId: string, actor: WebAiActor, db: PrismaClient) => Promise<unknown>,
  ]> = [
    ["list", (projectId, currentActor, db) => listProjectAutomationRules(projectId, currentActor, db)],
    ["create", (projectId, currentActor, db) => createProjectAutomationRule(projectId, { name: "Unauthorized rule", kind: "memoryQuality", intervalMinutes: 60, config: {}, startAt: new Date(Date.now() + 3_600_000).toISOString() }, currentActor, db)],
    ["update", (projectId, currentActor, db) => updateProjectAutomationRule(projectId, "88888888-8888-4888-8888-888888888888", { name: "Unauthorized update" }, currentActor, db)],
    ["trigger", (projectId, currentActor, db) => triggerProjectAutomationRule(projectId, "88888888-8888-4888-8888-888888888888", currentActor, db)],
  ];

  for (const [name, operation] of operations) {
    for (const [targetProject, currentActor] of [[PROJECT_B, actor(USER_A)], [PROJECT_A, actor(USER_B)] ] as const) {
      const db = automationAccessDb();
      await assert.rejects(
        () => operation(targetProject, currentActor, db),
        (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
        `${name} must reject an actor without target project access`,
      );
      assert.equal(db.automationRuleReads, 0, `${name} must authorize before touching automationRule`);
    }
  }
});

test("automation service preserves authorized owner flows within each project", async () => {
  const db = automationAccessDb();
  const currentActor = actor(USER_B);
  const listed = await listProjectAutomationRules(PROJECT_B, currentActor, db);
  assert.equal(listed.length, 1);
  const created = await createProjectAutomationRule(PROJECT_B, { name: "Authorized rule", kind: "memoryQuality", intervalMinutes: 60, config: {}, startAt: new Date(Date.now() + 3_600_000).toISOString() }, currentActor, db);
  assert.equal(created.projectId, PROJECT_B);
  const updated = await updateProjectAutomationRule(PROJECT_B, "99999999-9999-4999-8999-999999999999", { name: "Authorized update" }, currentActor, db);
  assert.equal(updated.name, "Authorized update");
  const triggered = await triggerProjectAutomationRule(PROJECT_B, "99999999-9999-4999-8999-999999999999", currentActor, db);
  assert.equal(triggered.projectId, PROJECT_B);
  assert.ok(db.automationRuleReads > 0);
});

test("project resource routes and services carry actor authorization to the transaction boundary", async () => {
  const [projectRoute, sourcesRoute, sourceDetailRoute, itemsRoute, aiRoutes, automation] = await Promise.all([
    readFile("src/app/api/projects/[projectId]/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/sources/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/sources/[sourceId]/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/items/route.ts", "utf8"),
    readFile("src/lib/project-ai-routes.ts", "utf8"),
    readFile("src/lib/automation.ts", "utf8"),
  ]);

  for (const [name, source] of Object.entries({ projectRoute, sourcesRoute, sourceDetailRoute, itemsRoute })) {
    assert.match(source, /const user = await requireApiSession\(request\)/u, `${name} must resolve the actor`);
    assert.match(source, /withWebAiProjectAccessTransaction/u, `${name} must use the transactional project guard`);
    assert.match(source, /actor:\s*user/u, `${name} must pass the current actor`);
  }
  assert.match(aiRoutes, /export async function getProjectAiRoutes\([\s\S]*withWebAiProjectAccessTransaction/u);
  assert.match(aiRoutes, /required:\s*"view"[\s\S]*allowArchived:\s*true/u);
  const aiRouteHandler = await readFile("src/app/api/projects/[projectId]/ai-routes/route.ts", "utf8");
  assert.match(aiRouteHandler, /previewProjectAiRouteChange\([\s\S]*user/u);
  assert.match(aiRouteHandler, /upsertProjectAiRoute\([\s\S]*user/u);
  assert.doesNotMatch(aiRouteHandler, /assertProjectAiRouteManager|assertProjectActive/u);
  for (const route of [
    await readFile("src/app/api/projects/[projectId]/automations/route.ts", "utf8"),
    await readFile("src/app/api/projects/[projectId]/automations/[ruleId]/route.ts", "utf8"),
    await readFile("src/app/api/projects/[projectId]/automations/[ruleId]/run/route.ts", "utf8"),
  ]) {
    assert.doesNotMatch(route, /assertProjectActive/u);
  }
  assert.match(automation, /listProjectAutomationRules\([\s\S]*actor:\s*WebAiActor/u);
  assert.match(automation, /createProjectAutomationRule\([\s\S]*required:\s*"edit"/u);
  assert.match(automation, /updateProjectAutomationRule\([\s\S]*required:\s*"owner"/u);
  assert.match(automation, /triggerProjectAutomationRule\([\s\S]*required:\s*"owner"/u);
});
