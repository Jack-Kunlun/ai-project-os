import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AppUserRole, PrismaClient } from "@prisma/client";
import { mapApiError } from "../src/lib/api-errors";
import { listAutoExtractSources, reviewWebAiCandidate, runAutoExtractJob } from "../src/lib/web-auto-extract";
import { listGovernanceOperations, listGovernanceReviews, listGovernanceRouteRevisions } from "../src/lib/project-governance";
import { listProjectJobs } from "../src/lib/background-jobs";
import { runGitHubCodeScanJob, runGitHubMaterialSyncJob } from "../src/lib/background-jobs";
import { cancelProjectJob, reconcileProjectJob } from "../src/lib/project-workflow";
import {
  cancelGitHubProjectSync,
  getProjectGitHubSync,
  prepareGitHubProjectSync,
  reconcileGitHubProjectSync,
  runGitHubProjectSyncJob,
} from "../src/lib/github/project-sync-service";
import { assertWebAiProjectAccess, WebAiAccessError, type WebAiActor } from "../src/lib/web-ai-access";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";
import { searchActiveMemoryForJob } from "../src/lib/web-rag";
import { auditedProviderCall } from "../src/lib/web-ai-governance";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

type FakeProjectSelect = Readonly<{
  id?: boolean;
  workspaceId?: boolean;
  archivedAt?: boolean;
  membershipInheritanceMode?: boolean;
  workspace?: unknown;
  memberships?: unknown;
}>;

type FakeProjectQuery = Readonly<{
  where?: Readonly<{ id?: string }>;
  select?: FakeProjectSelect;
}>;

type FakeOptions = Readonly<{
  storedRole: AppUserRole;
  storedRoleSequence?: readonly AppUserRole[];
  disabledAt?: Date | null;
  disabledAtSequence?: readonly (Date | null | undefined)[];
  accessibleProjectId?: string;
  projectRole?: "owner" | "editor" | "viewer";
  projectRoleSequence?: readonly ("owner" | "editor" | "viewer" | undefined)[];
  archivedAt?: Date | null;
}>;

function fakeDb(options: FakeOptions) {
  let sensitiveCalls = 0;
  let actorLookups = 0;
  const sensitiveRead = async () => {
    sensitiveCalls += 1;
    throw new Error("SENSITIVE_READ_MUST_NOT_RUN");
  };
  const db = {
    appUser: {
      findUnique: async () => {
        actorLookups += 1;
        return {
          id: ACTOR_ID,
          role: options.storedRoleSequence?.[actorLookups - 1] ?? options.storedRole,
          disabledAt: options.disabledAtSequence?.[actorLookups - 1] ?? options.disabledAt ?? null,
        };
      },
    },
    project: {
      count: async () => 1,
      findUnique: async (query: FakeProjectQuery) => {
        if (query.select?.archivedAt === true) return { archivedAt: options.archivedAt ?? null };
        const projectId = query.where?.id;
        const projectRole = options.projectRoleSequence?.[Math.max(0, actorLookups - 1)] ?? options.projectRole;
        const membership = projectId === options.accessibleProjectId && projectRole !== undefined
          ? [{ role: projectRole }]
          : [];
        return { workspace: { memberships: [] }, memberships: membership };
      },
    },
    projectMembership: {
      findMany: async ({ where }: { where?: { projectId?: string } }) => {
        const projectRole = options.projectRoleSequence?.[Math.max(0, actorLookups - 1)] ?? options.projectRole;
        return where?.projectId === options.accessibleProjectId && projectRole !== undefined
          ? [{ role: projectRole, accessState: "confirmed" }]
          : [];
      },
    },
    workspaceMembership: {
      findMany: async () => [],
    },
    projectAiRoute: { findUnique: sensitiveRead },
    projectSource: { findMany: sensitiveRead },
    webAiCandidate: { findMany: sensitiveRead },
    ragAnswer: { findMany: sensitiveRead },
    backgroundJob: { findMany: sensitiveRead, findUnique: sensitiveRead, update: sensitiveRead },
    backgroundJobAttempt: { updateMany: sensitiveRead },
    providerCallAudit: { findMany: sensitiveRead, create: sensitiveRead },
    platformTokenReservation: { findMany: sensitiveRead, create: sensitiveRead },
  } as unknown as PrismaClient;
  return {
    db,
    get sensitiveCalls() {
      return sensitiveCalls;
    },
    get actorLookups() {
      return actorLookups;
    },
  };
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

test("service authorization reloads the stored role and requires admin project membership", async () => {
  const forgedAdmin = { id: ACTOR_ID, role: "admin" } as const satisfies WebAiActor;
  const forgedRoleDb = fakeDb({ storedRole: "user" });
  await assert.rejects(
    () => assertWebAiProjectAccess(forgedAdmin, PROJECT_ID, "view", forgedRoleDb.db),
    hasCode("ACCESS_FORBIDDEN"),
  );

  const adminWithoutMembershipDb = fakeDb({ storedRole: "admin" });
  await assert.rejects(
    () => assertWebAiProjectAccess(forgedAdmin, PROJECT_ID, "view", adminWithoutMembershipDb.db),
    hasCode("ACCESS_FORBIDDEN"),
  );

  const adminDb = fakeDb({ storedRole: "admin", accessibleProjectId: PROJECT_ID, projectRole: "owner" });
  const current = await assertWebAiProjectAccess(forgedAdmin, PROJECT_ID, "edit", adminDb.db);
  assert.deepEqual(current, { id: ACTOR_ID, role: "admin" });
});

test("a second actor check catches disablement or edit-role revocation", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  for (const [label, options, expectedCode] of [
    [
      "disabled",
      {
        storedRole: "user" as const,
        accessibleProjectId: PROJECT_ID,
        projectRoleSequence: ["editor", "editor"] as const,
        disabledAtSequence: [null, new Date("2026-09-04T00:00:00.000Z")] as const,
      },
      "ACCOUNT_DISABLED",
    ],
    [
      "revoked",
      {
        storedRole: "user" as const,
        accessibleProjectId: PROJECT_ID,
        projectRoleSequence: ["editor", "viewer"] as const,
      },
      "ACCESS_FORBIDDEN",
    ],
  ] as const) {
    const fixture = fakeDb(options);
    await assertWebAiProjectAccess(actor, PROJECT_ID, "edit", fixture.db);
    await assert.rejects(
      () => assertWebAiProjectAccess(actor, PROJECT_ID, "edit", fixture.db),
      hasCode(expectedCode),
      label,
    );
    assert.equal(fixture.sensitiveCalls, 0);
  }
});

test("web AI access errors map without a runtime dependency back to project workflow", () => {
  const accessSource = readFileSync(join(process.cwd(), "src/lib/web-ai-access.ts"), "utf8");
  const apiErrorsSource = readFileSync(join(process.cwd(), "src/lib/api-errors.ts"), "utf8");
  assert.doesNotMatch(accessSource, /api-errors/u);
  assert.match(apiErrorsSource, /from "@\/lib\/web-ai-access"/u);
  assert.deepEqual(mapApiError(new WebAiAccessError("ACCESS_FORBIDDEN")), {
    status: 403,
    body: { error: { code: "ACCESS_FORBIDDEN", message: "你没有执行此操作所需的权限" } },
  });
  assert.deepEqual(mapApiError(new WebAiAccessError("ACCOUNT_DISABLED")), {
    status: 403,
    body: { error: { code: "ACCOUNT_DISABLED", message: "账户已停用" } },
  });
});

test("malformed actors fail closed before touching the database", async () => {
  const fixture = fakeDb({ storedRole: "admin" });
  await assert.rejects(
    () => assertWebAiProjectAccess(undefined as unknown as WebAiActor, PROJECT_ID, "view", fixture.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(fixture.sensitiveCalls, 0);
});

test("malformed project IDs fail closed before reloading the actor", async () => {
  const fixture = fakeDb({ storedRole: "admin" });
  await assert.rejects(
    () => assertWebAiProjectAccess({ id: ACTOR_ID, role: "admin" }, "not-a-uuid", "view", fixture.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(fixture.actorLookups, 0);
  assert.equal(fixture.sensitiveCalls, 0);
});

test("viewer reads succeed while editor and owner writes pass the service guard", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  const viewer = fakeDb({ storedRole: "user", accessibleProjectId: PROJECT_ID, projectRole: "viewer" });
  assert.deepEqual(await assertWebAiProjectAccess(actor, PROJECT_ID, "view", viewer.db), actor);

  for (const projectRole of ["editor", "owner"] as const) {
    const fixture = fakeDb({ storedRole: "user", accessibleProjectId: PROJECT_ID, projectRole });
    assert.deepEqual(await assertWebAiProjectAccess(actor, PROJECT_ID, "edit", fixture.db), actor);
  }
});

test("disabled actors fail closed before project or sensitive reads", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  const fixture = fakeDb({ storedRole: "user", disabledAt: new Date("2026-09-04T00:00:00.000Z") });
  await assert.rejects(
    () => listAutoExtractSources(PROJECT_ID, actor, fixture.db),
    hasCode("ACCOUNT_DISABLED"),
  );
  assert.equal(fixture.sensitiveCalls, 0);
});

test("non-members and cross-project reads are denied before project content queries", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  const nonMember = fakeDb({ storedRole: "user" });
  await assert.rejects(
    () => listAutoExtractSources(PROJECT_ID, actor, nonMember.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(nonMember.sensitiveCalls, 0);

  const crossProject = fakeDb({ storedRole: "user", accessibleProjectId: PROJECT_ID, projectRole: "viewer" });
  await assert.rejects(
    () => listAutoExtractSources(OTHER_PROJECT_ID, actor, crossProject.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(crossProject.sensitiveCalls, 0);
});

test("governance and job list services authorize before their queries", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  const fixture = fakeDb({ storedRole: "user" });
  const calls = [
    () => listGovernanceReviews(PROJECT_ID, actor, {}, fixture.db),
    () => listGovernanceOperations(PROJECT_ID, actor, {}, fixture.db),
    () => listGovernanceRouteRevisions(PROJECT_ID, actor, {}, fixture.db),
    () => listProjectJobs(PROJECT_ID, actor, fixture.db),
  ];
  for (const call of calls) await assert.rejects(call, hasCode("ACCESS_FORBIDDEN"));
  assert.equal(fixture.actorLookups, calls.length);
  assert.equal(fixture.sensitiveCalls, 0);
});

test("active memory job search authorizes before progress, audit, or reservation work", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  const fixture = fakeDb({ storedRole: "user" });
  await assert.rejects(
    () => searchActiveMemoryForJob({
      projectId: PROJECT_ID,
      jobId: PROJECT_ID,
      actor,
      attempt: {} as never,
      question: "状态",
      route: {} as never,
      index: {} as never,
    }, fixture.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(fixture.sensitiveCalls, 0);
});

test("generic job mutations deny non-members and viewers before job reads or writes", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  for (const options of [
    { storedRole: "user" as const },
    { storedRole: "user" as const, accessibleProjectId: PROJECT_ID, projectRole: "viewer" as const },
  ]) {
    const fixture = fakeDb(options);
    await assert.rejects(
      () => reconcileProjectJob(PROJECT_ID, PROJECT_ID, actor, fixture.db),
      hasCode("ACCESS_FORBIDDEN"),
    );
    await assert.rejects(
      () => cancelProjectJob(PROJECT_ID, PROJECT_ID, actor, fixture.db),
      hasCode("ACCESS_FORBIDDEN"),
    );
    assert.equal(fixture.sensitiveCalls, 0);
  }
});

test("GitHub job services enforce current actor access before job or GitHub work", async () => {
  const cases = [
    {
      name: "viewer",
      actor: { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor,
      options: { storedRole: "user" as const, accessibleProjectId: PROJECT_ID, projectRole: "viewer" as const },
      projectId: PROJECT_ID,
      expectedCode: "ACCESS_FORBIDDEN",
    },
    {
      name: "disabled",
      actor: { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor,
      options: { storedRole: "user" as const, disabledAt: new Date("2026-09-04T00:00:00.000Z") },
      projectId: PROJECT_ID,
      expectedCode: "ACCOUNT_DISABLED",
    },
    {
      name: "non-member",
      actor: { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor,
      options: { storedRole: "user" as const },
      projectId: PROJECT_ID,
      expectedCode: "ACCESS_FORBIDDEN",
    },
    {
      name: "cross-project",
      actor: { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor,
      options: { storedRole: "user" as const, accessibleProjectId: OTHER_PROJECT_ID, projectRole: "editor" as const },
      projectId: PROJECT_ID,
      expectedCode: "ACCESS_FORBIDDEN",
    },
    {
      name: "forged-admin-role",
      actor: { id: ACTOR_ID, role: "admin" } as const satisfies WebAiActor,
      options: { storedRole: "user" as const, accessibleProjectId: OTHER_PROJECT_ID, projectRole: "editor" as const },
      projectId: PROJECT_ID,
      expectedCode: "ACCESS_FORBIDDEN",
    },
    {
      name: "archived",
      actor: { id: ACTOR_ID, role: "admin" } as const satisfies WebAiActor,
      options: { storedRole: "admin" as const, accessibleProjectId: PROJECT_ID, projectRole: "owner" as const, archivedAt: new Date("2026-09-04T00:00:00.000Z") },
      projectId: PROJECT_ID,
      expectedCode: "PROJECT_ARCHIVED",
    },
  ] as const;

  for (const scenario of cases) {
    const fixture = fakeDb(scenario.options);
    const actor = scenario.actor;
    const calls: Array<() => Promise<unknown>> = [
      () => runGitHubCodeScanJob({ projectId: scenario.projectId, requestedBy: actor, clientKey: `${scenario.name}-code` }, fixture.db),
      () => runGitHubMaterialSyncJob({ projectId: scenario.projectId, linkId: ACTOR_ID, requestedBy: actor, clientKey: `${scenario.name}-material` }, fixture.db),
      () => prepareGitHubProjectSync({ projectId: scenario.projectId, requestedBy: actor, clientKey: `${scenario.name}-project` }, fixture.db),
      () => runGitHubProjectSyncJob({ projectId: scenario.projectId, requestedBy: actor, clientKey: `${scenario.name}-runner` }, fixture.db),
      () => reconcileGitHubProjectSync({ projectId: scenario.projectId, jobId: PROJECT_ID, actor }, fixture.db),
      () => cancelGitHubProjectSync({ projectId: scenario.projectId, jobId: PROJECT_ID, actor }, fixture.db),
    ];
    if (scenario.name !== "viewer" && scenario.name !== "archived") {
      calls.push(() => getProjectGitHubSync({ projectId: scenario.projectId, syncRunId: PROJECT_ID }, actor, fixture.db));
    }
    for (const call of calls) await assert.rejects(call, hasCode(scenario.expectedCode));
    assert.equal(fixture.sensitiveCalls, 0, `${scenario.name} touched a sensitive GitHub/job query`);
  }
});

test("viewer cannot create a web AI job and the guard runs before route/source reads", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  const fixture = fakeDb({ storedRole: "user", accessibleProjectId: PROJECT_ID, projectRole: "viewer" });
  await assert.rejects(
    () => runAutoExtractJob({
      projectId: PROJECT_ID,
      requestedBy: actor,
      clientKey: "viewer-denied",
      consent,
      request: {},
    }, fixture.db),
    hasCode("ACCESS_FORBIDDEN"),
  );
  assert.equal(fixture.sensitiveCalls, 0);
});

test("archived projects reject model work after access but before route reads", async () => {
  const actor = { id: ACTOR_ID, role: "admin" } as const satisfies WebAiActor;
  const fixture = fakeDb({ storedRole: "admin", accessibleProjectId: PROJECT_ID, projectRole: "owner", archivedAt: new Date("2026-09-04T00:00:00.000Z") });
  await assert.rejects(
    () => runAutoExtractJob({
      projectId: PROJECT_ID,
      requestedBy: actor,
      clientKey: "archived-denied",
      consent,
      request: {},
    }, fixture.db),
    hasCode("PROJECT_ARCHIVED"),
  );
  assert.equal(fixture.sensitiveCalls, 0);
});

test("candidate review persists the verified actor id rather than caller-provided text", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/web-auto-extract.ts"), "utf8");
  assert.match(source, /reviewedBy: currentActor\.id/u);
  assert.match(source, /actorId: currentActor\.id/u);
  assert.doesNotMatch(source, /input\.reviewedBy/u);
});

test("legacy candidate review repeats authorization inside the write transaction", async () => {
  for (const action of ["accept", "dismiss"] as const) {
    let actorLookups = 0;
    let membershipLookups = 0;
    let sensitiveCalls = 0;
    const sensitiveRead = async () => {
      sensitiveCalls += 1;
      throw new Error("SENSITIVE_REVIEW_WRITE_MUST_NOT_RUN");
    };
    const appUser = {
      findUnique: async () => {
        actorLookups += 1;
        return { id: ACTOR_ID, role: "user" as const, disabledAt: null };
      },
    };
    const project = {
      findUnique: async (query: FakeProjectQuery) => {
        if (query.select?.archivedAt === true && query.select.id !== true) return { archivedAt: null };
        if (query.select?.id === true && query.select.workspaceId === true && query.select.membershipInheritanceMode !== true) {
          return { id: PROJECT_ID, workspaceId: WORKSPACE_ID };
        }
        if (query.select?.membershipInheritanceMode === true && query.select.workspace === undefined && query.select.memberships === undefined) {
          return { id: PROJECT_ID, workspaceId: WORKSPACE_ID, archivedAt: null, membershipInheritanceMode: "projectOnly" as const };
        }
        return { membershipInheritanceMode: "projectOnly" as const, workspace: { memberships: [] }, memberships: [{ role: "editor" as const, accessState: "confirmed" as const }] };
      },
      count: async () => 1,
    };
    const workspaceMembership = { findUnique: async () => null, findMany: async () => [] };
    const projectMembership = {
      findUnique: async () => ({ role: "editor" as const, accessState: "confirmed" as const }),
      findMany: async () => [{ role: "editor" as const, accessState: "confirmed" as const }],
    };
    const txProjectMembership = {
      findUnique: async () => {
        membershipLookups += 1;
        return null;
      },
      findMany: async () => {
        membershipLookups += 1;
        return [];
      },
    };
    const tx = {
      appUser,
      project,
      workspaceMembership,
      projectMembership: txProjectMembership,
      $executeRaw: async () => 0,
      webAiCandidate: { findFirst: sensitiveRead },
      projectItem: { updateMany: sensitiveRead },
    };
    const db = {
      appUser,
      project,
      workspaceMembership,
      projectMembership,
      $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as PrismaClient;

    await assert.rejects(
      () => reviewWebAiCandidate({
        projectId: PROJECT_ID,
        candidateId: ACTOR_ID,
        action,
        expectedItemUpdatedAt: new Date("2026-09-04T00:00:00.000Z"),
        actor: { id: ACTOR_ID, role: "user" },
      }, db),
      hasCode("ACCESS_FORBIDDEN"),
      action,
    );
    assert.equal(actorLookups, 2, `${action} reloads actor inside transaction`);
    assert.equal(membershipLookups, 1, `${action} reloads membership inside transaction`);
    assert.equal(sensitiveCalls, 0, `${action} touched candidate data after revoke`);
  }
});

test("legacy web candidate route delegates access and lifecycle checks to its service", () => {
  const source = readFileSync(
    join(process.cwd(), "src/app/api/projects/[projectId]/memory/candidates/[candidateId]/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /assertProjectActive/u);
  assert.match(source, /reviewWebAiCandidate/u);
  assert.match(source, /actor:\s*user/u);
});

test("actor-aware Web AI routes delegate lifecycle checks to their services", () => {
  const routePaths = [
    "src/app/api/projects/[projectId]/memory/extract/route.ts",
    "src/app/api/projects/[projectId]/memory/search/route.ts",
    "src/app/api/projects/[projectId]/memory/index/route.ts",
    "src/app/api/projects/[projectId]/memory/answers/route.ts",
    "src/app/api/projects/[projectId]/intelligence/brief/route.ts",
    "src/app/api/projects/[projectId]/intelligence/agent/route.ts",
    "src/app/api/projects/[projectId]/assets/[assetId]/recognize/route.ts",
    "src/app/api/projects/[projectId]/repositories/scan/route.ts",
    "src/app/api/projects/[projectId]/repositories/materials/route.ts",
    "src/app/api/projects/[projectId]/repositories/sync/route.ts",
    "src/app/api/projects/[projectId]/jobs/[jobId]/route.ts",
  ] as const;
  for (const routePath of routePaths) {
    const source = readFileSync(join(process.cwd(), routePath), "utf8");
    assert.doesNotMatch(source, /assertProjectActive/u, routePath);
    assert.match(source, /requireApiSession/u, routePath);
    assert.match(source, /(?:actor:\s*user|requestedBy:\s*user|,\s*user\))/u, routePath);
  }
});

test("governance transport binds the current actor to the same project job", async () => {
  const actor = { id: ACTOR_ID, role: "user" } as const satisfies WebAiActor;
  let providerCalls = 0;
  let auditCreates = 0;
  let jobIdentity = { projectId: OTHER_PROJECT_ID, requestedById: ACTOR_ID };
  const db = {
    appUser: {
      findUnique: async () => ({ id: ACTOR_ID, role: "user" as const, disabledAt: null }),
    },
    project: {
      findUnique: async (query: FakeProjectQuery) => query.select?.archivedAt === true
        ? { archivedAt: null }
        : { workspace: { memberships: [] }, memberships: [{ role: "editor" as const }] },
      count: async () => 1,
    },
    projectMembership: { findMany: async () => [] },
    workspaceMembership: { findMany: async () => [] },
    backgroundJob: {
      findUnique: async () => jobIdentity,
    },
    providerCallAudit: {
      create: async () => {
        auditCreates += 1;
        throw new Error("AUDIT_MUST_NOT_RUN");
      },
    },
  } as unknown as PrismaClient;
  for (const mismatch of [
    { projectId: OTHER_PROJECT_ID, requestedById: ACTOR_ID },
    { projectId: PROJECT_ID, requestedById: OTHER_PROJECT_ID },
  ]) {
    jobIdentity = mismatch;
    await assert.rejects(
      () => auditedProviderCall({
        jobId: PROJECT_ID,
        attempt: {} as never,
        actor,
        route: { projectId: PROJECT_ID, operation: "autoExtract" } as never,
        callKey: "governance-mismatch-call",
        call: async () => {
          providerCalls += 1;
          throw new Error("PROVIDER_MUST_NOT_RUN");
        },
      }, db),
      hasCode("ACCESS_FORBIDDEN"),
    );
  }
  assert.equal(providerCalls, 0);
  assert.equal(auditCreates, 0);
});

test("all Web AI provider transports carry a request actor and vision guards before blob reads", () => {
  const governanceSource = readFileSync(join(process.cwd(), "src/lib/web-ai-governance.ts"), "utf8");
  assert.match(governanceSource, /requestedBy:\s*WebAiActor/u);
  assert.match(governanceSource, /actor:\s*WebAiActor/u);
  assert.match(
    governanceSource,
    /createGrantedWebAiJob[\s\S]+withWebAiProjectAccessTransaction[\s\S]+const transactionActor = admission\.actor[\s\S]+backgroundJob\.findUnique/u,
  );
  assert.match(
    governanceSource,
    /createSupplementalWebAiGrant[\s\S]+withWebAiProjectAccessTransaction[\s\S]+const currentActor = admission\.actor[\s\S]+backgroundJob\.findUnique[\s\S]+const billing = await assertAiOutboundEntitlement/u,
  );
  assert.match(governanceSource, /const currentActor = await assertWebAiProjectAccess\(input\.actor, input\.route\.projectId, "edit", db\)/u);
  assert.match(
    governanceSource,
    /requestedJob\.projectId !== input\.route\.projectId\s*\|\|\s*requestedJob\.requestedById !== currentActor\.id/u,
  );
  assert.match(governanceSource, /withProjectJobAccessTransaction\([\s\S]+markDispatched: true[\s\S]+providerCallAudit/u);

  const callerPaths = [
    "src/lib/web-auto-extract.ts",
    "src/lib/web-rag.ts",
    "src/lib/web-memory-index.ts",
    "src/lib/web-project-intelligence.ts",
    "src/lib/project-assets/vision.ts",
  ] as const;
  for (const callerPath of callerPaths) {
    const source = readFileSync(join(process.cwd(), callerPath), "utf8");
    const calls = [...source.matchAll(/auditedProviderCall\(\{([\s\S]*?)\n\s*\}, db\)/gu)];
    assert.ok(calls.length > 0, `${callerPath} has no audited provider call`);
    for (const call of calls) assert.match(call[1]!, /actor:/u, `${callerPath} has an actorless transport`);
  }

  const visionSource = readFileSync(join(process.cwd(), "src/lib/project-assets/vision.ts"), "utf8");
  const blobIndex = visionSource.indexOf("readAssetBlob(");
  const postClaimGuardIndex = visionSource.indexOf("withWebAiProjectAccessTransaction");
  assert.ok(postClaimGuardIndex >= 0 && postClaimGuardIndex < blobIndex);
});
