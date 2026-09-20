import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "pg";
import type {
  NotificationAttentionIntent,
  NotificationKind,
  NotificationSubjectKind,
  PrismaClient,
} from "@prisma/client";
import { getDb } from "../src/lib/db";
import {
  listUserNotifications,
  openNotification,
  type NotificationListOptions,
} from "../src/lib/automation";
import {
  persistNotification,
  projectNotification,
  type NotificationCreateInput,
} from "../src/lib/notification-service";
import { grantProjectMembership, revokeProjectMembership } from "../src/lib/membership-governance";
import { reconcileProjectJob } from "../src/lib/project-workflow";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";

const shouldRun = process.env.NOTIFICATION_SUBJECTS_POSTGRES_GATE === "1";
const repositoryRoot = process.cwd();
const notificationMigration = "20260913020000_add_trustworthy_notification_subjects";
const execFile = promisify(execFileCallback);

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/u.test(value)) throw new Error("NOTIFICATION_SUBJECTS_UPGRADE_IDENTIFIER_INVALID");
  return `"${value}"`;
}

function upgradeDatabaseName(suffix: string): string {
  const normalized = suffix.replaceAll("-", "");
  if (!/^[0-9a-f]{8,32}$/u.test(normalized)) throw new Error("NOTIFICATION_SUBJECTS_UPGRADE_DATABASE_INVALID");
  return `ai_project_os_notification_upgrade_${normalized}_test`;
}

async function migrationNamesFromDisk(): Promise<readonly string[]> {
  const entries = await readdir(join(repositoryRoot, "prisma", "migrations"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function stageMigrations(tempRoot: string, names: readonly string[]): Promise<void> {
  const migrationsRoot = join(tempRoot, "prisma", "migrations");
  await mkdir(migrationsRoot, { recursive: true });
  for (const name of names) {
    await cp(join(repositoryRoot, "prisma", "migrations", name), join(migrationsRoot, name), { recursive: true, force: true });
  }
  await cp(join(repositoryRoot, "prisma", "migrations", "migration_lock.toml"), join(migrationsRoot, "migration_lock.toml"), { force: true });
}

async function deployStagedMigrations(tempRoot: string, databaseUrl: string): Promise<void> {
  await execFile(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", join(tempRoot, "prisma.config.ts")],
    {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function runHistoricalBackfillGate(): Promise<void> {
  const configuredDatabaseUrl = process.env.DATABASE_URL;
  if (typeof configuredDatabaseUrl !== "string" || configuredDatabaseUrl.length === 0) throw new Error("NOTIFICATION_SUBJECTS_GATE_DATABASE_URL_REQUIRED");
  const target = new URL(configuredDatabaseUrl);
  const databaseName = upgradeDatabaseName(randomUUID());
  target.pathname = `/${databaseName}`;
  target.search = "";
  target.hash = "";
  const admin = new Client({ connectionString: configuredDatabaseUrl, connectionTimeoutMillis: 5_000 });
  let tempRoot: string | null = null;
  let oldClient: Client | null = null;
  let upgradedClient: Client | null = null;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
    const allMigrations = await migrationNamesFromDisk();
    const beforeR07 = allMigrations.filter((name) => name < notificationMigration);
    tempRoot = await mkdtemp(join(tmpdir(), "ai-project-os-notification-upgrade-"));
    await stageMigrations(tempRoot, beforeR07);
    await writeFile(join(tempRoot, "prisma.config.ts"), `import { defineConfig, env } from "prisma/config";\nexport default defineConfig({ schema: ${JSON.stringify(join(repositoryRoot, "prisma", "schema.prisma"))}, migrations: { path: ${JSON.stringify(join(tempRoot, "prisma", "migrations"))} }, datasource: { url: env("DATABASE_URL") } });\n`);
    await deployStagedMigrations(tempRoot, target.toString());

    const actionProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const actionId = randomUUID();
    const jobId = randomUUID();
    const succeededJobId = randomUUID();
    const runId = randomUUID();
    const missingId = randomUUID();
    const uuidV7 = "00000000-0000-7000-8000-000000000007";
    const uuidV8 = "00000000-0000-8000-8000-000000000008";
    const userId = randomUUID();
    const now = new Date();
    oldClient = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 5_000 });
    await oldClient.connect();
    await oldClient.query("BEGIN");
    await oldClient.query(`INSERT INTO "AppUser" ("id", "username", "passwordHash", "passwordSalt", "passwordVersion", "role", "updatedAt") VALUES ($1, $2, repeat('a', 43), repeat('b', 22), 1, 'user', $3)`, [userId, `notification_upgrade_${userId.slice(0, 8)}`, now]);
    await oldClient.query(`INSERT INTO "Project" ("id", "name", "slug", "updatedAt") VALUES ($1, $2, $3, $4), ($5, $6, $7, $4)`, [actionProjectId, "Notification upgrade", `notification-upgrade-${actionProjectId.slice(0, 8)}`, now, otherProjectId, "Notification upgrade other", `notification-upgrade-other-${otherProjectId.slice(0, 8)}`]);
    await oldClient.query(`INSERT INTO "ProjectAction" ("id", "projectId", "capability", "riskLevel", "status", "input", "inputFingerprint", "policyModeSnapshot", "idempotencyKey", "requestedById", "approvalExpiresAt", "completedAt", "updatedAt") VALUES ($1, $2, 'project.repository.sync', 'medium', 'waiting_approval', '{}', repeat('a', 64), 'approval_required', repeat('b', 64), $3, $4, NULL, $5)`, [actionId, actionProjectId, userId, new Date(now.getTime() + 60_000), now]);
    await oldClient.query(`INSERT INTO "BackgroundJob" ("id", "projectId", "kind", "status", "idempotencyKey", "requestedById", "payload") VALUES ($1, $2, 'project_brief', 'failed', repeat('c', 64), $3, '{}')`, [jobId, actionProjectId, userId]);
    await oldClient.query(`INSERT INTO "BackgroundJob" ("id", "projectId", "kind", "status", "idempotencyKey", "requestedById", "payload", "completedAt") VALUES ($1, $2, 'project_brief', 'succeeded', repeat('d', 64), $3, '{}', $4)`, [succeededJobId, actionProjectId, userId, now]);
    await oldClient.query(`INSERT INTO "AutomationRule" ("id", "projectId", "name", "kind", "intervalMinutes", "nextRunAt", "createdById", "updatedAt") VALUES ($1, $2, 'Upgrade rule', 'project_brief', 60, $3, $4, $5)`, [randomUUID(), actionProjectId, new Date(now.getTime() + 60_000), userId, now]);
    const rule = await oldClient.query<{ id: string }>(`SELECT "id" FROM "AutomationRule" WHERE "projectId" = $1`, [actionProjectId]);
    await oldClient.query(`INSERT INTO "AutomationRun" ("id", "automationRuleId", "projectId", "status", "scheduledFor", "completedAt") VALUES ($1, $2, $3, 'failed', $4, $4)`, [runId, rule.rows[0]!.id, actionProjectId, now]);
    const rows = [
      [randomUUID(), actionProjectId, "action_approval_required", `/projects/${actionProjectId}/actions?action=${actionId}`, "valid-action"],
      [randomUUID(), actionProjectId, "system", `/projects/${actionProjectId}/jobs/${jobId}`, "valid-job"],
      [randomUUID(), actionProjectId, "system", `/projects/${actionProjectId}/jobs/${succeededJobId}`, "succeeded-job"],
      [randomUUID(), actionProjectId, "automation_failed", `/projects/${actionProjectId}/automations?run=${runId}`, "valid-run"],
      [randomUUID(), actionProjectId, "system", `/projects/${actionProjectId}/actions?action=${"not-a-valid-uuid"}`, "pseudo-uuid"],
      [randomUUID(), actionProjectId, "action_approval_required", `/projects/${actionProjectId}/actions?action=${uuidV7}`, "uuid-v7"],
      [randomUUID(), actionProjectId, "system", `/projects/${actionProjectId}/jobs/${uuidV8}`, "uuid-v8"],
      [randomUUID(), actionProjectId, "action_approval_required", `/projects/${actionProjectId}/jobs/${jobId}`, "non-system-job"],
      [randomUUID(), otherProjectId, "action_approval_required", `/projects/${actionProjectId}/actions?action=${actionId}`, "project-mismatch"],
      [randomUUID(), actionProjectId, "action_approval_required", `/projects/${actionProjectId}/actions?action=${missingId}`, "missing-subject"],
      [randomUUID(), actionProjectId, "system", `/projects/${actionProjectId}/actions/${actionId}`, "legacy-url"],
      [randomUUID(), actionProjectId, "system", null, "no-url"],
    ] as const;
    for (const [id, projectId, kind, actionHref, label] of rows) {
      await oldClient.query(`INSERT INTO "Notification" ("id", "userId", "projectId", "kind", "severity", "title", "body", "actionHref", "dedupeKey") VALUES ($1, $2, $3, $4::"NotificationKind", 'warning', $5::varchar(160), $5::text, $6, $7)`, [id, userId, projectId, kind, label, actionHref, digest(`notification-upgrade-${label}`)]);
    }
    await oldClient.query("COMMIT");
    await oldClient.end();
    oldClient = null;

    await stageMigrations(tempRoot, [...beforeR07, notificationMigration]);
    await deployStagedMigrations(tempRoot, target.toString());
    upgradedClient = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 5_000 });
    await upgradedClient.connect();
    const migrated = await upgradedClient.query<{ title: string; subject_kind: string; subject_id: string | null; attention_intent: string }>(`SELECT "title", "subjectKind"::text AS subject_kind, "subjectId"::text AS subject_id, "attentionIntent"::text AS attention_intent FROM "Notification" WHERE "userId" = $1 ORDER BY "title"`, [userId]);
    const byTitle = new Map(migrated.rows.map((row) => [row.title, row]));
    assert.deepEqual(byTitle.get("valid-action"), { title: "valid-action", subject_kind: "project_action", subject_id: actionId, attention_intent: "requires_attention" });
    assert.deepEqual(byTitle.get("valid-job"), { title: "valid-job", subject_kind: "background_job", subject_id: jobId, attention_intent: "requires_attention" });
    assert.deepEqual(byTitle.get("succeeded-job"), { title: "succeeded-job", subject_kind: "background_job", subject_id: succeededJobId, attention_intent: "informational" });
    assert.deepEqual(byTitle.get("valid-run"), { title: "valid-run", subject_kind: "automation_run", subject_id: runId, attention_intent: "requires_attention" });
    for (const title of ["pseudo-uuid", "uuid-v7", "uuid-v8", "non-system-job", "project-mismatch", "missing-subject", "legacy-url", "no-url"]) {
      const row = byTitle.get(title);
      assert.deepEqual(row, { title, subject_kind: "legacy", subject_id: null, attention_intent: "informational" });
    }
  } finally {
    if (oldClient !== null) {
      await oldClient.query("ROLLBACK").catch(() => undefined);
      await oldClient.end().catch(() => undefined);
    }
    if (upgradedClient !== null) await upgradedClient.end().catch(() => undefined);
    if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

async function createNotification(
  db: PrismaClient,
  input: Omit<NotificationCreateInput, "dedupeKey"> & { dedupeKey: string },
) {
  await persistNotification(input, db);
  return db.notification.findFirstOrThrow({ where: { userId: input.userId, title: input.title } });
}

async function listPending(db: PrismaClient, userId: string, options: Omit<NotificationListOptions, "filter"> = {}) {
  return listUserNotifications(userId, db, { ...options, filter: "pending" });
}

test(
  "notification subjects project pending state from PostgreSQL state, time and current access",
  { skip: !shouldRun ? "NOTIFICATION_SUBJECTS_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const editorId = randomUUID();
    const secondOwnerId = randomUUID();
    const actionApprovalId = randomUUID();
    const actionFailedId = randomUUID();
    const expiredActionId = randomUUID();
    const failedJobId = randomUUID();
    const unknownJobId = randomUUID();
    const ruleId = randomUUID();
    const failedRunId = randomUUID();
    const nowRows = await db.$queryRaw<Array<{ now: Date | string }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
    const databaseNow = nowRows[0]?.now instanceof Date ? nowRows[0].now : new Date(nowRows[0]?.now ?? "");
    assert.ok(Number.isFinite(databaseNow.getTime()));

    try {
      await runHistoricalBackfillGate();
      await db.appUser.createMany({
        data: [
          { id: editorId, username: `notification_editor_${suffix}`, role: "user", passwordHash: "a".repeat(43), passwordSalt: "b".repeat(22), passwordVersion: 1 },
          { id: secondOwnerId, username: `notification_owner_${suffix}`, role: "user", passwordHash: "a".repeat(43), passwordSalt: "b".repeat(22), passwordVersion: 1 },
        ],
      });
      const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(db);
      await db.project.createMany({
        data: [
          { id: projectId, workspaceId, name: `Notification ${suffix}`, slug: `notification-${suffix}` },
          { id: otherProjectId, workspaceId, name: `Notification other ${suffix}`, slug: `notification-other-${suffix}` },
        ],
      });
      const admin = await db.appUser.findUniqueOrThrow({ where: { id: ownerId } });
      await db.$transaction(async (tx) => {
        await grantProjectMembership(tx, { projectId, workspaceId, userId: admin.id, role: "owner", actorId: admin.id, reason: "notification_subjects_gate_admin_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: admin.id, reason: "notification_subjects_gate_editor" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: secondOwnerId, role: "owner", actorId: admin.id, reason: "notification_subjects_gate_second_owner" });
        await grantProjectMembership(tx, { projectId: otherProjectId, workspaceId, userId: admin.id, role: "owner", actorId: admin.id, reason: "notification_subjects_gate_other_project" });
      });

      const actionBase = {
        projectId,
        capability: "project.repository.sync",
        riskLevel: "medium" as const,
        input: {},
        inputFingerprint: digest(`input-${suffix}`),
        policyModeSnapshot: "approvalRequired" as const,
        requestedById: admin.id,
      };
      await db.projectAction.createMany({
        data: [
          { ...actionBase, id: actionApprovalId, status: "waitingApproval", idempotencyKey: digest(`approval-${suffix}`), approvalExpiresAt: new Date(databaseNow.getTime() + 10 * 60_000) },
          { ...actionBase, id: actionFailedId, status: "failed", idempotencyKey: digest(`failed-${suffix}`), failureCode: "REMOTE_FAILED", completedAt: databaseNow },
          { ...actionBase, id: expiredActionId, status: "waitingApproval", idempotencyKey: digest(`expired-${suffix}`), approvalExpiresAt: databaseNow },
        ],
      });
      await db.backgroundJob.createMany({
        data: [
          { id: failedJobId, projectId, kind: "projectBrief", status: "failed", requestedById: admin.id, idempotencyKey: digest(`job-failed-${suffix}`), payload: {}, failureCode: "REMOTE_FAILED" },
          { id: unknownJobId, projectId, kind: "projectBrief", status: "unknown", reconciliationRequired: true, requestedById: admin.id, idempotencyKey: digest(`job-unknown-${suffix}`), payload: {}, failureCode: "RECONCILIATION_REQUIRED" },
        ],
      });
      await db.automationRule.create({
        data: {
          id: ruleId,
          projectId,
          name: `Notification rule ${suffix}`,
          kind: "projectBrief",
          intervalMinutes: 60,
          config: {},
          nextRunAt: new Date(databaseNow.getTime() + 60 * 60_000),
          createdById: admin.id,
        },
      });
      await db.automationRun.create({
        data: {
          id: failedRunId,
          automationRuleId: ruleId,
          projectId,
          status: "failed",
          scheduledFor: databaseNow,
          completedAt: databaseNow,
          failureCode: "REMOTE_FAILED",
          jobIds: [],
        },
      });

      const common = {
        userId: admin.id,
        projectId,
        severity: "error" as const,
        actionHref: "/projects/not-trusted/actionHref",
      };
      const approvalNotification = await createNotification(db, {
        ...common,
        subjectKind: "projectAction" as NotificationSubjectKind,
        subjectId: actionApprovalId,
        attentionIntent: "requiresAttention" as NotificationAttentionIntent,
        kind: "actionApprovalRequired" as NotificationKind,
        title: `approval-${suffix}`,
        body: "审批待处理",
        dedupeKey: `approval-notification-${suffix}`,
      });
      await createNotification(db, {
        ...common,
        subjectKind: "projectAction" as NotificationSubjectKind,
        subjectId: actionFailedId,
        attentionIntent: "requiresAttention" as NotificationAttentionIntent,
        kind: "actionFailed" as NotificationKind,
        title: `failed-action-${suffix}`,
        body: "动作失败",
        dedupeKey: `failed-action-notification-${suffix}`,
      });
      await createNotification(db, {
        ...common,
        subjectKind: "projectAction" as NotificationSubjectKind,
        subjectId: expiredActionId,
        attentionIntent: "requiresAttention" as NotificationAttentionIntent,
        kind: "actionApprovalRequired" as NotificationKind,
        title: `expired-${suffix}`,
        body: "审批已过期",
        dedupeKey: `expired-notification-${suffix}`,
      });
      await createNotification(db, {
        ...common,
        subjectKind: "backgroundJob" as NotificationSubjectKind,
        subjectId: failedJobId,
        attentionIntent: "requiresAttention" as NotificationAttentionIntent,
        kind: "actionFailed" as NotificationKind,
        title: `failed-job-${suffix}`,
        body: "任务失败",
        dedupeKey: `failed-job-notification-${suffix}`,
      });
      await createNotification(db, {
        ...common,
        subjectKind: "backgroundJob" as NotificationSubjectKind,
        subjectId: unknownJobId,
        attentionIntent: "requiresAttention" as NotificationAttentionIntent,
        kind: "actionFailed" as NotificationKind,
        title: `unknown-job-${suffix}`,
        body: "任务状态需要核对",
        dedupeKey: `unknown-job-notification-${suffix}`,
      });
      await createNotification(db, {
        ...common,
        subjectKind: "automationRun" as NotificationSubjectKind,
        subjectId: failedRunId,
        attentionIntent: "requiresAttention" as NotificationAttentionIntent,
        kind: "automationFailed" as NotificationKind,
        title: `failed-run-${suffix}`,
        body: "自动化失败",
        dedupeKey: `failed-run-notification-${suffix}`,
      });

      const firstPage = await listPending(db, admin.id, { limit: 2 });
      assert.equal(firstPage.pendingCount, 5);
      assert.equal(firstPage.notifications.length, 2);
      assert.equal(firstPage.notifications.every((item) => item.actionState === "pending"), true);
      assert.equal(firstPage.notifications.every((item) => item.destination?.startsWith(`/projects/${projectId}/`)), true);
      assert.equal(firstPage.notifications.some((item) => item.actionHref === null), false);

      // The same project editor can see the action, but cannot consume an
      // approval. Projection must fail closed rather than treating the
      // still-live approval as resolved or pending for this recipient.
      const nonOwnerApproval = await projectNotification(approvalNotification, editorId, db, databaseNow);
      assert.equal(nonOwnerApproval.actionState, "invalid");
      assert.equal(nonOwnerApproval.destination, null);

      const seen = new Set(firstPage.notifications.map((item) => item.id));
      let cursor = firstPage.nextCursor;
      while (cursor !== null) {
        const page = await listPending(db, admin.id, { cursor, limit: 2 });
        for (const item of page.notifications) {
          assert.equal(seen.has(item.id), false);
          seen.add(item.id);
        }
        cursor = page.nextCursor;
      }
      assert.equal(seen.size, 5);

      const opened = await openNotification(admin.id, approvalNotification.id, db);
      assert.equal(opened.actionState, "pending");
      assert.equal(opened.destination, `/projects/${projectId}/actions?action=${actionApprovalId}`);
      assert.notEqual(opened.readAt, null);
      assert.equal((await listPending(db, admin.id)).pendingCount, 5);

      const expired = await projectNotification(
        await db.notification.findUniqueOrThrow({ where: { id: (await db.notification.findFirstOrThrow({ where: { userId: admin.id, title: `expired-${suffix}` } })).id } }),
        admin.id,
        db,
        databaseNow,
      );
      assert.equal(expired.actionState, "invalid");
      assert.equal(expired.destination, null);

      // State changes are reflected on the next server projection: an
      // automation failure can recover and later become actionable again.
      await db.automationRun.update({ where: { id: failedRunId }, data: { status: "succeeded", completedAt: databaseNow } });
      assert.equal((await listPending(db, admin.id)).pendingCount, 4);
      await db.automationRun.update({ where: { id: failedRunId }, data: { status: "failed", completedAt: databaseNow } });
      assert.equal((await listPending(db, admin.id)).pendingCount, 5);

      // An unknown job stops demanding attention once reconciliation has been
      // completed, without changing the durable notification row.
      await reconcileProjectJob(projectId, unknownJobId, admin, db);
      assert.equal((await listPending(db, admin.id)).pendingCount, 4);

      // Archival invalidates every project-scoped destination immediately.
      await db.project.update({ where: { id: projectId }, data: { archivedAt: databaseNow } });
      const archivedApproval = await projectNotification(approvalNotification, admin.id, db, databaseNow);
      assert.equal(archivedApproval.actionState, "invalid");
      assert.equal(archivedApproval.destination, null);
      assert.equal((await listPending(db, admin.id)).pendingCount, 0);
      await db.project.update({ where: { id: projectId }, data: { archivedAt: null } });

      await db.$transaction((tx) => revokeProjectMembership(tx, projectId, admin.id, workspaceId, { actorId: secondOwnerId, reason: "notification_subjects_gate_revoke_admin" }));
      const revoked = await projectNotification(
        await db.notification.findUniqueOrThrow({ where: { id: (await db.notification.findFirstOrThrow({ where: { userId: admin.id, title: `approval-${suffix}` } })).id } }),
        admin.id,
        db,
        databaseNow,
      );
      assert.equal(revoked.actionState, "invalid");
      assert.equal(revoked.destination, null);

      const crossProject = await db.notification.create({
        data: {
          userId: editorId,
          projectId: otherProjectId,
          subjectKind: "projectAction",
          subjectId: actionApprovalId,
          attentionIntent: "requiresAttention",
          kind: "actionApprovalRequired",
          severity: "warning",
          title: `cross-${suffix}`,
          body: "错配主体",
          actionHref: `/projects/${projectId}/actions?action=${actionApprovalId}`,
          dedupeKey: digest(`cross-${suffix}`),
        },
      });
      const crossProjection = await projectNotification(crossProject, editorId, db, databaseNow);
      assert.equal(crossProjection.actionState, "invalid");
      assert.equal(crossProjection.destination, null);

      const legacy = await db.notification.create({
        data: {
          userId: editorId,
          projectId: null,
          kind: "system",
          severity: "info",
          title: `legacy-${suffix}`,
          body: "历史记录",
          actionHref: `/projects/${projectId}/actions?action=${actionApprovalId}`,
          dedupeKey: digest(`legacy-${suffix}`),
        },
      });
      const legacyProjection = await projectNotification(legacy, editorId, db, databaseNow);
      assert.equal(legacyProjection.actionState, "none");
      assert.equal(legacyProjection.destination, null);

      await assert.rejects(() => db.notification.update({ where: { id: approvalNotification.id }, data: { subjectId: actionFailedId } }));
      const guard = await db.$queryRaw<Array<{ enabled: boolean }>>`
        SELECT t.tgenabled = 'O' AS enabled
        FROM pg_trigger t
        WHERE t.tgname = 'Notification_subject_context_guard'
      `;
      assert.equal(guard[0]?.enabled, true);
    } finally {
      await db.$disconnect();
    }
  },
);
