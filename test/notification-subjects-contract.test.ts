import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("R-07 notification subject contract keeps durable state and server-owned navigation", async () => {
  const [schema, migration, service, automation, actionEngine, workflow, probe, route, client, principals] = await Promise.all([
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260913020000_add_trustworthy_notification_subjects/migration.sql", "utf8"),
    readFile("src/lib/notification-service.ts", "utf8"),
    readFile("src/lib/automation.ts", "utf8"),
    readFile("src/lib/action-engine.ts", "utf8"),
    readFile("src/lib/project-workflow.ts", "utf8"),
    readFile("src/lib/platform-provider-probe-service.ts", "utf8"),
    readFile("src/app/api/notifications/route.ts", "utf8"),
    readFile("src/app/notifications/notifications-client.tsx", "utf8"),
    readFile("src/lib/database-principal-catalog.ts", "utf8"),
  ]);

  assert.match(schema, /subjectKind\s+NotificationSubjectKind/u);
  assert.match(schema, /subjectId\s+String\?\s+@db\.Uuid/u);
  assert.match(schema, /attentionIntent\s+NotificationAttentionIntent/u);
  assert.match(schema, /@@index\(\[userId, attentionIntent, createdAt, id\]\)/u);
  assert.match(schema, /@@index\(\[subjectKind, subjectId\]\)/u);
  assert.match(migration, /Notification_subject_context_check/u);
  assert.match(migration, /Notification_subject_context_guard/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION "notification_subject_context_guard"\(\) FROM PUBLIC/u);
  assert.doesNotMatch(migration, /\[0-9a-fA-F-\]\{36\}/u);
  assert.doesNotMatch(migration, /\[1-8\]/u);
  assert.match(migration, /n\."kind" = 'system'/u);
  assert.match(migration, /j\."status" = 'failed'/u);
  assert.equal(migration.includes("\\?"), true);
  assert.match(service, /SELECT CURRENT_TIMESTAMP/u);
  assert.match(service, /take: PENDING_SCAN_BATCH_SIZE/u);
  assert.match(service, /attentionIntent === "requiresAttention"/u);
  assert.match(service, /\/projects\/\$\{projectId\}\/actions\?action=/u);
  assert.match(service, /\/projects\/\$\{projectId\}\/jobs\/\$\{subjectId\}/u);
  assert.match(service, /\/projects\/\$\{projectId\}\/automations\?run=/u);
  assert.match(automation, /subjectKind: "automationRun"/u);
  assert.match(actionEngine, /subjectKind: "projectAction"/u);
  assert.match(workflow, /subjectKind: "backgroundJob"/u);
  assert.match(probe, /subjectKind: "legacy"/u);
  assert.match(route, /z\.enum\(\["all", "unread", "pending", "system"\]\)/u);
  assert.match(client, /opened\.destination/u);
  assert.doesNotMatch(client, /typeof opened\.actionHref/u);
  assert.match(principals, /"Notification"/u);
  assert.match(principals, /notification_subject_context_guard/u);
});
