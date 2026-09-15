import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  AccountAccessServiceError,
  accountAccessRequestFingerprint,
  executeAccountAccess,
  getEffectiveAccessMatrix,
  listAccountAccess,
  previewAccountAccess,
  type AccountAccessPreview,
  groupAccessMatrixMembershipRows,
  type AccessMatrixMembershipRow,
} from "../src/lib/account-access-service";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_TARGET_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const WORKSPACE_CONFIRMED_ID = "61111111-1111-4111-8111-111111111111";
const WORKSPACE_PENDING_ID = "62222222-2222-4222-8222-222222222222";
const WORKSPACE_REVOKED_ID = "63333333-3333-4333-8333-333333333333";
const WORKSPACE_MEMBER_ID = "64444444-4444-4444-8444-444444444444";
const WORKSPACE_EMPTY_ID = "65555555-5555-4555-8555-555555555555";
const PROJECT_INHERITED_ID = "71111111-1111-4111-8111-111111111111";
const PROJECT_DIRECT_ID = "72222222-2222-4222-8222-222222222222";
const PROJECT_PENDING_ID = "73333333-3333-4333-8333-333333333333";
const PROJECT_REVOKED_ID = "74444444-4444-4444-8444-444444444444";
const PROJECT_MISSING_ID = "75555555-5555-4555-8555-555555555555";
const PROJECT_COMBINED_ID = "76666666-6666-4666-8666-666666666666";
const PROJECT_PENDING_INHERITED_ID = "77777777-7777-4777-8777-777777777777";
const WORKSPACE_FALLBACK_ID = "78888888-8888-4888-8888-888888888888";
const WORKSPACE_ROLE_ONLY_ID = "79999999-9999-4999-8999-999999999999";
const WORKSPACE_MISSING_ID = "7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_FALLBACK_ID = "7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_ROLE_ONLY_ID = "7ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT_NO_WORKSPACE_ID = "7ddddddd-dddd-4ddd-8ddd-dddddddddddd";

type FakeRole = "admin" | "user";
type FakeWorkspaceRole = "owner" | "admin" | "member" | "viewer";
type FakeProjectRole = "owner" | "editor" | "viewer";
type FakeAccessState = "pending" | "confirmed" | "revoked";

type FakeSubscription = {
  status: "active" | "revoked";
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type FakeUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: FakeRole;
  disabledAt: Date | null;
  disabledReason: string | null;
  disabledById: string | null;
  accountAccessVersion: number;
  createdAt: Date;
  membershipSubscription: FakeSubscription | null;
};

type FakeSession = {
  id: string;
  userId: string;
  accountAccessVersion: number;
  revokedAt: Date | null;
};

type FakeWorkspace = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
};

type FakeProject = {
  id: string;
  name: string;
  slug: string;
  workspaceId: string;
  membershipInheritanceMode: "workspaceInherited" | "projectOnly";
  archivedAt: Date | null;
  createdAt: Date;
};

type FakeWorkspaceMembership = {
  id: string;
  workspaceId: string;
  userId: string;
  role: FakeWorkspaceRole;
  accessState: FakeAccessState;
  createdAt: Date;
  updatedAt: Date;
};

type FakeProjectMembership = {
  id: string;
  projectId: string;
  userId: string;
  role: FakeProjectRole;
  accessState: FakeAccessState;
  createdAt: Date;
  updatedAt: Date;
};

type FakeMembershipAudit = {
  membershipKind: "workspace" | "project";
  membershipId: string;
  action: "revoked";
  createdAt: Date;
};

type FakePreview = {
  id: string;
  actorId: string;
  userId: string;
  action: "disable" | "restore";
  expectedVersion: number;
  impactFingerprint: string;
  requestFingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
};

type FakeAudit = {
  id: string;
  userId: string;
  actorId: string;
  event: "disabled" | "restored";
  versionBefore: number;
  versionAfter: number;
  disabledAtBefore: Date | null;
  disabledAtAfter: Date | null;
  disabledReasonBefore: string | null;
  disabledReasonAfter: string | null;
  disabledByIdBefore: string | null;
  disabledByIdAfter: string | null;
  previewId: string;
  reason: string;
  requestKey: string;
  requestFingerprint: string;
  impactFingerprint: string;
  transitionAt: Date;
  createdAt: Date;
  contractVersion: number;
};

type FakeDbSnapshot = {
  users: Array<[string, FakeUser]>;
  sessions: FakeSession[];
  workspaces: FakeWorkspace[];
  projects: FakeProject[];
  workspaceMemberships: FakeWorkspaceMembership[];
  projectMemberships: FakeProjectMembership[];
  membershipAudits: FakeMembershipAudit[];
  previews: Array<[string, FakePreview]>;
  audits: FakeAudit[];
};

type QueryObject = Record<string, unknown>;

function asObject(value: unknown): QueryObject {
  return typeof value === "object" && value !== null ? value as QueryObject : {};
}

function nestedObject(value: unknown, key: string): QueryObject {
  return asObject(asObject(value)[key]);
}

function cursorAllows(value: { createdAt: Date; id: string }, cursor: unknown): boolean {
  const cursorObject = asObject(cursor);
  const or = cursorObject.OR;
  if (!Array.isArray(or)) return true;
  const first = asObject(or[0]);
  const firstCreatedAt = nestedObject(first, "createdAt").gt;
  if (firstCreatedAt instanceof Date && value.createdAt > firstCreatedAt) return true;
  const second = asObject(or[1]);
  const secondCreatedAt = second.createdAt;
  const secondId = nestedObject(second, "id").gt;
  if (secondCreatedAt instanceof Date && value.createdAt.getTime() === secondCreatedAt.getTime() && typeof secondId === "string") {
    return value.id > secondId;
  }
  return false;
}

function containsSearch(value: string | null, search: string): boolean {
  return value !== null && value.toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

class FakeAccountAccessDb {
  readonly users = new Map<string, FakeUser>();
  readonly sessions: FakeSession[] = [];
  readonly workspaces: FakeWorkspace[] = [];
  readonly projects: FakeProject[] = [];
  readonly workspaceMemberships: FakeWorkspaceMembership[] = [];
  readonly projectMemberships: FakeProjectMembership[] = [];
  readonly membershipAudits: FakeMembershipAudit[] = [];
  readonly previews = new Map<string, FakePreview>();
  readonly audits: FakeAudit[] = [];
  readonly now = new Date("2026-09-15T04:00:00.000Z");
  adminCountOverride: number | undefined;
  transactionError: unknown;
  consumeCountOverride: number | undefined;
  queryNowOverride: Date | null | undefined;

  readonly appUser = {
    findUnique: async ({ where }: { where: { id: string } }) => this.cloneUser(this.users.get(where.id)),
    count: async ({ where }: { where?: unknown }) => {
      if (this.adminCountOverride !== undefined && JSON.stringify(where) === JSON.stringify({ role: "admin", disabledAt: null })) {
        return this.adminCountOverride;
      }
      const filter = asObject(where);
      return [...this.users.values()].filter((user) => {
        if (filter.role !== undefined && user.role !== filter.role) return false;
        if (filter.disabledAt === null && user.disabledAt !== null) return false;
        return true;
      }).length;
    },
    findMany: async ({ where, skip = 0, take = 20 }: { where?: unknown; skip?: number; take?: number }) => {
      const filter = asObject(where);
      const searchClauses = Array.isArray(filter.OR) ? filter.OR.map(asObject) : [];
      const search = searchClauses.length === 0
        ? ""
        : String(nestedObject(searchClauses[0], "username").contains ?? nestedObject(searchClauses[1], "displayName").contains ?? "");
      const rows = [...this.users.values()]
        .filter((user) => search.length === 0 || containsSearch(user.username, search) || containsSearch(user.displayName, search))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
        .slice(skip, skip + take)
        .map((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          disabledAt: user.disabledAt,
          accountAccessVersion: user.accountAccessVersion,
          _count: { sessions: this.sessions.filter((session) => session.userId === user.id).length },
        }));
      return rows;
    },
    update: async ({ where, data }: { where: { id: string }; data: unknown }) => {
      const user = this.users.get(where.id);
      if (user === undefined) throw new Error("FAKE_USER_NOT_FOUND");
      const update = asObject(data);
      const version = asObject(update.accountAccessVersion).increment;
      if (typeof version === "number") user.accountAccessVersion += version;
      if ("disabledAt" in update) user.disabledAt = update.disabledAt instanceof Date ? update.disabledAt : null;
      if ("disabledReason" in update) user.disabledReason = typeof update.disabledReason === "string" ? update.disabledReason : null;
      if ("disabledById" in update) user.disabledById = typeof update.disabledById === "string" ? update.disabledById : null;
      return this.cloneUser(user);
    },
  };

  readonly appSession = {
    count: async ({ where }: { where: { userId: string; revokedAt?: null } }) => this.sessions.filter((session) => session.userId === where.userId && (where.revokedAt === undefined || session.revokedAt === null)).length,
    updateMany: async ({ where, data }: { where: { userId: string; revokedAt?: null }; data: { revokedAt: Date } }) => {
      const matching = this.sessions.filter((session) => session.userId === where.userId && (where.revokedAt === undefined || session.revokedAt === null));
      for (const session of matching) session.revokedAt = data.revokedAt;
      return { count: matching.length };
    },
  };

  readonly workspaceMembership = {
    findMany: async ({ where }: { where: unknown }) => {
      const filter = asObject(where);
      return this.workspaceMemberships
        .filter((row) => row.userId === filter.userId && row.role === filter.role && row.accessState === filter.accessState)
        .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId) || left.id.localeCompare(right.id))
        .map((row) => ({ workspaceId: row.workspaceId }));
    },
    count: async ({ where }: { where: unknown }) => {
      const filter = asObject(where);
      const userFilter = nestedObject(filter, "user");
      return this.workspaceMemberships.filter((row) => row.workspaceId === filter.workspaceId
        && row.role === filter.role
        && row.accessState === filter.accessState
        && (userFilter.disabledAt === undefined || (userFilter.disabledAt === null && this.users.get(row.userId)?.disabledAt === null))).length;
    },
  };

  readonly workspace = {
    findMany: async ({ where, take = 20 }: { where: unknown; take?: number }) => {
      const filter = asObject(where);
      const idFilter = nestedObject(filter, "id").in;
      if (Array.isArray(idFilter)) {
        const selected = new Set(idFilter.map(String));
        return this.workspaces.filter((workspace) => selected.has(workspace.id)).map((workspace) => ({ id: workspace.id, name: workspace.name }));
      }
      const membershipFilter = nestedObject(nestedObject(filter, "memberships"), "some");
      const subjectId = typeof membershipFilter.userId === "string" ? membershipFilter.userId : null;
      const cursor = filter.OR === undefined ? null : { OR: filter.OR };
      return this.workspaces
        .filter((workspace) => subjectId === null || this.workspaceMemberships.some((row) => row.workspaceId === workspace.id && row.userId === subjectId))
        .filter((workspace) => cursorAllows(workspace, cursor))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
        .slice(0, take)
        .map((workspace) => ({ id: workspace.id, name: workspace.name, slug: workspace.slug, createdAt: workspace.createdAt }));
    },
  };

  readonly project = {
    findMany: async ({ where, take = 20 }: { where: unknown; take?: number }) => {
      const filter = asObject(where);
      const clauses = Array.isArray(filter.AND) ? filter.AND : [];
      const relation = asObject(clauses[0]);
      const relationOr = Array.isArray(relation.OR) ? relation.OR : [];
      const directSubject = nestedObject(nestedObject(relationOr[0], "memberships"), "some").userId;
      const workspaceSubject = nestedObject(nestedObject(nestedObject(relationOr[1], "workspace"), "memberships"), "some").userId;
      const subjectId = typeof directSubject === "string" ? directSubject : typeof workspaceSubject === "string" ? workspaceSubject : null;
      const cursor = clauses.length > 1 ? { OR: asObject(clauses[1]).OR } : null;
      const filtered = this.projects
        .filter((project) => subjectId === null || this.projectMemberships.some((row) => row.projectId === project.id && row.userId === subjectId)
          || this.workspaceMemberships.some((row) => row.workspaceId === project.workspaceId && row.userId === subjectId))
        .filter((project) => cursorAllows(project, cursor))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
      return filtered.slice(0, take).map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          workspaceId: project.workspaceId,
          membershipInheritanceMode: project.membershipInheritanceMode,
          archivedAt: project.archivedAt,
          createdAt: project.createdAt,
        }));
    },
  };

  readonly membershipAccessAudit = {
    findMany: async ({ where }: { where: unknown }) => {
      const filter = asObject(where);
      const membershipIds = new Set(nestedObject(filter, "membershipId").in as string[] | undefined);
      return this.membershipAudits
        .filter((row) => row.membershipKind === filter.membershipKind && row.action === filter.action && membershipIds.has(row.membershipId))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.membershipId.localeCompare(right.membershipId));
    },
  };

  readonly accountAccessMutationPreview = {
    create: async ({ data }: { data: FakePreview }) => {
      this.previews.set(data.id, { ...data, consumedAt: data.consumedAt ?? null });
      return data;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.previews.get(where.id) ?? null,
    updateMany: async ({ where, data }: { where: { id: string; consumedAt?: null }; data: { consumedAt: Date } }) => {
      const preview = this.previews.get(where.id);
      if (preview === undefined || (where.consumedAt === null && preview.consumedAt !== null)) return { count: 0 };
      if (this.consumeCountOverride !== undefined) {
        const count = this.consumeCountOverride;
        this.consumeCountOverride = undefined;
        return { count };
      }
      preview.consumedAt = data.consumedAt;
      return { count: 1 };
    },
  };

  readonly accountAccessAudit = {
    findFirst: async ({ where }: { where: { actorId: string; requestKey: string } }) => this.audits
      .filter((audit) => audit.actorId === where.actorId && audit.requestKey === where.requestKey)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0] ?? null,
    create: async ({ data }: { data: FakeAudit }) => {
      this.audits.push({ ...data, id: data.id ?? `audit-${this.audits.length + 1}` });
      return data;
    },
  };

  async $transaction<T>(callback: (tx: FakeAccountAccessDb) => Promise<T>): Promise<T> {
    if (this.transactionError !== undefined) {
      const error = this.transactionError;
      this.transactionError = undefined;
      throw error;
    }
    const snapshot = this.snapshot();
    try {
      return await callback(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  async $executeRaw(): Promise<number> {
    return 1;
  }

  async $queryRaw(query: unknown): Promise<unknown> {
    const sql = asObject(query);
    const text = Array.isArray(sql.strings) ? sql.strings.join("") : "";
    if (text.includes("clock_timestamp")) return [{ now: this.queryNowOverride === undefined ? this.now : this.queryNowOverride }];
    const values = Array.isArray(sql.values) ? sql.values : [];
    const subjectId = String(values.at(-1));
    const scopeIds = new Set(values.slice(0, -1).map(String));
    if (text.includes('"WorkspaceMembership"')) {
      return this.membershipRows(this.workspaceMemberships.filter((row) => scopeIds.has(row.workspaceId) && row.userId === subjectId), "workspaceId");
    }
    if (text.includes('"ProjectMembership"')) {
      return this.membershipRows(this.projectMemberships.filter((row) => scopeIds.has(row.projectId) && row.userId === subjectId), "projectId");
    }
    return [];
  }

  private membershipRows<T extends FakeWorkspaceMembership | FakeProjectMembership>(rows: readonly T[], scopeKey: "workspaceId" | "projectId"): T[] {
    const scopeValue = (row: T): string => scopeKey === "workspaceId"
      ? (row as FakeWorkspaceMembership).workspaceId
      : (row as FakeProjectMembership).projectId;
    const scopes = [...new Set(rows.map(scopeValue))];
    return scopes.flatMap((scope) => [
      ...rows.filter((row) => scopeValue(row) === scope && row.accessState !== "revoked")
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id))
        .slice(0, 2),
      ...rows.filter((row) => scopeValue(row) === scope && row.accessState === "revoked")
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id))
        .slice(0, 1),
    ]);
  }

  private cloneUser(user: FakeUser | undefined): FakeUser | null {
    if (user === undefined) return null;
    return {
      ...user,
      membershipSubscription: user.membershipSubscription === null ? null : { ...user.membershipSubscription },
    };
  }

  private snapshot(): FakeDbSnapshot {
    return structuredClone({
      users: [...this.users.entries()],
      sessions: this.sessions,
      workspaces: this.workspaces,
      projects: this.projects,
      workspaceMemberships: this.workspaceMemberships,
      projectMemberships: this.projectMemberships,
      membershipAudits: this.membershipAudits,
      previews: [...this.previews.entries()],
      audits: this.audits,
    });
  }

  private restore(snapshot: FakeDbSnapshot): void {
    this.users.clear();
    for (const [id, user] of snapshot.users) this.users.set(id, user);
    this.sessions.splice(0, this.sessions.length, ...snapshot.sessions);
    this.workspaces.splice(0, this.workspaces.length, ...snapshot.workspaces);
    this.projects.splice(0, this.projects.length, ...snapshot.projects);
    this.workspaceMemberships.splice(0, this.workspaceMemberships.length, ...snapshot.workspaceMemberships);
    this.projectMemberships.splice(0, this.projectMemberships.length, ...snapshot.projectMemberships);
    this.membershipAudits.splice(0, this.membershipAudits.length, ...snapshot.membershipAudits);
    this.previews.clear();
    for (const [id, preview] of snapshot.previews) this.previews.set(id, preview);
    this.audits.splice(0, this.audits.length, ...snapshot.audits);
  }
}

function serviceCode(error: unknown): string | null {
  return error instanceof AccountAccessServiceError ? error.code : null;
}

function observableMutationState(db: FakeAccountAccessDb): unknown {
  return structuredClone({
    users: [...db.users.entries()],
    sessions: db.sessions,
    previews: [...db.previews.entries()],
    audits: db.audits,
  });
}

function executeInput(preview: AccountAccessPreview, input: Readonly<{ adminUserId: string; adminAccountAccessVersion: number; reason: string; requestKey: string }>) {
  return {
    adminUserId: input.adminUserId,
    adminAccountAccessVersion: input.adminAccountAccessVersion,
    userId: preview.user.id,
    action: preview.action,
    reason: input.reason,
    expectedVersion: preview.current.accountAccessVersion,
    expectedImpactFingerprint: preview.impactFingerprint,
    requestKey: input.requestKey,
    requestFingerprint: preview.requestFingerprint,
    previewId: preview.previewId,
    previewIssuedAt: preview.previewIssuedAt,
    previewExpiresAt: preview.previewExpiresAt,
    confirmation: true as const,
    confirmationUsername: preview.user.username,
  };
}

function addAuditFixture(
  db: FakeAccountAccessDb,
  preview: AccountAccessPreview,
  input: ReturnType<typeof executeInput>,
  overrides: Partial<FakeAudit> = {},
): void {
  db.audits.push({
    id: `fixture-audit-${db.audits.length + 1}`,
    userId: input.userId,
    actorId: input.adminUserId,
    event: preview.action === "disable" ? "disabled" : "restored",
    versionBefore: preview.current.accountAccessVersion,
    versionAfter: preview.current.accountAccessVersion + 1,
    disabledAtBefore: preview.current.disabledAt,
    disabledAtAfter: preview.action === "disable" ? db.now : null,
    disabledReasonBefore: null,
    disabledReasonAfter: preview.action === "disable" ? input.reason : null,
    disabledByIdBefore: null,
    disabledByIdAfter: preview.action === "disable" ? input.adminUserId : null,
    previewId: preview.previewId,
    reason: input.reason,
    requestKey: input.requestKey,
    requestFingerprint: preview.requestFingerprint,
    impactFingerprint: preview.impactFingerprint,
    transitionAt: db.now,
    createdAt: db.now,
    contractVersion: 1,
    ...overrides,
  });
}

function addUser(db: FakeAccountAccessDb, input: Partial<FakeUser> & Pick<FakeUser, "id" | "username" | "role" | "createdAt">): void {
  db.users.set(input.id, {
    displayName: null,
    disabledAt: null,
    disabledReason: null,
    disabledById: null,
    accountAccessVersion: 1,
    membershipSubscription: null,
    ...input,
  });
}

function addWorkspace(db: FakeAccountAccessDb, input: FakeWorkspace): void {
  db.workspaces.push(input);
}

function addProject(db: FakeAccountAccessDb, input: FakeProject): void {
  db.projects.push(input);
}

function addWorkspaceMembership(db: FakeAccountAccessDb, input: FakeWorkspaceMembership): void {
  db.workspaceMemberships.push(input);
}

function addProjectMembership(db: FakeAccountAccessDb, input: FakeProjectMembership): void {
  db.projectMemberships.push(input);
}

function activeSubscription(db: FakeAccountAccessDb): FakeSubscription {
  return {
    status: "active",
    startsAt: new Date(db.now.getTime() - 60_000),
    expiresAt: new Date(db.now.getTime() + 60_000),
    createdAt: new Date(db.now.getTime() - 120_000),
    updatedAt: new Date(db.now.getTime() - 30_000),
  };
}

test("account access public services exercise fake-DB lifecycle, idempotency, safety and pagination", async () => {
  const db = new FakeAccountAccessDb();
  addUser(db, { id: ADMIN_ID, username: "fake-admin", role: "admin", createdAt: new Date("2026-09-15T00:00:00.000Z") });
  addUser(db, { id: SECOND_ADMIN_ID, username: "fake-admin-two", role: "admin", createdAt: new Date("2026-09-15T00:01:00.000Z") });
  addUser(db, { id: TARGET_ID, username: "fake-target", role: "user", createdAt: new Date("2026-09-15T00:02:00.000Z") });
  addUser(db, { id: OWNER_TARGET_ID, username: "fake-owner-target", role: "user", createdAt: new Date("2026-09-15T00:03:00.000Z") });
  addUser(db, { id: OTHER_ID, username: "searchable-user", role: "user", createdAt: new Date("2026-09-15T00:04:00.000Z") });
  db.sessions.push({ id: "session-target", userId: TARGET_ID, accountAccessVersion: 1, revokedAt: null });

  const typedDb = db as unknown as PrismaClient;
  const disablePreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "fake lifecycle review",
    expectedVersion: 1,
  }, typedDb);
  assert.equal(disablePreview.current.sessionCount, 1);
  assert.equal(disablePreview.canExecute, true);
  const unconfirmedInput = { ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "fake-disable" }), confirmation: false } as unknown as Parameters<typeof executeAccountAccess>[0];
  await assert.rejects(
    () => executeAccountAccess(unconfirmedInput, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    () => executeAccountAccess({ ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "fake-disable" }), confirmationUsername: "wrong" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFIRMATION_REQUIRED",
  );
  const beforeTamper = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: OTHER_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "fake-actor-tamper" }),
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_REQUIRED",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "fake-user-tamper" }),
      userId: SECOND_ADMIN_ID,
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "fake-action-tamper" }),
      action: "restore",
    } as unknown as Parameters<typeof executeAccountAccess>[0], typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "fake-fingerprint-tamper" }),
      requestFingerprint: "a".repeat(64),
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "fake-time-tamper" }),
      previewIssuedAt: new Date(disablePreview.previewIssuedAt.getTime() + 1),
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "bad" }),
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "missing execute target", requestKey: "fake-missing-execute-target" }),
      userId: "99999999-9999-4999-8999-999999999999",
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_USER_NOT_FOUND",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "invalid execute action", requestKey: "fake-invalid-action" }),
      action: "other",
    } as unknown as Parameters<typeof executeAccountAccess>[0], typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "invalid execute version", requestKey: "fake-invalid-version" }),
      expectedVersion: 0,
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "unsafe request key", requestKey: "a".repeat(64) }),
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_UNSAFE_AUDIT_TEXT",
  );
  assert.deepEqual(observableMutationState(db), beforeTamper);
  const disabled = await executeAccountAccess(executeInput(disablePreview, {
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    reason: "fake lifecycle review",
    requestKey: "fake-disable",
  }), typedDb);
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.revokedSessionCount, 1);
  assert.equal(db.sessions[0]?.revokedAt?.toISOString(), db.now.toISOString());
  const replay = await executeAccountAccess(executeInput(disablePreview, {
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    reason: "fake lifecycle review",
    requestKey: "fake-disable",
  }), typedDb);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    () => executeAccountAccess({ ...executeInput(disablePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "fake lifecycle review", requestKey: "fake-disable" }), requestFingerprint: "a".repeat(64) }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT",
  );

  const restorePreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "restore",
    reason: "fake restore review",
    expectedVersion: 2,
  }, typedDb);
  const restored = await executeAccountAccess(executeInput(restorePreview, {
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    reason: "fake restore review",
    requestKey: "fake-restore",
  }), typedDb);
  assert.equal(restored.state, "enabled");
  assert.equal(restored.accountAccessVersion, 3);
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "wrong expected version", expectedVersion: 2 }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_STALE",
  );

  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: "99999999-9999-4999-8999-999999999999", action: "disable", reason: "missing target" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_USER_NOT_FOUND",
  );
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "invalid" as never, reason: "invalid action" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "   " }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_REASON_REQUIRED",
  );
  db.users.get(ADMIN_ID)!.disabledAt = db.now;
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "disabled admin" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_REQUIRED",
  );
  db.users.get(ADMIN_ID)!.disabledAt = null;
  db.users.get(ADMIN_ID)!.accountAccessVersion = 2;
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "stale admin" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_STALE",
  );
  db.users.get(ADMIN_ID)!.accountAccessVersion = 1;

  const staleVersionPreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "target epoch drift",
  }, typedDb);
  db.users.get(TARGET_ID)!.accountAccessVersion += 1;
  const beforeVersionDrift = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess(executeInput(staleVersionPreview, {
      adminUserId: ADMIN_ID,
      adminAccountAccessVersion: 1,
      reason: "target epoch drift",
      requestKey: "fake-target-epoch-drift",
    }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_STALE",
  );
  assert.deepEqual(observableMutationState(db), beforeVersionDrift);
  db.users.get(TARGET_ID)!.accountAccessVersion -= 1;

  const staleSessionPreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "session impact drift",
  }, typedDb);
  db.sessions.push({ id: "session-impact-drift", userId: TARGET_ID, accountAccessVersion: 3, revokedAt: null });
  const beforeSessionDrift = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess(executeInput(staleSessionPreview, {
      adminUserId: ADMIN_ID,
      adminAccountAccessVersion: 1,
      reason: "session impact drift",
      requestKey: "fake-session-impact-drift",
    }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_STALE",
  );
  assert.deepEqual(observableMutationState(db), beforeSessionDrift);
  db.sessions.splice(db.sessions.findIndex((session) => session.id === "session-impact-drift"), 1);

  const consumedPreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "consumed preview",
  }, typedDb);
  db.previews.get(consumedPreview.previewId)!.consumedAt = db.now;
  const beforeConsumed = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess(executeInput(consumedPreview, {
      adminUserId: ADMIN_ID,
      adminAccountAccessVersion: 1,
      reason: "consumed preview",
      requestKey: "fake-consumed-preview",
    }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_STALE",
  );
  assert.deepEqual(observableMutationState(db), beforeConsumed);
  db.previews.get(consumedPreview.previewId)!.consumedAt = null;

  const missingPreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "missing preview",
  }, typedDb);
  const beforeMissing = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(missingPreview, {
        adminUserId: ADMIN_ID,
        adminAccountAccessVersion: 1,
        reason: "missing preview",
        requestKey: "fake-missing-preview",
      }),
      previewId: "99999999-9999-4999-8999-999999999999",
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_STALE",
  );
  assert.deepEqual(observableMutationState(db), beforeMissing);

  const consumeConflictPreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "consume conflict",
  }, typedDb);
  const beforeConsumeConflict = observableMutationState(db);
  db.consumeCountOverride = 0;
  await assert.rejects(
    () => executeAccountAccess(executeInput(consumeConflictPreview, {
      adminUserId: ADMIN_ID,
      adminAccountAccessVersion: 1,
      reason: "consume conflict",
      requestKey: "fake-consume-conflict",
    }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFLICT",
  );
  assert.deepEqual(observableMutationState(db), beforeConsumeConflict);

  const missingExpectedPreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "second disable",
  }, typedDb);
  await executeAccountAccess(executeInput(missingExpectedPreview, {
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    reason: "second disable",
    requestKey: "fake-disable-again",
  }), typedDb);
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "already disabled" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ACTION_CONFLICT",
  );
  const restoreAgain = await previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "restore", reason: "restore again" }, typedDb);
  await executeAccountAccess(executeInput(restoreAgain, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "restore again", requestKey: "fake-restore-again" }), typedDb);

  const expiredPreview = await previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "expired preview" }, typedDb);
  const expiredIssuedAt = new Date(db.now.getTime() - 10 * 60_000);
  const expiredExpiresAt = new Date(db.now.getTime() - 5 * 60_000);
  await assert.rejects(
    () => executeAccountAccess({
      ...executeInput(expiredPreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "expired preview", requestKey: "fake-expired" }),
      requestFingerprint: accountAccessRequestFingerprint({ userId: TARGET_ID, action: "disable", expectedVersion: expiredPreview.current.accountAccessVersion, expectedImpactFingerprint: expiredPreview.impactFingerprint, reason: "expired preview", previewIssuedAt: expiredIssuedAt, previewExpiresAt: expiredExpiresAt }),
      previewIssuedAt: expiredIssuedAt,
      previewExpiresAt: expiredExpiresAt,
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_EXPIRED",
  );
  db.transactionError = new Prisma.PrismaClientKnownRequestError("serialization conflict", { code: "P2034", clientVersion: "7.10.0" });
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: OTHER_ID, action: "disable", reason: "transaction conflict" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFLICT",
  );
  db.transactionError = new Prisma.PrismaClientKnownRequestError("transaction closed", { code: "P2028", clientVersion: "7.10.0" });
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: OTHER_ID, action: "disable", reason: "transaction closed" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFLICT",
  );

  await assert.rejects(
    () => previewAccountAccess({ adminUserId: TARGET_ID, adminAccountAccessVersion: 1, userId: OTHER_ID, action: "disable", reason: "not an admin" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_REQUIRED",
  );
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: ADMIN_ID, action: "disable", reason: "self" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_SELF_FORBIDDEN",
  );
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: "not-a-uuid", action: "disable", reason: "invalid" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
  );
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: OTHER_ID, action: "disable", reason: "" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_REASON_REQUIRED",
  );

  db.adminCountOverride = 1;
  addUser(db, { id: "88888888-8888-4888-8888-888888888888", username: "fake-target-admin", role: "admin", createdAt: new Date("2026-09-15T00:05:00.000Z") });
  db.adminCountOverride = undefined;
  const executeLastAdminPreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: SECOND_ADMIN_ID,
    action: "disable",
    reason: "execution last admin guard",
  }, typedDb);
  const beforeLastAdminExecution = observableMutationState(db);
  db.adminCountOverride = 1;
  await assert.rejects(
    () => executeAccountAccess(executeInput(executeLastAdminPreview, {
      adminUserId: ADMIN_ID,
      adminAccountAccessVersion: 1,
      reason: "execution last admin guard",
      requestKey: "fake-execute-last-admin",
    }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_LAST_ADMIN_REQUIRED",
  );
  assert.deepEqual(observableMutationState(db), beforeLastAdminExecution);
  db.adminCountOverride = 1;
  const lastAdminPreview = await previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: "88888888-8888-4888-8888-888888888888", action: "disable", reason: "last admin guard" }, typedDb);
  assert.deepEqual(lastAdminPreview.blockingCategories, ["last_enabled_system_admin"]);
  assert.equal(lastAdminPreview.canExecute, false);
  db.adminCountOverride = undefined;

  addWorkspace(db, { id: "86666666-6666-4666-8666-666666666666", name: "Owner boundary", slug: "owner-boundary", createdAt: new Date("2026-09-15T00:06:00.000Z") });
  addWorkspaceMembership(db, { id: "87777777-7777-4777-8777-777777777777", workspaceId: "86666666-6666-4666-8666-666666666666", userId: OWNER_TARGET_ID, role: "owner", accessState: "confirmed", createdAt: db.now, updatedAt: db.now });
  addWorkspaceMembership(db, { id: "88888888-8888-4888-8888-888888888889", workspaceId: "86666666-6666-4666-8666-666666666666", userId: SECOND_ADMIN_ID, role: "owner", accessState: "confirmed", createdAt: db.now, updatedAt: db.now });
  const executeLastOwnerPreview = await previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: OWNER_TARGET_ID, action: "disable", reason: "execution last owner guard" }, typedDb);
  assert.equal(executeLastOwnerPreview.canExecute, true);
  db.workspaceMemberships.splice(db.workspaceMemberships.findIndex((row) => row.userId === SECOND_ADMIN_ID && row.workspaceId === "86666666-6666-4666-8666-666666666666"), 1);
  const beforeLastOwnerExecution = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess(executeInput(executeLastOwnerPreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "execution last owner guard", requestKey: "fake-execute-last-owner" }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_LAST_OWNER_REQUIRED",
  );
  assert.deepEqual(observableMutationState(db), beforeLastOwnerExecution);
  const lastOwnerPreview = await previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: OWNER_TARGET_ID, action: "disable", reason: "last owner guard" }, typedDb);
  assert.deepEqual(lastOwnerPreview.blockingCategories, ["last_enabled_workspace_owner"]);
  await assert.rejects(
    () => executeAccountAccess(executeInput(lastOwnerPreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "last owner guard", requestKey: "fake-last-owner" }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_LAST_OWNER_REQUIRED",
  );

  const writeConflictPreview = await previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: OTHER_ID, action: "disable", reason: "write conflict mapping" }, typedDb);
  const beforeP2002 = observableMutationState(db);
  db.transactionError = new Prisma.PrismaClientKnownRequestError("unique constraint", { code: "P2002", clientVersion: "7.10.0" });
  await assert.rejects(
    () => executeAccountAccess(executeInput(writeConflictPreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "write conflict mapping", requestKey: "fake-p2002-conflict" }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFLICT",
  );
  assert.deepEqual(observableMutationState(db), beforeP2002);
  db.transactionError = new Prisma.PrismaClientKnownRequestError("foreign key constraint", { code: "P2003", clientVersion: "7.10.0" });
  await assert.rejects(
    () => executeAccountAccess(executeInput(writeConflictPreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "write conflict mapping", requestKey: "fake-p2003-conflict" }), typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFLICT",
  );
  assert.deepEqual(observableMutationState(db), beforeP2002);

  const listed = await listAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, pageSize: 2 }, typedDb);
  assert.equal(listed.items.length, 2);
  assert.equal(listed.hasNextPage, true);
  const searched = await listAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, search: "SEARCHABLE", page: 0, pageSize: 200 }, typedDb);
  assert.equal(searched.page, 1);
  assert.equal(searched.pageSize, 100);
  assert.equal(searched.items[0]?.username, "searchable-user");
  await assert.rejects(
    () => listAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 2 }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_STALE",
  );
});

test("effective access matrix fake-DB path preserves cursor boundaries, membership provenance and disabled overlays", async () => {
  const db = new FakeAccountAccessDb();
  addUser(db, { id: ADMIN_ID, username: "matrix-admin", role: "admin", createdAt: new Date("2026-09-15T00:00:00.000Z") });
  addUser(db, { id: SECOND_ADMIN_ID, username: "matrix-second-admin", role: "admin", createdAt: new Date("2026-09-15T00:01:00.000Z") });
  addUser(db, { id: TARGET_ID, username: "matrix-subject", role: "user", createdAt: new Date("2026-09-15T00:02:00.000Z"), membershipSubscription: activeSubscription(db) });
  addUser(db, { id: OTHER_ID, username: "matrix-other", role: "user", createdAt: new Date("2026-09-15T00:03:00.000Z") });
  addWorkspace(db, { id: WORKSPACE_CONFIRMED_ID, name: "Confirmed workspace", slug: "confirmed", createdAt: new Date("2026-09-15T00:10:00.000Z") });
  addWorkspace(db, { id: WORKSPACE_PENDING_ID, name: "Pending workspace", slug: "pending", createdAt: new Date("2026-09-15T00:11:00.000Z") });
  addWorkspace(db, { id: WORKSPACE_REVOKED_ID, name: "Revoked workspace", slug: "revoked", createdAt: new Date("2026-09-15T00:12:00.000Z") });
  addWorkspace(db, { id: WORKSPACE_MEMBER_ID, name: "Member workspace", slug: "member", createdAt: new Date("2026-09-15T00:13:00.000Z") });
  addWorkspace(db, { id: WORKSPACE_EMPTY_ID, name: "Direct-only workspace", slug: "direct-only", createdAt: new Date("2026-09-15T00:14:00.000Z") });
  addWorkspaceMembership(db, { id: "91111111-1111-4111-8111-111111111111", workspaceId: WORKSPACE_CONFIRMED_ID, userId: TARGET_ID, role: "owner", accessState: "confirmed", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 20_000) });
  addWorkspaceMembership(db, { id: "92222222-2222-4222-8222-222222222222", workspaceId: WORKSPACE_CONFIRMED_ID, userId: TARGET_ID, role: "viewer", accessState: "revoked", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 30_000) });
  addWorkspaceMembership(db, { id: "93333333-3333-4333-8333-333333333333", workspaceId: WORKSPACE_PENDING_ID, userId: TARGET_ID, role: "member", accessState: "pending", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 10_000) });
  addWorkspaceMembership(db, { id: "94444444-4444-4444-8444-444444444444", workspaceId: WORKSPACE_REVOKED_ID, userId: TARGET_ID, role: "viewer", accessState: "revoked", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 5_000) });
  addWorkspaceMembership(db, { id: "95555555-5555-4555-8555-555555555555", workspaceId: WORKSPACE_MEMBER_ID, userId: TARGET_ID, role: "member", accessState: "confirmed", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 15_000) });
  db.membershipAudits.push({ membershipKind: "workspace", membershipId: "92222222-2222-4222-8222-222222222222", action: "revoked", createdAt: new Date(db.now.getTime() - 25_000) });
  db.membershipAudits.push({ membershipKind: "workspace", membershipId: "94444444-4444-4444-8444-444444444444", action: "revoked", createdAt: new Date(db.now.getTime() - 4_000) });

  addProject(db, { id: PROJECT_INHERITED_ID, name: "Inherited project", slug: "inherited", workspaceId: WORKSPACE_CONFIRMED_ID, membershipInheritanceMode: "workspaceInherited", archivedAt: null, createdAt: new Date("2026-09-15T00:20:00.000Z") });
  addProject(db, { id: PROJECT_DIRECT_ID, name: "Direct project", slug: "direct", workspaceId: WORKSPACE_MEMBER_ID, membershipInheritanceMode: "projectOnly", archivedAt: null, createdAt: new Date("2026-09-15T00:21:00.000Z") });
  addProject(db, { id: PROJECT_PENDING_ID, name: "Pending project", slug: "pending-project", workspaceId: WORKSPACE_MEMBER_ID, membershipInheritanceMode: "projectOnly", archivedAt: null, createdAt: new Date("2026-09-15T00:22:00.000Z") });
  addProject(db, { id: PROJECT_REVOKED_ID, name: "Revoked project", slug: "revoked-project", workspaceId: WORKSPACE_REVOKED_ID, membershipInheritanceMode: "workspaceInherited", archivedAt: null, createdAt: new Date("2026-09-15T00:23:00.000Z") });
  addProject(db, { id: PROJECT_MISSING_ID, name: "Direct-only project", slug: "direct-only-project", workspaceId: WORKSPACE_EMPTY_ID, membershipInheritanceMode: "workspaceInherited", archivedAt: new Date("2026-09-15T00:24:00.000Z"), createdAt: new Date("2026-09-15T00:24:00.000Z") });
  addProject(db, { id: PROJECT_COMBINED_ID, name: "Combined project", slug: "combined-project", workspaceId: WORKSPACE_CONFIRMED_ID, membershipInheritanceMode: "workspaceInherited", archivedAt: null, createdAt: new Date("2026-09-15T00:25:00.000Z") });
  addProject(db, { id: PROJECT_PENDING_INHERITED_ID, name: "Pending inherited project", slug: "pending-inherited", workspaceId: WORKSPACE_PENDING_ID, membershipInheritanceMode: "workspaceInherited", archivedAt: null, createdAt: new Date("2026-09-15T00:26:00.000Z") });
  addProjectMembership(db, { id: "a1111111-1111-4111-8111-111111111111", projectId: PROJECT_DIRECT_ID, userId: TARGET_ID, role: "editor", accessState: "confirmed", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 10_000) });
  addProjectMembership(db, { id: "a2222222-2222-4222-8222-222222222222", projectId: PROJECT_PENDING_ID, userId: TARGET_ID, role: "viewer", accessState: "pending", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 9_000) });
  addProjectMembership(db, { id: "a3333333-3333-4333-8333-333333333333", projectId: PROJECT_REVOKED_ID, userId: TARGET_ID, role: "viewer", accessState: "revoked", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 8_000) });
  addProjectMembership(db, { id: "a4444444-4444-4444-8444-444444444444", projectId: PROJECT_COMBINED_ID, userId: TARGET_ID, role: "viewer", accessState: "confirmed", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 6_000) });
  addProjectMembership(db, { id: "a5555555-5555-4555-8555-555555555555", projectId: PROJECT_MISSING_ID, userId: TARGET_ID, role: "viewer", accessState: "confirmed", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 5_000) });
  db.membershipAudits.push({ membershipKind: "project", membershipId: "a3333333-3333-4333-8333-333333333333", action: "revoked", createdAt: new Date(db.now.getTime() - 7_000) });
  db.membershipAudits.push({ membershipKind: "project", membershipId: "a3333333-3333-4333-8333-333333333333", action: "revoked", createdAt: new Date(db.now.getTime() - 8_000) });

  type ScopedMatrixRow = AccessMatrixMembershipRow & { scopeId: string };
  const olderRevocation: ScopedMatrixRow = {
    scopeId: WORKSPACE_EMPTY_ID,
    id: "a7777777-7777-4777-8777-777777777777",
    role: "viewer",
    accessState: "revoked",
    createdAt: new Date(db.now.getTime() - 30_000),
    updatedAt: new Date(db.now.getTime() - 30_000),
  };
  const newerRevocation: ScopedMatrixRow = {
    ...olderRevocation,
    id: "a8888888-8888-4888-8888-888888888888",
    updatedAt: new Date(db.now.getTime() - 20_000),
  };
  const tiedRevocation: ScopedMatrixRow = {
    ...newerRevocation,
    id: "a9999999-9999-4999-8999-999999999999",
  };
  const lowerTiedRevocation: ScopedMatrixRow = {
    ...tiedRevocation,
    id: "a0000000-0000-4000-8000-000000000000",
  };
  const groupedRevocations = groupAccessMatrixMembershipRows([olderRevocation, newerRevocation, tiedRevocation, lowerTiedRevocation], (row) => row.scopeId);
  assert.equal(groupedRevocations.latestRevoked.get(WORKSPACE_EMPTY_ID)?.id, tiedRevocation.id);
  assert.throws(
    () => groupAccessMatrixMembershipRows([
      { ...olderRevocation, accessState: "confirmed" as const },
      { ...newerRevocation, accessState: "confirmed" as const },
    ], (row) => row.scopeId),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFLICT",
  );

  const typedDb = db as unknown as PrismaClient;
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-account-access-fake-"));
  const keyPath = join(keyDirectory, "master.key");
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = keyPath;
  try {
    const first = await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, pageSize: 2 }, typedDb);
    assert.equal(first.system.role, "user");
    assert.equal(first.system.effective, true);
    assert.equal(first.commercial.lifecycle, "active");
    assert.equal(first.commercial.entitlementEffective, true);
    assert.equal(first.workspaces.items.length, 2);
    assert.equal(first.workspaces.hasMore, true);
    assert.equal(first.projects.items.length, 2);
    assert.equal(first.projects.hasMore, true);
    assert.ok(first.workspaces.nextCursor);
    assert.ok(first.projects.nextCursor);

    const projectCursor = first.projects.nextCursor!;
    const cursorVariants = [
      "x".repeat(513),
      projectCursor.split(".")[0]!,
      `${projectCursor}.extra`,
      `!${projectCursor.slice(1)}`,
      `${projectCursor.slice(0, -1)}!`,
      `${projectCursor.slice(0, projectCursor.indexOf(".") + 1)}`,
    ];
    for (const malformedCursor of cursorVariants) {
      await assert.rejects(
        () => getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, projectCursor: malformedCursor, pageSize: 2 }, typedDb),
        (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
      );
    }

    const workspaceContinuation = await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, workspaceCursor: first.workspaces.nextCursor, pageSize: 2 }, typedDb);
    const projectContinuation = await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, projectCursor: first.projects.nextCursor, pageSize: 2 }, typedDb);
    assert.ok(projectContinuation.projects.nextCursor);
    const projectFinal = await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, projectCursor: projectContinuation.projects.nextCursor, pageSize: 2 }, typedDb);
    assert.ok(projectFinal.projects.nextCursor);
    const projectLast = await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, projectCursor: projectFinal.projects.nextCursor, pageSize: 2 }, typedDb);
    assert.equal(workspaceContinuation.workspaces.items.length, 2);
    assert.equal(workspaceContinuation.workspaces.hasMore, false);
    assert.equal(projectContinuation.projects.items.length, 2);
    assert.equal(projectContinuation.projects.hasMore, true);
    assert.equal(projectFinal.projects.items.length, 2);
    assert.equal(projectFinal.projects.hasMore, true);
    assert.equal(projectLast.projects.items.length, 1);
    assert.equal(projectLast.projects.hasMore, false);
    const allProjects = [...first.projects.items, ...projectContinuation.projects.items, ...projectFinal.projects.items, ...projectLast.projects.items];
    assert.equal(allProjects.find((project) => project.id === PROJECT_INHERITED_ID)?.grantedPermission, "owner");
    assert.equal(allProjects.find((project) => project.id === PROJECT_DIRECT_ID)?.grantedPermission, "edit");
    assert.equal(allProjects.find((project) => project.id === PROJECT_PENDING_ID)?.grantedPermission, null);
    assert.equal(allProjects.find((project) => project.id === PROJECT_REVOKED_ID)?.latestDirectRevocation?.evidence.kind, "membership_access_audit");
    assert.equal(allProjects.find((project) => project.id === PROJECT_MISSING_ID)?.inheritedFromWorkspace, null);
    assert.equal(allProjects.find((project) => project.id === PROJECT_COMBINED_ID)?.provenance.kind, "direct_and_workspace_inherited");
    assert.equal(allProjects.find((project) => project.id === PROJECT_PENDING_INHERITED_ID)?.inheritedFromWorkspace?.accessState, "pending");

    // Keep the fallback branches explicit: a revoked membership without an
    // audit row still exposes membership evidence, an ordinary workspace
    // member is not an inherited project grant, and a direct project record
    // must not manufacture a missing workspace relationship.
    addWorkspace(db, { id: WORKSPACE_FALLBACK_ID, name: "Revoked without audit", slug: "revoked-without-audit", createdAt: new Date("2026-09-15T00:30:00.000Z") });
    addWorkspaceMembership(db, { id: "96666666-6666-4666-8666-666666666666", workspaceId: WORKSPACE_FALLBACK_ID, userId: TARGET_ID, role: "viewer", accessState: "revoked", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 3_000) });
    addWorkspace(db, { id: WORKSPACE_ROLE_ONLY_ID, name: "Non elevated workspace", slug: "non-elevated", createdAt: new Date("2026-09-15T00:31:00.000Z") });
    addWorkspaceMembership(db, { id: "97777777-7777-4777-8777-777777777777", workspaceId: WORKSPACE_ROLE_ONLY_ID, userId: TARGET_ID, role: "member", accessState: "confirmed", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 2_000) });
    addWorkspace(db, { id: WORKSPACE_MISSING_ID, name: "No subject membership", slug: "no-subject-membership", createdAt: new Date("2026-09-15T00:32:00.000Z") });
    addProject(db, { id: PROJECT_FALLBACK_ID, name: "Revoked inherited project", slug: "revoked-inherited", workspaceId: WORKSPACE_FALLBACK_ID, membershipInheritanceMode: "workspaceInherited", archivedAt: null, createdAt: new Date("2026-09-15T00:33:00.000Z") });
    addProject(db, { id: PROJECT_ROLE_ONLY_ID, name: "Non elevated inherited project", slug: "non-elevated-inherited", workspaceId: WORKSPACE_ROLE_ONLY_ID, membershipInheritanceMode: "workspaceInherited", archivedAt: null, createdAt: new Date("2026-09-15T00:34:00.000Z") });
    addProject(db, { id: PROJECT_NO_WORKSPACE_ID, name: "Direct assignment without workspace", slug: "direct-without-workspace", workspaceId: WORKSPACE_MISSING_ID, membershipInheritanceMode: "workspaceInherited", archivedAt: null, createdAt: new Date("2026-09-15T00:35:00.000Z") });
    addProjectMembership(db, { id: "a6666666-6666-4666-8666-666666666666", projectId: PROJECT_NO_WORKSPACE_ID, userId: TARGET_ID, role: "viewer", accessState: "revoked", createdAt: db.now, updatedAt: new Date(db.now.getTime() - 1_000) });
    const fallbackMatrix = await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, pageSize: 100 }, typedDb);
    const fallbackProject = fallbackMatrix.projects.items.find((project) => project.id === PROJECT_FALLBACK_ID);
    assert.equal(fallbackProject?.latestDirectRevocation, null);
    assert.equal(fallbackProject?.inheritedFromWorkspace?.accessState, "revoked");
    assert.ok(fallbackProject?.reasons.includes("workspace_membership_revoked"));
    assert.equal(fallbackProject?.inheritedFromWorkspace?.provenance.kind, "none");
    assert.equal(fallbackMatrix.workspaces.items.find((workspace) => workspace.id === WORKSPACE_FALLBACK_ID)?.latestRevocation?.evidence.kind, "membership_record");
    const roleOnlyProject = fallbackMatrix.projects.items.find((project) => project.id === PROJECT_ROLE_ONLY_ID);
    assert.equal(roleOnlyProject?.inheritedFromWorkspace?.accessState, "confirmed");
    assert.ok(roleOnlyProject?.reasons.includes("workspace_role_not_elevated"));
    assert.equal(roleOnlyProject?.grantedPermission, null);
    const noWorkspaceProject = fallbackMatrix.projects.items.find((project) => project.id === PROJECT_NO_WORKSPACE_ID);
    assert.equal(noWorkspaceProject?.inheritedFromWorkspace, null);
    assert.ok(noWorkspaceProject?.reasons.includes("workspace_membership_missing"));
    assert.equal(noWorkspaceProject?.latestDirectRevocation?.evidence.kind, "membership_record");

    const tampered = `${first.projects.nextCursor!.slice(0, -1)}${first.projects.nextCursor!.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      () => getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, projectCursor: tampered, pageSize: 2 }, typedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
    );
    await assert.rejects(
      () => getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: OTHER_ID, projectCursor: first.projects.nextCursor, pageSize: 2 }, typedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
    );
    await assert.rejects(
      () => getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, workspaceCursor: first.projects.nextCursor, pageSize: 2 }, typedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
    );
    await assert.rejects(
      () => getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, projectCursor: first.projects.nextCursor, pageSize: 3 }, typedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
    );

    const lifecycle = db.users.get(TARGET_ID)!;
    lifecycle.membershipSubscription = { ...activeSubscription(db), startsAt: new Date(db.now.getTime() + 60_000), expiresAt: new Date(db.now.getTime() + 120_000) };
    assert.equal((await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID }, typedDb)).commercial.lifecycle, "not_started");
    lifecycle.membershipSubscription = { ...activeSubscription(db), startsAt: new Date(db.now.getTime() - 120_000), expiresAt: new Date(db.now.getTime() - 60_000) };
    assert.equal((await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID }, typedDb)).commercial.lifecycle, "expired");
    lifecycle.membershipSubscription = { ...activeSubscription(db), status: "revoked" };
    assert.equal((await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID }, typedDb)).commercial.lifecycle, "revoked");
    lifecycle.membershipSubscription = null;
    assert.equal((await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID }, typedDb)).commercial.lifecycle, "none");
    lifecycle.membershipSubscription = activeSubscription(db);
    lifecycle.disabledAt = db.now;
    const disabled = await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, pageSize: 100 }, typedDb);
    assert.equal(disabled.system.accountState, "disabled");
    assert.equal(disabled.commercial.entitlementEffective, false);
    assert.equal(disabled.workspaces.items.every((workspace) => !workspace.effective), true);
    assert.equal(disabled.projects.items.find((project) => project.id === PROJECT_INHERITED_ID)?.grantedPermission, "owner");
    assert.equal(disabled.projects.items.find((project) => project.id === PROJECT_INHERITED_ID)?.effectivePermission, null);
    lifecycle.disabledAt = null;

    const adminMatrix = await getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: ADMIN_ID, pageSize: 100 }, typedDb);
    assert.equal(adminMatrix.system.role, "admin");
    assert.equal(adminMatrix.workspaces.items.length, 0);
    assert.equal(adminMatrix.projects.items.length, 0);
    await assert.rejects(
      () => getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: "99999999-9999-4999-8999-999999999999", pageSize: 100 }, typedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_USER_NOT_FOUND",
    );
    db.users.get(ADMIN_ID)!.disabledAt = db.now;
    await assert.rejects(
      () => getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, pageSize: 100 }, typedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_REQUIRED",
    );
    db.users.get(ADMIN_ID)!.disabledAt = null;
  } finally {
    try {
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    } finally {
      try {
        const metadata = await stat(keyPath);
        assert.equal(metadata.mode & 0o077, 0);
      } finally {
        await rm(keyDirectory, { recursive: true, force: true });
      }
    }
  }
});

test("account access request fingerprints reject unsafe or malformed evidence", () => {
  const base = {
    userId: TARGET_ID,
    action: "disable" as const,
    expectedVersion: 1,
    expectedImpactFingerprint: "b".repeat(64),
    reason: "security review",
    previewIssuedAt: "2026-09-15T04:00:00.000Z",
    previewExpiresAt: "2026-09-15T04:05:00.000Z",
  };
  assert.match(accountAccessRequestFingerprint(base), /^[0-9a-f]{64}$/u);
  assert.throws(() => accountAccessRequestFingerprint({ ...base, reason: "unsafe@example.com" }), /ACCOUNT_ACCESS_UNSAFE_AUDIT_TEXT/u);
  assert.throws(() => accountAccessRequestFingerprint({ ...base, reason: "a".repeat(40) }), /ACCOUNT_ACCESS_UNSAFE_AUDIT_TEXT/u);
  assert.throws(() => accountAccessRequestFingerprint({ ...base, expectedVersion: 0 }), /ACCOUNT_ACCESS_INVALID_INPUT/u);
  assert.throws(() => accountAccessRequestFingerprint({ ...base, expectedVersion: null as never }), /ACCOUNT_ACCESS_INVALID_INPUT/u);
  assert.throws(() => accountAccessRequestFingerprint({ ...base, previewIssuedAt: "not-a-date" }), /ACCOUNT_ACCESS_INVALID_INPUT/u);
  assert.throws(() => accountAccessRequestFingerprint({ ...base, previewExpiresAt: {} as never }), /ACCOUNT_ACCESS_INVALID_INPUT/u);
});

test("account access rejects alternate clock evidence and preserves expiry boundaries", async () => {
  const db = new FakeAccountAccessDb();
  addUser(db, { id: ADMIN_ID, username: "boundary-admin", role: "admin", createdAt: new Date("2026-09-15T00:00:00.000Z") });
  addUser(db, { id: TARGET_ID, username: "boundary-target", role: "user", createdAt: new Date("2026-09-15T00:01:00.000Z") });
  const typedDb = db as unknown as PrismaClient;

  const missingAdminBefore = observableMutationState(db);
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: "66666666-6666-4666-8666-666666666666", adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "missing actor" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_REQUIRED",
  );
  assert.deepEqual(observableMutationState(db), missingAdminBefore);

  const noClockDb = new FakeAccountAccessDb();
  addUser(noClockDb, { id: ADMIN_ID, username: "no-clock-admin", role: "admin", createdAt: new Date("2026-09-15T00:00:00.000Z") });
  addUser(noClockDb, { id: TARGET_ID, username: "no-clock-target", role: "user", createdAt: new Date("2026-09-15T00:01:00.000Z") });
  (noClockDb as unknown as { $queryRaw?: unknown }).$queryRaw = undefined;
  const noClockTypedDb = noClockDb as unknown as PrismaClient;
  const noClockPreview = await previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "clock fallback" }, noClockTypedDb);
  assert.equal(noClockPreview.current.state, "enabled");
  const noClockResult = await executeAccountAccess(executeInput(noClockPreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "clock fallback", requestKey: "clock-fallback" }), noClockTypedDb);
  assert.equal(noClockResult.state, "disabled");
  assert.equal(noClockDb.audits.length, 1);

  const invalidClockDb = new FakeAccountAccessDb();
  addUser(invalidClockDb, { id: ADMIN_ID, username: "invalid-clock-admin", role: "admin", createdAt: new Date("2026-09-15T00:00:00.000Z") });
  addUser(invalidClockDb, { id: TARGET_ID, username: "invalid-clock-target", role: "user", createdAt: new Date("2026-09-15T00:01:00.000Z") });
  invalidClockDb.queryNowOverride = null;
  const invalidClockBefore = observableMutationState(invalidClockDb);
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "invalid clock" }, invalidClockDb as unknown as PrismaClient),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFLICT",
  );
  assert.deepEqual(observableMutationState(invalidClockDb), invalidClockBefore);

  const evidenceDb = new FakeAccountAccessDb();
  addUser(evidenceDb, { id: ADMIN_ID, username: "evidence-admin", role: "admin", createdAt: new Date("2026-09-15T00:00:00.000Z") });
  addUser(evidenceDb, { id: TARGET_ID, username: "evidence-target", role: "user", createdAt: new Date("2026-09-15T00:01:00.000Z") });
  const evidenceTypedDb = evidenceDb as unknown as PrismaClient;
  const evidencePreview = await previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "expiry boundary" }, evidenceTypedDb);
  const expiryCases = [
    { issuedAt: new Date(evidenceDb.now.getTime() + 6_000), expiresAt: new Date(evidenceDb.now.getTime() + 306_000), key: "future-issued" },
    { issuedAt: new Date(evidenceDb.now.getTime() + 1_000), expiresAt: new Date(evidenceDb.now.getTime() + 500), key: "reversed-window" },
    { issuedAt: new Date(evidenceDb.now.getTime() - 1_000), expiresAt: new Date(evidenceDb.now.getTime() + 301_000), key: "long-window" },
  ];
  for (const expiryCase of expiryCases) {
    const requestFingerprint = accountAccessRequestFingerprint({
      userId: TARGET_ID,
      action: "disable",
      expectedVersion: evidencePreview.current.accountAccessVersion,
      expectedImpactFingerprint: evidencePreview.impactFingerprint,
      reason: "expiry boundary",
      previewIssuedAt: expiryCase.issuedAt,
      previewExpiresAt: expiryCase.expiresAt,
    });
    const beforeExpiry = observableMutationState(evidenceDb);
    await assert.rejects(
      () => executeAccountAccess({
        ...executeInput(evidencePreview, { adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, reason: "expiry boundary", requestKey: expiryCase.key }),
        requestFingerprint,
        previewIssuedAt: expiryCase.issuedAt,
        previewExpiresAt: expiryCase.expiresAt,
      }, evidenceTypedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_EXPIRED",
    );
    assert.deepEqual(observableMutationState(evidenceDb), beforeExpiry);
  }
});

test("account access rejects malformed fingerprints and audit conflicts before mutation", async () => {
  const fingerprintBase = {
    userId: TARGET_ID,
    action: "disable" as const,
    expectedVersion: 1,
    expectedImpactFingerprint: "b".repeat(64),
    reason: "security evidence",
    previewIssuedAt: "2026-09-15T04:00:00.000Z",
    previewExpiresAt: "2026-09-15T04:05:00.000Z",
  };
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, userId: "not-a-uuid" }),
    /ACCOUNT_ACCESS_INVALID_INPUT/u,
  );
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, action: "delete" as never }),
    /ACCOUNT_ACCESS_INVALID_INPUT/u,
  );
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, expectedImpactFingerprint: "not-a-fingerprint" }),
    /ACCOUNT_ACCESS_INVALID_INPUT/u,
  );
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, reason: 42 as never }),
    /ACCOUNT_ACCESS_REASON_REQUIRED/u,
  );
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, reason: "control\u0000character" }),
    /ACCOUNT_ACCESS_UNSAFE_AUDIT_TEXT/u,
  );
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, reason: "x".repeat(501) }),
    /ACCOUNT_ACCESS_UNSAFE_AUDIT_TEXT/u,
  );
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, reason: "f".repeat(64) }),
    /ACCOUNT_ACCESS_UNSAFE_AUDIT_TEXT/u,
  );
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, previewIssuedAt: new Date(Number.NaN) }),
    /ACCOUNT_ACCESS_INVALID_INPUT/u,
  );
  assert.throws(
    () => accountAccessRequestFingerprint({ ...fingerprintBase, previewExpiresAt: new Date(Number.NaN) }),
    /ACCOUNT_ACCESS_INVALID_INPUT/u,
  );

  const db = new FakeAccountAccessDb();
  addUser(db, { id: ADMIN_ID, username: "conflict-admin", role: "admin", createdAt: new Date("2026-09-15T00:00:00.000Z") });
  addUser(db, { id: TARGET_ID, username: "conflict-target", role: "user", createdAt: new Date("2026-09-15T00:01:00.000Z") });
  const typedDb = db as unknown as PrismaClient;
  const beforeSelf = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess({
      adminUserId: ADMIN_ID,
      adminAccountAccessVersion: 1,
      userId: ADMIN_ID,
      action: "disable",
      reason: "self execute guard",
      expectedVersion: 1,
      expectedImpactFingerprint: "c".repeat(64),
      requestKey: "self-execute-key",
      requestFingerprint: "d".repeat(64),
      previewId: ADMIN_ID,
      previewIssuedAt: db.now,
      previewExpiresAt: new Date(db.now.getTime() + 300_000),
      confirmation: true,
      confirmationUsername: "conflict-admin",
    }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_SELF_FORBIDDEN",
  );
  assert.deepEqual(observableMutationState(db), beforeSelf);

  db.transactionError = new Error("serialization failure");
  await assert.rejects(
    () => previewAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, action: "disable", reason: "regex serialization" }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_CONFLICT",
  );

  const previewIdConflict = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "preview id conflict",
  }, typedDb);
  const previewIdInput = executeInput(previewIdConflict, {
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    reason: "preview id conflict",
    requestKey: "fixture-preview-id",
  });
  addAuditFixture(db, previewIdConflict, previewIdInput, { previewId: OTHER_ID });
  const beforePreviewIdConflict = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess(previewIdInput, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(observableMutationState(db), beforePreviewIdConflict);
  db.audits.splice(0, db.audits.length);

  const userIdConflict = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "audit user conflict",
  }, typedDb);
  const userIdInput = executeInput(userIdConflict, {
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    reason: "audit user conflict",
    requestKey: "fixture-user-id",
  });
  addAuditFixture(db, userIdConflict, userIdInput, { userId: OTHER_ID });
  const beforeUserIdConflict = observableMutationState(db);
  await assert.rejects(
    () => executeAccountAccess(userIdInput, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(observableMutationState(db), beforeUserIdConflict);

  const storedPreview = await previewAccountAccess({
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    userId: TARGET_ID,
    action: "disable",
    reason: "stored preview evidence",
  }, typedDb);
  const storedInput = executeInput(storedPreview, {
    adminUserId: ADMIN_ID,
    adminAccountAccessVersion: 1,
    reason: "stored preview evidence",
    requestKey: "stored-preview-evidence",
  });
  const tamperCases: ReadonlyArray<Readonly<{ field: string; value: unknown }>> = [
    { field: "actorId", value: OTHER_ID },
    { field: "userId", value: OTHER_ID },
    { field: "action", value: "restore" },
    { field: "expectedVersion", value: 2 },
    { field: "impactFingerprint", value: "e".repeat(64) },
    { field: "requestFingerprint", value: "f".repeat(64) },
    { field: "issuedAt", value: new Date(db.now.getTime() + 1) },
    { field: "expiresAt", value: new Date(db.now.getTime() + 1) },
  ];
  for (const tamperCase of tamperCases) {
    const storedRow = db.previews.get(storedPreview.previewId)!;
    const originalRow = structuredClone(storedRow);
    Object.assign(storedRow, { [tamperCase.field]: tamperCase.value });
    const beforeStoredTamper = observableMutationState(db);
    await assert.rejects(
      () => executeAccountAccess(storedInput, typedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_PREVIEW_STALE",
    );
    assert.deepEqual(observableMutationState(db), beforeStoredTamper);
    db.previews.set(storedPreview.previewId, originalRow);
  }

  for (const [message, expectedCode] of [
    ["duplicate key", "ACCOUNT_ACCESS_CONFLICT"],
    ["check_violation", "ACCOUNT_ACCESS_CONFLICT"],
  ] as const) {
    db.transactionError = new Error(message);
    const beforeMappedError = observableMutationState(db);
    await assert.rejects(
      () => executeAccountAccess(storedInput, typedDb),
      (error: unknown) => serviceCode(error) === expectedCode,
    );
    assert.deepEqual(observableMutationState(db), beforeMappedError);
  }
  db.transactionError = new Error("unrelated transaction failure");
  await assert.rejects(
    () => executeAccountAccess(storedInput, typedDb),
    /unrelated transaction failure/u,
  );

  db.users.get(TARGET_ID)!.disabledAt = db.now;
  const listedDisabled = await listAccountAccess({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, search: "conflict-target" }, typedDb);
  assert.equal(listedDisabled.items[0]?.state, "disabled");
  db.users.get(TARGET_ID)!.disabledAt = null;
  await assert.rejects(
    () => listAccountAccess({ adminUserId: OTHER_ID, adminAccountAccessVersion: 1 }, typedDb),
    (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_ADMIN_REQUIRED",
  );

  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-account-access-cursor-fake-"));
  const keyPath = join(keyDirectory, "master.key");
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = keyPath;
  try {
    const emptyCursor = await getEffectiveAccessMatrix({
      adminUserId: ADMIN_ID,
      adminAccountAccessVersion: 1,
      userId: TARGET_ID,
      workspaceCursor: null,
      projectCursor: "",
      pageSize: 0,
    }, typedDb);
    assert.equal(emptyCursor.workspaces.items.length, 0);
    assert.equal(emptyCursor.projects.items.length, 0);
    await assert.rejects(
      () => getEffectiveAccessMatrix({ adminUserId: ADMIN_ID, adminAccountAccessVersion: 1, userId: TARGET_ID, projectCursor: 42 as never }, typedDb),
      (error: unknown) => serviceCode(error) === "ACCOUNT_ACCESS_INVALID_INPUT",
    );
  } finally {
    try {
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    } finally {
      try {
        const metadata = await stat(keyPath);
        assert.equal(metadata.mode & 0o077, 0);
      } finally {
        await rm(keyDirectory, { recursive: true, force: true });
      }
    }
  }
});
