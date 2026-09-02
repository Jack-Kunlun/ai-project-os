import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ProjectActionPolicyMode,
  type ProjectActionStatus,
} from "@prisma/client";
import { z } from "zod";
import { assertProjectAccess, getProjectPermission, type AccessUser } from "@/lib/access-control";
import { getDb } from "@/lib/db";
import { runGitRepositorySyncJob } from "@/lib/git";
import { listPagination } from "@/lib/list-pagination";
import {
  buildMcpActionSnapshot,
  canonicalMcpActionSnapshot,
  executeMcpActionSnapshot,
} from "@/lib/mcp";

const ACTION_LEASE_MS = 10 * 60_000;
const ACTION_HEARTBEAT_MS = 60_000;
const APPROVAL_TTL_MS = 24 * 60 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WORKER_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
const CLIENT_REQUEST_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const SAFE_ACTION_HREF = /^\/[A-Za-z0-9/_?=&.-]{1,1023}$/u;

export const PROJECT_ACTION_CAPABILITIES = [
  "project.repository.sync",
  "project.web-source.sync",
  "project.memory-quality.scan",
  "project.mcp.read-tool.invoke",
] as const;

export type ProjectActionCapability = (typeof PROJECT_ACTION_CAPABILITIES)[number];

type CapabilityDefinition = Readonly<{
  id: ProjectActionCapability;
  label: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  defaultPolicy: "automatic" | "approvalRequired" | "denied";
  effect: "local" | "external-read";
}>;

const CAPABILITY_CATALOG: Readonly<Record<ProjectActionCapability, CapabilityDefinition>> = Object.freeze({
  "project.repository.sync": Object.freeze({
    id: "project.repository.sync",
    label: "同步代码仓库",
    description: "读取当前项目全部启用仓库，固定远端提交并原子发布新的代码快照。不会写入远端仓库。",
    riskLevel: "medium",
    defaultPolicy: "approvalRequired",
    effect: "external-read",
  }),
  "project.web-source.sync": Object.freeze({
    id: "project.web-source.sync",
    label: "刷新网页来源",
    description: "重新读取项目中全部启用网页并发布新修订。不会向网页目标写入数据。",
    riskLevel: "medium",
    defaultPolicy: "approvalRequired",
    effect: "external-read",
  }),
  "project.memory-quality.scan": Object.freeze({
    id: "project.memory-quality.scan",
    label: "检查记忆质量",
    description: "在本地数据库中识别重复、冲突、过期、证据不足和低置信度记忆。",
    riskLevel: "low",
    defaultPolicy: "automatic",
    effect: "local",
  }),
  "project.mcp.read-tool.invoke": Object.freeze({
    id: "project.mcp.read-tool.invoke",
    label: "调用 MCP 只读工具",
    description: "调用管理员已验证、项目 Owner 已逐项授权的远程只读工具。每次调用都必须单独审批，结果默认只保存在动作记录中，可再由成员人工固化为未审核项目资料。",
    riskLevel: "high",
    defaultPolicy: "approvalRequired",
    effect: "external-read",
  }),
});

const capabilitySchema = z.enum(PROJECT_ACTION_CAPABILITIES);
const emptyInputSchema = z.object({}).strict();
const policyModeSchema = z.enum(["automatic", "approvalRequired", "denied"]);
const requestSchema = z.object({
  capability: capabilitySchema,
  input: z.unknown().optional(),
  clientRequestId: z.string().min(8).max(128).regex(CLIENT_REQUEST_PATTERN),
}).strict();
const policyUpdateSchema = z.object({
  mode: policyModeSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();
const cancelSchema = z.object({ expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict();

export type ActionEngineErrorCode =
  | "ACTION_INVALID_INPUT"
  | "ACTION_PROJECT_NOT_FOUND"
  | "ACTION_PROJECT_ARCHIVED"
  | "ACTION_NOT_FOUND"
  | "ACTION_POLICY_DENIED"
  | "ACTION_POLICY_CONFLICT"
  | "ACTION_IDEMPOTENCY_CONFLICT"
  | "ACTION_APPROVAL_REQUIRED"
  | "ACTION_APPROVAL_EXPIRED"
  | "ACTION_DECISION_CONFLICT"
  | "ACTION_CANCEL_FORBIDDEN"
  | "ACTION_STATE_CONFLICT"
  | "ACTION_EXECUTION_FAILED";

export class ActionEngineError extends Error {
  constructor(readonly code: ActionEngineErrorCode) {
    super(code);
    this.name = "ActionEngineError";
  }
}

class ActionExecutionError extends Error {
  constructor(readonly failureCode: string, readonly safeResult?: Prisma.InputJsonObject) {
    super(failureCode);
    this.name = "ActionExecutionError";
  }
}

const actionSelect = {
  id: true,
  projectId: true,
  capability: true,
  riskLevel: true,
  status: true,
  input: true,
  inputFingerprint: true,
  policyModeSnapshot: true,
  approvalExpiresAt: true,
  workerId: true,
  attemptCount: true,
  result: true,
  failureCode: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  requestedBy: { select: { id: true, username: true, displayName: true } },
  resultImport: {
    select: {
      id: true,
      resultFingerprint: true,
      contentFingerprint: true,
      createdAt: true,
      projectSource: { select: { id: true, kind: true, ingestedAt: true } },
      importedBy: { select: { id: true, username: true, displayName: true } },
    },
  },
  approval: { select: { decision: true, note: true, decidedAt: true, decidedBy: { select: { id: true, username: true, displayName: true } } } },
  audits: { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], take: 12, select: { id: true, event: true, details: true, createdAt: true, actor: { select: { id: true, username: true, displayName: true } } } },
} satisfies Prisma.ProjectActionSelect;

type ClaimedAction = Prisma.ProjectActionGetPayload<{ include: { requestedBy: true } }>;

function fail(code: ActionEngineErrorCode): never {
  throw new ActionEngineError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("ACTION_INVALID_INPUT");
  return value;
}

function parseCapability(value: unknown): ProjectActionCapability {
  const parsed = capabilitySchema.safeParse(value);
  return parsed.success ? parsed.data : fail("ACTION_INVALID_INPUT");
}

function parseTimestamp(value: string): Date {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : fail("ACTION_INVALID_INPUT");
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function notificationKey(value: string): string {
  return hash(`action-notification:v1:${value}`);
}

export function projectActionCapabilityCatalog(): readonly CapabilityDefinition[] {
  return Object.freeze(PROJECT_ACTION_CAPABILITIES.map((id) => CAPABILITY_CATALOG[id]));
}

export function canonicalProjectActionInput(capabilityInput: unknown, input: unknown): Readonly<Record<string, unknown>> {
  const capability = parseCapability(capabilityInput);
  if (capability === "project.mcp.read-tool.invoke") return canonicalMcpActionSnapshot(input);
  const parsed = emptyInputSchema.safeParse(input ?? {});
  if (!parsed.success) return fail("ACTION_INVALID_INPUT");
  return Object.freeze({});
}

export function projectActionInputFingerprint(projectIdInput: unknown, capabilityInput: unknown, input: unknown): string {
  const projectId = uuid(projectIdInput);
  const capability = parseCapability(capabilityInput);
  const canonicalInput = canonicalProjectActionInput(capability, input);
  return hash(`project-action-input:v1\n${projectId}\n${capability}\n${JSON.stringify(canonicalInput)}`);
}

export function isProjectActionTransitionAllowed(from: string, to: string): boolean {
  const transitions: Readonly<Record<string, readonly string[]>> = Object.freeze({
    waitingApproval: ["queued", "rejected", "cancelled", "expired"],
    queued: ["running", "cancelled"],
    running: ["succeeded", "failed"],
    succeeded: [],
    failed: [],
    rejected: [],
    cancelled: [],
    expired: [],
  });
  return transitions[from]?.includes(to) ?? false;
}

async function assertActiveProject(actor: AccessUser, projectId: string, permission: "view" | "edit" | "owner", db: PrismaClient): Promise<void> {
  await assertProjectAccess(actor, projectId, permission, db);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
  if (project === null) return fail("ACTION_PROJECT_NOT_FOUND");
  if (project.archivedAt !== null) return fail("ACTION_PROJECT_ARCHIVED");
}

async function createActionNotification(input: Readonly<{
  userId: string;
  projectId: string;
  kind: "actionApprovalRequired" | "actionCompleted" | "actionFailed" | "system";
  severity: "info" | "success" | "warning" | "error";
  title: string;
  body: string;
  actionId: string;
  dedupeSuffix: string;
}>, db: PrismaClient): Promise<void> {
  const actionHref = `/projects/${input.projectId}/actions?action=${input.actionId}`;
  if (!SAFE_ACTION_HREF.test(actionHref)) return fail("ACTION_INVALID_INPUT");
  await db.notification.upsert({
    where: { userId_dedupeKey: { userId: input.userId, dedupeKey: notificationKey(`${input.actionId}:${input.dedupeSuffix}`) } },
    create: {
      userId: input.userId,
      projectId: input.projectId,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      body: input.body,
      actionHref,
      dedupeKey: notificationKey(`${input.actionId}:${input.dedupeSuffix}`),
    },
    update: { title: input.title, body: input.body, severity: input.severity, actionHref, readAt: null },
  });
}

async function tryCreateActionNotification(
  input: Parameters<typeof createActionNotification>[0],
  db: PrismaClient,
): Promise<void> {
  try {
    await createActionNotification(input, db);
  } catch {
    console.error("Action notification could not be persisted");
  }
}

async function notifyProjectApprovers(projectId: string, actionId: string, requesterId: string, label: string, db: PrismaClient): Promise<void> {
  const [project, globalAdmins] = await Promise.all([
    db.project.findUnique({
      where: { id: projectId },
      select: {
        workspace: { select: { memberships: { where: { role: { in: ["owner", "admin"] }, user: { disabledAt: null } }, select: { userId: true } } } },
        memberships: { where: { role: "owner", user: { disabledAt: null } }, select: { userId: true } },
      },
    }),
    db.appUser.findMany({ where: { role: "admin", disabledAt: null }, select: { id: true } }),
  ]);
  if (project === null) return;
  const userIds = new Set<string>([
    ...project.workspace.memberships.map((entry) => entry.userId),
    ...project.memberships.map((entry) => entry.userId),
    ...globalAdmins.map((entry) => entry.id),
  ]);
  for (const userId of userIds) {
    await tryCreateActionNotification({
      userId,
      projectId,
      kind: "actionApprovalRequired",
      severity: "warning",
      title: `动作等待审批：${label}`,
      body: userId === requesterId ? "动作已创建，执行前仍需项目 Owner 审批。" : "有一项受控动作等待你核对能力、风险和输入指纹。",
      actionId,
      dedupeSuffix: "approval-required",
    }, db);
  }
}

export async function getProjectActionCenter(
  projectIdInput: unknown,
  actor: AccessUser,
  input: Readonly<{ page: number; pageSize: number; search?: string; capability?: ProjectActionCapability; status?: ProjectActionStatus }>,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  await assertProjectAccess(actor, projectId, "view", db);
  const permission = await getProjectPermission(actor, projectId, db);
  if (permission === null) return fail("ACTION_PROJECT_NOT_FOUND");
  const search = input.search?.trim();
  const actionWhere: Prisma.ProjectActionWhereInput = {
    projectId,
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(search ? { OR: [
      { failureCode: { contains: search, mode: "insensitive" } },
      { requestedBy: { is: { OR: [
        { username: { contains: search, mode: "insensitive" } },
        { displayName: { contains: search, mode: "insensitive" } },
      ] } } },
    ] } : {}),
  };
  const [storedPolicies, actions, actionTotal, importableActions, project] = await Promise.all([
    db.projectActionPolicy.findMany({ where: { projectId }, orderBy: { capability: "asc" }, select: { capability: true, mode: true, updatedAt: true, updatedBy: { select: { id: true, username: true, displayName: true } } } }),
    db.projectAction.findMany({ where: actionWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize, select: actionSelect }),
    db.projectAction.count({ where: actionWhere }),
    db.projectAction.findMany({ where: { projectId, capability: "project.mcp.read-tool.invoke", status: "succeeded" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, select: actionSelect }),
    db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } }),
  ]);
  if (project === null) return fail("ACTION_PROJECT_NOT_FOUND");
  const storedByCapability = new Map(storedPolicies.map((policy) => [policy.capability, policy]));
  const policies = projectActionCapabilityCatalog().map((capability) => {
    const stored = storedByCapability.get(capability.id);
    return Object.freeze({
      capability: capability.id,
      mode: stored?.mode ?? capability.defaultPolicy,
      inherited: stored === undefined,
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    });
  });
  return Object.freeze({
    catalog: projectActionCapabilityCatalog(),
    policies,
    actions: actions.map((action) => Object.freeze({
      ...action,
      canCancel: ["waitingApproval", "queued"].includes(action.status) && (permission === "owner" || action.requestedBy.id === actor.id),
    })),
    importableActions: importableActions.map((action) => Object.freeze({ ...action, canCancel: false })),
    pagination: listPagination(input.page, input.pageSize, actionTotal),
    canManagePolicies: permission === "owner",
    canApprove: permission === "owner",
    canImportResults: permission === "owner" || permission === "edit",
    archived: project.archivedAt !== null,
  });
}

export async function requestProjectAction(projectIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return fail("ACTION_INVALID_INPUT");
  await assertActiveProject(actor, projectId, "edit", db);
  const capability = CAPABILITY_CATALOG[parsed.data.capability];
  const canonicalInput = capability.id === "project.mcp.read-tool.invoke"
    ? await buildMcpActionSnapshot(projectId, parsed.data.input, db)
    : canonicalProjectActionInput(capability.id, parsed.data.input);
  const inputFingerprint = projectActionInputFingerprint(projectId, capability.id, canonicalInput);
  const idempotencyKey = hash(`project-action-request:v1:${projectId}:${actor.id}:${parsed.data.clientRequestId}`);
  const existing = await db.projectAction.findUnique({
    where: { projectId_requestedById_idempotencyKey: { projectId, requestedById: actor.id, idempotencyKey } },
    select: actionSelect,
  });
  if (existing !== null) {
    if (existing.capability !== capability.id || existing.inputFingerprint !== inputFingerprint) return fail("ACTION_IDEMPOTENCY_CONFLICT");
    return existing;
  }

  let action;
  try {
    action = await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${capability.id}`}::text, 31010001))`);
      const duplicate = await tx.projectAction.findUnique({ where: { projectId_requestedById_idempotencyKey: { projectId, requestedById: actor.id, idempotencyKey } }, select: actionSelect });
      if (duplicate !== null) {
        if (duplicate.capability !== capability.id || duplicate.inputFingerprint !== inputFingerprint) return fail("ACTION_IDEMPOTENCY_CONFLICT");
        return duplicate;
      }
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
      if (project === null) return fail("ACTION_PROJECT_NOT_FOUND");
      if (project.archivedAt !== null) return fail("ACTION_PROJECT_ARCHIVED");
      const override = await tx.projectActionPolicy.findUnique({ where: { projectId_capability: { projectId, capability: capability.id } }, select: { mode: true } });
      const configuredMode: ProjectActionPolicyMode = override?.mode ?? capability.defaultPolicy;
      const policyMode: ProjectActionPolicyMode = capability.id === "project.mcp.read-tool.invoke" && configuredMode !== "denied"
        ? "approvalRequired"
        : configuredMode;
      if (policyMode === "denied") return fail("ACTION_POLICY_DENIED");
      const now = new Date();
      const status = policyMode === "automatic" ? "queued" as const : "waitingApproval" as const;
      const approvalExpiresAt = policyMode === "approvalRequired" ? new Date(now.getTime() + APPROVAL_TTL_MS) : null;
      const created = await tx.projectAction.create({
        data: {
          id: randomUUID(),
          projectId,
          capability: capability.id,
          riskLevel: capability.riskLevel,
          status,
          input: canonicalInput as Prisma.InputJsonObject,
          inputFingerprint,
          policyModeSnapshot: policyMode,
          idempotencyKey,
          requestedById: actor.id,
          approvalExpiresAt,
          updatedAt: now,
        },
        select: actionSelect,
      });
      await tx.projectActionAudit.createMany({ data: [
        { id: randomUUID(), projectId, actionId: created.id, event: "requested", actorId: actor.id, details: { capability: capability.id, riskLevel: capability.riskLevel, inputFingerprint } },
        { id: randomUUID(), projectId, actionId: created.id, event: status === "queued" ? "queued" : "approvalRequested", actorId: actor.id, details: { policyMode } },
      ] });
      return tx.projectAction.findUniqueOrThrow({ where: { id: created.id }, select: actionSelect });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await db.projectAction.findUniqueOrThrow({ where: { projectId_requestedById_idempotencyKey: { projectId, requestedById: actor.id, idempotencyKey } }, select: actionSelect });
      if (duplicate.capability !== capability.id || duplicate.inputFingerprint !== inputFingerprint) return fail("ACTION_IDEMPOTENCY_CONFLICT");
      return duplicate;
    }
    throw error;
  }
  if (action.policyModeSnapshot === "approvalRequired") await notifyProjectApprovers(projectId, action.id, actor.id, capability.label, db);
  return action;
}

export async function updateProjectActionPolicy(projectIdInput: unknown, capabilityInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const capability = parseCapability(capabilityInput);
  const parsed = policyUpdateSchema.safeParse(input);
  if (!parsed.success) return fail("ACTION_INVALID_INPUT");
  if (capability === "project.mcp.read-tool.invoke" && parsed.data.mode === "automatic") return fail("ACTION_INVALID_INPUT");
  await assertActiveProject(actor, projectId, "owner", db);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${capability}`}::text, 31010001))`);
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
    if (project === null) return fail("ACTION_PROJECT_NOT_FOUND");
    if (project.archivedAt !== null) return fail("ACTION_PROJECT_ARCHIVED");
    const current = await tx.projectActionPolicy.findUnique({ where: { projectId_capability: { projectId, capability } } });
    const expected = parsed.data.expectedUpdatedAt === null ? null : parseTimestamp(parsed.data.expectedUpdatedAt);
    if ((current === null) !== (expected === null)) return fail("ACTION_POLICY_CONFLICT");
    if (current !== null && expected !== null && current.updatedAt.getTime() !== expected.getTime()) return fail("ACTION_POLICY_CONFLICT");
    if (current?.mode === parsed.data.mode) return current;
    const changedAt = new Date();
    const policy = await tx.projectActionPolicy.upsert({
      where: { projectId_capability: { projectId, capability } },
      create: { id: randomUUID(), projectId, capability, mode: parsed.data.mode, updatedById: actor.id, createdAt: changedAt, updatedAt: changedAt },
      update: { mode: parsed.data.mode, updatedById: actor.id, updatedAt: changedAt },
    });
    await tx.projectActionPolicyRevision.create({
      data: { id: randomUUID(), projectId, capability, previousMode: current?.mode ?? null, currentMode: policy.mode, changedById: actor.id, policyUpdatedAt: policy.updatedAt },
    });
    return policy;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function decideProjectAction(projectIdInput: unknown, actionIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const actionId = uuid(actionIdInput);
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return fail("ACTION_INVALID_INPUT");
  await assertActiveProject(actor, projectId, "owner", db);
  const outcome = await db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${actionId}::text, 31010002))`);
    const action = await tx.projectAction.findFirst({ where: { id: actionId, projectId }, select: { id: true, status: true, inputFingerprint: true, approvalExpiresAt: true, updatedAt: true, requestedById: true } });
    if (action === null) return fail("ACTION_NOT_FOUND");
    if (action.updatedAt.getTime() !== parseTimestamp(parsed.data.expectedUpdatedAt).getTime() || action.inputFingerprint !== parsed.data.expectedFingerprint) return fail("ACTION_DECISION_CONFLICT");
    if (action.status !== "waitingApproval") return fail("ACTION_STATE_CONFLICT");
    const now = new Date();
    if (action.approvalExpiresAt === null || action.approvalExpiresAt <= now) {
      await tx.projectAction.update({ where: { id: actionId }, data: { status: "expired", completedAt: now, updatedAt: now } });
      await tx.projectActionAudit.create({ data: { id: randomUUID(), projectId, actionId, event: "expired", actorId: actor.id, details: { reason: "APPROVAL_WINDOW_EXPIRED" } } });
      return { expired: true as const, requesterId: action.requestedById, action: await tx.projectAction.findUniqueOrThrow({ where: { id: actionId }, select: actionSelect }) };
    }
    await tx.projectActionApproval.create({
      data: { id: randomUUID(), projectId, actionId, decision: parsed.data.decision, actionFingerprint: action.inputFingerprint, decidedById: actor.id, note: parsed.data.note ?? null, decidedAt: now },
    });
    const approved = parsed.data.decision === "approved";
    await tx.projectAction.update({
      where: { id: actionId },
      data: { status: approved ? "queued" : "rejected", ...(approved ? {} : { completedAt: now }), updatedAt: now },
    });
    await tx.projectActionAudit.create({ data: { id: randomUUID(), projectId, actionId, event: approved ? "approved" : "rejected", actorId: actor.id, details: { actionFingerprint: action.inputFingerprint, noteProvided: Boolean(parsed.data.note) } } });
    if (approved) await tx.projectActionAudit.create({ data: { id: randomUUID(), projectId, actionId, event: "queued", actorId: actor.id, details: { policyMode: "approvalRequired" } } });
    return { expired: false as const, requesterId: action.requestedById, action: await tx.projectAction.findUniqueOrThrow({ where: { id: actionId }, select: actionSelect }) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (outcome.expired) {
    await tryCreateActionNotification({ userId: outcome.requesterId, projectId, kind: "actionFailed", severity: "warning", title: "动作审批已过期", body: "审批窗口已经结束，请重新创建动作。", actionId, dedupeSuffix: "approval-expired" }, db);
    return fail("ACTION_APPROVAL_EXPIRED");
  }
  await tryCreateActionNotification({
    userId: outcome.requesterId,
    projectId,
    kind: outcome.action.status === "queued" ? "system" : "actionFailed",
    severity: outcome.action.status === "queued" ? "info" : "warning",
    title: outcome.action.status === "queued" ? "动作已批准并进入队列" : "动作申请已被拒绝",
    body: outcome.action.status === "queued" ? "Worker 将按持久化租约领取并执行该动作。" : "该动作不会执行；审批意见已保留在审计记录中。",
    actionId,
    dedupeSuffix: `decision-${outcome.action.status}`,
  }, db);
  return outcome.action;
}

export async function cancelProjectAction(projectIdInput: unknown, actionIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const actionId = uuid(actionIdInput);
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return fail("ACTION_INVALID_INPUT");
  await assertProjectAccess(actor, projectId, "edit", db);
  const permission = await getProjectPermission(actor, projectId, db);
  if (permission === null) return fail("ACTION_PROJECT_NOT_FOUND");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${actionId}::text, 31010003))`);
    const action = await tx.projectAction.findFirst({ where: { id: actionId, projectId }, select: { id: true, requestedById: true, status: true, updatedAt: true } });
    if (action === null) return fail("ACTION_NOT_FOUND");
    if (permission !== "owner" && action.requestedById !== actor.id) return fail("ACTION_CANCEL_FORBIDDEN");
    if (action.updatedAt.getTime() !== parseTimestamp(parsed.data.expectedUpdatedAt).getTime()) return fail("ACTION_DECISION_CONFLICT");
    if (!isProjectActionTransitionAllowed(action.status, "cancelled")) return fail("ACTION_STATE_CONFLICT");
    const now = new Date();
    await tx.projectAction.update({ where: { id: actionId }, data: { status: "cancelled", completedAt: now, updatedAt: now } });
    await tx.projectActionAudit.create({ data: { id: randomUUID(), projectId, actionId, event: "cancelled", actorId: actor.id, details: { previousStatus: action.status } } });
    return tx.projectAction.findUniqueOrThrow({ where: { id: actionId }, select: actionSelect });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function recoverExpiredActions(now: Date, db: PrismaClient): Promise<{ leases: number; approvals: number }> {
  const expiredApprovals = await db.projectAction.findMany({ where: { status: "waitingApproval", approvalExpiresAt: { lt: now } }, take: 50, select: { id: true, projectId: true, requestedById: true } });
  let approvals = 0;
  for (const action of expiredApprovals) {
    const changed = await db.$transaction(async (tx) => {
      const updated = await tx.projectAction.updateMany({ where: { id: action.id, status: "waitingApproval", approvalExpiresAt: { lt: now } }, data: { status: "expired", completedAt: now, updatedAt: now } });
      if (updated.count !== 1) return false;
      await tx.projectActionAudit.create({ data: { id: randomUUID(), projectId: action.projectId, actionId: action.id, event: "expired", details: { reason: "APPROVAL_WINDOW_EXPIRED" } } });
      return true;
    });
    if (!changed) continue;
    approvals += 1;
    await tryCreateActionNotification({ userId: action.requestedById, projectId: action.projectId, kind: "actionFailed", severity: "warning", title: "动作审批已过期", body: "审批窗口已经结束，请重新创建动作。", actionId: action.id, dedupeSuffix: "approval-expired" }, db);
  }

  const expiredLeases = await db.projectAction.findMany({ where: { status: "running", leaseExpiresAt: { lt: now } }, take: 50, select: { id: true, projectId: true, requestedById: true } });
  let leases = 0;
  for (const action of expiredLeases) {
    const changed = await db.$transaction(async (tx) => {
      const updated = await tx.projectAction.updateMany({ where: { id: action.id, status: "running", leaseExpiresAt: { lt: now } }, data: { status: "failed", failureCode: "ACTION_LEASE_EXPIRED", leaseExpiresAt: null, completedAt: now, updatedAt: now } });
      if (updated.count !== 1) return false;
      await tx.projectActionAudit.create({ data: { id: randomUUID(), projectId: action.projectId, actionId: action.id, event: "failed", details: { failureCode: "ACTION_LEASE_EXPIRED" } } });
      return true;
    });
    if (!changed) continue;
    leases += 1;
    await tryCreateActionNotification({ userId: action.requestedById, projectId: action.projectId, kind: "actionFailed", severity: "error", title: "动作执行租约已过期", body: "系统已失败关闭该动作，不会自动重复外部读取。请核对审计记录后重新创建。", actionId: action.id, dedupeSuffix: "lease-expired" }, db);
  }
  return { leases, approvals };
}

async function claimAction(workerId: string, now: Date, db: PrismaClient): Promise<ClaimedAction | null> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT action."id"
      FROM "ProjectAction" AS action
      JOIN "Project" AS project ON project."id" = action."projectId"
      WHERE action."status" = 'queued'::"ProjectActionStatus"
        AND project."archivedAt" IS NULL
      ORDER BY action."createdAt" ASC, action."id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const id = rows[0]?.id;
    if (id === undefined) return null;
    const updated = await tx.projectAction.update({
      where: { id },
      data: { status: "running", workerId, leaseExpiresAt: new Date(now.getTime() + ACTION_LEASE_MS), attemptCount: { increment: 1 }, startedAt: now, updatedAt: now },
      include: { requestedBy: true },
    });
    await tx.projectActionAudit.create({ data: { id: randomUUID(), projectId: updated.projectId, actionId: id, event: "claimed", details: { workerIdHash: hash(workerId) } } });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function startActionHeartbeat(action: ClaimedAction, db: PrismaClient): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    const now = new Date();
    void db.projectAction.updateMany({
      where: { id: action.id, status: "running", workerId: action.workerId },
      data: { leaseExpiresAt: new Date(now.getTime() + ACTION_LEASE_MS), updatedAt: now },
    }).catch(() => undefined).finally(() => { inFlight = false; });
  }, ACTION_HEARTBEAT_MS);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearInterval(timer);
}

async function executeAction(action: ClaimedAction, db: PrismaClient): Promise<Prisma.InputJsonObject> {
  const capability = parseCapability(action.capability);
  canonicalProjectActionInput(capability, action.input);
  if (capability === "project.repository.sync") {
    const links = await db.projectGitRepositoryLink.findMany({ where: { projectId: action.projectId, status: "active", codeEnabled: true }, orderBy: { id: "asc" }, select: { id: true } });
    const jobIds: string[] = [];
    for (const link of links) {
      const job = await runGitRepositorySyncJob({ projectId: action.projectId, linkId: link.id, requestedBy: action.requestedBy, clientKey: `project-action:${action.id}:${link.id}` }, db);
      jobIds.push(job.id);
      if (job.status !== "succeeded") throw new ActionExecutionError(job.failureCode ?? "ACTION_REPOSITORY_SYNC_FAILED", { repositoryCount: links.length, completedCount: jobIds.length - 1 });
    }
    return { repositoryCount: links.length, jobIds };
  }
  if (capability === "project.web-source.sync") {
    const { syncAllProjectWebSources } = await import("@/lib/web-sources");
    const results = await syncAllProjectWebSources(action.projectId, action.requestedBy, db);
    const failedCount = results.filter((entry) => entry.status === "failed").length;
    if (failedCount > 0) throw new ActionExecutionError("ACTION_WEB_SOURCE_SYNC_PARTIAL_FAILURE", { sourceCount: results.length, failedCount });
    return { sourceCount: results.length, failedCount: 0 };
  }
  if (capability === "project.mcp.read-tool.invoke") {
    const result = await executeMcpActionSnapshot(action.projectId, action.input, db);
    return {
      connectionId: result.connectionId,
      toolName: result.toolName,
      definitionFingerprint: result.definitionFingerprint,
      text: result.text ?? "",
      structuredContent: (result.structuredContent ?? {}) as Prisma.InputJsonValue,
      hasStructuredContent: result.structuredContent !== null,
      omittedContentCount: result.omittedContentCount,
      resultFingerprint: result.resultFingerprint,
    };
  }
  const { analyzeProjectMemoryQuality } = await import("@/lib/memory-quality");
  const result = await analyzeProjectMemoryQuality(action.projectId, db);
  return { score: result.score, openIssueCount: result.openIssueCount };
}

async function finishAction(action: ClaimedAction, outcome: Readonly<{ status: "succeeded" | "failed"; result?: Prisma.InputJsonObject; failureCode?: string }>, db: PrismaClient): Promise<void> {
  const now = new Date();
  await db.$transaction(async (tx) => {
    const updated = await tx.projectAction.updateMany({
      where: { id: action.id, status: "running", workerId: action.workerId },
      data: {
        status: outcome.status,
        result: outcome.result,
        failureCode: outcome.status === "failed" ? outcome.failureCode ?? "ACTION_EXECUTION_FAILED" : null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) return fail("ACTION_STATE_CONFLICT");
    await tx.projectActionAudit.create({ data: { id: randomUUID(), projectId: action.projectId, actionId: action.id, event: outcome.status, details: outcome.status === "failed" ? { failureCode: outcome.failureCode ?? "ACTION_EXECUTION_FAILED" } : { resultFingerprint: hash(JSON.stringify(outcome.result ?? {})) } } });
  });
}

export async function runProjectActionWorkerCycle(input: Readonly<{ workerId: string; maximumActions?: number }>, db: PrismaClient = getDb()) {
  if (!WORKER_PATTERN.test(input.workerId)) return fail("ACTION_INVALID_INPUT");
  const maximumActions = input.maximumActions ?? 5;
  if (!Number.isInteger(maximumActions) || maximumActions < 1 || maximumActions > 20) return fail("ACTION_INVALID_INPUT");
  const recovered = await recoverExpiredActions(new Date(), db);
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < maximumActions; index += 1) {
    const action = await claimAction(input.workerId, new Date(), db);
    if (action === null) break;
    claimed += 1;
    const stopHeartbeat = startActionHeartbeat(action, db);
    let outcome: Readonly<{ status: "succeeded"; result: Prisma.InputJsonObject }> | Readonly<{ status: "failed"; failureCode: string; result?: Prisma.InputJsonObject }>;
    try {
      const result = await executeAction(action, db);
      outcome = { status: "succeeded", result };
    } catch (error) {
      const failureCode = error instanceof ActionExecutionError
        ? error.failureCode
        : error instanceof Error && SAFE_FAILURE_CODE.test(error.message)
          ? error.message
          : "ACTION_EXECUTION_FAILED";
      const safeFailureCode = SAFE_FAILURE_CODE.test(failureCode) ? failureCode : "ACTION_EXECUTION_FAILED";
      const safeResult = error instanceof ActionExecutionError ? error.safeResult : undefined;
      outcome = { status: "failed", failureCode: safeFailureCode, result: safeResult };
    } finally {
      stopHeartbeat();
    }
    try {
      await finishAction(action, outcome, db);
    } catch {
      continue;
    }
    if (outcome.status === "succeeded") {
      succeeded += 1;
      await tryCreateActionNotification({ userId: action.requestedById, projectId: action.projectId, kind: "actionCompleted", severity: "success", title: `动作已完成：${CAPABILITY_CATALOG[parseCapability(action.capability)].label}`, body: "执行结果和完整状态变化已写入动作审计。", actionId: action.id, dedupeSuffix: "completed" }, db);
    } else {
      failed += 1;
      await tryCreateActionNotification({ userId: action.requestedById, projectId: action.projectId, kind: "actionFailed", severity: "error", title: `动作执行失败：${CAPABILITY_CATALOG[parseCapability(action.capability)].label}`, body: `安全错误码：${outcome.failureCode}。系统不会自动重复执行。`, actionId: action.id, dedupeSuffix: "failed" }, db);
    }
  }
  return Object.freeze({ recoveredLeases: recovered.leases, expiredApprovals: recovered.approvals, claimed, succeeded, failed });
}
