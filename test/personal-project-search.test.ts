import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { ProjectSearchError, type ProjectSearchResponse } from "../src/lib/ai-memory/project-search";
import {
  createPersonalProjectSearchService,
  PersonalProjectSearchError,
} from "../src/lib/personal-project-search-service";
import { WebAiAccessError } from "../src/lib/web-ai-access";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "33333333-3333-4333-8333-333333333333";
const USER_A = "44444444-4444-4444-8444-444444444444";

function searchResponse(projectId: string, sourceId: string): ProjectSearchResponse {
  return {
    searchVersion: "project-search:v1",
    mode: "lexical",
    snapshot: {
      id: `55555555-5555-4555-8555-${projectId.slice(-12)}`,
      manifestFingerprint: "a".repeat(64),
      manualIndexGenerationId: "66666666-6666-4666-8666-666666666666",
      manualCorpusGenerationId: "77777777-7777-4777-8777-777777777777",
      effectivePolicyVersion: 1,
      publishedAt: new Date("2026-09-22T00:00:00.000Z"),
    },
    results: [{
      rank: 1,
      score: projectId === PROJECT_A ? 0.9 : 0.8,
      matchedFeatures: ["substring"],
      componentRanks: { vector: null, cjk: null, identifier: null, substring: 1, token: null },
      citation: {
        projectId,
        sourceId,
        sourceKind: "document",
        externalRef: null,
        chunkId: "88888888-8888-4888-8888-888888888888",
        rangeUnit: "utf8_byte",
        rangeStart: 0,
        rangeEnd: 12,
        contentHash: "b".repeat(64),
        excerpt: `${projectId} evidence`,
      },
    }],
  };
}

function fakeDb(options: Readonly<{ revokeProjectId?: string; revokeAfterAccessChecks?: number }>): PrismaClient & { accessChecks: () => number } {
  const projects = new Map([
    [PROJECT_A, { id: PROJECT_A, name: "Alpha", workspaceId: WORKSPACE_A, membershipInheritanceMode: "projectOnly" as const, archivedAt: null }],
    [PROJECT_B, { id: PROJECT_B, name: "Beta", workspaceId: WORKSPACE_A, membershipInheritanceMode: "projectOnly" as const, archivedAt: new Date("2026-09-21T00:00:00.000Z") }],
  ]);
  let accessChecks = 0;
  const db = {
    appUser: {
      findUnique: async () => ({ id: USER_A, disabledAt: null, accountAccessVersion: 1 }),
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      findMany: async ({ where, take }: { where: { id?: { in: string[] } }; take?: number }) => {
        const rows = where.id === undefined ? [...projects.values()] : [...projects.values()].filter((project) => where.id!.in.includes(project.id));
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      count: async ({ where }: { where: { id: string } }) => projects.has(where.id) ? 1 : 0,
    },
    workspaceMembership: {
      findMany: async () => [],
    },
    projectMembership: {
      findMany: async ({ where }: { where: { projectId: string } }) => {
        accessChecks += 1;
        if (options.revokeProjectId === where.projectId && options.revokeAfterAccessChecks !== undefined && accessChecks > options.revokeAfterAccessChecks) return [];
        const project = projects.get(where.projectId);
        if (project === undefined) return [];
        return [{ id: `${where.projectId}:${USER_A}`, projectId: where.projectId, userId: USER_A, role: "viewer", accessState: "confirmed", createdAt: new Date(0), updatedAt: new Date(0) }];
      },
    },
  };
  return Object.assign(db as unknown as PrismaClient, { accessChecks: () => accessChecks });
}

function searchService(): { search: (input: { projectId: string; query: string; take?: number }) => Promise<ProjectSearchResponse> } {
  return {
    async search(input) {
      return searchResponse(input.projectId, input.projectId === PROJECT_A ? "99999999-9999-4999-8999-999999999999" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    },
  };
}

test("personal project search returns only selected lexical citations in stable score order", async () => {
  const service = createPersonalProjectSearchService({ db: fakeDb({}), searchService: searchService() });
  const result = await service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { projectIds: [PROJECT_B, PROJECT_A], query: "evidence", take: 2 });

  assert.equal(result.mode, "lexical");
  assert.deepEqual(result.selectedProjects.map((project) => project.name), ["Beta", "Alpha"]);
  assert.deepEqual(result.results.map((item) => item.projectId), [PROJECT_A, PROJECT_B]);
  assert.equal(result.results[0]?.projectName, "Alpha");
  assert.equal(result.results[0]?.snapshotId.startsWith("55555555"), true);
  assert.equal(result.results[0]?.citation.excerpt, `${PROJECT_A} evidence`);
  assert.deepEqual(result.results.map((item) => item.rank), [1, 2]);
});

test("personal project search resolves all accessible projects on the server and rechecks every citation", async () => {
  const db = fakeDb({});
  const service = createPersonalProjectSearchService({ db, searchService: searchService() });
  const result = await service.search(
    { id: USER_A, role: "user", accountAccessVersion: 1 },
    { scope: "allAccessible", query: "evidence", take: 2 },
  );

  assert.equal(result.scope, "allAccessible");
  assert.deepEqual(result.results.map((item) => item.projectId), [PROJECT_A, PROJECT_B]);
  assert.equal(db.accessChecks(), 4);
});

test("personal project search rejects invalid or duplicate scopes before project access", async () => {
  const db = fakeDb({});
  const service = createPersonalProjectSearchService({ db, searchService: searchService() });
  await assert.rejects(
    () => service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { projectIds: [PROJECT_A, PROJECT_A], query: "evidence" }),
    (error: unknown) => error instanceof PersonalProjectSearchError && error.code === "PERSONAL_PROJECT_SEARCH_INVALID_INPUT",
  );
  assert.equal(db.accessChecks(), 0);
});

test("personal project search fails closed when one selected project is inaccessible", async () => {
  const service = createPersonalProjectSearchService({ db: fakeDb({}), searchService: searchService() });
  await assert.rejects(
    () => service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { projectIds: [PROJECT_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], query: "evidence" }),
    (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
  );
});

test("personal project search rechecks membership before returning citations", async () => {
  const db = fakeDb({ revokeProjectId: PROJECT_A, revokeAfterAccessChecks: 1 });
  const service = createPersonalProjectSearchService({ db, searchService: searchService() });
  await assert.rejects(
    () => service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { projectIds: [PROJECT_A], query: "evidence" }),
    (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
  );
});

test("project search route and panel keep selected project scope explicit", async () => {
  const [route, panel] = await Promise.all([
    readFile("src/app/api/personal/knowledge/project-search/route.ts", "utf8"),
    readFile("src/app/personal/knowledge/personal-project-search-panel.tsx", "utf8"),
  ]);
  assert.match(route, /assertSameOrigin/u);
  assert.match(route, /parsePersonalProjectSearchInput/u);
  assert.match(route, /cache-control/u);
  assert.match(panel, /最多 \{MAX_SELECTED_PROJECTS\} 个项目/u);
  assert.match(panel, /projectIds: selectedIds/u);
  assert.match(panel, /全部可访问项目/u);
  assert.match(panel, /scope === "allAccessible"/u);
  assert.match(panel, /项目记忆优先展示，个人知识随后展示/u);
  assert.match(panel, /项目内容不会复制到个人库/u);
  assert.match(panel, /当前索引/u);
  assert.match(panel, /sourceKindLabel/u);
});

test("project search service maps an unready project index without exposing search internals", async () => {
  const searchError = { search: async (): Promise<ProjectSearchResponse> => { throw new ProjectSearchError("PROJECT_SEARCH_SNAPSHOT_NOT_READY"); } };
  const service = createPersonalProjectSearchService({ db: fakeDb({}), searchService: searchError });
  await assert.rejects(
    () => service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { projectIds: [PROJECT_A], query: "evidence" }),
    (error: unknown) => error instanceof PersonalProjectSearchError && error.code === "PERSONAL_PROJECT_SEARCH_NOT_READY",
  );
});
