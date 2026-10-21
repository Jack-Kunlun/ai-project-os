import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { markAllUserNotificationsRead } from "../src/lib/notification-service";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const visibleProjectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const hiddenProjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const cutoff = new Date("2026-10-22T12:00:00.000Z");

type Row = {
  userId: string;
  projectId: string | null;
  projectVisible: boolean;
  createdAt: Date;
  readAt: Date | null;
  actionState: "pending" | "resolved" | "none";
};

type UpdateInput = {
  where: {
    userId: string;
    OR: unknown[];
    readAt: null;
    createdAt: { lte: Date };
    [key: string]: unknown;
  };
  data: { readAt: Date };
};

test("mark-all-read updates every owned visible unread row through a database cutoff only", async () => {
  const rows: Row[] = Array.from({ length: 23 }, (_, index) => ({
    userId: ownerId,
    projectId: index < 11 ? null : visibleProjectId,
    projectVisible: true,
    createdAt: new Date(cutoff.getTime() - 10_000 - index),
    readAt: null,
    actionState: index === 0 ? "pending" : "none",
  }));
  rows.push(
    { userId: otherUserId, projectId: null, projectVisible: true, createdAt: new Date(cutoff.getTime() - 1_000), readAt: null, actionState: "none" },
    { userId: ownerId, projectId: hiddenProjectId, projectVisible: false, createdAt: new Date(cutoff.getTime() - 1_000), readAt: null, actionState: "pending" },
    { userId: ownerId, projectId: null, projectVisible: true, createdAt: new Date(cutoff.getTime() + 1), readAt: null, actionState: "none" },
    { userId: ownerId, projectId: null, projectVisible: true, createdAt: new Date(cutoff.getTime() - 1_000), readAt: new Date(cutoff.getTime() - 500), actionState: "resolved" },
  );

  const updates: UpdateInput[] = [];
  const db = {
    $queryRaw: async () => [{ now: cutoff }],
    notification: {
      updateMany: async (input: UpdateInput) => {
        updates.push(input);
        let count = 0;
        for (const row of rows) {
          const inScope = row.userId === input.where.userId
            && (row.projectId === null || row.projectVisible)
            && row.readAt === null
            && row.createdAt <= input.where.createdAt.lte;
          if (!inScope) continue;
          row.readAt = input.data.readAt;
          count += 1;
        }
        return { count };
      },
    },
  } as unknown as PrismaClient;

  const first = await markAllUserNotificationsRead(ownerId, db);
  assert.deepEqual(first, { markedReadCount: 23 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.where.userId, ownerId);
  assert.equal(updates[0]?.where.readAt, null);
  assert.equal(updates[0]?.where.createdAt.lte.getTime(), cutoff.getTime());
  assert.deepEqual(updates[0]?.where.OR, [
    { projectId: null },
    {
      project: {
        OR: [
          { memberships: { some: { userId: ownerId, accessState: "confirmed", user: { disabledAt: null } } } },
          { membershipInheritanceMode: "workspaceInherited", workspace: { memberships: { some: { userId: ownerId, accessState: "confirmed", role: { in: ["owner", "admin"] }, user: { disabledAt: null } } } } },
        ],
      },
    },
  ]);
  assert.equal(Object.hasOwn(updates[0]?.where ?? {}, "take"), false, "one update covers all matching pages");
  assert.equal(updates[0]?.data.readAt.getTime(), cutoff.getTime());
  assert.equal(rows[0]?.readAt?.getTime(), cutoff.getTime());
  assert.equal(rows[0]?.actionState, "pending");
  assert.equal(rows[23]?.readAt, null, "another user's row stays unread");
  assert.equal(rows[24]?.readAt, null, "a project the user cannot see stays unread");
  assert.equal(rows[25]?.readAt, null, "a row created after the cutoff stays unread");
  assert.notEqual(rows[26]?.readAt, null, "a previously read row is left read");

  const second = await markAllUserNotificationsRead(ownerId, db);
  assert.deepEqual(second, { markedReadCount: 0 });
  assert.equal(updates.length, 2, "each request uses one updateMany statement");
});

test("read-all route is same-origin, authenticated, strict-empty-body, and refreshes the current list", async () => {
  const [route, client] = await Promise.all([
    readFile("src/app/api/notifications/read-all/route.ts", "utf8"),
    readFile("src/app/notifications/notifications-client.tsx", "utf8"),
  ]);

  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /z\.object\(\{\}\)\.strict\(\)/u);
  assert.match(route, /bodySchema\.parse\(await readJsonBody\(request\)\)/u);
  assert.match(route, /cache-control.*no-store/u);
  assert.match(client, /\/api\/notifications\/read-all/u);
  assert.match(client, /body: "\{\}"/u);
  assert.match(client, /ai-project-os:notifications-changed/u);
  assert.match(client, /if \(filter === "unread" && cursor !== null\) setCursor\(null\);\s*else await reload\(\)/u);
  assert.match(client, /disabled=\{markingAllRead \|\| unreadCount === 0/u);
});
