import { createHash, randomUUID } from "node:crypto";
import { Prisma, type AppUser, type AutomationRuleKind, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { runGitRepositorySyncJob } from "@/lib/git";
import { getProjectOperationsSummary } from "@/lib/project-operations";

const AUTOMATION_LEASE_MS = 10 * 60 * 1_000;
const AUTOMATION_HEARTBEAT_MS = 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ACTION_HREF = /^\/[A-Za-z0-9/_?=&.-]{1,1023}$/u;

export type AutomationErrorCode =
  | "AUTOMATION_INVALID_INPUT"
  | "AUTOMATION_PROJECT_NOT_FOUND"
  | "AUTOMATION_RULE_NOT_FOUND"
  | "AUTOMATION_RULE_CONFLICT"
  | "AUTOMATION_RULE_PAUSED"
  | "AUTOMATION_RUN_CONFLICT"
  | "NOTIFICATION_NOT_FOUND";

export class AutomationError extends Error {
  constructor(readonly code: AutomationErrorCode) {
    super(code);
    this.name = "AutomationError";
  }
}

const kindSchema = z.enum(["repositorySync", "memoryQuality", "memoryIndex", "projectBrief", "webSourceSync", "projectPlanHealth"]);
const repositoryConfigSchema = z.object({ linkIds: z.array(z.string().uuid()).max(100).default([]) }).strict();
const emptyConfigSchema = z.object({}).strict();
const memoryIndexConfigSchema = z.object({ mode: z.literal("incremental").default("incremental") }).strict();
const projectPlanHealthConfigSchema = z.object({ dueSoonDays: z.number().int().min(1).max(14).default(3), includeAssignees: z.boolean().default(true) }).strict();
const createRuleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: kindSchema,
  intervalMinutes: z.number().int().min(5).max(43_200),
  config: z.unknown().optional(),
  startAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const updateRuleSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  intervalMinutes: z.number().int().min(5).max(43_200).optional(),
  config: z.unknown().optional(),
  enabled: z.boolean().optional(),
}).strict();

const ruleSelect = {
  id: true,
  projectId: true,
  name: true,
  kind: true,
  status: true,
  intervalMinutes: true,
  config: true,
  nextRunAt: true,
  lastRunAt: true,
  consecutiveFailures: true,
  createdAt: true,
  updatedAt: true,
  runs: {
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      jobIds: true,
      result: true,
      failureCode: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  },
} satisfies Prisma.AutomationRuleSelect;

type ClaimedRun = Prisma.AutomationRunGetPayload<{
  include: { rule: { include: { createdBy: true } } };
}>;

function fail(code: AutomationErrorCode): never {
  throw new AutomationError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("AUTOMATION_INVALID_INPUT");
  return value;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function canonicalConfig(kind: AutomationRuleKind, value: unknown): Prisma.InputJsonObject {
  const parsed = kind === "repositorySync"
    ? repositoryConfigSchema.parse(value ?? {})
    : kind === "memoryIndex"
      ? memoryIndexConfigSchema.parse(value ?? {})
      : kind === "projectPlanHealth"
        ? projectPlanHealthConfigSchema.parse(value ?? {})
      : emptyConfigSchema.parse(value ?? {});
  return parsed as Prisma.InputJsonObject;
}

function notificationKey(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function createNotification(input: Readonly<{
  userId: string;
  projectId: string | null;
  kind: "automationSucceeded" | "automationFailed" | "consentRequired" | "memoryQuality" | "projectPlanHealth" | "system";
  severity: "info" | "success" | "warning" | "error";
  title: string;
  body: string;
  actionHref: string | null;
  dedupeKey: string;
}>, db: PrismaClient): Promise<void> {
  if (input.actionHref !== null && !SAFE_ACTION_HREF.test(input.actionHref)) return fail("AUTOMATION_INVALID_INPUT");
  await db.notification.upsert({
    where: { userId_dedupeKey: { userId: input.userId, dedupeKey: notificationKey(input.dedupeKey) } },
    create: { ...input, dedupeKey: notificationKey(input.dedupeKey) },
    update: { title: input.title, body: input.body, severity: input.severity, actionHref: input.actionHref, readAt: null },
  });
}

export async function listProjectAutomationRules(projectIdInput: unknown, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (project === null) return fail("AUTOMATION_PROJECT_NOT_FOUND");
  return db.automationRule.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: ruleSelect });
}

export async function createProjectAutomationRule(
  projectIdInput: unknown,
  input: unknown,
  actor: Pick<AppUser, "id">,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const parsed = createRuleSchema.parse(input);
  const config = canonicalConfig(parsed.kind, parsed.config);
  const startAt = parsed.startAt === undefined ? new Date(Date.now() + parsed.intervalMinutes * 60_000) : new Date(parsed.startAt);
  if (!Number.isFinite(startAt.getTime()) || startAt.getTime() < Date.now() - 60_000) return fail("AUTOMATION_INVALID_INPUT");
  try {
    return await db.automationRule.create({
      data: {
        projectId,
        name: parsed.name,
        kind: parsed.kind,
        intervalMinutes: parsed.intervalMinutes,
        config,
        nextRunAt: startAt,
        createdById: actor.id,
      },
      select: ruleSelect,
    });
  } catch (error) {
    if (isPrismaCode(error, "P2003")) return fail("AUTOMATION_PROJECT_NOT_FOUND");
    if (isPrismaCode(error, "P2002")) return fail("AUTOMATION_RULE_CONFLICT");
    throw error;
  }
}

export async function updateProjectAutomationRule(
  projectIdInput: unknown,
  ruleIdInput: unknown,
  input: unknown,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const ruleId = uuid(ruleIdInput);
  const parsed = updateRuleSchema.parse(input);
  const current = await db.automationRule.findFirst({ where: { id: ruleId, projectId } });
  if (current === null) return fail("AUTOMATION_RULE_NOT_FOUND");
  const config = parsed.config === undefined ? undefined : canonicalConfig(current.kind, parsed.config);
  try {
    return await db.automationRule.update({
      where: { id: ruleId },
      data: {
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        ...(parsed.intervalMinutes === undefined ? {} : { intervalMinutes: parsed.intervalMinutes }),
        ...(config === undefined ? {} : { config }),
        ...(parsed.enabled === undefined ? {} : parsed.enabled
          ? { status: "active", nextRunAt: new Date(Date.now() + (parsed.intervalMinutes ?? current.intervalMinutes) * 60_000) }
          : { status: "paused" }),
      },
      select: ruleSelect,
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("AUTOMATION_RULE_CONFLICT");
    throw error;
  }
}

export async function triggerProjectAutomationRule(projectIdInput: unknown, ruleIdInput: unknown, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const ruleId = uuid(ruleIdInput);
  const updated = await db.automationRule.updateMany({
    where: { id: ruleId, projectId, status: "active" },
    data: { nextRunAt: new Date() },
  });
  if (updated.count !== 1) {
    const exists = await db.automationRule.findFirst({ where: { id: ruleId, projectId }, select: { status: true } });
    if (exists === null) return fail("AUTOMATION_RULE_NOT_FOUND");
    return fail("AUTOMATION_RULE_PAUSED");
  }
  return db.automationRule.findUniqueOrThrow({ where: { id: ruleId }, select: ruleSelect });
}

async function recoverExpiredRuns(now: Date, db: PrismaClient): Promise<number> {
  const expired = await db.automationRun.findMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    select: { id: true, automationRuleId: true, projectId: true, rule: { select: { createdById: true, name: true } } },
    take: 50,
  });
  let recovered = 0;
  for (const run of expired) {
    const paused = await db.$transaction(async (tx) => {
      const changed = await tx.automationRun.updateMany({
        where: { id: run.id, status: "running", leaseExpiresAt: { lt: now } },
        data: { status: "failed", failureCode: "AUTOMATION_LEASE_EXPIRED", completedAt: now, leaseExpiresAt: null },
      });
      if (changed.count === 0) return null;
      const rule = await tx.automationRule.findUniqueOrThrow({ where: { id: run.automationRuleId }, select: { consecutiveFailures: true } });
      const shouldPause = rule.consecutiveFailures >= 2;
      await tx.automationRule.update({
        where: { id: run.automationRuleId },
        data: {
          consecutiveFailures: { increment: 1 },
          ...(shouldPause ? { status: "paused" } : { nextRunAt: now }),
        },
      });
      return shouldPause;
    });
    if (paused === null) continue;
    recovered += 1;
    await createNotification({
      userId: run.rule.createdById,
      projectId: run.projectId,
      kind: "automationFailed",
      severity: "error",
      title: `自动化需要恢复：${run.rule.name}`,
      body: paused
        ? "上一次执行的 Worker 租约已过期，连续失败达到三次，规则已自动暂停。"
        : "上一次执行的 Worker 租约已过期，系统已安全标记失败并安排重试。",
      actionHref: `/projects/${run.projectId}/automations`,
      dedupeKey: `automation-expired:${run.id}`,
    }, db);
  }
  return recovered;
}

async function claimDueRun(workerId: string, now: Date, db: PrismaClient): Promise<ClaimedRun | null> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT rule."id"
      FROM "AutomationRule" AS rule
      JOIN "Project" AS project ON project."id" = rule."projectId"
      WHERE rule."status" = 'active'::"AutomationRuleStatus"
        AND rule."nextRunAt" <= ${now}
        AND project."archivedAt" IS NULL
      ORDER BY rule."nextRunAt" ASC, rule."id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const ruleId = rows[0]?.id;
    if (ruleId === undefined) return null;
    const rule = await tx.automationRule.findUniqueOrThrow({ where: { id: ruleId }, include: { createdBy: true } });
    const scheduledFor = rule.nextRunAt;
    const nextBase = scheduledFor.getTime() < now.getTime() - rule.intervalMinutes * 60_000 ? now : scheduledFor;
    const nextRunAt = new Date(nextBase.getTime() + rule.intervalMinutes * 60_000);
    await tx.automationRule.update({ where: { id: rule.id }, data: { nextRunAt, lastRunAt: now } });
    try {
      return await tx.automationRun.create({
        data: {
          id: randomUUID(),
          automationRuleId: rule.id,
          projectId: rule.projectId,
          status: "running",
          scheduledFor,
          workerId,
          leaseExpiresAt: new Date(now.getTime() + AUTOMATION_LEASE_MS),
          startedAt: now,
        },
        include: { rule: { include: { createdBy: true } } },
      });
    } catch (error) {
      if (isPrismaCode(error, "P2002")) return null;
      throw error;
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function startAutomationHeartbeat(run: ClaimedRun, db: PrismaClient): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    const now = new Date();
    void db.automationRun.updateMany({
      where: { id: run.id, status: "running", workerId: run.workerId },
      data: { leaseExpiresAt: new Date(now.getTime() + AUTOMATION_LEASE_MS) },
    }).catch(() => undefined).finally(() => { inFlight = false; });
  }, AUTOMATION_HEARTBEAT_MS);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearInterval(timer);
}

async function completeRun(run: ClaimedRun, input: Readonly<{
  status: "waitingConsent" | "succeeded" | "failed" | "skipped";
  jobIds?: readonly string[];
  result?: Prisma.InputJsonValue;
  failureCode?: string;
}>, db: PrismaClient): Promise<void> {
  const completedAt = new Date();
  await db.$transaction(async (tx) => {
    const updated = await tx.automationRun.updateMany({
      where: { id: run.id, status: "running", workerId: run.workerId },
      data: {
        status: input.status,
        jobIds: [...(input.jobIds ?? [])],
        ...(input.result === undefined ? {} : { result: input.result }),
        failureCode: input.failureCode ?? null,
        completedAt,
        leaseExpiresAt: null,
      },
    });
    if (updated.count !== 1) return fail("AUTOMATION_RUN_CONFLICT");
    if (input.status === "failed") {
      const current = await tx.automationRule.findUniqueOrThrow({ where: { id: run.automationRuleId }, select: { consecutiveFailures: true } });
      await tx.automationRule.update({
        where: { id: run.automationRuleId },
        data: { consecutiveFailures: { increment: 1 }, ...(current.consecutiveFailures >= 2 ? { status: "paused" } : {}) },
      });
    } else if (input.status === "succeeded" || input.status === "skipped") {
      await tx.automationRule.update({ where: { id: run.automationRuleId }, data: { consecutiveFailures: 0 } });
    }
  });
}

async function executeRepositorySync(run: ClaimedRun, db: PrismaClient) {
  const config = repositoryConfigSchema.parse(run.rule.config);
  const links = await db.projectGitRepositoryLink.findMany({
    where: {
      projectId: run.projectId,
      status: "active",
      ...(config.linkIds.length > 0 ? { id: { in: config.linkIds } } : {}),
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (links.length === 0) {
    await completeRun(run, { status: "skipped", result: { reason: "NO_ACTIVE_REPOSITORIES" } }, db);
    return;
  }
  const jobIds: string[] = [];
  for (const link of links) {
    const job = await runGitRepositorySyncJob({
      projectId: run.projectId,
      linkId: link.id,
      requestedBy: run.rule.createdBy,
      clientKey: `automation:${run.id}:${link.id}`,
    }, db);
    jobIds.push(job.id);
    if (job.status !== "succeeded") throw new Error(job.failureCode ?? "AUTOMATION_REPOSITORY_SYNC_FAILED");
  }
  await completeRun(run, { status: "succeeded", jobIds, result: { repositoryCount: links.length } }, db);
}

async function executeProjectPlanHealth(run: ClaimedRun, db: PrismaClient) {
  const config = projectPlanHealthConfigSchema.parse(run.rule.config);
  const health = await getProjectOperationsSummary(run.projectId, config.dueSoonDays, db);
  const assigneeIds = new Set(health.signals.flatMap((signal) => signal.assigneeId === null ? [] : [signal.assigneeId]));
  const candidateIds = new Set([run.rule.createdById, ...(config.includeAssignees ? [...assigneeIds] : [])]);
  const eligibleRecipients = await db.appUser.findMany({
      where: {
        id: { in: [...candidateIds] },
        disabledAt: null,
        OR: [
          { projectMemberships: { some: { projectId: run.projectId } } },
          { workspaceMemberships: { some: { workspace: { projects: { some: { id: run.projectId } } }, role: { in: ["owner", "admin"] } } } },
        ],
      },
      select: { id: true },
    });
  const recipients = new Set(eligibleRecipients.map((entry) => entry.id));
  const dayKey = run.scheduledFor.toISOString().slice(0, 10);
  const body = health.status === "healthy"
    ? "当前没有逾期、受阻、缺少负责人或缺少验收证据的活动工作项。"
    : `逾期 ${health.counts.overdue} 项、受阻 ${health.counts.blocked} 项、即将到期 ${health.counts.dueSoon} 项、未分配 ${health.counts.unassigned} 项、验收或证据缺口 ${health.counts.missingAcceptance + health.counts.missingEvidence + health.counts.staleEvidence} 项；另有 ${health.counts.openImpacts} 条仓库变更待评估。`;
  for (const userId of recipients) {
    await createNotification({
      userId,
      projectId: run.projectId,
      kind: "projectPlanHealth",
      severity: health.status === "atRisk" ? "error" : health.status === "attention" ? "warning" : "success",
      title: health.status === "atRisk" ? "项目计划存在逾期或受阻工作" : health.status === "attention" ? "项目计划有待处理事项" : "项目计划运行正常",
      body,
      actionHref: `/projects/${run.projectId}/plan`,
      dedupeKey: `project-plan-health:${run.automationRuleId}:${dayKey}:${userId}`,
    }, db);
  }
  await completeRun(run, { status: "succeeded", result: { health, notifiedUserCount: recipients.size } }, db);
}

async function executeRun(run: ClaimedRun, db: PrismaClient): Promise<void> {
  if (run.rule.kind === "repositorySync") {
    await executeRepositorySync(run, db);
    await createNotification({
      userId: run.rule.createdById,
      projectId: run.projectId,
      kind: "automationSucceeded",
      severity: "success",
      title: `自动化已完成：${run.rule.name}`,
      body: "已固定远端提交并原子发布仓库快照。",
      actionHref: `/projects/${run.projectId}/repositories`,
      dedupeKey: `automation-succeeded:${run.id}`,
    }, db);
    return;
  }
  if (run.rule.kind === "memoryQuality") {
    const { analyzeProjectMemoryQuality } = await import("@/lib/memory-quality");
    const result = await analyzeProjectMemoryQuality(run.projectId, db);
    await completeRun(run, { status: "succeeded", result: { score: result.score, openIssueCount: result.openIssueCount } }, db);
    await createNotification({
      userId: run.rule.createdById,
      projectId: run.projectId,
      kind: "memoryQuality",
      severity: result.openIssueCount > 0 ? "warning" : "success",
      title: `记忆质量检查：${result.score} 分`,
      body: result.openIssueCount > 0 ? `发现 ${result.openIssueCount} 个待处理问题。` : "未发现新的重复、冲突或过期事实。",
      actionHref: `/projects/${run.projectId}/memory-quality`,
      dedupeKey: `memory-quality:${run.id}`,
    }, db);
    return;
  }
  if (run.rule.kind === "webSourceSync") {
    const { syncAllProjectWebSources } = await import("@/lib/web-sources");
    const result = await syncAllProjectWebSources(run.projectId, run.rule.createdBy, db);
    await completeRun(run, { status: "succeeded", result: { sourceCount: result.length } }, db);
    return;
  }
  if (run.rule.kind === "projectPlanHealth") {
    await executeProjectPlanHealth(run, db);
    return;
  }
  await completeRun(run, { status: "waitingConsent", result: { reason: "MODEL_TRANSFER_REQUIRES_CONFIRMATION" } }, db);
  await createNotification({
    userId: run.rule.createdById,
    projectId: run.projectId,
    kind: "consentRequired",
    severity: "warning",
    title: `需要确认模型数据发送：${run.rule.name}`,
    body: "自动化已准备好输入边界。请在项目页面确认本次模型、范围和外发内容后执行。",
    actionHref: run.rule.kind === "memoryIndex" ? `/projects/${run.projectId}/memory` : `/projects/${run.projectId}/intelligence`,
    dedupeKey: `automation-consent:${run.id}`,
  }, db);
}

export async function runAutomationWorkerCycle(input: Readonly<{
  workerId: string;
  maximumRuns?: number;
}>, db: PrismaClient = getDb()) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(input.workerId)) return fail("AUTOMATION_INVALID_INPUT");
  const maximumRuns = input.maximumRuns ?? 5;
  if (!Number.isInteger(maximumRuns) || maximumRuns < 1 || maximumRuns > 20) return fail("AUTOMATION_INVALID_INPUT");
  const recovered = await recoverExpiredRuns(new Date(), db);
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < maximumRuns; index += 1) {
    const run = await claimDueRun(input.workerId, new Date(), db);
    if (run === null) break;
    claimed += 1;
    const stopHeartbeat = startAutomationHeartbeat(run, db);
    try {
      await executeRun(run, db);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const failureCode = error instanceof Error && /^[A-Z0-9_]{3,64}$/u.test(error.message)
        ? error.message
        : "AUTOMATION_EXECUTION_FAILED";
      await completeRun(run, { status: "failed", failureCode }, db).catch(() => undefined);
      await createNotification({
        userId: run.rule.createdById,
        projectId: run.projectId,
        kind: "automationFailed",
        severity: "error",
        title: `自动化执行失败：${run.rule.name}`,
        body: `安全错误码：${failureCode}。连续失败三次后规则会自动暂停。`,
        actionHref: `/projects/${run.projectId}/automations`,
        dedupeKey: `automation-failed:${run.id}`,
      }, db);
    } finally {
      stopHeartbeat();
    }
  }
  return Object.freeze({ recovered, claimed, succeeded, failed });
}

export async function listUserNotifications(userIdInput: unknown, db: PrismaClient = getDb()) {
  const userId = uuid(userIdInput);
  const notifications = await db.notification.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { id: true, projectId: true, kind: true, severity: true, title: true, body: true, actionHref: true, readAt: true, createdAt: true },
  });
  const unreadCount = await db.notification.count({ where: { userId, readAt: null } });
  return Object.freeze({ notifications, unreadCount });
}

export async function markNotificationRead(userIdInput: unknown, notificationIdInput: unknown, read: boolean, db: PrismaClient = getDb()) {
  const userId = uuid(userIdInput);
  const notificationId = uuid(notificationIdInput);
  const updated = await db.notification.updateMany({ where: { id: notificationId, userId }, data: { readAt: read ? new Date() : null } });
  if (updated.count !== 1) return fail("NOTIFICATION_NOT_FOUND");
  return db.notification.findUniqueOrThrow({ where: { id: notificationId }, select: { id: true, readAt: true } });
}
