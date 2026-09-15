import assert from "node:assert/strict";
import test from "node:test";
import { MembershipAccessState, Prisma } from "@prisma/client";
import {
  findConfirmedProjectMembership,
  findConfirmedWorkspaceMembership,
} from "../src/lib/membership-governance";
import {
  ACCESS_ACTOR_LOCK_NAMESPACE,
  ACCESS_INVITATION_LOCK_NAMESPACE,
  ACCESS_PROJECT_LOCK_NAMESPACE,
  ACCESS_WORKSPACE_LOCK_NAMESPACE,
  admitWebAiProjectAccess,
  lockActorAccess,
  lockActorWorkspaceProjectAccess,
  lockActorsAccess,
  lockAppUserAccess,
  lockProjectAccess,
  lockWorkspaceAccess,
  lockWorkspaceInvitationAccess,
  WebAiAccessError,
  withWebAiProjectAccessTransaction,
} from "../src/lib/access-linearization";

const ACTOR_ID = "00000000-0000-4000-8000-000000000201";
const OTHER_ACTOR_ID = "00000000-0000-4000-8000-000000000202";
const PROJECT_ID = "00000000-0000-4000-8000-000000000203";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000204";
const MISSING_PROJECT_ID = "00000000-0000-4000-8000-000000000205";

type ActorRow = {
  id: string;
  role: "admin" | "user";
  disabledAt: Date | null;
  accountAccessVersion: number;
};

type ProjectRow = {
  id: string;
  workspaceId: string;
  archivedAt: Date | null;
  membershipInheritanceMode: "workspaceInherited" | "projectOnly";
};

type MembershipRow = {
  id: string;
  workspaceId?: string;
  projectId?: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer" | "editor";
  accessState: MembershipAccessState;
  createdAt: Date;
  updatedAt: Date;
};

function copyActor(row: ActorRow): ActorRow {
  return { ...row, disabledAt: row.disabledAt === null ? null : new Date(row.disabledAt) };
}

function copyProject(row: ProjectRow): ProjectRow {
  return { ...row, archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt) };
}

function copyMembership(row: MembershipRow): MembershipRow {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

class LinearizationFakeDb {
  readonly actors = new Map<string, ActorRow>();
  readonly projects = new Map<string, ProjectRow>();
  readonly workspaceMemberships: MembershipRow[] = [];
  readonly projectMemberships: MembershipRow[] = [];
  readonly rawCalls: Array<{ namespace: number; key: string }> = [];

  readonly appUser = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.actors.get(where.id.toLowerCase());
      return row === undefined ? null : copyActor(row);
    },
  };

  readonly project = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.projects.get(where.id.toLowerCase());
      return row === undefined ? null : copyProject(row);
    },
  };

  readonly workspaceMembership = {
    findMany: async ({ where, take = 2 }: { where: Record<string, unknown>; take?: number }) => this.workspaceMemberships
      .filter((row) => row.workspaceId === where.workspaceId
        && row.userId === where.userId
        && (where.accessState === MembershipAccessState.confirmed
          || (typeof where.accessState === "object" && where.accessState !== null
            && "not" in where.accessState && row.accessState !== (where.accessState as { not: MembershipAccessState }).not)))
      .slice(0, take)
      .map(copyMembership),
  };

  readonly projectMembership = {
    findMany: async ({ where, take = 2 }: { where: Record<string, unknown>; take?: number }) => this.projectMemberships
      .filter((row) => row.projectId === where.projectId
        && row.userId === where.userId
        && (where.accessState === MembershipAccessState.confirmed
          || (typeof where.accessState === "object" && where.accessState !== null
            && "not" in where.accessState && row.accessState !== (where.accessState as { not: MembershipAccessState }).not)))
      .slice(0, take)
      .map(copyMembership),
  };

  async $executeRaw(query: Prisma.Sql): Promise<number> {
    const values = query.values as unknown[];
    this.rawCalls.push({ namespace: Number(values.at(-1)), key: String(values[0]) });
    return 1;
  }
}

function dbFor(db: LinearizationFakeDb) {
  return db as never;
}

function accessCode(error: unknown): string | null {
  return error instanceof WebAiAccessError ? error.code : null;
}

function addFixtures(db: LinearizationFakeDb, input: Readonly<{
  inheritance: "workspaceInherited" | "projectOnly";
  actor?: Partial<ActorRow>;
  workspaceRole?: MembershipRow["role"];
  projectRole?: MembershipRow["role"];
  archivedAt?: Date | null;
}>): void {
  db.actors.set(ACTOR_ID, {
    id: ACTOR_ID,
    role: "user",
    disabledAt: null,
    accountAccessVersion: 3,
    ...input.actor,
  });
  db.projects.set(PROJECT_ID, {
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    archivedAt: input.archivedAt ?? null,
    membershipInheritanceMode: input.inheritance,
  });
  if (input.workspaceRole !== undefined) {
    db.workspaceMemberships.push({
      id: "00000000-0000-4000-8000-000000000206",
      workspaceId: WORKSPACE_ID,
      userId: ACTOR_ID,
      role: input.workspaceRole,
      accessState: MembershipAccessState.confirmed,
      createdAt: new Date("2026-09-15T01:00:00.000Z"),
      updatedAt: new Date("2026-09-15T01:00:00.000Z"),
    });
  }
  if (input.projectRole !== undefined) {
    db.projectMemberships.push({
      id: "00000000-0000-4000-8000-000000000207",
      projectId: PROJECT_ID,
      userId: ACTOR_ID,
      role: input.projectRole,
      accessState: MembershipAccessState.confirmed,
      createdAt: new Date("2026-09-15T01:00:00.000Z"),
      updatedAt: new Date("2026-09-15T01:00:00.000Z"),
    });
  }
}

function actorInput(input: Partial<{ id: string; role: ActorRow["role"]; accountAccessVersion: number }> = {}) {
  return {
    id: input.id ?? ACTOR_ID,
    role: input.role ?? "user",
    accountAccessVersion: input.accountAccessVersion ?? 3,
  } as const;
}

test("access linearization fake records canonical UUID locks in actor-workspace-project order", async () => {
  const db = new LinearizationFakeDb();
  const uppercaseActor = ACTOR_ID.toUpperCase();
  assert.equal(await lockActorAccess(dbFor(db), uppercaseActor), ACTOR_ID);
  assert.equal(await lockAppUserAccess(dbFor(db), OTHER_ACTOR_ID), OTHER_ACTOR_ID);
  assert.equal(await lockWorkspaceAccess(dbFor(db), WORKSPACE_ID.toUpperCase()), WORKSPACE_ID);
  assert.equal(await lockProjectAccess(dbFor(db), PROJECT_ID), PROJECT_ID);
  assert.equal(await lockWorkspaceInvitationAccess(dbFor(db), MISSING_PROJECT_ID), MISSING_PROJECT_ID);
  db.rawCalls.splice(0, db.rawCalls.length);

  const locked = await lockActorsAccess(dbFor(db), [uppercaseActor, OTHER_ACTOR_ID, uppercaseActor]);
  assert.deepEqual(locked, [ACTOR_ID, OTHER_ACTOR_ID].sort());
  assert.deepEqual(db.rawCalls.map((call) => call.namespace), [
    ACCESS_ACTOR_LOCK_NAMESPACE,
    ACCESS_ACTOR_LOCK_NAMESPACE,
  ]);
  assert.deepEqual(db.rawCalls.map((call) => call.key), [ACTOR_ID, OTHER_ACTOR_ID].sort());
  db.rawCalls.splice(0, db.rawCalls.length);
  const sequence = await lockActorWorkspaceProjectAccess(dbFor(db), {
    actorIds: [OTHER_ACTOR_ID, ACTOR_ID, ACTOR_ID],
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
  });
  assert.deepEqual(sequence, {
    actorIds: [ACTOR_ID, OTHER_ACTOR_ID].sort(),
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
  });
  assert.deepEqual(db.rawCalls.map((call) => call.namespace), [
    ACCESS_ACTOR_LOCK_NAMESPACE,
    ACCESS_ACTOR_LOCK_NAMESPACE,
    ACCESS_WORKSPACE_LOCK_NAMESPACE,
    ACCESS_PROJECT_LOCK_NAMESPACE,
  ]);
  db.rawCalls.splice(0, db.rawCalls.length);
  await assert.rejects(
    () => lockActorsAccess(dbFor(db), [ACTOR_ID, "not-a-uuid"]),
    (error: unknown) => accessCode(error) === "ACCESS_FORBIDDEN",
  );
  assert.equal(db.rawCalls.length, 0);
  await assert.rejects(
    () => lockWorkspaceAccess(dbFor(db), "not-a-uuid"),
    (error: unknown) => accessCode(error) === "ACCESS_FORBIDDEN",
  );
});

test("access linearization fake enforces direct versus inherited permission, lifecycle, and account epochs", async () => {
  const db = new LinearizationFakeDb();
  addFixtures(db, { inheritance: "projectOnly", workspaceRole: "owner", projectRole: "viewer" });
  const direct = await admitWebAiProjectAccess(dbFor(db), { actor: actorInput(), projectId: PROJECT_ID.toUpperCase(), required: "view" });
  assert.equal(direct.permission, "view");
  assert.equal(direct.project.id, PROJECT_ID);
  assert.equal(direct.actor.accountAccessVersion, 3);
  await assert.rejects(
    () => admitWebAiProjectAccess(dbFor(db), { actor: actorInput(), projectId: PROJECT_ID, required: "edit" }),
    (error: unknown) => accessCode(error) === "ACCESS_FORBIDDEN",
  );

  db.projectMemberships.splice(0, db.projectMemberships.length);
  await assert.rejects(
    () => admitWebAiProjectAccess(dbFor(db), { actor: actorInput(), projectId: PROJECT_ID, required: "view" }),
    (error: unknown) => accessCode(error) === "ACCESS_FORBIDDEN",
  );
  db.projects.get(PROJECT_ID)!.membershipInheritanceMode = "workspaceInherited";
  const inherited = await admitWebAiProjectAccess(dbFor(db), { actor: actorInput(), projectId: PROJECT_ID, required: "owner" });
  assert.equal(inherited.permission, "owner");
  db.projects.get(PROJECT_ID)!.archivedAt = new Date("2026-09-15T02:00:00.000Z");
  await assert.rejects(
    () => admitWebAiProjectAccess(dbFor(db), { actor: actorInput(), projectId: PROJECT_ID, required: "view" }),
    (error: unknown) => accessCode(error) === "ACCESS_FORBIDDEN",
  );
  const archived = await admitWebAiProjectAccess(dbFor(db), {
    actor: actorInput(),
    projectId: PROJECT_ID,
    required: "view",
    allowArchived: true,
  });
  assert.equal(archived.project.archivedAt?.toISOString(), "2026-09-15T02:00:00.000Z");

  db.actors.get(ACTOR_ID)!.disabledAt = new Date("2026-09-15T03:00:00.000Z");
  await assert.rejects(
    () => admitWebAiProjectAccess(dbFor(db), { actor: actorInput(), projectId: PROJECT_ID, required: "view", allowArchived: true }),
    (error: unknown) => accessCode(error) === "ACCOUNT_DISABLED",
  );
  db.actors.get(ACTOR_ID)!.disabledAt = null;
  db.actors.get(ACTOR_ID)!.accountAccessVersion = 4;
  await assert.rejects(
    () => admitWebAiProjectAccess(dbFor(db), { actor: actorInput({ accountAccessVersion: 3 }), projectId: PROJECT_ID, required: "view", allowArchived: true }),
    (error: unknown) => accessCode(error) === "ACCOUNT_ACCESS_STALE",
  );
  await assert.rejects(
    () => admitWebAiProjectAccess(dbFor(db), { actor: actorInput({ accountAccessVersion: 4 }), projectId: MISSING_PROJECT_ID, required: "view" }),
    (error: unknown) => accessCode(error) === "ACCESS_FORBIDDEN",
  );
  await assert.rejects(
    () => admitWebAiProjectAccess(dbFor(db), { actor: { id: ACTOR_ID, role: "user" } as never, projectId: PROJECT_ID, required: "view" }),
    (error: unknown) => accessCode(error) === "ACCOUNT_ACCESS_STALE",
  );
  await assert.rejects(
    () => admitWebAiProjectAccess(dbFor(db), { actor: actorInput(), projectId: PROJECT_ID, required: "invalid" as never }),
    (error: unknown) => accessCode(error) === "ACCESS_FORBIDDEN",
  );
});

test("access transaction wrapper runs admission on both direct and transaction-like clients", async () => {
  const db = new LinearizationFakeDb();
  addFixtures(db, { inheritance: "projectOnly", projectRole: "editor" });
  const direct = await withWebAiProjectAccessTransaction(
    dbFor(db),
    { actor: actorInput(), projectId: PROJECT_ID, required: "edit" },
    async (tx, admission) => {
      assert.equal(tx, dbFor(db));
      assert.equal(admission.permission, "edit");
      return admission.project.id;
    },
  );
  assert.equal(direct, PROJECT_ID);

  const transactionClient = Object.assign(db, {
    $transaction: async (callback: (tx: never) => Promise<string>) => callback(dbFor(db)),
  });
  const viaTransaction = await withWebAiProjectAccessTransaction(
    transactionClient as never,
    { actor: actorInput(), projectId: PROJECT_ID, required: "view" },
    async (_tx, admission) => admission.actor.id,
  );
  assert.equal(viaTransaction, ACTOR_ID);
  delete (transactionClient as { $transaction?: unknown }).$transaction;
  assert.equal(await findConfirmedWorkspaceMembership(dbFor(db), WORKSPACE_ID, ACTOR_ID), null);
  assert.equal(await findConfirmedProjectMembership(dbFor(db), PROJECT_ID, ACTOR_ID) !== null, true);
  assert.equal(ACCESS_INVITATION_LOCK_NAMESPACE > ACCESS_PROJECT_LOCK_NAMESPACE, true);
});
