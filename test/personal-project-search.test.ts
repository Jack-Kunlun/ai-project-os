import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ProjectSearchError, type ProjectSearchResponse } from "../src/lib/ai-memory/project-search";
import {
  createPersonalProjectSearchService,
  PersonalProjectSearchError,
} from "../src/lib/personal-project-search-service";
import { isCurrentProjectSourceCitation } from "../src/lib/project-source-citation";
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
        sourceContentHash: "c".repeat(64),
        excerpt: `${projectId} evidence`,
      },
    }],
  };
}

function fakeDb(options: Readonly<{ revokeProjectId?: string; revokeAfterAccessChecks?: number; transactionConflicts?: number }>): PrismaClient & { accessChecks: () => number; transactionAttempts: () => number; archiveProject: (id: string) => void } {
  const projects = new Map([
    [PROJECT_A, { id: PROJECT_A, name: "Alpha", workspaceId: WORKSPACE_A, membershipInheritanceMode: "projectOnly" as const, archivedAt: null }],
    [PROJECT_B, { id: PROJECT_B, name: "Beta", workspaceId: WORKSPACE_A, membershipInheritanceMode: "projectOnly" as const, archivedAt: new Date("2026-09-21T00:00:00.000Z") }],
  ]);
  let accessChecks = 0;
  let transactionAttempts = 0;
  const db = {
    $executeRaw: async () => 1,
    $transaction: async <T>(callback: (tx: PrismaClient) => Promise<T>): Promise<T> => {
      transactionAttempts += 1;
      if (transactionAttempts <= (options.transactionConflicts ?? 0)) {
        throw new Prisma.PrismaClientKnownRequestError("serialization conflict", { code: "P2034", clientVersion: "7.10.0" });
      }
      return callback(db as unknown as PrismaClient);
    },
    appUser: {
      findUnique: async () => ({ id: USER_A, role: "user", disabledAt: null, accountAccessVersion: 1 }),
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      findMany: async ({ where, take }: { where: { id?: { in: string[] }; archivedAt?: null; AND?: readonly unknown[] }; take?: number }) => {
        const activeOnly = where.archivedAt === null || where.AND?.some((part) =>
          typeof part === "object" && part !== null && "archivedAt" in part && part.archivedAt === null) === true;
        const rows = [...projects.values()].filter((project) =>
          (where.id === undefined || where.id.in.includes(project.id)) && (!activeOnly || project.archivedAt === null));
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      count: async ({ where }: { where: { id: string | { in: string[] }; archivedAt?: null } }) =>
        [...projects.values()].filter((project) =>
          (typeof where.id === "string" ? project.id === where.id : where.id.in.includes(project.id))
          && (where.archivedAt !== null || project.archivedAt === null)).length,
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
  return Object.assign(db as unknown as PrismaClient, {
    accessChecks: () => accessChecks,
    transactionAttempts: () => transactionAttempts,
    archiveProject: (id: string) => {
      const project = projects.get(id);
      if (project) projects.set(id, { ...project, archivedAt: new Date() });
    },
  });
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
  assert.equal(result.results[0]?.citation.contentHash, "b".repeat(64));
  assert.equal(result.results[0]?.citation.sourceContentHash, "c".repeat(64));
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
  assert.deepEqual(result.results.map((item) => item.projectId), [PROJECT_A]);
  assert.equal(db.accessChecks(), 3);
});

test("all-accessible search drops the response if a selected project is archived during search", async () => {
  const db = fakeDb({});
  const service = createPersonalProjectSearchService({ db, searchService: {
    search: async (input) => {
      db.archiveProject(input.projectId);
      return searchResponse(input.projectId, "99999999-9999-4999-8999-999999999999");
    },
  } });
  await assert.rejects(
    () => service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { scope: "allAccessible", query: "evidence" }),
    (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
  );
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

test("personal project search retries a serialization conflict within the selected scope", async () => {
  const db = fakeDb({ transactionConflicts: 1 });
  const service = createPersonalProjectSearchService({ db, searchService: searchService() });
  const result = await service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { projectIds: [PROJECT_A], query: "evidence" });
  assert.deepEqual(result.selectedProjects.map((project) => project.id), [PROJECT_A]);
  assert.equal(db.transactionAttempts(), 2);
});

test("personal project search reports a stable conflict after bounded serialization retries", async () => {
  const db = fakeDb({ transactionConflicts: 3 });
  const service = createPersonalProjectSearchService({ db, searchService: searchService() });
  await assert.rejects(
    () => service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { projectIds: [PROJECT_A], query: "evidence" }),
    (error: unknown) => error instanceof PersonalProjectSearchError && error.code === "PERSONAL_PROJECT_SEARCH_CONFLICT",
  );
  assert.equal(db.transactionAttempts(), 3);
});

test("project search route and panel keep selected project scope explicit", async () => {
  const [route, panel, sourceRoute, sourceDetail] = await Promise.all([
    readFile("src/app/api/personal/knowledge/project-search/route.ts", "utf8"),
    readFile("src/app/personal/knowledge/personal-project-search-panel.tsx", "utf8"),
    readFile("src/app/api/projects/[projectId]/sources/[sourceId]/route.ts", "utf8"),
    readFile("src/app/projects/[projectId]/materials/sources/[sourceId]/source-detail-client.tsx", "utf8"),
  ]);
  assert.match(route, /assertSameOrigin/u);
  assert.match(route, /parsePersonalProjectSearchInput/u);
  assert.match(route, /cache-control/u);
  assert.match(panel, /最多 \{MAX_SELECTED_PROJECTS\} 个项目/u);
  assert.match(panel, /projectIds: selectedIds/u);
  assert.match(panel, /全部可访问的未归档项目/u);
  assert.match(panel, /本次搜索时仍有权访问的未归档项目/u);
  assert.match(panel, /scope === "allAccessible"/u);
  assert.match(panel, /useState<"selected" \| "allAccessible">\("selected"\)/u);
  assert.match(panel, /跨项目检索需手动选择范围/u);
  assert.match(panel, /结果保留项目归属/u);
  assert.match(panel, /当前索引/u);
  assert.match(panel, /sourceKindLabel/u);
  assert.match(panel, /contentHash=\$\{encodeURIComponent\(result\.citation\.sourceContentHash\)\}/u);
  assert.match(panel, /打开并核对原始资料/u);
  assert.match(sourceRoute, /requireApiSession\(request\)/u);
  assert.match(sourceRoute, /required: "view", allowArchived: true/u);
  assert.match(sourceRoute, /SOURCE_CITATION_STALE/u);
  assert.match(sourceRoute, /isCurrentProjectSourceCitation/u);
  assert.match(sourceRoute, /no-store/u);
  assert.match(sourceDetail, /contentHash=\$\{encodeURIComponent\(contentHash\)\}/u);
  assert.match(sourceDetail, /setSource\(null\)/u);
});

test("project source citations fail closed on retired or changed source versions", () => {
  const contentHash = "b".repeat(64);
  assert.equal(isCurrentProjectSourceCitation({
    expectedContentHash: contentHash,
    currentContentHash: contentHash,
    retiredAt: null,
  }), true);
  assert.equal(isCurrentProjectSourceCitation({
    expectedContentHash: contentHash.toUpperCase(),
    currentContentHash: contentHash,
    retiredAt: null,
  }), true);
  assert.equal(isCurrentProjectSourceCitation({
    expectedContentHash: contentHash,
    currentContentHash: "c".repeat(64),
    retiredAt: null,
  }), false);
  assert.equal(isCurrentProjectSourceCitation({
    expectedContentHash: contentHash,
    currentContentHash: contentHash,
    retiredAt: new Date("2026-09-25T00:00:00.000Z"),
  }), false);
});

test("project search service maps an unready project index without exposing search internals", async () => {
  const searchError = { search: async (): Promise<ProjectSearchResponse> => { throw new ProjectSearchError("PROJECT_SEARCH_SNAPSHOT_NOT_READY"); } };
  const service = createPersonalProjectSearchService({ db: fakeDb({}), searchService: searchError });
  await assert.rejects(
    () => service.search({ id: USER_A, role: "user", accountAccessVersion: 1 }, { projectIds: [PROJECT_A], query: "evidence" }),
    (error: unknown) => error instanceof PersonalProjectSearchError && error.code === "PERSONAL_PROJECT_SEARCH_NOT_READY",
  );
});
