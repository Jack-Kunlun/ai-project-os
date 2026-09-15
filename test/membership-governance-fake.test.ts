import assert from "node:assert/strict";
import test from "node:test";
import {
  MembershipAccessAuditMembershipKind,
  MembershipAccessState,
  Prisma,
} from "@prisma/client";
import {
  appendProjectMembershipAudit,
  appendWorkspaceMembershipAudit,
  assertMembershipAccessTransition,
  buildConfirmedProjectMembershipWhere,
  buildConfirmedWorkspaceMembershipWhere,
  findConfirmedProjectMembership,
  findConfirmedWorkspaceMembership,
  findCurrentProjectMembership,
  findCurrentWorkspaceMembership,
  grantProjectMembership,
  grantWorkspaceMembership,
  hasRevokedProjectMembership,
  hasRevokedWorkspaceMembership,
  MembershipGovernanceError,
  membershipFingerprint,
  membershipManifestFingerprint,
  revokeProjectMembership,
  revokeWorkspaceMembership,
  transitionMembershipAccessState,
} from "../src/lib/membership-governance";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000101";
const PROJECT_ID = "00000000-0000-4000-8000-000000000102";
const USER_ID = "00000000-0000-4000-8000-000000000103";
const ACTOR_ID = "00000000-0000-4000-8000-000000000104";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000105";
const PENDING_WORKSPACE_ID = "00000000-0000-4000-8000-000000000106";
const PENDING_PROJECT_ID = "00000000-0000-4000-8000-000000000107";

type WorkspaceRow = {
  id: string;
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  accessState: MembershipAccessState;
  createdAt: Date;
  updatedAt: Date;
};

type ProjectRow = {
  id: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
  accessState: MembershipAccessState;
  createdAt: Date;
  updatedAt: Date;
};

function fakeDatabaseError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("fake membership database error", {
    code,
    clientVersion: "7.10.0",
  });
}

function matchesAccessState(rowState: MembershipAccessState, condition: unknown): boolean {
  if (typeof condition === "object" && condition !== null && "not" in condition) {
    return rowState !== (condition as { not: MembershipAccessState }).not;
  }
  return rowState === condition;
}

function timestampFor(index: number): Date {
  return new Date(`2026-09-15T0${index}:00:00.000Z`);
}

function copyWorkspace(row: WorkspaceRow): WorkspaceRow {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

function copyProject(row: ProjectRow): ProjectRow {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

class MembershipFakeDb {
  readonly workspaces: WorkspaceRow[] = [];
  readonly projects: ProjectRow[] = [];
  readonly audits: Record<string, unknown>[] = [];
  failNextCreate: "workspace" | "project" | null = null;
  failNextUpdate: "workspace" | "project" | null = null;
  dropAfterUpdate: "workspace" | "project" | null = null;

  readonly workspaceMembership = {
    findMany: async ({ where, take = 2 }: { where: Record<string, unknown>; take?: number }) => this.workspaces
      .filter((row) => (where.workspaceId === undefined || row.workspaceId === where.workspaceId)
        && (where.userId === undefined || row.userId === where.userId)
        && matchesAccessState(row.accessState, where.accessState))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .slice(0, take)
      .map(copyWorkspace),
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.workspaces.find((candidate) => candidate.id === where.id);
      return row === undefined ? null : copyWorkspace(row);
    },
    updateMany: async ({ where, data }: { where: { id: string; accessState: MembershipAccessState }; data: Record<string, unknown> }) => {
      if (this.failNextUpdate === "workspace") {
        this.failNextUpdate = null;
        return { count: 0 };
      }
      const index = this.workspaces.findIndex((row) => row.id === where.id && row.accessState === where.accessState);
      if (index < 0) return { count: 0 };
      Object.assign(this.workspaces[index], data, { updatedAt: timestampFor(8) });
      if (this.dropAfterUpdate === "workspace") {
        this.dropAfterUpdate = null;
        this.workspaces.splice(index, 1);
      }
      return { count: 1 };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (this.failNextCreate === "workspace") {
        this.failNextCreate = null;
        throw fakeDatabaseError("P2002");
      }
      if (this.workspaces.some((row) => row.workspaceId === data.workspaceId
        && row.userId === data.userId
        && row.accessState !== MembershipAccessState.revoked)) throw fakeDatabaseError("P2002");
      const now = timestampFor(9);
      const row = {
        id: String(data.id),
        workspaceId: String(data.workspaceId),
        userId: String(data.userId),
        role: data.role as WorkspaceRow["role"],
        accessState: data.accessState as MembershipAccessState,
        createdAt: now,
        updatedAt: now,
      } satisfies WorkspaceRow;
      this.workspaces.push(row);
      return copyWorkspace(row);
    },
    count: async ({ where }: { where: Record<string, unknown> }) => this.workspaces.filter((row) => row.workspaceId === where.workspaceId
      && row.userId === where.userId
      && row.accessState === where.accessState).length,
  };

  readonly projectMembership = {
    findMany: async ({ where, take = 2 }: { where: Record<string, unknown>; take?: number }) => this.projects
      .filter((row) => (where.projectId === undefined || row.projectId === where.projectId)
        && (where.userId === undefined || row.userId === where.userId)
        && matchesAccessState(row.accessState, where.accessState))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .slice(0, take)
      .map(copyProject),
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.projects.find((candidate) => candidate.id === where.id);
      return row === undefined ? null : copyProject(row);
    },
    updateMany: async ({ where, data }: { where: { id: string; accessState: MembershipAccessState }; data: Record<string, unknown> }) => {
      if (this.failNextUpdate === "project") {
        this.failNextUpdate = null;
        return { count: 0 };
      }
      const index = this.projects.findIndex((row) => row.id === where.id && row.accessState === where.accessState);
      if (index < 0) return { count: 0 };
      Object.assign(this.projects[index], data, { updatedAt: timestampFor(8) });
      if (this.dropAfterUpdate === "project") {
        this.dropAfterUpdate = null;
        this.projects.splice(index, 1);
      }
      return { count: 1 };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (this.failNextCreate === "project") {
        this.failNextCreate = null;
        throw fakeDatabaseError("P2002");
      }
      if (this.projects.some((row) => row.projectId === data.projectId
        && row.userId === data.userId
        && row.accessState !== MembershipAccessState.revoked)) throw fakeDatabaseError("P2002");
      const now = timestampFor(9);
      const row = {
        id: String(data.id),
        projectId: String(data.projectId),
        workspaceId: WORKSPACE_ID,
        userId: String(data.userId),
        role: data.role as ProjectRow["role"],
        accessState: data.accessState as MembershipAccessState,
        createdAt: now,
        updatedAt: now,
      } satisfies ProjectRow;
      this.projects.push(row);
      return copyProject(row);
    },
    count: async ({ where }: { where: Record<string, unknown> }) => this.projects.filter((row) => row.projectId === where.projectId
      && row.userId === where.userId
      && row.accessState === where.accessState).length,
  };

  readonly membershipAccessAudit = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.audits.push({ ...data });
      return data;
    },
  };
}

function dbFor(db: MembershipFakeDb) {
  return db as never;
}

function workspaceRow(input: Partial<WorkspaceRow> = {}): WorkspaceRow {
  const createdAt = input.createdAt ?? timestampFor(1);
  return {
    id: input.id ?? "00000000-0000-4000-8000-000000000110",
    workspaceId: input.workspaceId ?? WORKSPACE_ID,
    userId: input.userId ?? USER_ID,
    role: input.role ?? "member",
    accessState: input.accessState ?? MembershipAccessState.confirmed,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  };
}

function projectRow(input: Partial<ProjectRow> = {}): ProjectRow {
  const createdAt = input.createdAt ?? timestampFor(1);
  return {
    id: input.id ?? "00000000-0000-4000-8000-000000000111",
    projectId: input.projectId ?? PROJECT_ID,
    workspaceId: input.workspaceId ?? WORKSPACE_ID,
    userId: input.userId ?? USER_ID,
    role: input.role ?? "viewer",
    accessState: input.accessState ?? MembershipAccessState.confirmed,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  };
}

function governanceCode(error: unknown): string | null {
  return error instanceof MembershipGovernanceError ? error.code : null;
}

test("membership governance fake helpers canonicalize evidence and audit confirmed/revoked rows", async () => {
  const db = new MembershipFakeDb();
  const workspace = workspaceRow({ id: "00000000-0000-4000-8000-000000000112", role: "owner" });
  const project = projectRow({ id: "00000000-0000-4000-8000-000000000113", role: "editor" });
  const fingerprint = membershipFingerprint({
    membershipId: workspace.id.toUpperCase(),
    resourceId: WORKSPACE_ID.toUpperCase(),
    userId: USER_ID.toUpperCase(),
    role: " owner ",
    createdAt: "2026-09-15 01:00:00.000",
    updatedAt: new Date("2026-09-15T01:00:00.000Z"),
  });
  assert.match(fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(membershipFingerprint({
    membershipId: workspace.id,
    resourceId: WORKSPACE_ID,
    userId: USER_ID,
    role: workspace.role,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }), membershipFingerprint({
    membershipId: workspace.id.toUpperCase(),
    resourceId: WORKSPACE_ID.toUpperCase(),
    userId: USER_ID.toUpperCase(),
    role: workspace.role,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  }));
  assert.notEqual(membershipFingerprint({
    membershipId: workspace.id,
    resourceId: PROJECT_ID,
    userId: workspace.userId,
    role: "admin",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }), fingerprint);
  assert.throws(
    () => membershipFingerprint({ ...workspace, role: "invalid" } as never),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_INVALID_FINGERPRINT_INPUT",
  );
  assert.throws(
    () => membershipFingerprint({ ...workspace, createdAt: "not-a-date" } as never),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_INVALID_FINGERPRINT_INPUT",
  );

  const manifest = membershipManifestFingerprint([
    { membershipKind: "project", membershipId: project.id, membershipFingerprint: "b".repeat(64) },
    { membershipKind: "workspace", membershipId: workspace.id, membershipFingerprint: fingerprint },
  ]);
  assert.equal(manifest, membershipManifestFingerprint([
    { membershipKind: "workspace", membershipId: workspace.id.toUpperCase(), membershipFingerprint: fingerprint.toUpperCase() },
    { membershipKind: MembershipAccessAuditMembershipKind.project, membershipId: project.id, membershipFingerprint: "b".repeat(64) },
  ]));
  assert.throws(
    () => membershipManifestFingerprint([{ membershipKind: "other" as never, membershipId: workspace.id, membershipFingerprint: fingerprint }]),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY",
  );
  assert.throws(
    () => membershipManifestFingerprint([{ membershipKind: "workspace", membershipId: workspace.id, membershipFingerprint: "bad" }]),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY",
  );
  assert.deepEqual(buildConfirmedWorkspaceMembershipWhere(), { accessState: MembershipAccessState.confirmed });
  assert.deepEqual(buildConfirmedProjectMembershipWhere({ projectId: PROJECT_ID, userId: USER_ID }), {
    accessState: MembershipAccessState.confirmed,
    projectId: PROJECT_ID,
    userId: USER_ID,
  });

  for (const [previous, next] of [
    [MembershipAccessState.pending, MembershipAccessState.pending],
    [MembershipAccessState.pending, MembershipAccessState.confirmed],
    [MembershipAccessState.pending, MembershipAccessState.revoked],
    [MembershipAccessState.confirmed, MembershipAccessState.revoked],
  ] as const) {
    assert.doesNotThrow(() => assertMembershipAccessTransition(previous, next));
    assert.equal(transitionMembershipAccessState(previous, next), next);
  }
  for (const [previous, next] of [
    [MembershipAccessState.revoked, MembershipAccessState.confirmed],
    [MembershipAccessState.confirmed, MembershipAccessState.pending],
  ] as const) {
    assert.throws(
      () => assertMembershipAccessTransition(previous, next),
      (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_INVALID_TRANSITION",
    );
  }

  await appendWorkspaceMembershipAudit(dbFor(db), workspace, {
    action: "confirmed",
    previousState: null,
    actorId: ACTOR_ID,
    reason: "workspace grant",
    manifestFingerprint: manifest,
  });
  await appendWorkspaceMembershipAudit(dbFor(db), { ...workspace, accessState: MembershipAccessState.revoked }, {
    action: "revoked",
    previousState: MembershipAccessState.confirmed,
    actorId: null,
    reason: "workspace revoke",
  });
  await appendProjectMembershipAudit(dbFor(db), { ...project, accessState: MembershipAccessState.confirmed }, {
    action: "confirmed",
    previousState: null,
    reason: "project grant",
  });
  assert.equal(db.audits.length, 3);
  assert.equal(db.audits[0]?.membershipKind, MembershipAccessAuditMembershipKind.workspace);
  assert.equal(db.audits[0]?.projectId, null);
  assert.equal(db.audits[2]?.membershipKind, MembershipAccessAuditMembershipKind.project);
  assert.equal(db.audits[2]?.projectId, PROJECT_ID);
  await assert.rejects(
    () => appendWorkspaceMembershipAudit(dbFor(db), workspace, { action: "revoked", previousState: null, reason: "bad transition" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_INVALID_TRANSITION",
  );
  await assert.rejects(
    () => appendWorkspaceMembershipAudit(dbFor(db), workspace, { action: "confirmed", previousState: null, reason: "" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY",
  );
});

test("workspace membership fake lifecycle preserves history, confirms only one current row, and maps write conflicts", async () => {
  const db = new MembershipFakeDb();
  const input = { workspaceId: WORKSPACE_ID, userId: USER_ID, role: "member" as const, actorId: ACTOR_ID, reason: "initial workspace access" };
  const created = await grantWorkspaceMembership(dbFor(db), input);
  assert.equal(created.accessState, MembershipAccessState.confirmed);
  assert.equal(created.role, "member");
  assert.equal(db.audits.length, 1);
  const idempotent = await grantWorkspaceMembership(dbFor(db), input);
  assert.equal(idempotent.id, created.id);
  assert.equal(db.workspaces.length, 1);
  assert.equal(db.audits.length, 1);

  const promoted = await grantWorkspaceMembership(dbFor(db), { ...input, role: "admin", reason: "promote workspace access" });
  assert.notEqual(promoted.id, created.id);
  assert.equal(db.workspaces.find((row) => row.id === created.id)?.accessState, MembershipAccessState.revoked);
  assert.equal(db.workspaces.filter((row) => row.accessState !== MembershipAccessState.revoked).length, 1);
  assert.equal(db.audits.filter((audit) => audit.action === "revoked").length, 1);
  assert.equal(db.audits.filter((audit) => audit.action === "confirmed").length, 2);
  assert.equal((await findCurrentWorkspaceMembership(dbFor(db), WORKSPACE_ID, USER_ID))?.id, promoted.id);
  assert.equal((await findConfirmedWorkspaceMembership(dbFor(db), WORKSPACE_ID, USER_ID))?.role, "admin");

  const revoked = await revokeWorkspaceMembership(dbFor(db), WORKSPACE_ID, USER_ID, { actorId: ACTOR_ID, reason: "remove workspace access" });
  assert.equal(revoked?.accessState, MembershipAccessState.revoked);
  assert.equal(await findCurrentWorkspaceMembership(dbFor(db), WORKSPACE_ID, USER_ID), null);
  assert.equal(await findConfirmedWorkspaceMembership(dbFor(db), WORKSPACE_ID, USER_ID), null);
  assert.equal(await hasRevokedWorkspaceMembership(dbFor(db), WORKSPACE_ID, USER_ID), true);
  assert.equal(await revokeWorkspaceMembership(dbFor(db), WORKSPACE_ID, OTHER_USER_ID, { reason: "no row" }), null);

  const regranted = await grantWorkspaceMembership(dbFor(db), { ...input, role: "owner", reason: "restore workspace owner" });
  assert.notEqual(regranted.id, promoted.id);
  assert.equal(regranted.role, "owner");

  db.workspaces.push(workspaceRow({ id: PENDING_WORKSPACE_ID, userId: OTHER_USER_ID, accessState: MembershipAccessState.pending }));
  const beforePending = { rows: db.workspaces.length, audits: db.audits.length };
  await assert.rejects(
    () => grantWorkspaceMembership(dbFor(db), { ...input, userId: OTHER_USER_ID, reason: "ordinary regrant" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    () => revokeWorkspaceMembership(dbFor(db), WORKSPACE_ID, OTHER_USER_ID, { reason: "ordinary revoke" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED",
  );
  assert.deepEqual({ rows: db.workspaces.length, audits: db.audits.length }, beforePending);

  db.workspaces.push(workspaceRow({ id: "00000000-0000-4000-8000-000000000114", userId: ACTOR_ID }));
  db.workspaces.push(workspaceRow({ id: "00000000-0000-4000-8000-000000000115", userId: ACTOR_ID }));
  await assert.rejects(
    () => findCurrentWorkspaceMembership(dbFor(db), WORKSPACE_ID, ACTOR_ID),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_CURRENT_CONFLICT",
  );
  await assert.rejects(
    () => findConfirmedWorkspaceMembership(dbFor(db), WORKSPACE_ID, ACTOR_ID),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_CURRENT_CONFLICT",
  );

  const conflictUser = "00000000-0000-4000-8000-000000000116";
  db.failNextCreate = "workspace";
  const beforeConflict = { rows: db.workspaces.length, audits: db.audits.length };
  await assert.rejects(
    () => grantWorkspaceMembership(dbFor(db), { ...input, userId: conflictUser, reason: "conflicting create" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_WRITE_CONFLICT",
  );
  assert.deepEqual({ rows: db.workspaces.length, audits: db.audits.length }, beforeConflict);

  db.failNextUpdate = "workspace";
  await assert.rejects(
    () => revokeWorkspaceMembership(dbFor(db), WORKSPACE_ID, USER_ID, { reason: "concurrent revoke" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_WRITE_CONFLICT",
  );
  db.dropAfterUpdate = "workspace";
  await assert.rejects(
    () => revokeWorkspaceMembership(dbFor(db), WORKSPACE_ID, USER_ID, { reason: "disappearing revoke" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_WRITE_CONFLICT",
  );
});

test("project membership fake lifecycle is direct, confirmed, and independent from workspace inheritance", async () => {
  const db = new MembershipFakeDb();
  db.workspaces.push(workspaceRow({ id: "00000000-0000-4000-8000-000000000117", userId: USER_ID, role: "owner" }));
  assert.equal(await findConfirmedProjectMembership(dbFor(db), PROJECT_ID, USER_ID), null);
  const input = { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, userId: USER_ID, role: "viewer" as const, actorId: ACTOR_ID, reason: "direct project grant" };
  const created = await grantProjectMembership(dbFor(db), input);
  assert.equal(created.accessState, MembershipAccessState.confirmed);
  assert.equal(created.role, "viewer");
  assert.equal((await findConfirmedProjectMembership(dbFor(db), PROJECT_ID, USER_ID))?.id, created.id);
  assert.equal(db.audits.at(-1)?.projectId, PROJECT_ID);
  const same = await grantProjectMembership(dbFor(db), input);
  assert.equal(same.id, created.id);
  assert.equal(db.projects.length, 1);

  const elevated = await grantProjectMembership(dbFor(db), { ...input, role: "editor", reason: "elevate project access" });
  assert.notEqual(elevated.id, created.id);
  assert.equal(db.projects.find((row) => row.id === created.id)?.accessState, MembershipAccessState.revoked);
  assert.equal(await hasRevokedProjectMembership(dbFor(db), PROJECT_ID, USER_ID), true);
  const revoked = await revokeProjectMembership(dbFor(db), PROJECT_ID, USER_ID, WORKSPACE_ID, { reason: "remove project access" });
  assert.equal(revoked?.accessState, MembershipAccessState.revoked);
  assert.equal(await findCurrentProjectMembership(dbFor(db), PROJECT_ID, USER_ID), null);

  db.projects.push(projectRow({ id: PENDING_PROJECT_ID, userId: OTHER_USER_ID, accessState: MembershipAccessState.pending }));
  const beforePending = { rows: db.projects.length, audits: db.audits.length };
  await assert.rejects(
    () => grantProjectMembership(dbFor(db), { ...input, userId: OTHER_USER_ID, reason: "pending project grant" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    () => revokeProjectMembership(dbFor(db), PROJECT_ID, OTHER_USER_ID, WORKSPACE_ID, { reason: "pending project revoke" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED",
  );
  assert.deepEqual({ rows: db.projects.length, audits: db.audits.length }, beforePending);

  const conflictUser = "00000000-0000-4000-8000-000000000118";
  db.failNextCreate = "project";
  const beforeConflict = { rows: db.projects.length, audits: db.audits.length };
  await assert.rejects(
    () => grantProjectMembership(dbFor(db), { ...input, userId: conflictUser, reason: "conflicting project create" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_WRITE_CONFLICT",
  );
  assert.deepEqual({ rows: db.projects.length, audits: db.audits.length }, beforeConflict);

  const stableUser = "00000000-0000-4000-8000-000000000119";
  await grantProjectMembership(dbFor(db), { ...input, userId: stableUser, reason: "stable project grant" });
  db.failNextUpdate = "project";
  await assert.rejects(
    () => revokeProjectMembership(dbFor(db), PROJECT_ID, stableUser, WORKSPACE_ID, { reason: "concurrent project revoke" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_WRITE_CONFLICT",
  );
  db.dropAfterUpdate = "project";
  await assert.rejects(
    () => revokeProjectMembership(dbFor(db), PROJECT_ID, stableUser, WORKSPACE_ID, { reason: "disappearing project revoke" }),
    (error: unknown) => governanceCode(error) === "MEMBERSHIP_GOVERNANCE_WRITE_CONFLICT",
  );
  assert.equal(db.audits.some((audit) => audit.reason === "direct project grant"), true);
});
