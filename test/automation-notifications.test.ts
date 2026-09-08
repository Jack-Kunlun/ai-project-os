import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { AutomationError, listUserNotifications, markNotificationRead, openNotification } from "../src/lib/automation";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PLATFORM_NOTIFICATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_NOTIFICATION_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

type FakeNotification = {
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

type NotificationWhere = {
  id?: string;
  userId?: string;
  projectId?: string | null;
  readAt?: Date | null;
  OR?: Array<Record<string, unknown>>;
};

function makeFakeDb() {
  const notifications = new Map<string, FakeNotification>([
    [PLATFORM_NOTIFICATION_ID, {
      id: PLATFORM_NOTIFICATION_ID,
      userId: USER_ID,
      projectId: null,
      kind: "system",
      severity: "info",
      title: "平台通知",
      body: "平台维护窗口已安排。",
      actionHref: null,
      readAt: null,
      createdAt: new Date("2026-09-04T00:00:00.000Z"),
    }],
    [PROJECT_NOTIFICATION_ID, {
      id: PROJECT_NOTIFICATION_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      kind: "consentRequired",
      severity: "warning",
      title: "项目需要确认",
      body: "项目来源需要人工确认。",
      actionHref: `/projects/${PROJECT_ID}/automations`,
      readAt: null,
      createdAt: new Date("2026-09-04T00:01:00.000Z"),
    }],
  ]);
  let projectAccess = false;
  const seenWhere: NotificationWhere[] = [];

  function matches(where: NotificationWhere, notification: FakeNotification): boolean {
    seenWhere.push(where);
    if (!Array.isArray(where.OR)) throw new Error("notification operation must include visibility scope");
    if (where.id !== undefined && where.id !== notification.id) return false;
    if (where.userId !== undefined && where.userId !== notification.userId) return false;
    if (where.projectId !== undefined && where.projectId !== notification.projectId) return false;
    if (where.readAt === null && notification.readAt !== null) return false;
    if (notification.projectId === null) return where.OR.some((branch) => branch.projectId === null);
    return projectAccess && where.OR.some((branch) => "project" in branch);
  }

  function select(notification: FakeNotification, requested: Record<string, unknown> | undefined) {
    if (!requested) return { ...notification };
    return Object.fromEntries(Object.keys(requested).filter((key) => requested[key] === true).map((key) => [key, notification[key as keyof FakeNotification]]));
  }

  const db = {
    notification: {
      findMany: async ({ where, select: requested }: { where: NotificationWhere; select?: Record<string, unknown> }) => [...notifications.values()]
        .filter((notification) => matches(where, notification))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .map((notification) => select(notification, requested)),
      count: async ({ where }: { where: NotificationWhere }) => [...notifications.values()].filter((notification) => matches(where, notification)).length,
      findFirst: async ({ where, select: requested }: { where: NotificationWhere; select?: Record<string, unknown> }) => {
        const notification = [...notifications.values()].find((entry) => matches(where, entry));
        return notification ? select(notification, requested) : null;
      },
      updateMany: async ({ where, data }: { where: NotificationWhere; data: { readAt: Date | null } }) => {
        const matched = [...notifications.values()].filter((notification) => matches(where, notification));
        for (const notification of matched) notification.readAt = data.readAt;
        return { count: matched.length };
      },
    },
  } as unknown as PrismaClient;

  return {
    db,
    notifications,
    seenWhere,
    setProjectAccess(value: boolean) { projectAccess = value; },
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof AutomationError && error.code === "NOTIFICATION_NOT_FOUND";
}

test("project notifications are hidden and immutable after project access is revoked", async () => {
  const fake = makeFakeDb();

  const initial = await listUserNotifications(USER_ID, fake.db);
  assert.deepEqual(initial.notifications.map((notification) => notification.id), [PLATFORM_NOTIFICATION_ID]);
  await assert.rejects(() => openNotification(USER_ID, PROJECT_NOTIFICATION_ID, fake.db), isNotFound);
  await assert.rejects(() => markNotificationRead(USER_ID, PROJECT_NOTIFICATION_ID, true, fake.db), isNotFound);
  assert.equal(fake.notifications.get(PROJECT_NOTIFICATION_ID)?.readAt, null);

  fake.setProjectAccess(true);
  const marked = await markNotificationRead(USER_ID, PROJECT_NOTIFICATION_ID, true, fake.db);
  assert.equal(marked.id, PROJECT_NOTIFICATION_ID);
  assert.ok(marked.readAt instanceof Date);
  assert.equal(marked.actionHref, `/projects/${PROJECT_ID}/automations`);
  assert.equal(marked.title, "项目需要确认");
  const readAtAfterAuthorizedUpdate = fake.notifications.get(PROJECT_NOTIFICATION_ID)?.readAt;

  fake.setProjectAccess(false);
  await assert.rejects(() => markNotificationRead(USER_ID, PROJECT_NOTIFICATION_ID, false, fake.db), isNotFound);
  assert.equal(fake.notifications.get(PROJECT_NOTIFICATION_ID)?.readAt, readAtAfterAuthorizedUpdate);
  assert.ok(fake.seenWhere.every((where) => Array.isArray(where.OR)), "all notification reads and writes must carry the visibility predicate");
});

test("platform notifications remain readable and can be marked read without project membership", async () => {
  const fake = makeFakeDb();

  const opened = await openNotification(USER_ID, PLATFORM_NOTIFICATION_ID, fake.db);
  assert.equal(opened.id, PLATFORM_NOTIFICATION_ID);
  assert.ok(opened.readAt instanceof Date);

  const restored = await markNotificationRead(USER_ID, PLATFORM_NOTIFICATION_ID, false, fake.db);
  assert.equal(restored.id, PLATFORM_NOTIFICATION_ID);
  assert.equal(restored.readAt, null);
});
