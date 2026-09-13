import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { AutomationError, listUserNotifications } from "../src/lib/automation";
import { notificationCursorForId, rememberNotificationPageCursor } from "../src/lib/notification-navigation";
import { buildProjectPlanHealth } from "../src/lib/project-operations";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SYSTEM_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_NOTIFICATION_ID = "44444444-4444-4444-8444-444444444444";

type NotificationRow = {
  id: string;
  userId: string;
  projectId: string | null;
  kind: string;
  severity: string;
  title: string;
  body: string;
  actionHref: string | null;
  readAt: Date | null;
  createdAt: Date;
};

type FakeWhere = {
  userId?: string;
  projectId?: string | null;
  kind?: string;
  readAt?: Date | null;
  createdAt?: Date | { lt: Date };
  id?: { lt?: string };
  project?: object;
  OR?: FakeWhere[];
  AND?: FakeWhere[];
};

function row(id: string, createdAt: string, kind: string, readAt: Date | null): NotificationRow {
  return { id, userId: USER_ID, projectId: kind === "system" ? null : PROJECT_ID, kind, severity: "info", title: id, body: id, actionHref: null, readAt, createdAt: new Date(createdAt) };
}

function makeNotificationDb(rows: NotificationRow[]) {
  function matches(where: FakeWhere, value: NotificationRow): boolean {
    if (where.userId !== undefined && where.userId !== value.userId) return false;
    if (where.readAt === null && value.readAt !== null) return false;
    if (where.kind !== undefined && where.kind !== value.kind) return false;
    if (where.OR !== undefined) {
      const isVisibility = where.OR.some((branch) => branch.projectId === null || branch.project !== undefined);
      const matched = isVisibility
        ? where.OR.some((branch) => branch.projectId === null ? value.projectId === null : branch.project !== undefined && value.projectId === PROJECT_ID)
        : where.OR.some((branch) => matches(branch, value));
      if (!matched) return false;
    }
    if (where.AND !== undefined && !where.AND.every((entry) => matches(entry, value))) return false;
    if (where.createdAt !== undefined && !(where.createdAt instanceof Date) && !(value.createdAt < where.createdAt.lt)) return false;
    if (where.createdAt instanceof Date && value.createdAt.getTime() !== where.createdAt.getTime()) return false;
    if (where.id?.lt !== undefined && !(value.id < where.id.lt)) return false;
    return true;
  }
  const db = {
    notification: {
      findMany: async ({ where, take }: { where: FakeWhere; take: number }) => rows.filter((value) => matches(where, value)).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)).slice(0, take),
      count: async ({ where }: { where: FakeWhere }) => rows.filter((value) => matches(where, value)).length,
    },
  } as unknown as PrismaClient;
  return db;
}

test("empty project plans are explicit and never reported as healthy", () => {
  const health = buildProjectPlanHealth({ workItems: [], dependencies: [], evidenceLinks: [], impacts: [], actions: [] });
  assert.equal(health.status, "empty");
});

test("notification history supports all/unread/system filters and validated cursors", async () => {
  const db = makeNotificationDb([
    row(SYSTEM_ID, "2026-09-05T00:02:00.000Z", "system", null),
    row(PROJECT_NOTIFICATION_ID, "2026-09-05T00:01:00.000Z", "actionCompleted", new Date("2026-09-05T00:03:00.000Z")),
    row("55555555-5555-4555-8555-555555555555", "2026-09-05T00:00:00.000Z", "automationFailed", null),
  ]);
  const first = await listUserNotifications(USER_ID, db, { filter: "all", limit: 1 });
  assert.equal(first.notifications.length, 1);
  assert.ok(first.nextCursor);
  const second = await listUserNotifications(USER_ID, db, { filter: "all", cursor: first.nextCursor ?? undefined, limit: 1 });
  assert.equal(second.notifications.length, 1);
  assert.notEqual(second.notifications[0]?.id, first.notifications[0]?.id);
  const unread = await listUserNotifications(USER_ID, db, { filter: "unread" });
  assert.deepEqual(unread.notifications.map((item) => item.id), [SYSTEM_ID, "55555555-5555-4555-8555-555555555555"]);
  const system = await listUserNotifications(USER_ID, db, { filter: "system" });
  assert.deepEqual(system.notifications.map((item) => item.id), [SYSTEM_ID]);
  await assert.rejects(() => listUserNotifications(USER_ID, db, { filter: "all", cursor: "not-a-cursor" }), (error: unknown) => error instanceof AutomationError && error.code === "AUTOMATION_INVALID_INPUT");
});

test("notification return context restores the fetched page cursor for an appended record", () => {
  const firstPage = rememberNotificationPageCursor(new Map(), [{ id: SYSTEM_ID }], null);
  const secondPage = rememberNotificationPageCursor(firstPage, [{ id: PROJECT_NOTIFICATION_ID }], "page-two-cursor");
  assert.equal(notificationCursorForId(secondPage, SYSTEM_ID, "fallback"), null);
  assert.equal(notificationCursorForId(secondPage, PROJECT_NOTIFICATION_ID, null), "page-two-cursor");
  assert.equal(notificationCursorForId(secondPage, "66666666-6666-4666-8666-666666666666", "fallback"), "fallback");
});

test("Dashboard, deep links, return context and mobile admin entry are bounded contracts", async () => {
  const [dashboardRoute, dashboardClient, actionClient, actionRoute, actionEngine, notifications, notificationsRoute, notificationService, header] = await Promise.all([
    readFile("src/app/api/dashboard/route.ts", "utf8"),
    readFile("src/app/dashboard/dashboard-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/actions/project-actions-client.tsx", "utf8"),
    readFile("src/app/api/projects/[projectId]/actions/route.ts", "utf8"),
    readFile("src/lib/action-engine.ts", "utf8"),
    readFile("src/app/notifications/notifications-client.tsx", "utf8"),
    readFile("src/app/api/notifications/route.ts", "utf8"),
    readFile("src/lib/notification-service.ts", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
  ]);
  assert.match(dashboardRoute, /state = projects\.length === 0/u);
  assert.match(dashboardRoute, /"empty-plan"/u);
  assert.match(dashboardRoute, /cache-control/u);
  assert.match(dashboardClient, /\/projects\/\$\{job\.project\.id\}\/jobs\/\$\{job\.id\}/u);
  assert.match(dashboardClient, /href, action: "打开项目计划"/u);
  assert.match(dashboardClient, /#work-item-\$\{signal\.workItemId\}/u);
  assert.match(dashboardClient, /暂时无法确认跨项目状态/u);
  assert.match(dashboardClient, /暂时无法确认项目就绪度/u);
  assert.match(dashboardClient, /暂时无法确认最近任务/u);
  assert.match(dashboardClient, /暂时无法确认工作空间状态/u);
  assert.match(dashboardClient, /role="img" aria-label=/u);
  assert.match(dashboardClient, /work-item-\$\{signal\.workItemId\}/u);
  assert.match(actionClient, /searchParams\.get\("action"\)/u);
  assert.match(actionClient, /action: focusActionId/u);
  assert.match(actionClient, /scrollIntoView/u);
  assert.match(actionRoute, /action: z\.string\(\)\.uuid\(\)\.optional\(\)/u);
  assert.match(actionRoute, /actionId: query\.action/u);
  assert.match(actionEngine, /const actionId = input\.actionId === undefined \? undefined : uuid\(input\.actionId\)/u);
  assert.match(actionEngine, /\.\.\.\(actionId \? \{ id: actionId \}/u);
  assert.match(notificationsRoute, /filter: z/u);
  assert.match(notifications, /from=notifications/u);
  assert.match(notifications, /cursor/u);
  assert.match(notifications, /notificationCursorForId\(notificationCursorByIdRef\.current/u);
  assert.match(notifications, /target\.focus/u);
  assert.match(notifications, /opened\.destination/u);
  assert.match(notifications, /filter === "pending"/u);
  assert.match(notificationService, /CURRENT_TIMESTAMP/u);
  assert.match(notificationService, /actionState === "pending"/u);
  assert.match(notifications, /<time className="text-xs text-slate-600">/u);
  assert.match(notifications, /<span className="text-xs text-slate-600">已读<\/span>/u);
  assert.match(notifications, /"text-slate-700 hover:bg-white\/70"/u);
  assert.match(header, /isSystemAdmin \? <Link href="\/admin"/u);
  assert.match(header, /sm:hidden/u);
});
