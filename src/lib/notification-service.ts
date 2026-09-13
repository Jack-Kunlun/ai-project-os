import { createHash } from "node:crypto";
import { Prisma, type NotificationAttentionIntent, type NotificationKind, type NotificationSubjectKind, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getProjectPermission, type ProjectPermission } from "@/lib/access-control";
import { getDb } from "@/lib/db";
import { lockActorsAccess, lockProjectAccess, lockWorkspaceAccess } from "@/lib/access-linearization";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ACTION_HREF = /^\/(?!\/)[A-Za-z0-9/_?=&.-]{0,1023}$/u;

export type NotificationFilter = "all" | "unread" | "pending" | "system";
export type NotificationActionState = "none" | "pending" | "resolved" | "invalid";
export type NotificationListOptions = Readonly<{
  filter?: NotificationFilter;
  cursor?: string;
  limit?: number;
}>;

export type NotificationCreateInput = Readonly<{
  userId: string;
  projectId: string | null;
  subjectKind: NotificationSubjectKind;
  subjectId: string | null;
  attentionIntent: NotificationAttentionIntent;
  kind: NotificationKind;
  severity: "info" | "success" | "warning" | "error";
  title: string;
  body: string;
  actionHref: string | null;
  dedupeKey: string;
}>;

export type NotificationProjection = Readonly<{
  id: string;
  projectId: string | null;
  kind: NotificationKind | string;
  severity: string;
  title: string;
  body: string;
  actionHref: string | null;
  readAt: Date | null;
  createdAt: Date;
  subjectKind: NotificationSubjectKind | string;
  subjectId: string | null;
  attentionIntent: NotificationAttentionIntent | string;
  actionState: NotificationActionState;
  destination: string | null;
}>;

export class NotificationServiceError extends Error {
  constructor(readonly code: "NOTIFICATION_INVALID_INPUT" | "NOTIFICATION_NOT_FOUND") {
    super(code);
    this.name = "NotificationServiceError";
  }
}

function fail(code: NotificationServiceError["code"]): never {
  throw new NotificationServiceError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("NOTIFICATION_INVALID_INPUT");
  return value;
}

function notificationKey(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Stored destinations are retained for historical compatibility only.  All
 * current navigation is generated from the durable subject tuple below.
 */
export function safeNotificationActionHref(value: string | null): string | null {
  return value !== null && SAFE_ACTION_HREF.test(value) ? value : null;
}

function destinationFor(subjectKind: string, projectId: string, subjectId: string): string | null {
  if (subjectKind === "projectAction") return `/projects/${projectId}/actions?action=${subjectId}`;
  if (subjectKind === "backgroundJob") return `/projects/${projectId}/jobs/${subjectId}`;
  if (subjectKind === "automationRun") return `/projects/${projectId}/automations?run=${subjectId}`;
  return null;
}

function noSubjectProjection(row: NotificationRow): NotificationProjection {
  return Object.freeze({
    ...row,
    subjectKind: row.subjectKind ?? "legacy",
    subjectId: row.subjectId ?? null,
    attentionIntent: row.attentionIntent ?? "informational",
    actionHref: safeNotificationActionHref(row.actionHref),
    actionState: row.attentionIntent === "requiresAttention" ? "invalid" : "none",
    destination: null,
  });
}

type NotificationRow = Readonly<{
  id: string;
  projectId: string | null;
  kind: NotificationKind | string;
  severity: string;
  title: string;
  body: string;
  actionHref: string | null;
  readAt: Date | null;
  createdAt: Date;
  subjectKind?: NotificationSubjectKind | string;
  subjectId?: string | null;
  attentionIntent?: NotificationAttentionIntent | string;
}>;

type SubjectProjectionDb = PrismaClient & {
  project?: PrismaClient["project"];
};

type ProjectContext = { project: { archivedAt: Date | null }; permission: ProjectPermission | null } | null;
type ProjectContextCache = Map<string, Promise<ProjectContext>>;
type ActionSubject = Prisma.ProjectActionGetPayload<{ select: { id: true; projectId: true; status: true; approvalExpiresAt: true; capability: true } }>;
type JobSubject = Prisma.BackgroundJobGetPayload<{ select: { id: true; projectId: true; status: true; reconciliationRequired: true } }>;
type AutomationRunSubject = Prisma.AutomationRunGetPayload<{ select: { id: true; projectId: true; status: true; rule: { select: { id: true; projectId: true } } } }>;
type SubjectProjectionLookup = Readonly<{
  actions: ReadonlyMap<string, ActionSubject>;
  jobs: ReadonlyMap<string, JobSubject>;
  runs: ReadonlyMap<string, AutomationRunSubject>;
}>;

async function databaseNow(db: SubjectProjectionDb): Promise<Date> {
  if (typeof db.$queryRaw !== "function") return new Date();
  const rows = await db.$queryRaw<Array<{ now: Date | string }>>(Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`);
  const value = rows[0]?.now;
  const now = value instanceof Date ? value : new Date(value ?? "");
  // A real client must return a usable database timestamp. Do not silently
  // substitute process time after a query or decoding failure: approval
  // expiry is a security-sensitive boundary.
  if (!Number.isFinite(now.getTime())) throw new Error("Database returned an invalid CURRENT_TIMESTAMP value");
  return now;
}

async function currentProjectPermission(userId: string, projectId: string, db: SubjectProjectionDb): Promise<ProjectContext> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { archivedAt: true },
  });
  if (project === null) return null;
  const user = await db.appUser.findUnique({ where: { id: userId }, select: { id: true, role: true, disabledAt: true } });
  if (user === null || user.disabledAt !== null) return { project, permission: null };
  const permission = await getProjectPermission({ id: user.id, role: user.role }, projectId, db);
  return { project, permission };
}

function cachedProjectPermission(userId: string, projectId: string, db: SubjectProjectionDb, cache: ProjectContextCache): Promise<ProjectContext> {
  const key = `${userId}:${projectId}`;
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const promise = currentProjectPermission(userId, projectId, db);
  cache.set(key, promise);
  return promise;
}

function permissionAtLeast(permission: ProjectPermission | null, required: ProjectPermission): boolean {
  if (permission === null) return false;
  const rank: Record<ProjectPermission, number> = { view: 1, edit: 2, owner: 3 };
  return rank[permission] >= rank[required];
}

function actionRequiredPermission(capability: string): ProjectPermission {
  // Keep this aligned with the action capability catalog.  The notification
  // projection intentionally fails closed for unknown capabilities.
  if (capability === "project.web-source.sync" || capability === "project.mcp.read-tool.invoke") return "owner";
  if (capability === "project.repository.sync" || capability === "project.memory-quality.scan") return "edit";
  return "owner";
}

async function projectActionState(row: NotificationRow, userId: string, db: SubjectProjectionDb, subjectId: string, now: Date, cache: ProjectContextCache, lookup?: SubjectProjectionLookup): Promise<NotificationActionState> {
  const context = await cachedProjectPermission(userId, row.projectId!, db, cache);
  if (context === null || context.project.archivedAt !== null) return "invalid";
  const action = lookup === undefined
    ? await db.projectAction.findUnique({ where: { id: subjectId }, select: { projectId: true, status: true, approvalExpiresAt: true, capability: true } })
    : lookup.actions.get(subjectId) ?? null;
  if (action === null || action.projectId !== row.projectId) return "invalid";
  if (row.attentionIntent !== "requiresAttention") return "resolved";
  if (row.kind === "actionApprovalRequired") {
    if (action.status !== "waitingApproval") return "resolved";
    if (action.approvalExpiresAt === null || action.approvalExpiresAt.getTime() <= now.getTime()) return "invalid";
    return context.permission === "owner" ? "pending" : "invalid";
  }
  if (row.kind === "actionFailed") {
    if (action.status !== "failed") return "resolved";
    return permissionAtLeast(context.permission, actionRequiredPermission(action.capability)) ? "pending" : "invalid";
  }
  return "invalid";
}

async function backgroundJobState(row: NotificationRow, userId: string, db: SubjectProjectionDb, subjectId: string, cache: ProjectContextCache, lookup?: SubjectProjectionLookup): Promise<NotificationActionState> {
  const context = await cachedProjectPermission(userId, row.projectId!, db, cache);
  if (context === null || context.project.archivedAt !== null) return "invalid";
  const job = lookup === undefined
    ? await db.backgroundJob.findUnique({ where: { id: subjectId }, select: { projectId: true, status: true, reconciliationRequired: true } })
    : lookup.jobs.get(subjectId) ?? null;
  if (job === null || job.projectId !== row.projectId) return "invalid";
  if (row.attentionIntent !== "requiresAttention") return "resolved";
  const attention = job.status === "failed" || (job.status === "unknown" && job.reconciliationRequired);
  if (!attention) return "resolved";
  return permissionAtLeast(context.permission, "edit") ? "pending" : "invalid";
}

async function automationRunState(row: NotificationRow, userId: string, db: SubjectProjectionDb, subjectId: string, cache: ProjectContextCache, lookup?: SubjectProjectionLookup): Promise<NotificationActionState> {
  const context = await cachedProjectPermission(userId, row.projectId!, db, cache);
  if (context === null || context.project.archivedAt !== null) return "invalid";
  const run = lookup === undefined
    ? await db.automationRun.findUnique({
      where: { id: subjectId },
      select: { projectId: true, status: true, rule: { select: { id: true, projectId: true } } },
    })
    : lookup.runs.get(subjectId) ?? null;
  if (run === null || run.projectId !== row.projectId || run.rule.projectId !== row.projectId) return "invalid";
  if (row.attentionIntent !== "requiresAttention") return "resolved";
  if (row.kind !== "automationFailed" || run.status !== "failed") return "resolved";
  return context.permission === "owner" ? "pending" : "invalid";
}

export async function projectNotification(
  row: NotificationRow,
  userIdInput: unknown,
  db: SubjectProjectionDb = getDb(),
  now?: Date,
  contextCache: ProjectContextCache = new Map(),
  subjectLookup?: SubjectProjectionLookup,
): Promise<NotificationProjection> {
  const userId = uuid(userIdInput);
  const subjectKind = row.subjectKind ?? "legacy";
  const subjectId = row.subjectId ?? null;
  const attentionIntent = row.attentionIntent ?? "informational";
  const normalized: NotificationRow & { subjectKind: string; subjectId: string | null; attentionIntent: string } = { ...row, subjectKind, subjectId, attentionIntent };
  if (subjectKind === "legacy" || subjectId === null || row.projectId === null) return noSubjectProjection(normalized);
  if (!UUID_PATTERN.test(subjectId)) return Object.freeze({ ...noSubjectProjection(normalized), actionState: "invalid" });
  const projectionNow = now ?? await databaseNow(db);
  const actionState = subjectKind === "projectAction"
    ? await projectActionState(normalized, userId, db, subjectId, projectionNow, contextCache, subjectLookup)
    : subjectKind === "backgroundJob"
      ? await backgroundJobState(normalized, userId, db, subjectId, contextCache, subjectLookup)
      : subjectKind === "automationRun"
        ? await automationRunState(normalized, userId, db, subjectId, contextCache, subjectLookup)
        : "invalid";
  return Object.freeze({
    ...normalized,
    actionHref: safeNotificationActionHref(row.actionHref ?? null),
    actionState,
    destination: actionState === "pending" || actionState === "resolved" ? destinationFor(subjectKind, row.projectId, subjectId) : null,
  });
}

export async function persistNotification(input: NotificationCreateInput, db: PrismaClient): Promise<void> {
  if (!UUID_PATTERN.test(input.userId) || (input.projectId !== null && !UUID_PATTERN.test(input.projectId))) return;
  if (input.subjectKind === "legacy" && (input.subjectId !== null || input.attentionIntent !== "informational")) return;
  if (input.subjectKind !== "legacy" && (input.projectId === null || input.subjectId === null || !UUID_PATTERN.test(input.subjectId))) return;
  if (input.actionHref !== null && !SAFE_ACTION_HREF.test(input.actionHref)) return;
  const dedupeKey = notificationKey(input.dedupeKey);
  const persist = async (tx: PrismaClient | Prisma.TransactionClient) => {
    await tx.notification.upsert({
      where: { userId_dedupeKey: { userId: input.userId, dedupeKey } },
      create: { ...input, dedupeKey },
      update: { title: input.title, body: input.body, severity: input.severity, actionHref: input.actionHref, readAt: null },
    });
  };
  if (input.projectId === null) {
    await persist(db);
    return;
  }
  const project = await db.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
  if (project === null) {
    // A schema-valid Project always returns its workspaceId. Keep the
    // fallback only for narrow in-memory workflow doubles that expose a
    // count but cannot model this metadata lookup; a real missing project is
    // still dropped without attempting a write.
    const exists = await db.project.count({ where: { id: input.projectId } });
    if (exists === 0) return;
    await persist(db);
    return;
  }
  await db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [input.userId]);
    await lockWorkspaceAccess(tx, project.workspaceId);
    await lockProjectAccess(tx, input.projectId!);
    const visible = await tx.project.findFirst({
      where: {
        id: input.projectId!,
        OR: [
          { memberships: { some: { userId: input.userId, accessState: "confirmed", user: { disabledAt: null } } } },
          { membershipInheritanceMode: "workspaceInherited", workspace: { memberships: { some: { userId: input.userId, accessState: "confirmed", role: { in: ["owner", "admin"] }, user: { disabledAt: null } } } } },
        ],
      },
      select: { id: true },
    });
    if (visible === null) return;
    await persist(tx);
  });
}

const notificationCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
}).strict();

function encodeNotificationCursor(notification: Readonly<{ createdAt: Date; id: string }>): string {
  return Buffer.from(JSON.stringify({ createdAt: notification.createdAt.toISOString(), id: notification.id }), "utf8").toString("base64url");
}

function decodeNotificationCursor(value: string | undefined): { createdAt: Date; id: string } | null {
  if (value === undefined) return null;
  if (value.length === 0 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) return fail("NOTIFICATION_INVALID_INPUT");
  try {
    const parsed = notificationCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime())) return fail("NOTIFICATION_INVALID_INPUT");
    return { createdAt, id: parsed.id };
  } catch {
    return fail("NOTIFICATION_INVALID_INPUT");
  }
}

const notificationSelect = {
  id: true,
  projectId: true,
  subjectKind: true,
  subjectId: true,
  attentionIntent: true,
  kind: true,
  severity: true,
  title: true,
  body: true,
  actionHref: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

async function loadSubjectProjectionLookup(
  rows: readonly NotificationRow[],
  userId: string,
  db: SubjectProjectionDb,
  cache: ProjectContextCache,
): Promise<SubjectProjectionLookup> {
  const actionIds = [...new Set(rows.filter((row) => row.subjectKind === "projectAction" && row.subjectId !== null).map((row) => row.subjectId!))];
  const jobIds = [...new Set(rows.filter((row) => row.subjectKind === "backgroundJob" && row.subjectId !== null).map((row) => row.subjectId!))];
  const runIds = [...new Set(rows.filter((row) => row.subjectKind === "automationRun" && row.subjectId !== null).map((row) => row.subjectId!))];
  const [actions, jobs, runs] = await Promise.all([
    actionIds.length === 0
      ? Promise.resolve([] as ActionSubject[])
      : db.projectAction.findMany({ where: { id: { in: actionIds } }, select: { id: true, projectId: true, status: true, approvalExpiresAt: true, capability: true } }),
    jobIds.length === 0
      ? Promise.resolve([] as JobSubject[])
      : db.backgroundJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, projectId: true, status: true, reconciliationRequired: true } }),
    runIds.length === 0
      ? Promise.resolve([] as AutomationRunSubject[])
      : db.automationRun.findMany({ where: { id: { in: runIds } }, select: { id: true, projectId: true, status: true, rule: { select: { id: true, projectId: true } } } }),
  ]);
  const projectIds = [...new Set(rows
    .filter((row) => row.subjectId !== null && row.subjectKind !== undefined && row.subjectKind !== "legacy")
    .map((row) => row.projectId)
    .filter((projectId): projectId is string => projectId !== null))];
  await Promise.all(projectIds.map((projectId) => cachedProjectPermission(userId, projectId, db, cache)));
  return Object.freeze({
    actions: new Map(actions.map((action) => [action.id, action])),
    jobs: new Map(jobs.map((job) => [job.id, job])),
    runs: new Map(runs.map((run) => [run.id, run])),
  });
}

function cursorWhere(cursor: { createdAt: Date; id: string } | null): Prisma.NotificationWhereInput {
  return cursor === null ? {} : { AND: [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] };
}

function visibilityWhere(userId: string): Prisma.NotificationWhereInput {
  return {
    userId,
    OR: [
      { projectId: null },
      {
        project: {
          OR: [
            { memberships: { some: { userId, accessState: "confirmed", user: { disabledAt: null } } } },
            { membershipInheritanceMode: "workspaceInherited", workspace: { memberships: { some: { userId, accessState: "confirmed", role: { in: ["owner", "admin"] }, user: { disabledAt: null } } } } },
          ],
        },
      },
    ],
  };
}

const PENDING_SCAN_BATCH_SIZE = 100;

async function scanPendingNotifications(
  userId: string,
  db: SubjectProjectionDb,
  now: Date,
  limit: number,
  cache: ProjectContextCache,
  startingCursor: { createdAt: Date; id: string } | null = null,
): Promise<{ rows: NotificationProjection[]; count: number }> {
  const rows: NotificationProjection[] = [];
  let count = 0;
  let scanCursor: { createdAt: Date; id: string } | null = startingCursor;
  for (;;) {
    const batch: NotificationRow[] = await db.notification.findMany({
      where: {
        ...visibilityWhere(userId),
        attentionIntent: "requiresAttention",
        subjectKind: { not: "legacy" },
        ...cursorWhere(scanCursor),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PENDING_SCAN_BATCH_SIZE,
      select: notificationSelect,
    });
    if (batch.length === 0) break;
    const subjectLookup = await loadSubjectProjectionLookup(batch, userId, db, cache);
    for (const row of batch) {
      const item = await projectNotification(row, userId, db, now, cache, subjectLookup);
      if (item.actionState !== "pending") continue;
      count += 1;
      if (rows.length < limit + 1) rows.push(item);
    }
    const last: NotificationRow | undefined = batch.at(-1);
    if (last === undefined || batch.length < PENDING_SCAN_BATCH_SIZE) break;
    scanCursor = { createdAt: last.createdAt, id: last.id };
  }
  return { rows, count };
}

export async function listUserNotifications(userIdInput: unknown, db: SubjectProjectionDb = getDb(), options: NotificationListOptions = {}) {
  const userId = uuid(userIdInput);
  const filter = options.filter ?? "all";
  if (filter !== "all" && filter !== "unread" && filter !== "pending" && filter !== "system") return fail("NOTIFICATION_INVALID_INPUT");
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail("NOTIFICATION_INVALID_INPUT");
  const cursor = decodeNotificationCursor(options.cursor);
  const now = await databaseNow(db);
  const cache: ProjectContextCache = new Map();
  const baseWhere: Prisma.NotificationWhereInput = {
    ...visibilityWhere(userId),
    ...(filter === "unread" ? { readAt: null } : {}),
    ...(filter === "system" ? { kind: "system" } : {}),
    ...(filter === "pending" ? { attentionIntent: "requiresAttention", subjectKind: { not: "legacy" } } : {}),
    ...cursorWhere(cursor),
  };
  const pending = filter === "pending"
    ? await scanPendingNotifications(userId, db, now, limit, cache, cursor)
    : null;
  const rows = pending?.rows ?? await db.notification.findMany({ where: baseWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, select: notificationSelect });
  const projected: NotificationProjection[] = [];
  if (pending !== null) projected.push(...pending.rows);
  else {
    const subjectLookup = await loadSubjectProjectionLookup(rows, userId, db, cache);
    for (const row of rows) projected.push(await projectNotification(row, userId, db, now, cache, subjectLookup));
  }
  const page = projected.slice(0, limit);
  const hasNext = projected.length > limit;
  const last = page.at(-1);
  const [unreadCount, pendingCount] = await Promise.all([
    db.notification.count({ where: { ...visibilityWhere(userId), readAt: null } }),
    pending === null
      ? listPendingCount(userId, db, now, cache)
      : cursor === null
        ? Promise.resolve(pending.count)
        : scanPendingNotifications(userId, db, now, 0, cache).then((result) => result.count),
  ]);
  return Object.freeze({ filter, notifications: page, unreadCount, pendingCount, nextCursor: hasNext && last !== undefined ? encodeNotificationCursor(last) : null });
}

async function listPendingCount(userId: string, db: SubjectProjectionDb, now: Date, cache: ProjectContextCache): Promise<number> {
  return (await scanPendingNotifications(userId, db, now, 0, cache)).count;
}

export async function openNotification(userIdInput: unknown, notificationIdInput: unknown, db: SubjectProjectionDb = getDb()) {
  const userId = uuid(userIdInput);
  const notificationId = uuid(notificationIdInput);
  const visible = visibilityWhere(userId);
  const current = await db.notification.findFirst({ where: { ...visible, id: notificationId }, select: notificationSelect });
  if (current === null) return fail("NOTIFICATION_NOT_FOUND");
  await db.notification.updateMany({ where: { ...visible, id: notificationId, readAt: null }, data: { readAt: new Date() } });
  const notification = await db.notification.findFirst({ where: { ...visible, id: notificationId }, select: notificationSelect });
  if (notification === null) return fail("NOTIFICATION_NOT_FOUND");
  const now = await databaseNow(db);
  return projectNotification(notification, userId, db, now);
}

export async function markNotificationRead(userIdInput: unknown, notificationIdInput: unknown, read: boolean, db: SubjectProjectionDb = getDb()) {
  const userId = uuid(userIdInput);
  const notificationId = uuid(notificationIdInput);
  const visible = visibilityWhere(userId);
  const updated = await db.notification.updateMany({ where: { ...visible, id: notificationId }, data: { readAt: read ? new Date() : null } });
  if (updated.count !== 1) return fail("NOTIFICATION_NOT_FOUND");
  const now = await databaseNow(db);
  const notification = await db.notification.findFirst({ where: { ...visible, id: notificationId }, select: notificationSelect });
  if (notification === null) return fail("NOTIFICATION_NOT_FOUND");
  return projectNotification(notification, userId, db, now);
}

export type { NotificationRow };
