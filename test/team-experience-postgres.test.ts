import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getDb } from "../src/lib/db";
import { AccessControlError, type AccessUser } from "../src/lib/access-control";
import { ACCESS_ACTOR_LOCK_NAMESPACE, lockActorsAccess, lockProjectAccess, lockWorkspaceAccess } from "../src/lib/access-linearization";
import {
  grantProjectMembership,
  grantWorkspaceMembership,
  revokeProjectMembership,
  revokeWorkspaceMembership,
} from "../src/lib/membership-governance";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import { getTeamActivity, getTeamOverview, getTeamPermissions, listTeams } from "../src/lib/team-service";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";

const shouldRun = process.env.TEAM_EXPERIENCE_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_team_experience_test";
const gateUser = "ai_project_os_gate";

test("personal workspace team controls admit owners and admins but reject ordinary collaborators", { skip: !shouldRun ? "TEAM_EXPERIENCE_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  try {
    const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(db);
    await db.workspace.update({ where: { id: workspaceId }, data: { slug: `user-${ownerId}` } });
    const actor: AccessUser = { id: ownerId, role: "user", accountAccessVersion: 1 };
    const [overview, permissions, teams] = await Promise.all([
      getTeamOverview(actor, workspaceId, db),
      getTeamPermissions(actor, workspaceId, db),
      listTeams(actor, db),
    ]);
    assert.equal(overview.role, "owner");
    assert.equal(overview.workspace.id, workspaceId);
    assert.equal(permissions.role, "owner");
    assert.equal(teams.some((team) => team.workspace.id === workspaceId), false);
    const collaboratorId = randomUUID();
    const adminId = randomUUID();
    await db.appUser.createMany({ data: [
      { id: collaboratorId, username: `personal_collaborator_${collaboratorId.slice(0, 8)}`, role: "user" },
      { id: adminId, username: `personal_admin_${adminId.slice(0, 8)}`, role: "user" },
    ] });
    await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [ownerId, collaboratorId, adminId]);
      await lockWorkspaceAccess(tx, workspaceId);
      await grantWorkspaceMembership(tx, { workspaceId, userId: collaboratorId, role: "member", actorId: ownerId, reason: "personal_team_collaborator_test" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "admin", actorId: ownerId, reason: "personal_team_admin_test" });
    });
    await assert.rejects(
      () => getTeamOverview({ id: collaboratorId, role: "user", accountAccessVersion: 1 }, workspaceId, db),
      (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
    );
    const adminOverview = await getTeamOverview({ id: adminId, role: "user", accountAccessVersion: 1 }, workspaceId, db);
    assert.equal(adminOverview.role, "admin");
  } finally { await db.$disconnect(); }
});

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("TEAM_EXPERIENCE_TEST_DATABASE_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("TEAM_EXPERIENCE_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== gateUser
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("TEAM_EXPERIENCE_TEST_DATABASE_URL_INVALID");
}

type TeamFixture = Readonly<{
  actor: AccessUser;
  owner: AccessUser;
  workspaceId: string;
  visibleProjectId: string;
  privateProjectId: string;
  privateProjectName: string;
}>;

async function createTeamFixture(db: ReturnType<typeof getDb>, suffix: string): Promise<TeamFixture> {
  const actorId = randomUUID();
  const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(db);
  const visibleProjectId = randomUUID();
  const privateProjectId = randomUUID();
  const privateProjectName = `Private team project ${suffix}`;
  await db.appUser.create({ data: { id: actorId, username: `team_reader_${suffix}`, role: "user" } });
  await db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [ownerId, actorId]);
    await lockWorkspaceAccess(tx, workspaceId);
    await grantWorkspaceMembership(tx, { workspaceId, userId: actorId, role: "member", actorId: ownerId, reason: "team_experience_fixture_member" });
  });
  await db.project.createMany({
    data: [
      { id: visibleProjectId, workspaceId, name: `Visible team project ${suffix}`, slug: `visible-team-project-${suffix}`, membershipInheritanceMode: "projectOnly" },
      { id: privateProjectId, workspaceId, name: privateProjectName, slug: `private-team-project-${suffix}`, membershipInheritanceMode: "projectOnly" },
    ],
  });
  await db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [ownerId, actorId]);
    await lockWorkspaceAccess(tx, workspaceId);
    await lockProjectAccess(tx, visibleProjectId);
    await lockProjectAccess(tx, privateProjectId);
    await grantProjectMembership(tx, { projectId: visibleProjectId, workspaceId, userId: actorId, role: "viewer", actorId: ownerId, reason: "team_experience_fixture_visible_project" });
    await grantProjectMembership(tx, { projectId: privateProjectId, workspaceId, userId: actorId, role: "viewer", actorId: ownerId, reason: "team_experience_fixture_private_project" });
  });
  await db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [ownerId, actorId]);
    await lockWorkspaceAccess(tx, workspaceId);
    await lockProjectAccess(tx, privateProjectId);
    await revokeProjectMembership(tx, privateProjectId, actorId, workspaceId, { actorId: ownerId, reason: "team_experience_fixture_private_project_revoked" });
  });
  return {
    actor: { id: actorId, role: "user", accountAccessVersion: 1 },
    owner: { id: ownerId, role: "user", accountAccessVersion: 1 },
    workspaceId,
    visibleProjectId,
    privateProjectId,
    privateProjectName,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runWriterFirst<T>(
  writer: (holdBeforeCommit: () => Promise<void>) => Promise<unknown>,
  reader: () => Promise<T>,
): Promise<Readonly<{ writer: { ok: boolean; error?: unknown }; reader: { ok: boolean; value?: T; error?: unknown } }>> {
  let writerReady!: () => void;
  const writerPrepared = new Promise<void>((resolve) => { writerReady = resolve; });
  let releaseWriter!: () => void;
  const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let writerFinished = false;
  const writerPromise = writer(async () => {
    writerReady();
    await writerRelease;
  }).then(
    () => { writerFinished = true; return { ok: true as const }; },
    (error: unknown) => { writerFinished = true; return { ok: false as const, error }; },
  );
  await waitForSignal(writerPrepared, "team_writer_prepare");
  let readerFinished = false;
  const readerPromise = reader().then(
    (value) => { readerFinished = true; return { ok: true as const, value }; },
    (error: unknown) => { readerFinished = true; return { ok: false as const, error }; },
  );
  await delay(80);
  const writerWasPending = !writerFinished;
  const readerWasPending = !readerFinished;
  releaseWriter();
  const [writerResult, readerResult] = await Promise.all([writerPromise, readerPromise]);
  assert.equal(writerWasPending, true, "writer must remain uncommitted until the latch is released");
  assert.equal(readerWasPending, true, "reader must wait on the uncommitted writer lock");
  return { writer: writerResult, reader: readerResult };
}

async function runCommittedWriter<T>(
  writer: () => Promise<unknown>,
  reader: () => Promise<T>,
): Promise<Readonly<{ writer: { ok: boolean; error?: unknown }; reader: { ok: boolean; value?: T; error?: unknown } }>> {
  const writerResult = await writer().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const readerResult = await reader().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { writer: writerResult, reader: readerResult };
}

function isActorAccessLockQuery(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const values = (value as { values?: unknown }).values;
  return Array.isArray(values) && values.includes(ACCESS_ACTOR_LOCK_NAMESPACE);
}

function gateTeamReadAfterActorLock(
  db: ReturnType<typeof getDb>,
  onActorLock: () => Promise<void>,
): ReturnType<typeof getDb> {
  let actorLockObserved = false;
  const transaction = db.$transaction.bind(db) as unknown as (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: unknown,
  ) => Promise<unknown>;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => transaction(async (tx) => {
        const gatedTx = new Proxy(tx, {
          get(txTarget, txProperty) {
            if (txProperty !== "$executeRaw") return Reflect.get(txTarget, txProperty, txTarget);
            const executeRaw = txTarget.$executeRaw.bind(txTarget) as unknown as (...args: readonly unknown[]) => Promise<number>;
            return async (...args: readonly unknown[]) => {
              const result = await executeRaw(...args);
              if (!actorLockObserved && isActorAccessLockQuery(args[0])) {
                actorLockObserved = true;
                await onActorLock();
              }
              return result;
            };
          },
        });
        return callback(gatedTx as Prisma.TransactionClient);
      }, options);
    },
  }) as ReturnType<typeof getDb>;
}

async function waitForSignal(signal: Promise<void>, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), 3_000);
    signal.then(
      () => { clearTimeout(timer); resolve(); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function createPrivateAuditHistory(
  db: ReturnType<typeof getDb>,
  fixture: TeamFixture,
  count: number,
): Promise<readonly string[]> {
  const projects = Array.from({ length: count }, () => {
    const id = randomUUID();
    return { id, workspaceId: fixture.workspaceId, name: `Private history project ${id.slice(0, 8)}`, slug: `private-history-project-${id}` };
  });
  const projectIds = projects.map((project) => project.id).sort();
  await db.project.createMany({ data: projects.map((project) => ({ ...project, membershipInheritanceMode: "projectOnly" as const })) });
  await db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [fixture.owner.id, fixture.actor.id]);
    await lockWorkspaceAccess(tx, fixture.workspaceId);
    for (const projectId of projectIds) await lockProjectAccess(tx, projectId);
    for (const projectId of projectIds) {
      await grantProjectMembership(tx, { projectId, workspaceId: fixture.workspaceId, userId: fixture.actor.id, role: "viewer", actorId: fixture.owner.id, reason: "team activity pagination private grant" });
    }
  });
  await db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [fixture.owner.id, fixture.actor.id]);
    await lockWorkspaceAccess(tx, fixture.workspaceId);
    for (const projectId of projectIds) await lockProjectAccess(tx, projectId);
    for (const projectId of projectIds) {
      await revokeProjectMembership(tx, projectId, fixture.actor.id, fixture.workspaceId, { actorId: fixture.owner.id, reason: "team activity pagination private revoke" });
    }
  });
  return projectIds;
}

test("team activity omits inaccessible project audit history", { skip: !shouldRun ? "TEAM_EXPERIENCE_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const fixture = await createTeamFixture(db, randomUUID().slice(0, 8));
  const privateAuditIds = (await db.membershipAccessAudit.findMany({ where: { workspaceId: fixture.workspaceId, projectId: fixture.privateProjectId }, select: { id: true } })).map((row) => row.id);
  const activity = await getTeamActivity(fixture.actor, fixture.workspaceId, 50, db);
  const returnedIds = new Set(activity.activity.map((entry) => entry.id));
  assert.equal(privateAuditIds.some((id) => returnedIds.has(id)), false);
  assert.equal(JSON.stringify(activity).includes(fixture.privateProjectName), false);
  assert.equal(activity.activity.some((entry) => entry.project?.id === fixture.visibleProjectId), true);
});

test("team activity filters private project audits before the page window", { skip: !shouldRun ? "TEAM_EXPERIENCE_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const fixture = await createTeamFixture(db, randomUUID().slice(0, 8));
  const privateProjectIds = await createPrivateAuditHistory(db, fixture, 30);
  const visibleAudit = await db.membershipAccessAudit.findFirstOrThrow({
    where: { workspaceId: fixture.workspaceId, projectId: fixture.visibleProjectId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const activity = await getTeamActivity(fixture.actor, fixture.workspaceId, 1, db);
  assert.equal(activity.activity.length, 1);
  assert.equal(activity.activity[0]?.id, visibleAudit.id);
  assert.equal(activity.activity[0]?.project?.id, fixture.visibleProjectId);
  assert.equal(privateProjectIds.some((projectId) => activity.activity.some((entry) => entry.project?.id === projectId)), false);
  assert.equal(JSON.stringify(activity).includes("Private history project"), false);
});

test("team overview rejects a disabled account after account disable", { skip: !shouldRun ? "TEAM_EXPERIENCE_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const fixture = await createTeamFixture(db, suffix);
  const adminId = randomUUID();
  await db.appUser.create({ data: { id: adminId, username: `team_access_admin_${suffix}`, role: "admin" } });
  const preview = await previewAccountAccess({ adminUserId: adminId, adminAccountAccessVersion: 1, userId: fixture.actor.id, action: "disable", reason: "team access race test", expectedVersion: 1 }, db);
  const executeInput = {
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: fixture.actor.id,
    action: preview.action,
    reason: "team access race test",
    expectedVersion: preview.current.accountAccessVersion,
    expectedImpactFingerprint: preview.impactFingerprint,
    requestKey: `team-access-race-${suffix}`,
    requestFingerprint: preview.requestFingerprint,
    previewId: preview.previewId,
    previewIssuedAt: preview.previewIssuedAt,
    previewExpiresAt: preview.previewExpiresAt,
    confirmation: true as const,
    confirmationUsername: preview.user.username,
  };
  const race = await runCommittedWriter(() => executeAccountAccess(executeInput, db), () => getTeamOverview(fixture.actor, fixture.workspaceId, db));
  assert.equal(race.writer.ok, true);
  assert.equal(race.reader.ok, false);
  assert.ok(race.reader.error instanceof AccessControlError && race.reader.error.code === "ACCOUNT_DISABLED");
  await assert.rejects(() => getTeamOverview(fixture.actor, fixture.workspaceId, db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCOUNT_DISABLED");
});

test("team overview linearizes workspace membership revoke", { skip: !shouldRun ? "TEAM_EXPERIENCE_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const fixture = await createTeamFixture(db, randomUUID().slice(0, 8));
  const race = await runWriterFirst(async (holdBeforeCommit) => {
    await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [fixture.owner.id, fixture.actor.id]);
      await lockWorkspaceAccess(tx, fixture.workspaceId);
      await revokeWorkspaceMembership(tx, fixture.workspaceId, fixture.actor.id, { actorId: fixture.owner.id, reason: "team workspace revoke race test" });
      await holdBeforeCommit();
    });
  }, () => getTeamOverview(fixture.actor, fixture.workspaceId, db));
  assert.equal(race.writer.ok, true);
  assert.equal(race.reader.ok, false);
  assert.ok(race.reader.error instanceof AccessControlError && race.reader.error.code === "ACCESS_FORBIDDEN");
  await assert.rejects(() => getTeamOverview(fixture.actor, fixture.workspaceId, db), (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN");
});

test("team permissions linearize project grant revoke", { skip: !shouldRun ? "TEAM_EXPERIENCE_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const fixture = await createTeamFixture(db, randomUUID().slice(0, 8));
  const race = await runWriterFirst(async (holdBeforeCommit) => {
    await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [fixture.owner.id, fixture.actor.id]);
      await lockWorkspaceAccess(tx, fixture.workspaceId);
      await lockProjectAccess(tx, fixture.visibleProjectId);
      await revokeProjectMembership(tx, fixture.visibleProjectId, fixture.actor.id, fixture.workspaceId, { actorId: fixture.owner.id, reason: "team project revoke race test" });
      await holdBeforeCommit();
    });
  }, () => getTeamPermissions(fixture.actor, fixture.workspaceId, db));
  assert.equal(race.writer.ok, true);
  assert.equal(race.reader.ok, true);
  const finalPermissions = await getTeamPermissions(fixture.actor, fixture.workspaceId, db);
  assert.equal(finalPermissions.projects.some((entry) => entry.project.id === fixture.visibleProjectId), false);
});

test("team list linearizes project grant revoke", { skip: !shouldRun ? "TEAM_EXPERIENCE_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const fixture = await createTeamFixture(db, randomUUID().slice(0, 8));
  const race = await runWriterFirst(async (holdBeforeCommit) => {
    await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [fixture.owner.id, fixture.actor.id]);
      await lockWorkspaceAccess(tx, fixture.workspaceId);
      await lockProjectAccess(tx, fixture.visibleProjectId);
      await revokeProjectMembership(tx, fixture.visibleProjectId, fixture.actor.id, fixture.workspaceId, { actorId: fixture.owner.id, reason: "team project list revoke race test" });
      await holdBeforeCommit();
    });
  }, () => listTeams(fixture.actor, db));
  assert.equal(race.writer.ok, true);
  assert.equal(race.reader.ok, true);
  const finalTeams = await listTeams(fixture.actor, db);
  assert.equal(finalTeams.find((team) => team.workspace.id === fixture.workspaceId)?.counts.projects, 0);
});

test("team activity read lock linearizes before project grant revoke", { skip: !shouldRun ? "TEAM_EXPERIENCE_POSTGRES_GATE=1 is required" : false }, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const fixture = await createTeamFixture(db, randomUUID().slice(0, 8));
  let actorLock!: () => void;
  const actorLocked = new Promise<void>((resolve) => { actorLock = resolve; });
  let releaseReader!: () => void;
  const readerRelease = new Promise<void>((resolve) => { releaseReader = resolve; });
  const gatedDb = gateTeamReadAfterActorLock(db, async () => {
    actorLock();
    await readerRelease;
  });
  const readerPromise = getTeamActivity(fixture.actor, fixture.workspaceId, 50, gatedDb);
  await waitForSignal(actorLocked, "team_activity_actor_lock");
  let writerFinished = false;
  const writerPromise = db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [fixture.owner.id, fixture.actor.id]);
    await lockWorkspaceAccess(tx, fixture.workspaceId);
    await lockProjectAccess(tx, fixture.visibleProjectId);
    await revokeProjectMembership(tx, fixture.visibleProjectId, fixture.actor.id, fixture.workspaceId, { actorId: fixture.owner.id, reason: "team activity read lock race test" });
  }).then(
    () => { writerFinished = true; },
    (error: unknown) => { writerFinished = true; throw error; },
  );
  await delay(80);
  assert.equal(writerFinished, false);
  releaseReader();
  const reader = await readerPromise;
  assert.equal(reader.activity.some((entry) => entry.project?.id === fixture.visibleProjectId), true);
  await writerPromise;
  const afterRevoke = await getTeamActivity(fixture.actor, fixture.workspaceId, 50, db);
  assert.equal(afterRevoke.activity.some((entry) => entry.project?.id === fixture.visibleProjectId), false);
});
