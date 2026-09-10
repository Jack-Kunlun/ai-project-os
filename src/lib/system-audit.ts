import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";

export const SYSTEM_AUDIT_SOURCES = [
  "platformDefaultAiRoute",
  "membershipSubscription",
  "accountAccess",
  "membershipAccess",
  "workspaceInvitation",
  "mcpToolAttestation",
  "projectAiProviderDelegation",
  "projectGitRepositoryDelegation",
  "projectMcpConnectionDelegation",
  "projectMcpToolGrantLedger",
] as const;

export type SystemAuditSource = (typeof SYSTEM_AUDIT_SOURCES)[number];

export const SYSTEM_AUDIT_SOURCE_LABELS: Readonly<Record<SystemAuditSource, string>> = {
  platformDefaultAiRoute: "平台默认路由",
  membershipSubscription: "会员资格",
  accountAccess: "账号状态",
  membershipAccess: "成员访问",
  workspaceInvitation: "工作区邀请",
  mcpToolAttestation: "MCP 工具认证",
  projectAiProviderDelegation: "项目 AI 委托",
  projectGitRepositoryDelegation: "项目 Git 委托",
  projectMcpConnectionDelegation: "项目 MCP 委托",
  projectMcpToolGrantLedger: "项目 MCP 工具授权",
};

export const SYSTEM_AUDIT_ACTIONS = [
  "draftCreated",
  "draftUpdated",
  "validated",
  "activated",
  "retired",
  "grant",
  "extend",
  "revoke",
  "disabled",
  "restored",
  "migrationQuarantined",
  "confirmed",
  "bootstrapConfirmed",
  "created",
  "accepted",
  "attested",
  "proposed",
  "ownerConfirmed",
  "rejected",
  "revoked",
  "expired",
  "platformSelected",
  "personalSelected",
  "selectionUpdated",
  "granted",
] as const;

export type SystemAuditAction = (typeof SYSTEM_AUDIT_ACTIONS)[number];

export const SYSTEM_AUDIT_RESULTS = [
  "applied",
  "pending",
  "disabled",
  "restored",
  "rejected",
  "revoked",
  "expired",
  "unknown",
] as const;

export type SystemAuditResult = (typeof SYSTEM_AUDIT_RESULTS)[number];

export type SystemAuditRegistryEntry = Readonly<{
  source: SystemAuditSource;
  label: string;
  table: string;
  selectedFields: readonly string[];
  referenceFields: readonly string[];
  actionField: string;
  allowedActions: readonly string[];
  actionMap: Readonly<Record<string, string>>;
  resultField: string;
  resultMap: Readonly<Partial<Record<SystemAuditResult, readonly string[]>>>;
}>;

function actionMapping(actions: readonly string[]): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(actions.map((action) => [action, action])));
}

function resultMapping(input: Readonly<Partial<Record<SystemAuditResult, readonly string[]>>>): Readonly<Partial<Record<SystemAuditResult, readonly string[]>>> {
  return Object.freeze(input);
}

/**
 * The registry is intentionally declarative.  Query code below is still a
 * static switch so a request can never choose a Prisma delegate, relation, or
 * field by name.
 */
export const SYSTEM_AUDIT_REGISTRY: Readonly<Record<SystemAuditSource, SystemAuditRegistryEntry>> = {
  platformDefaultAiRoute: {
    source: "platformDefaultAiRoute",
    label: SYSTEM_AUDIT_SOURCE_LABELS.platformDefaultAiRoute,
    table: "PlatformDefaultAiRouteAudit",
    selectedFields: ["id", "action", "routeId", "operation", "routeVersion", "providerConnectionId", "providerConfigurationVersion", "actorId", "reason", "createdAt"],
    referenceFields: ["routeId", "providerConnectionId"],
    actionField: "action",
    allowedActions: ["draftCreated", "draftUpdated", "validated", "activated", "retired"],
    actionMap: actionMapping(["draftCreated", "draftUpdated", "validated", "activated", "retired"]),
    resultField: "action",
    resultMap: resultMapping({ applied: ["draftCreated", "draftUpdated", "validated", "activated", "retired"] }),
  },
  membershipSubscription: {
    source: "membershipSubscription",
    label: SYSTEM_AUDIT_SOURCE_LABELS.membershipSubscription,
    table: "MembershipSubscriptionAudit",
    selectedFields: ["id", "subscriptionId", "userId", "actorId", "eventKind", "versionBefore", "versionAfter", "statusBefore", "statusAfter", "reason", "createdAt"],
    referenceFields: ["subscriptionId", "userId"],
    actionField: "eventKind",
    allowedActions: ["grant", "extend", "revoke"],
    actionMap: actionMapping(["grant", "extend", "revoke"]),
    resultField: "eventKind",
    resultMap: resultMapping({ applied: ["grant", "extend"], revoked: ["revoke"] }),
  },
  accountAccess: {
    source: "accountAccess",
    label: SYSTEM_AUDIT_SOURCE_LABELS.accountAccess,
    table: "AccountAccessAudit",
    selectedFields: ["id", "userId", "actorId", "event", "versionBefore", "versionAfter", "disabledAtBefore", "disabledAtAfter", "previewId", "reason", "createdAt"],
    referenceFields: ["userId", "previewId"],
    actionField: "event",
    allowedActions: ["disabled", "restored"],
    actionMap: actionMapping(["disabled", "restored"]),
    resultField: "event",
    resultMap: resultMapping({ disabled: ["disabled"], restored: ["restored"] }),
  },
  membershipAccess: {
    source: "membershipAccess",
    label: SYSTEM_AUDIT_SOURCE_LABELS.membershipAccess,
    table: "MembershipAccessAudit",
    selectedFields: ["id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId", "action", "previousState", "newState", "roleSnapshot", "actorId", "reason", "createdAt"],
    referenceFields: ["membershipId", "workspaceId", "projectId", "userId"],
    actionField: "action",
    allowedActions: ["migrationQuarantined", "confirmed", "revoked", "bootstrapConfirmed"],
    actionMap: actionMapping(["migrationQuarantined", "confirmed", "revoked", "bootstrapConfirmed"]),
    resultField: "action",
    resultMap: resultMapping({ applied: ["confirmed", "bootstrapConfirmed"], pending: ["migrationQuarantined"], revoked: ["revoked"] }),
  },
  workspaceInvitation: {
    source: "workspaceInvitation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.workspaceInvitation,
    table: "WorkspaceInvitationAudit",
    selectedFields: ["id", "invitationId", "workspaceId", "event", "versionBefore", "versionAfter", "statusBefore", "statusAfter", "actorId", "reason", "createdAt"],
    referenceFields: ["invitationId", "workspaceId"],
    actionField: "event",
    allowedActions: ["created", "accepted", "revoked"],
    actionMap: actionMapping(["created", "accepted", "revoked"]),
    resultField: "event",
    resultMap: resultMapping({ applied: ["created", "accepted"], revoked: ["revoked"] }),
  },
  mcpToolAttestation: {
    source: "mcpToolAttestation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.mcpToolAttestation,
    table: "McpToolAttestationAudit",
    selectedFields: ["id", "attestationId", "connectionId", "toolDefinitionId", "event", "actorId", "controlPlaneVersion", "attestationVersion", "statusBefore", "statusAfter", "connectionConfigurationRevision", "createdAt"],
    referenceFields: ["attestationId", "connectionId", "toolDefinitionId"],
    actionField: "event",
    allowedActions: ["attested", "revoked"],
    actionMap: actionMapping(["attested", "revoked"]),
    resultField: "event",
    resultMap: resultMapping({ applied: ["attested"], revoked: ["revoked"] }),
  },
  projectAiProviderDelegation: {
    source: "projectAiProviderDelegation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectAiProviderDelegation,
    table: "ProjectAiProviderDelegationAudit",
    selectedFields: ["id", "projectId", "operation", "entity", "action", "delegationId", "selectionId", "delegationVersion", "selectionVersion", "statusBefore", "statusAfter", "selectionSource", "selectedDelegationId", "selectedByProjectMembershipId", "providerConnectionId", "connectionOwnerId", "providerConfigurationVersion", "connectionOwnerAccountAccessVersion", "actorKind", "actorId", "actorProjectMembershipId", "reason", "createdAt"],
    referenceFields: ["projectId", "delegationId", "selectionId", "providerConnectionId", "connectionOwnerId"],
    actionField: "action",
    allowedActions: ["proposed", "ownerConfirmed", "activated", "rejected", "revoked", "expired", "platformSelected", "personalSelected", "selectionUpdated"],
    actionMap: actionMapping(["proposed", "ownerConfirmed", "activated", "rejected", "revoked", "expired", "platformSelected", "personalSelected", "selectionUpdated"]),
    resultField: "action",
    resultMap: resultMapping({ applied: ["activated", "platformSelected", "personalSelected", "selectionUpdated"], pending: ["proposed", "ownerConfirmed"], rejected: ["rejected"], revoked: ["revoked"], expired: ["expired"] }),
  },
  projectGitRepositoryDelegation: {
    source: "projectGitRepositoryDelegation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectGitRepositoryDelegation,
    table: "ProjectGitRepositoryDelegationAudit",
    selectedFields: ["id", "projectId", "gitConnectionId", "delegationId", "connectionOwnerId", "action", "delegationVersion", "statusBefore", "statusAfter", "actorKind", "actorId", "actorProjectMembershipId", "ownerProjectMembershipId", "connectionConfigurationVersion", "connectionOwnerAccountAccessVersion", "reason", "createdAt"],
    referenceFields: ["projectId", "gitConnectionId", "delegationId", "connectionOwnerId"],
    actionField: "action",
    allowedActions: ["proposed", "ownerConfirmed", "activated", "rejected", "revoked", "expired"],
    actionMap: actionMapping(["proposed", "ownerConfirmed", "activated", "rejected", "revoked", "expired"]),
    resultField: "action",
    resultMap: resultMapping({ applied: ["activated"], pending: ["proposed", "ownerConfirmed"], rejected: ["rejected"], revoked: ["revoked"], expired: ["expired"] }),
  },
  projectMcpConnectionDelegation: {
    source: "projectMcpConnectionDelegation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectMcpConnectionDelegation,
    table: "ProjectMcpConnectionDelegationAudit",
    selectedFields: ["id", "projectId", "mcpConnectionId", "delegationId", "connectionOwnerId", "action", "delegationVersion", "statusBefore", "statusAfter", "actorKind", "actorId", "actorProjectMembershipId", "ownerProjectMembershipId", "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "reason", "createdAt"],
    referenceFields: ["projectId", "mcpConnectionId", "delegationId", "connectionOwnerId"],
    actionField: "action",
    allowedActions: ["proposed", "ownerConfirmed", "activated", "rejected", "revoked", "expired"],
    actionMap: actionMapping(["proposed", "ownerConfirmed", "activated", "rejected", "revoked", "expired"]),
    resultField: "action",
    resultMap: resultMapping({ applied: ["activated"], pending: ["proposed", "ownerConfirmed"], rejected: ["rejected"], revoked: ["revoked"], expired: ["expired"] }),
  },
  projectMcpToolGrantLedger: {
    source: "projectMcpToolGrantLedger",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectMcpToolGrantLedger,
    table: "ProjectMcpToolGrantLedger",
    selectedFields: ["id", "projectId", "grantId", "connectionId", "delegationId", "toolDefinitionId", "attestationId", "connectionOwnerId", "controlPlaneVersion", "grantVersion", "event", "statusBefore", "statusAfter", "actorId", "actorProjectMembershipId", "delegationVersion", "connectionConfigurationRevision", "grantorProjectMembershipId", "revokerProjectMembershipId", "acknowledgedAt", "transactionId", "transitionAt", "createdAt"],
    referenceFields: ["projectId", "grantId", "connectionId", "delegationId", "toolDefinitionId", "attestationId", "connectionOwnerId"],
    actionField: "event",
    allowedActions: ["granted", "revoked"],
    actionMap: actionMapping(["granted", "revoked"]),
    resultField: "event",
    resultMap: resultMapping({ applied: ["granted"], revoked: ["revoked"] }),
  },
};

export type SystemAuditFilters = Readonly<{
  source?: SystemAuditSource;
  action?: SystemAuditAction;
  result?: SystemAuditResult;
  actor?: string;
  subject?: string;
  projectId?: string;
  workspaceId?: string;
  userId?: string;
  from?: Date;
  to?: Date;
}>;

export type SystemAuditQuery = Readonly<SystemAuditFilters & {
  cursor?: string;
  pageSize?: number;
}>;

export const SYSTEM_AUDIT_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const SYSTEM_AUDIT_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const SYSTEM_AUDIT_CURSOR_CONTEXT = "ai-project-os:system-audit-cursor:v1";
const SYSTEM_AUDIT_FILTER_CONTEXT = "ai-project-os:system-audit-filter:v1";
export const SYSTEM_AUDIT_MAX_PAGE_SIZE = 50;
const MAX_USER_LOOKUP_RESULTS = 2;
const MAX_HYDRATED_USER_IDS = SYSTEM_AUDIT_MAX_PAGE_SIZE * 2;

export type SystemAuditPrincipal = Readonly<{
  kind: "user" | "system" | "unrecorded";
  id: string | null;
  username: string | null;
  displayName: string | null;
}>;

export type SystemAuditReferences = Readonly<Record<string, string>>;

export type SystemAuditEvidence = Readonly<{
  before: Readonly<Record<string, string | number | boolean | null>>;
  after: Readonly<Record<string, string | number | boolean | null>>;
  versions: Readonly<Record<string, number | null>>;
  safeErrorCode: string | null;
  reasonRecorded: boolean;
}>;

export type SystemAuditEvent = Readonly<{
  id: string;
  source: SystemAuditSource;
  action: string;
  result: SystemAuditResult;
  occurredAt: string;
  actor: SystemAuditPrincipal;
  subject: SystemAuditPrincipal | null;
  references: SystemAuditReferences;
  evidence: SystemAuditEvidence;
}>;

export type SystemAuditList = Readonly<{
  events: readonly SystemAuditEvent[];
  nextCursor: string | null;
  snapshotAt: string;
  pageSize: number;
}>;

const querySchema = z.object({
  source: z.enum(SYSTEM_AUDIT_SOURCES).optional(),
  action: z.enum(SYSTEM_AUDIT_ACTIONS).optional(),
  result: z.enum(SYSTEM_AUDIT_RESULTS).optional(),
  actor: z.string().trim().min(1).max(160).optional(),
  subject: z.string().trim().min(1).max(160).optional(),
  projectId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  to: z.string().datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  pageSize: z.coerce.number().int().min(1).max(SYSTEM_AUDIT_MAX_PAGE_SIZE).default(20),
}).strict().superRefine((value, context) => {
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    context.addIssue({ code: "custom", path: ["from"], message: "from must be before to" });
  }
});

export function parseSystemAuditQuery(input: Readonly<Record<string, string | undefined>>): SystemAuditQuery {
  return querySchema.parse(input) as SystemAuditQuery;
}

type CursorPayload = Readonly<{
  version: 1;
  filterHash: string;
  snapshotAt: string;
  createdAt: string;
  source: SystemAuditSource;
  id: string;
}>;

const CURSOR_VERSION = 1 as const;

function auditError(code: string, message: string, status = 400): never {
  throw new ApiError(status, code, message);
}

function canonicalFilters(filters: SystemAuditFilters): string {
  return JSON.stringify({
    source: filters.source ?? null,
    action: filters.action ?? null,
    result: filters.result ?? null,
    actor: filters.actor ?? null,
    subject: filters.subject ?? null,
    projectId: filters.projectId ?? null,
    workspaceId: filters.workspaceId ?? null,
    userId: filters.userId ?? null,
    from: filters.from?.toISOString() ?? null,
    to: filters.to?.toISOString() ?? null,
  });
}

/** Bind the effective filters without exposing an unauthenticated checksum. */
async function filterHash(filters: SystemAuditFilters): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update(SYSTEM_AUDIT_FILTER_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(canonicalFilters(filters), "utf8")
    .digest("hex");
}

async function cursorSignature(encodedPayload: string): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update(SYSTEM_AUDIT_CURSOR_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

async function encodeCursor(payload: CursorPayload): Promise<string> {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${await cursorSignature(encodedPayload)}`;
}

async function decodeCursor(value: string): Promise<CursorPayload> {
  const [encodedPayload, signature, ...rest] = value.split(".");
  if (!encodedPayload || !signature || rest.length > 0) return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  const expectedSignature = await cursorSignature(encodedPayload);
  let supplied: Buffer;
  let expected: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
    expected = Buffer.from(expectedSignature, "base64url");
  } catch {
    return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown;
  } catch {
    return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  }
  const result = z.object({
    version: z.literal(CURSOR_VERSION),
    filterHash: z.string().length(64),
    snapshotAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
    source: z.enum(SYSTEM_AUDIT_SOURCES),
    id: z.string().uuid(),
  }).strict().safeParse(parsed);
  if (!result.success) return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  return result.data;
}

type RawAuditEvent = Readonly<{
  id: string;
  source: SystemAuditSource;
  action: string;
  result: SystemAuditResult;
  createdAt: Date;
  actorId: string | null;
  actorKind: "user" | "system" | "unrecorded";
  subjectId: string | null;
  references: SystemAuditReferences;
  evidence: SystemAuditEvidence;
}>;

type AuditValue = string | number | boolean | null;

function safeReferences(input: Readonly<{
  categories: readonly string[];
  projectId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
}>): SystemAuditReferences {
  return Object.freeze(Object.fromEntries([
    ["categories", input.categories.join(",")],
    ...(input.projectId === undefined || input.projectId === null ? [] : [["projectId", input.projectId]]),
    ...(input.workspaceId === undefined || input.workspaceId === null ? [] : [["workspaceId", input.workspaceId]]),
    ...(input.userId === undefined || input.userId === null ? [] : [["userId", input.userId]]),
  ]));
}

function principalKind(value: unknown): "user" | "system" | "unrecorded" {
  if (value === "user") return "user";
  if (typeof value === "string" && value.toLowerCase().includes("system")) return "system";
  return "unrecorded";
}

function statusResult(action: string, statusAfter: string | null | undefined): SystemAuditResult {
  if (action === "disabled" || action === "disable") return "disabled";
  if (action === "restored" || action === "restore") return "restored";
  if (action === "rejected") return "rejected";
  if (action === "revoked" || action === "revoke") return "revoked";
  if (action === "expired") return "expired";
  if (statusAfter === "rejected") return "rejected";
  if (statusAfter === "revoked") return "revoked";
  if (statusAfter === "expired") return "expired";
  if (statusAfter === "draft" || statusAfter === "ownerConfirmed" || statusAfter === "pending") return "pending";
  if (statusAfter === "active" || statusAfter === "confirmed") return "applied";
  if (action.length > 0) return "applied";
  return "unknown";
}

function evidence(
  before: Readonly<Record<string, AuditValue>> = {},
  after: Readonly<Record<string, AuditValue>> = {},
  versions: Readonly<Record<string, number | null>> = {},
  reasonRecorded = false,
): SystemAuditEvidence {
  return Object.freeze({
    before: Object.freeze(before),
    after: Object.freeze(after),
    versions: Object.freeze(versions),
    safeErrorCode: null,
    reasonRecorded,
  });
}

function rawEvent(input: Omit<RawAuditEvent, "result"> & { result?: SystemAuditResult }): RawAuditEvent {
  return Object.freeze({ ...input, result: input.result ?? "unknown" });
}

type PlatformRow = Prisma.PlatformDefaultAiRouteAuditGetPayload<{ select: typeof platformSelect }>;
const platformSelect = {
  id: true,
  action: true,
  routeId: true,
  operation: true,
  routeVersion: true,
  providerConnectionId: true,
  providerConfigurationVersion: true,
  actorId: true,
  reason: true,
  createdAt: true,
} as const;

type SubscriptionRow = Prisma.MembershipSubscriptionAuditGetPayload<{ select: typeof subscriptionSelect }>;
const subscriptionSelect = {
  id: true,
  subscriptionId: true,
  userId: true,
  actorId: true,
  eventKind: true,
  versionBefore: true,
  versionAfter: true,
  statusBefore: true,
  statusAfter: true,
  reason: true,
  createdAt: true,
} as const;

type AccountAccessRow = Prisma.AccountAccessAuditGetPayload<{ select: typeof accountAccessSelect }>;
const accountAccessSelect = {
  id: true,
  userId: true,
  actorId: true,
  event: true,
  versionBefore: true,
  versionAfter: true,
  disabledAtBefore: true,
  disabledAtAfter: true,
  previewId: true,
  reason: true,
  createdAt: true,
} as const;

type MembershipAccessRow = Prisma.MembershipAccessAuditGetPayload<{ select: typeof membershipAccessSelect }>;
const membershipAccessSelect = {
  id: true,
  membershipKind: true,
  membershipId: true,
  workspaceId: true,
  projectId: true,
  userId: true,
  action: true,
  previousState: true,
  newState: true,
  roleSnapshot: true,
  actorId: true,
  reason: true,
  createdAt: true,
} as const;

type InvitationRow = Prisma.WorkspaceInvitationAuditGetPayload<{ select: typeof invitationSelect }>;
const invitationSelect = {
  id: true,
  invitationId: true,
  workspaceId: true,
  event: true,
  versionBefore: true,
  versionAfter: true,
  statusBefore: true,
  statusAfter: true,
  actorId: true,
  reason: true,
  createdAt: true,
} as const;

type AttestationRow = Prisma.McpToolAttestationAuditGetPayload<{ select: typeof attestationSelect }>;
const attestationSelect = {
  id: true,
  attestationId: true,
  connectionId: true,
  toolDefinitionId: true,
  event: true,
  actorId: true,
  controlPlaneVersion: true,
  attestationVersion: true,
  statusBefore: true,
  statusAfter: true,
  connectionConfigurationRevision: true,
  createdAt: true,
} as const;

type ProjectAiRow = Prisma.ProjectAiProviderDelegationAuditGetPayload<{ select: typeof projectAiSelect }>;
const projectAiSelect = {
  id: true,
  projectId: true,
  operation: true,
  entity: true,
  action: true,
  delegationId: true,
  selectionId: true,
  delegationVersion: true,
  selectionVersion: true,
  statusBefore: true,
  statusAfter: true,
  selectionSource: true,
  selectedDelegationId: true,
  selectedByProjectMembershipId: true,
  providerConnectionId: true,
  connectionOwnerId: true,
  providerConfigurationVersion: true,
  connectionOwnerAccountAccessVersion: true,
  actorKind: true,
  actorId: true,
  actorProjectMembershipId: true,
  reason: true,
  createdAt: true,
} as const;

type GitRow = Prisma.ProjectGitRepositoryDelegationAuditGetPayload<{ select: typeof gitSelect }>;
const gitSelect = {
  id: true,
  projectId: true,
  gitConnectionId: true,
  delegationId: true,
  connectionOwnerId: true,
  action: true,
  delegationVersion: true,
  statusBefore: true,
  statusAfter: true,
  actorKind: true,
  actorId: true,
  actorProjectMembershipId: true,
  ownerProjectMembershipId: true,
  connectionConfigurationVersion: true,
  connectionOwnerAccountAccessVersion: true,
  reason: true,
  createdAt: true,
} as const;

type McpDelegationRow = Prisma.ProjectMcpConnectionDelegationAuditGetPayload<{ select: typeof mcpDelegationSelect }>;
const mcpDelegationSelect = {
  id: true,
  projectId: true,
  mcpConnectionId: true,
  delegationId: true,
  connectionOwnerId: true,
  action: true,
  delegationVersion: true,
  statusBefore: true,
  statusAfter: true,
  actorKind: true,
  actorId: true,
  actorProjectMembershipId: true,
  ownerProjectMembershipId: true,
  connectionConfigurationRevision: true,
  connectionOwnerAccountAccessVersion: true,
  reason: true,
  createdAt: true,
} as const;

type GrantRow = Prisma.ProjectMcpToolGrantLedgerGetPayload<{ select: typeof grantSelect }>;
const grantSelect = {
  id: true,
  projectId: true,
  grantId: true,
  connectionId: true,
  delegationId: true,
  toolDefinitionId: true,
  attestationId: true,
  connectionOwnerId: true,
  controlPlaneVersion: true,
  grantVersion: true,
  event: true,
  statusBefore: true,
  statusAfter: true,
  actorId: true,
  actorProjectMembershipId: true,
  delegationVersion: true,
  connectionConfigurationRevision: true,
  grantorProjectMembershipId: true,
  revokerProjectMembershipId: true,
  acknowledgedAt: true,
  transactionId: true,
  transitionAt: true,
  createdAt: true,
} as const;

type QueryContext = Readonly<{
  db: PrismaClient;
  filters: SystemAuditFilters;
  actorIds?: readonly string[];
  subjectIds?: readonly string[];
  snapshotAt: Date;
  cursor: CursorPayload | null;
  auditId?: string;
  take: number;
}>;

type SourceWhereOptions = Readonly<{
  actorField?: string;
  subjectField?: string;
  projectField?: string;
  workspaceField?: string;
}>;

function temporalWhere(context: QueryContext, source: SystemAuditSource): Record<string, unknown> {
  const dateRange: Record<string, Date> = { lte: context.snapshotAt };
  if (context.filters.from !== undefined) dateRange.gte = context.filters.from;
  if (context.filters.to !== undefined) dateRange.lte = context.filters.to;
  const cursor = context.cursor;
  if (cursor === null) return { createdAt: dateRange };
  if (source < cursor.source) return { createdAt: { ...dateRange, lt: new Date(cursor.createdAt) } };
  if (source > cursor.source) return { createdAt: { ...dateRange, lte: new Date(cursor.createdAt) } };
  return {
    AND: [{
      OR: [
        { createdAt: { ...dateRange, lt: new Date(cursor.createdAt) } },
        { createdAt: { ...dateRange, equals: new Date(cursor.createdAt) }, id: { lt: cursor.id } },
      ],
    }],
  };
}

function sourceWhere(context: QueryContext, source: SystemAuditSource, options: SourceWhereOptions): Record<string, unknown> {
  const where: Record<string, unknown> = { ...temporalWhere(context, source) };
  const filters = context.filters;
  const impossible = { in: [] as string[] };
  const registry = SYSTEM_AUDIT_REGISTRY[source];
  if (context.auditId !== undefined) where.id = context.auditId;
  if (filters.action !== undefined) {
    const mappedAction = registry.actionMap[filters.action];
    if (mappedAction === undefined) where.id = impossible;
    else where[registry.actionField] = mappedAction;
  }
  if (filters.projectId !== undefined) {
    if (options.projectField === undefined) where.id = impossible;
    else where[options.projectField] = filters.projectId;
  }
  if (filters.workspaceId !== undefined) {
    if (options.workspaceField === undefined) where.id = impossible;
    else where[options.workspaceField] = filters.workspaceId;
  }
  if (filters.userId !== undefined) {
    if (options.subjectField === undefined) where.id = impossible;
    else where[options.subjectField] = filters.userId;
  }
  if (context.actorIds !== undefined) {
    if (options.actorField === undefined) where.id = impossible;
    else where[options.actorField] = { in: context.actorIds };
  }
  if (context.subjectIds !== undefined) {
    if (options.subjectField === undefined) where.id = impossible;
    else where[options.subjectField] = { in: context.subjectIds };
  }
  if (filters.result !== undefined) {
    const mappedResults = registry.resultMap[filters.result];
    if (mappedResults === undefined || mappedResults.length === 0) where.id = impossible;
    else if (filters.action === undefined) where[registry.resultField] = { in: mappedResults };
    else {
      const mappedAction = registry.actionMap[filters.action];
      if (mappedAction === undefined || !mappedResults.includes(mappedAction)) where.id = impossible;
    }
  }
  return where;
}

function orderBy(): Array<{ createdAt: "desc" } | { id: "desc" }> {
  return [{ createdAt: "desc" }, { id: "desc" }];
}

function platformProjection(row: PlatformRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "platformDefaultAiRoute",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: null,
    references: safeReferences({ categories: ["platformDefaultRoute", "providerConnection"] }),
    evidence: evidence({}, {}, { route: row.routeVersion, providerConfiguration: row.providerConfigurationVersion }, row.reason !== null),
    result: statusResult(action, null),
  });
}

function subscriptionProjection(row: SubscriptionRow): RawAuditEvent {
  const action = String(row.eventKind);
  return rawEvent({
    id: row.id,
    source: "membershipSubscription",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.userId,
    references: safeReferences({ categories: ["membershipSubscription"], userId: row.userId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore), version: row.versionBefore },
      { status: row.statusAfter === null ? null : String(row.statusAfter), version: row.versionAfter },
      { before: row.versionBefore, after: row.versionAfter },
      row.reason !== null,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function accountAccessProjection(row: AccountAccessRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "accountAccess",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.userId,
    references: safeReferences({ categories: ["accountAccessPreview"], userId: row.userId }),
    evidence: evidence(
      { state: row.disabledAtBefore === null ? "enabled" : "disabled" },
      { state: row.disabledAtAfter === null ? "enabled" : "disabled" },
      { before: row.versionBefore, after: row.versionAfter },
      true,
    ),
    result: statusResult(action, null),
  });
}

function membershipAccessProjection(row: MembershipAccessRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "membershipAccess",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: row.actorId === null ? "unrecorded" : "user",
    subjectId: row.userId,
    references: safeReferences({ categories: ["membership"], workspaceId: row.workspaceId, projectId: row.projectId, userId: row.userId }),
    evidence: evidence(
      { state: row.previousState === null ? null : String(row.previousState), role: row.roleSnapshot },
      { state: String(row.newState), role: row.roleSnapshot },
      {},
      true,
    ),
    result: statusResult(action, String(row.newState)),
  });
}

function invitationProjection(row: InvitationRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "workspaceInvitation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: row.actorId === null ? "unrecorded" : "user",
    subjectId: null,
    references: safeReferences({ categories: ["workspaceInvitation"], workspaceId: row.workspaceId }),
    evidence: evidence(
      { status: row.statusBefore, version: row.versionBefore },
      { status: row.statusAfter, version: row.versionAfter },
      { before: row.versionBefore, after: row.versionAfter },
      true,
    ),
    result: statusResult(action, row.statusAfter),
  });
}

function attestationProjection(row: AttestationRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "mcpToolAttestation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: null,
    references: safeReferences({ categories: ["mcpConnection", "mcpTool", "attestation"] }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: row.statusAfter === null ? null : String(row.statusAfter) },
      { controlPlane: row.controlPlaneVersion, attestation: row.attestationVersion, connectionConfiguration: row.connectionConfigurationRevision },
      false,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function projectAiProjection(row: ProjectAiRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "projectAiProviderDelegation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: principalKind(row.actorKind),
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["projectAiDelegation", "provider"], projectId: row.projectId, userId: row.connectionOwnerId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore), entity: String(row.entity) },
      { status: row.statusAfter === null ? null : String(row.statusAfter), source: row.selectionSource === null ? null : String(row.selectionSource) },
      { delegation: row.delegationVersion, selection: row.selectionVersion, providerConfiguration: row.providerConfigurationVersion, accountAccess: row.connectionOwnerAccountAccessVersion },
      true,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function gitProjection(row: GitRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "projectGitRepositoryDelegation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: principalKind(row.actorKind),
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["gitConnection", "repositoryDelegation"], projectId: row.projectId, userId: row.connectionOwnerId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: row.statusAfter === null ? null : String(row.statusAfter) },
      { delegation: row.delegationVersion, connectionConfiguration: row.connectionConfigurationVersion, accountAccess: row.connectionOwnerAccountAccessVersion },
      true,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function mcpDelegationProjection(row: McpDelegationRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "projectMcpConnectionDelegation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: principalKind(row.actorKind),
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["mcpConnection", "connectionDelegation"], projectId: row.projectId, userId: row.connectionOwnerId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: row.statusAfter === null ? null : String(row.statusAfter) },
      { delegation: row.delegationVersion, connectionConfiguration: row.connectionConfigurationRevision, accountAccess: row.connectionOwnerAccountAccessVersion },
      true,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function grantProjection(row: GrantRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "projectMcpToolGrantLedger",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["mcpConnection", "mcpTool", "grant", "attestation", "delegation"], projectId: row.projectId, userId: row.connectionOwnerId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: String(row.statusAfter) },
      { controlPlane: row.controlPlaneVersion, grant: row.grantVersion, delegation: row.delegationVersion, connectionConfiguration: row.connectionConfigurationRevision },
      false,
    ),
    result: statusResult(action, String(row.statusAfter)),
  });
}

async function fetchPlatform(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.platformDefaultAiRouteAudit.findMany({
    where: sourceWhere(context, "platformDefaultAiRoute", { actorField: "actorId" }) as Prisma.PlatformDefaultAiRouteAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: platformSelect,
  });
  return rows.map(platformProjection);
}

async function fetchSubscription(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.membershipSubscriptionAudit.findMany({
    where: sourceWhere(context, "membershipSubscription", { actorField: "actorId", subjectField: "userId" }) as Prisma.MembershipSubscriptionAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: subscriptionSelect,
  });
  return rows.map(subscriptionProjection);
}

async function fetchAccountAccess(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.accountAccessAudit.findMany({
    where: sourceWhere(context, "accountAccess", { actorField: "actorId", subjectField: "userId" }) as Prisma.AccountAccessAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: accountAccessSelect,
  });
  return rows.map(accountAccessProjection);
}

async function fetchMembershipAccess(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.membershipAccessAudit.findMany({
    where: sourceWhere(context, "membershipAccess", { actorField: "actorId", subjectField: "userId", projectField: "projectId", workspaceField: "workspaceId" }) as Prisma.MembershipAccessAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: membershipAccessSelect,
  });
  return rows.map(membershipAccessProjection);
}

async function fetchInvitation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.workspaceInvitationAudit.findMany({
    where: sourceWhere(context, "workspaceInvitation", { actorField: "actorId", workspaceField: "workspaceId" }) as Prisma.WorkspaceInvitationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: invitationSelect,
  });
  return rows.map(invitationProjection);
}

async function fetchAttestation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.mcpToolAttestationAudit.findMany({
    where: sourceWhere(context, "mcpToolAttestation", { actorField: "actorId" }) as Prisma.McpToolAttestationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: attestationSelect,
  });
  return rows.map(attestationProjection);
}

async function fetchProjectAi(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectAiProviderDelegationAudit.findMany({
    where: sourceWhere(context, "projectAiProviderDelegation", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectAiProviderDelegationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: projectAiSelect,
  });
  return rows.map(projectAiProjection);
}

async function fetchGit(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectGitRepositoryDelegationAudit.findMany({
    where: sourceWhere(context, "projectGitRepositoryDelegation", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectGitRepositoryDelegationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: gitSelect,
  });
  return rows.map(gitProjection);
}

async function fetchMcpDelegation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectMcpConnectionDelegationAudit.findMany({
    where: sourceWhere(context, "projectMcpConnectionDelegation", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectMcpConnectionDelegationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: mcpDelegationSelect,
  });
  return rows.map(mcpDelegationProjection);
}

async function fetchGrant(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectMcpToolGrantLedger.findMany({
    where: sourceWhere(context, "projectMcpToolGrantLedger", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectMcpToolGrantLedgerWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: grantSelect,
  });
  return rows.map(grantProjection);
}

async function fetchSource(context: QueryContext, source: SystemAuditSource): Promise<RawAuditEvent[]> {
  switch (source) {
    case "platformDefaultAiRoute": return fetchPlatform(context);
    case "membershipSubscription": return fetchSubscription(context);
    case "accountAccess": return fetchAccountAccess(context);
    case "membershipAccess": return fetchMembershipAccess(context);
    case "workspaceInvitation": return fetchInvitation(context);
    case "mcpToolAttestation": return fetchAttestation(context);
    case "projectAiProviderDelegation": return fetchProjectAi(context);
    case "projectGitRepositoryDelegation": return fetchGit(context);
    case "projectMcpConnectionDelegation": return fetchMcpDelegation(context);
    case "projectMcpToolGrantLedger": return fetchGrant(context);
  }
}

async function resolveUserIds(db: PrismaClient, value: string): Promise<readonly string[]> {
  if (z.string().uuid().safeParse(value).success) return [value];
  const users = await db.appUser.findMany({
    where: { username: value },
    select: { id: true },
    take: MAX_USER_LOOKUP_RESULTS,
  });
  if (users.length !== 1) return [];
  return [users[0]!.id];
}

function normalizeFilters(input: SystemAuditQuery, snapshotAt: Date, now: Date): SystemAuditFilters {
  const from = input.from ?? new Date(snapshotAt.getTime() - SYSTEM_AUDIT_DEFAULT_WINDOW_MS);
  const requestedTo = input.to ?? snapshotAt;
  if (
    !Number.isFinite(now.getTime())
    ||
    !Number.isFinite(snapshotAt.getTime())
    || snapshotAt.getTime() > now.getTime()
    || snapshotAt.getTime() < now.getTime() - SYSTEM_AUDIT_MAX_WINDOW_MS
  ) {
    return auditError("SYSTEM_AUDIT_TIME_INVALID", "审计时间快照无效");
  }
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(requestedTo.getTime()) || requestedTo > now) {
    return auditError("SYSTEM_AUDIT_TIME_INVALID", "审计时间范围无效或不能包含未来时间");
  }
  const to = new Date(Math.min(requestedTo.getTime(), snapshotAt.getTime()));
  if (from > to) return auditError("SYSTEM_AUDIT_TIME_INVALID", "审计时间范围无效或不能包含未来时间");
  if (to.getTime() - from.getTime() > SYSTEM_AUDIT_MAX_WINDOW_MS) {
    return auditError("SYSTEM_AUDIT_TIME_RANGE_TOO_LARGE", "审计查询时间范围不能超过 90 天");
  }
  return {
    source: input.source,
    action: input.action,
    result: input.result,
    actor: input.actor,
    subject: input.subject,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    from,
    to,
  };
}

function sourceSupportsFilters(source: SystemAuditSource, filters: SystemAuditFilters): boolean {
  const registry = SYSTEM_AUDIT_REGISTRY[source];
  if (filters.action !== undefined && registry.actionMap[filters.action] === undefined) return false;
  if (filters.result !== undefined && registry.resultMap[filters.result] === undefined) return false;
  return true;
}

function compareEvents(left: RawAuditEvent, right: RawAuditEvent): number {
  const dateDelta = right.createdAt.getTime() - left.createdAt.getTime();
  if (dateDelta !== 0) return dateDelta;
  if (left.source !== right.source) return left.source < right.source ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

function publicPrincipal(id: string | null, kind: RawAuditEvent["actorKind"], users: ReadonlyMap<string, Readonly<{ username: string; displayName: string | null }>>): SystemAuditPrincipal {
  if (id === null || kind !== "user") {
    return { kind, id: null, username: null, displayName: null };
  }
  const user = users.get(id);
  return { kind: "user", id, username: user?.username ?? null, displayName: user?.displayName ?? null };
}

function toPublicEvent(event: RawAuditEvent, users: ReadonlyMap<string, Readonly<{ username: string; displayName: string | null }>>): SystemAuditEvent {
  return Object.freeze({
    id: event.id,
    source: event.source,
    action: event.action,
    result: event.result,
    occurredAt: event.createdAt.toISOString(),
    actor: publicPrincipal(event.actorId, event.actorKind, users),
    subject: event.subjectId === null ? null : publicPrincipal(event.subjectId, "user", users),
    references: event.references,
    evidence: event.evidence,
  });
}

async function hydrateUsers(db: PrismaClient, events: readonly RawAuditEvent[]): Promise<ReadonlyMap<string, Readonly<{ username: string; displayName: string | null }>>> {
  const ids = [...new Set(events.flatMap((event) => [event.actorKind === "user" ? event.actorId : null, event.subjectId]).filter((value): value is string => value !== null))].slice(0, MAX_HYDRATED_USER_IDS);
  if (ids.length === 0) return new Map();
  const users = await db.appUser.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, displayName: true } });
  return new Map(users.map((user) => [user.id, { username: user.username, displayName: user.displayName }]));
}

function emptyList(snapshotAt: Date, pageSize: number): SystemAuditList {
  return Object.freeze({ events: Object.freeze([]), nextCursor: null, snapshotAt: snapshotAt.toISOString(), pageSize });
}

export async function listSystemAudit(
  input: SystemAuditQuery,
  db: PrismaClient = getDb(),
  now = new Date(),
): Promise<SystemAuditList> {
  const cursor = input.cursor === undefined ? null : await decodeCursor(input.cursor);
  const snapshotAt = cursor === null ? now : new Date(cursor.snapshotAt);
  const filters = normalizeFilters(input, snapshotAt, now);
  const hash = await filterHash(filters);
  const pageSize = input.pageSize ?? 20;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > SYSTEM_AUDIT_MAX_PAGE_SIZE) {
    return auditError("SYSTEM_AUDIT_PAGE_SIZE_INVALID", "审计分页大小必须在 1 到 50 之间");
  }
  const cursorCreatedAt = cursor === null ? null : new Date(cursor.createdAt);
  if (
    cursor !== null
    && (
      cursor.filterHash !== hash
      || cursorCreatedAt === null
      || !Number.isFinite(cursorCreatedAt.getTime())
      || cursorCreatedAt > snapshotAt
    )
  ) {
    return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标与当前筛选条件或快照不匹配");
  }
  const actorIds = input.actor === undefined ? undefined : await resolveUserIds(db, input.actor);
  const subjectIds = input.subject === undefined ? undefined : await resolveUserIds(db, input.subject);
  if ((actorIds !== undefined && actorIds.length === 0) || (subjectIds !== undefined && subjectIds.length === 0)) {
    return emptyList(snapshotAt, pageSize);
  }
  const sources = (input.source === undefined ? SYSTEM_AUDIT_SOURCES : [input.source]).filter((source) => sourceSupportsFilters(source, filters));
  if (sources.length === 0) return emptyList(snapshotAt, pageSize);
  const rows = await Promise.all(sources.map((source) => fetchSource({ db, filters, actorIds, subjectIds, snapshotAt, cursor, take: pageSize + 1 }, source)));
  const merged = rows.flat().filter((event) => input.result === undefined || event.result === input.result).sort(compareEvents);
  const page = merged.slice(0, pageSize);
  const hasMore = merged.length > pageSize;
  const users = await hydrateUsers(db, page);
  const events = page.map((event) => toPublicEvent(event, users));
  const last = page.at(-1);
  const nextCursor = hasMore && last !== undefined
    ? await encodeCursor({ version: CURSOR_VERSION, filterHash: hash, snapshotAt: snapshotAt.toISOString(), createdAt: last.createdAt.toISOString(), source: last.source, id: last.id })
    : null;
  return Object.freeze({ events: Object.freeze(events), nextCursor, snapshotAt: snapshotAt.toISOString(), pageSize });
}

export async function getSystemAuditDetail(
  source: SystemAuditSource,
  auditId: string,
  db: PrismaClient = getDb(),
): Promise<SystemAuditEvent> {
  if (!z.string().uuid().safeParse(auditId).success) auditError("SYSTEM_AUDIT_NOT_FOUND", "审计记录不存在", 404);
  const now = new Date();
  const rows = await fetchSource({ db, filters: { source }, actorIds: undefined, subjectIds: undefined, snapshotAt: now, cursor: null, auditId, take: 1 }, source);
  const event = rows[0];
  if (event === undefined || event.id !== auditId) auditError("SYSTEM_AUDIT_NOT_FOUND", "审计记录不存在", 404);
  const users = await hydrateUsers(db, [event]);
  return toPublicEvent(event, users);
}

export const SYSTEM_AUDIT_DENYLIST_KEYS = [
  "secret",
  "credential",
  "token",
  "bearer",
  "authorization",
  "baseUrl",
  "repositoryPath",
  "trackedRef",
  "canonicalArguments",
  "sanitizedPayload",
  "providerRequestId",
  "emailFingerprint",
  "details",
  "metadata",
] as const;
