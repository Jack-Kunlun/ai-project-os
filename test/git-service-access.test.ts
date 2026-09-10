import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AppUserRole, PrismaClient } from "@prisma/client";
import {
  connectProjectGitRepository,
  disableProjectGitRepository,
  GitServiceError,
  listProjectGitRepositories,
  runGitRepositorySyncJob,
} from "../src/lib/git";
import { mapApiError } from "../src/lib/api-errors";
import { WebAiAccessError, type WebAiActor } from "../src/lib/web-ai-access";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const LINK_ID = "44444444-4444-4444-8444-444444444444";
const CONNECTION_ID = "55555555-5555-4555-8555-555555555555";

const actor = (role: AppUserRole = "user"): WebAiActor => ({ id: ACTOR_ID, role, accountAccessVersion: 1 });

const repositoryInput = {
  gitConnectionId: CONNECTION_ID,
  repositoryPath: "team/service",
  trackedRef: "main",
  role: "application",
  requiredForProjectSnapshot: true,
  codeEnabled: true,
  metadataEnabled: true,
  includeRoots: ["."],
  softExcludePatterns: [],
};

type FakeOptions = Readonly<{
  storedRole?: AppUserRole;
  storedRoleSequence?: readonly AppUserRole[];
  disabledAt?: Date | null;
  disabledAtSequence?: readonly (Date | null)[];
  projectRole?: "owner" | "editor" | "viewer";
  workspaceRole?: "owner" | "admin" | "member" | "viewer";
  accessibleProjectId?: string;
  archivedAt?: Date | null;
  connectionStatus?: "configured" | "verified";
}>;

function fakeDb(options: FakeOptions = {}) {
  let actorLookups = 0;
  let projectLookups = 0;
  let gitMetadataReads = 0;
  let linkReads = 0;
  let linkWrites = 0;

  const db = {
    appUser: {
      findUnique: async () => {
        actorLookups += 1;
        return {
          id: ACTOR_ID,
          role: options.storedRoleSequence?.[actorLookups - 1] ?? options.storedRole ?? "user",
          disabledAt: options.disabledAtSequence?.[actorLookups - 1] ?? options.disabledAt ?? null,
          accountAccessVersion: 1,
        };
      },
    },
    project: {
      count: async () => options.accessibleProjectId === undefined ? 1 : 0,
      findUnique: async (query: { where?: { id?: string }; select?: { archivedAt?: boolean } }) => {
        projectLookups += 1;
        if (query.select?.archivedAt === true) return { archivedAt: options.archivedAt ?? null };
        if (options.accessibleProjectId !== undefined && query.where?.id !== options.accessibleProjectId) return null;
        return {
          workspace: {
            memberships: options.workspaceRole === undefined ? [] : [{ role: options.workspaceRole }],
          },
          memberships: options.projectRole === undefined ? [] : [{ role: options.projectRole }],
        };
      },
    },
    workspaceMembership: {
      findMany: async () => options.workspaceRole === undefined ? [] : [{ role: options.workspaceRole, accessState: "confirmed" as const }],
    },
    projectMembership: {
      findMany: async ({ where }: { where?: { projectId?: string } }) =>
        options.projectRole !== undefined
          && (options.accessibleProjectId === undefined || where?.projectId === options.accessibleProjectId)
          ? [{ role: options.projectRole, accessState: "confirmed" as const }]
          : [],
    },
    gitConnection: {
      findUnique: async () => {
        gitMetadataReads += 1;
        return { id: CONNECTION_ID, status: options.connectionStatus ?? "configured", disabledAt: null };
      },
    },
    projectGitRepositoryLink: {
      findMany: async () => {
        linkReads += 1;
        return [];
      },
      updateMany: async () => {
        linkWrites += 1;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ id: LINK_ID }),
    },
    $transaction: async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(db),
  } as unknown as PrismaClient;

  return {
    db,
    get actorLookups() { return actorLookups; },
    get projectLookups() { return projectLookups; },
    get gitMetadataReads() { return gitMetadataReads; },
    get linkReads() { return linkReads; },
    get linkWrites() { return linkWrites; },
  };
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WebAiAccessError && error.code === code;
}

function hasErrorCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function hasGitCode(code: string) {
  return (error: unknown): boolean => error instanceof GitServiceError && error.code === code;
}

function repositorySyncFixture() {
  let actorLookups = 0;
  let linkReads = 0;
  let snapshotCreates = 0;
  let credentialReads = 0;
  const networkCalls = 0;
  let heartbeatWrites = 0;
  let jobReads = 0;
  let jobWrites = 0;
  const job = {
    id: "66666666-6666-4666-8666-666666666666",
    projectId: PROJECT_ID,
    requestedById: ACTOR_ID,
    kind: "gitRepositorySync" as const,
    status: "queued" as "queued" | "running" | "failed",
    stage: "queued",
    result: null,
    progressCurrent: 0,
    progressTotal: 0,
    failureCode: null as string | null,
    reconciliationRequired: false,
    createdAt: new Date(),
    startedAt: null as Date | null,
    completedAt: null as Date | null,
  };
  let attempt: {
    id: string;
    jobId: string;
    attemptNumber: number;
    status: "running" | "failed";
    leaseTokenHash: string;
    leasedAt: Date;
    leaseExpiresAt: Date;
    heartbeatAt: Date;
    dispatchState: "pending";
    safeFailureCode: string | null;
    completedAt: Date | null;
  } | null = null;

  const db = {
    appUser: {
      findUnique: async () => {
        actorLookups += 1;
        return {
          id: ACTOR_ID,
          role: "user" as const,
          disabledAt: null,
          accountAccessVersion: 1,
        };
      },
    },
    project: {
      count: async () => 1,
      findUnique: async (query: { select?: { archivedAt?: boolean; workspaceId?: boolean } }) => query.select?.workspaceId === true
        ? { id: PROJECT_ID, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", archivedAt: null, membershipInheritanceMode: "projectOnly" }
        : query.select?.archivedAt === true
          ? { archivedAt: null }
          : { workspace: { memberships: [] }, memberships: [{ role: "editor" as const }] },
    },
    workspaceMembership: {
      findUnique: async () => ({ role: "member" as const, accessState: "confirmed" as const }),
      findMany: async () => [{ role: "member" as const, accessState: "confirmed" as const }],
    },
    projectMembership: {
      findUnique: async () => ({ role: "editor" as const, accessState: "confirmed" as const }),
      findMany: async () => [{ role: "editor" as const, accessState: "confirmed" as const }],
    },
    backgroundJob: {
      findUnique: async () => {
        jobReads += 1;
        return job;
      },
      create: async () => job,
      update: async (_query: { data: Partial<typeof job> }) => {
        jobWrites += 1;
        Object.assign(job, _query.data);
        return job;
      },
      updateMany: async (_query: { data: Partial<typeof job> }) => {
        jobWrites += 1;
        Object.assign(job, _query.data);
        return { count: 1 };
      },
    },
    backgroundJobAttempt: {
      findFirst: async () => attempt,
      findUnique: async () => attempt,
      create: async ({ data }: { data: { id?: string; jobId: string; attemptNumber: number; leaseTokenHash: string; leasedAt: Date; leaseExpiresAt: Date; heartbeatAt: Date } }) => {
        attempt = {
          id: "99999999-9999-4999-8999-999999999999",
          jobId: data.jobId,
          attemptNumber: data.attemptNumber,
          status: "running",
          leaseTokenHash: data.leaseTokenHash,
          leasedAt: data.leasedAt,
          leaseExpiresAt: data.leaseExpiresAt,
          heartbeatAt: data.heartbeatAt,
          dispatchState: "pending",
          safeFailureCode: null,
          completedAt: null,
        };
        return attempt;
      },
      updateMany: async (_query: { data: Partial<NonNullable<typeof attempt>> }) => {
        if (attempt === null) return { count: 0 };
        if ("leaseExpiresAt" in _query.data && !("status" in _query.data)) heartbeatWrites += 1;
        Object.assign(attempt, _query.data);
        return { count: 1 };
      },
    },
    projectGitRepositoryLink: {
      findFirst: async () => {
        linkReads += 1;
        throw new Error("LINK_READ_MUST_NOT_RUN");
      },
    },
    gitRepositorySnapshot: {
      create: async () => {
        snapshotCreates += 1;
        throw new Error("SNAPSHOT_CREATE_MUST_NOT_RUN");
      },
    },
    externalCredential: {
      findUnique: async () => {
        credentialReads += 1;
        throw new Error("CREDENTIAL_READ_MUST_NOT_RUN");
      },
    },
    notification: { upsert: async () => ({}) },
    $executeRaw: async () => 0,
    $transaction: async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(db),
  } as unknown as PrismaClient;

  return {
    db,
    job,
    get attempt() { return attempt; },
    get actorLookups() { return actorLookups; },
    get linkReads() { return linkReads; },
    get snapshotCreates() { return snapshotCreates; },
    get credentialReads() { return credentialReads; },
    get networkCalls() { return networkCalls; },
    get heartbeatWrites() { return heartbeatWrites; },
    get jobReads() { return jobReads; },
    get jobWrites() { return jobWrites; },
  };
}

test("Git repository list enforces current view access before link reads", async () => {
  const viewer = fakeDb({ projectRole: "viewer" });
  assert.deepEqual(await listProjectGitRepositories(PROJECT_ID, actor(), viewer.db), []);
  assert.equal(viewer.linkReads, 0);

  const noMembershipAdmin = fakeDb({ storedRole: "admin" });
  await assert.rejects(
    () => listProjectGitRepositories(PROJECT_ID, actor("admin"), noMembershipAdmin.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(noMembershipAdmin.linkReads, 0);
  assert.equal(noMembershipAdmin.gitMetadataReads, 0);
});

test("Git repository disable enforces edit and active access before writes", async () => {
  const editor = fakeDb({ projectRole: "editor" });
  assert.deepEqual(await disableProjectGitRepository(PROJECT_ID, LINK_ID, actor(), editor.db), { id: LINK_ID });
  assert.equal(editor.linkWrites, 1);

  const viewer = fakeDb({ projectRole: "viewer" });
  await assert.rejects(
    () => disableProjectGitRepository(PROJECT_ID, LINK_ID, actor(), viewer.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(viewer.linkWrites, 0);

  const archived = fakeDb({ projectRole: "editor", archivedAt: new Date("2026-09-04T00:00:00.000Z") });
  await assert.rejects(
    () => disableProjectGitRepository(PROJECT_ID, LINK_ID, actor(), archived.db),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "PROJECT_ARCHIVED",
  );
  assert.equal(archived.linkWrites, 0);
});

test("legacy project Git connect is frozen before metadata for every actor", async () => {
  const fixtures = [
    fakeDb({ storedRole: "user", projectRole: "owner" }),
    fakeDb({ storedRole: "admin" }),
    fakeDb({ storedRole: "admin", projectRole: "owner", archivedAt: new Date("2026-09-04T00:00:00.000Z") }),
    fakeDb({ storedRole: "admin", projectRole: "owner", connectionStatus: "verified" }),
  ];
  for (const [index, fixture] of fixtures.entries()) {
    await assert.rejects(
      () => connectProjectGitRepository(PROJECT_ID, repositoryInput, actor(index === 0 ? "user" : "admin"), fixture.db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_LEGACY_PROJECT_CONNECT_FROZEN",
    );
    assert.equal(fixture.projectLookups, 0);
    assert.equal(fixture.gitMetadataReads, 0);
    assert.equal(fixture.linkReads, 0);
    assert.equal(fixture.linkWrites, 0);
  }
  const mapped = mapApiError(new GitServiceError("GIT_LEGACY_PROJECT_CONNECT_FROZEN"));
  assert.equal(mapped.status, 409);
  assert.match(mapped.body.error.message, /项目仓库连接与同步暂时冻结/u);
});

test("legacy Web GitHub HTTP routes freeze before project or request-body access", async () => {
  const listRoute = await readFile("src/app/api/projects/[projectId]/repositories/route.ts", "utf8");
  const deleteRoute = await readFile("src/app/api/projects/[projectId]/repositories/[linkId]/route.ts", "utf8");
  for (const route of [listRoute, deleteRoute]) {
    assert.match(route, /requireApiSession\(request\)/u);
    assert.match(route, /GITHUB_WEB_PROJECT_CONNECT_FROZEN/u);
    assert.doesNotMatch(route, /readJsonBody|assertProjectActive|connectWebGitHubRepository|getWebGitHubStatus|disableWebGitHubRepository/u);
  }

  const service = await readFile("src/lib/web-github.ts", "utf8");
  const statusStart = service.indexOf("export async function getWebGitHubStatus");
  const statusEnd = service.indexOf("\nexport async function connectWebGitHubRepository", statusStart);
  const disableStart = service.indexOf("export async function disableWebGitHubRepository");
  assert.ok(statusStart >= 0 && statusEnd > statusStart && disableStart >= 0);
  const status = service.slice(statusStart, statusEnd);
  const disable = service.slice(disableStart);
  assert.match(status, /assertWebAiProjectAccess\(actor, projectId, "view"/u);
  assert.match(disable, /assertWebAiProjectAccess\(actor, projectId, "edit"/u);
});

test("Git repository list fails closed for disabled and cross-project actors", async () => {
  const disabled = fakeDb({ storedRole: "admin", disabledAt: new Date("2026-09-04T00:00:00.000Z"), projectRole: "owner" });
  await assert.rejects(
    () => listProjectGitRepositories(PROJECT_ID, actor("admin"), disabled.db),
    hasCode("ACCOUNT_DISABLED"),
  );
  assert.equal(disabled.projectLookups, 0);
  assert.equal(disabled.gitMetadataReads, 0);

  const crossProject = fakeDb({ storedRole: "admin", accessibleProjectId: PROJECT_ID, projectRole: "owner" });
  await assert.rejects(
    () => listProjectGitRepositories(OTHER_PROJECT_ID, actor("admin"), crossProject.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(crossProject.gitMetadataReads, 0);
});

test("Git connect and disable recheck revocation before sensitive work and writes", async () => {
  const disableRevoked = fakeDb({
    projectRole: "editor",
    disabledAtSequence: [null, null, null, null, null, new Date("2026-09-04T00:00:00.000Z")],
  });
  await assert.rejects(
    () => disableProjectGitRepository(PROJECT_ID, LINK_ID, actor(), disableRevoked.db),
    hasErrorCode("ACCOUNT_DISABLED"),
  );
  assert.equal(disableRevoked.linkWrites, 0);
});

test("Git connect remains a side-effect-free frozen boundary", async () => {
  const source = await readFile("src/lib/git/service.ts", "utf8");
  const connectStart = source.indexOf("export async function connectProjectGitRepository");
  const connectEnd = source.indexOf("\nexport async function disableProjectGitRepository", connectStart);
  const connect = source.slice(connectStart, connectEnd);
  assert.match(connect, /GIT_LEGACY_PROJECT_CONNECT_FROZEN/u);
  assert.doesNotMatch(connect, /assertWebAiProjectAccess|gitConnection\.findUnique|loadConnection|probeRepository|\$transaction/u);
});

test("generic Git sync is frozen before project credential admission", async () => {
  const fixture = repositorySyncFixture();
  await assert.rejects(
    () => runGitRepositorySyncJob({
      projectId: PROJECT_ID,
      linkId: LINK_ID,
      requestedBy: actor(),
      clientKey: "git-sync-revoke-test",
    }, fixture.db),
    hasGitCode("GIT_LEGACY_PROJECT_CONNECT_FROZEN"),
  );
  assert.equal(fixture.job.status, "queued");
  assert.equal(fixture.attempt, null);
  assert.equal(fixture.linkReads, 0);
  assert.equal(fixture.snapshotCreates, 0);
  assert.equal(fixture.credentialReads, 0);
  assert.equal(fixture.networkCalls, 0);
  assert.equal(fixture.heartbeatWrites, 0);
  assert.equal(fixture.jobWrites, 0);
});

test("generic Git sync admits before heartbeat/credential/remote and acknowledges known success", async () => {
  const source = await readFile("src/lib/git/service.ts", "utf8");
  const start = source.indexOf("export async function runGitRepositorySyncJob");
  const runner = source.slice(start);
  const admission = runner.indexOf("withProjectJobAccessTransaction");
  const heartbeat = runner.indexOf("heartbeat = startProjectJobHeartbeat");
  const credential = runner.indexOf("syncRepository");
  const acknowledged = runner.indexOf("markProviderAcknowledged");
  const terminal = runner.indexOf("finishProjectJob");
  assert.ok(admission >= 0);
  assert.ok(admission < heartbeat);
  assert.ok(heartbeat < credential);
  assert.ok(credential < acknowledged);
  assert.ok(acknowledged < terminal);
  assert.doesNotMatch(runner, /markProviderDispatched/u);
});

test("direct GitHub jobs admit before heartbeat/client load and rollback pre-dispatch setup failures", async () => {
  const source = await readFile("src/lib/background-jobs.ts", "utf8");
  for (const name of ["runGitHubCodeScanJob", "runGitHubMaterialSyncJob"] as const) {
    const start = source.indexOf(`export async function ${name}`);
    const end = source.indexOf("\nexport async function", start + 1);
    const runner = source.slice(start, end === -1 ? undefined : end);
    const admission = runner.indexOf("await admitDirectGitHubDispatch");
    const heartbeat = runner.indexOf("heartbeat = startProjectJobHeartbeat");
    const client = runner.indexOf("loadProjectGitHubClient");
    assert.ok(admission >= 0, `${name} should use shared dispatch admission`);
    assert.ok(admission < heartbeat, `${name} should start heartbeat after admission`);
    assert.ok(heartbeat < client, `${name} should load the client after heartbeat/admission`);
    assert.doesNotMatch(runner, /markProviderDispatched/u);
  }
  assert.match(source, /markProviderNotDispatched/u);
});
