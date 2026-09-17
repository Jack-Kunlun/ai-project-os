import { Prisma, type AppUserRole, type PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";
import { APP_VERSION } from "@/lib/version";
import {
  getPlatformDefaultAiRouteReadiness,
  PLATFORM_DEFAULT_AI_OPERATIONS,
  type PlatformDefaultAiOperation,
  type PlatformDefaultAiRouteReadiness,
} from "@/lib/platform-default-ai-routes";
import { AuthError } from "@/lib/auth";
import { isInitialSuperAdmin, readBackupOperationsSnapshot } from "@/lib/system-operations";
import { RECOVERY_DRILL_FRESHNESS_THRESHOLD_MS, RECOVERY_DRILL_RUNBOOK_HREF, type PublicRecoveryDrill } from "@/lib/system-operations-types";
import { readWorkerHealth, type WorkerHealthSummary } from "@/lib/worker-health";

const NO_MCP_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;
export const SYSTEM_OVERVIEW_FAILURE_WINDOW_DAYS = 7;
export const SYSTEM_OVERVIEW_BACKUP_FRESHNESS_THRESHOLD_MS = 48 * 60 * 60 * 1_000;
export const SYSTEM_OVERVIEW_RECOVERY_DRILL_FRESHNESS_THRESHOLD_MS = RECOVERY_DRILL_FRESHNESS_THRESHOLD_MS;

type OverviewActor = Readonly<{ id: string; role: AppUserRole }>;
type FailureGroup = Readonly<{ code: string; count: number }>;

export type SystemOverviewFailureAggregate = Readonly<{
  total: number | null;
  byCode: readonly FailureGroup[];
  evidence: "available" | "not_obtained";
}>;

export type SystemOverviewFailureWindow = Readonly<{
  days: typeof SYSTEM_OVERVIEW_FAILURE_WINDOW_DAYS;
  from: string;
  to: string;
}>;

export type SystemOverviewRoute = Readonly<{
  operation: PlatformDefaultAiOperation;
  code: PlatformDefaultAiRouteReadiness["code"] | "not_obtained";
  controlPlane: "ready" | "blocked" | "not_obtained";
  routeVersion: number | null;
  liveCallEvidence: "not_obtained";
}>;

export type SystemOverviewBackup = Readonly<{
  access: "full" | "restricted" | "not_obtained";
  snapshotRead: "read" | "restricted" | "not_obtained" | "error";
  sourceStatus: "ready" | "not_configured" | "invalid" | "not_obtained";
  latestValidRecord: Readonly<{
    status: "available" | "none" | "not_obtained";
    state: "running" | "succeeded" | "failed" | "skipped" | null;
    startedAt: string | null;
    completedAt: string | null;
    safeErrorCode: string | null;
  }>;
  freshness: Readonly<{
    status: "fresh" | "stale" | "unknown" | "restricted" | "not_obtained";
    thresholdMs: typeof SYSTEM_OVERVIEW_BACKUP_FRESHNESS_THRESHOLD_MS;
    readAt: string | null;
    sourceTimestamp: string | null;
  }>;
  recoveryDrill: Readonly<{
    status: "verified" | "failed" | "not_obtained" | "error" | "restricted";
    environment: PublicRecoveryDrill["environment"] | null;
    scope: PublicRecoveryDrill["scope"] | null;
    completedAt: string | null;
    freshness: "fresh" | "stale" | "unknown" | "restricted" | "not_obtained";
    sourceArtifactName: string | null;
    sourceArtifactSha256: string | null;
    sourceArtifactKind: "local-consistent-snapshot" | "production-backup" | null;
    validationSha256: string | null;
    checks: PublicRecoveryDrill["checks"] | null;
    migrationCount: number | null;
    securityCounts: PublicRecoveryDrill["securityCounts"] | null;
    matchingBackup: "matched" | "mismatch" | "unknown";
    runbookHref: typeof RECOVERY_DRILL_RUNBOOK_HREF;
  }>;
}>;

export type SystemOverview = Readonly<{
  service: Readonly<{
    application: "up";
    version: string;
    database: "up";
    worker: WorkerHealthSummary;
    measuredAt: string;
  }>;
  counts: Readonly<{
    users: number;
    activeMemberships: number;
    verifiedPlatformModels: number;
  }>;
  tokens: Readonly<{
    issuedTokens: number;
    availableTokens: number;
    reservedTokens: number;
    consumedTokens: number;
  }>;
  defaultRoutes: Readonly<{
    total: number;
    ready: number | null;
    blocked: number | null;
    controlPlane: "ready" | "attention" | "not_obtained";
    liveCallEvidence: "not_obtained";
    operations: Readonly<Record<PlatformDefaultAiOperation, SystemOverviewRoute>>;
  }>;
  mcp: Readonly<{
    pendingAttestations: number | null;
    evidence: "available" | "not_obtained";
  }>;
  failures: Readonly<{
    total: number | null;
    window: SystemOverviewFailureWindow;
    providerCalls: SystemOverviewFailureAggregate;
    mcpCalls: SystemOverviewFailureAggregate;
    backgroundJobs: SystemOverviewFailureAggregate;
    automationRuns: SystemOverviewFailureAggregate;
    controlledActions: SystemOverviewFailureAggregate;
  }>;
  backup: SystemOverviewBackup;
  setupChecklist: readonly Readonly<{
    key: "database" | "worker" | "platform-provider" | "default-routes" | "backup-source";
    label: string;
    status: "ready" | "attention" | "unknown" | "restricted";
    detail: string;
  }>[];
}>;

function aggregateValue(value: number | null | undefined): number {
  return value ?? 0;
}

function safeErrorCode(value: string | null): string {
  return value !== null && SAFE_ERROR_CODE.test(value) ? value : "UNCLASSIFIED_FAILURE";
}

function normalizeFailureGroups(
  rows: readonly { safeErrorCode?: string | null; failureCode?: string | null; _count: { _all: number } }[],
): readonly FailureGroup[] {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    const code = safeErrorCode(row.safeErrorCode ?? row.failureCode ?? null);
    grouped.set(code, (grouped.get(code) ?? 0) + row._count._all);
  }
  return Object.freeze([...grouped.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)));
}

function failureAggregate(
  rows: readonly { safeErrorCode?: string | null; failureCode?: string | null; _count: { _all: number } }[] | null,
): SystemOverviewFailureAggregate {
  if (rows === null) return Object.freeze({ total: null, byCode: Object.freeze([]), evidence: "not_obtained" });
  const byCode = normalizeFailureGroups(rows);
  return Object.freeze({ total: byCode.reduce((sum, entry) => sum + entry.count, 0), byCode, evidence: "available" });
}

function routeNotObtained(operation: PlatformDefaultAiOperation): SystemOverviewRoute {
  return Object.freeze({ operation, code: "not_obtained", controlPlane: "not_obtained", routeVersion: null, liveCallEvidence: "not_obtained" });
}

function routeProjection(
  readiness: Readonly<Record<PlatformDefaultAiOperation, PlatformDefaultAiRouteReadiness>> | null,
): SystemOverview["defaultRoutes"] {
  const operations = Object.fromEntries(PLATFORM_DEFAULT_AI_OPERATIONS.map((operation) => {
    const source = readiness?.[operation];
    if (source === undefined) return [operation, routeNotObtained(operation)];
    return [operation, Object.freeze({
      operation,
      code: source.code,
      controlPlane: source.code === "ready" ? "ready" : "blocked",
      routeVersion: source.activeRouteVersion,
      liveCallEvidence: "not_obtained",
    })];
  })) as Record<PlatformDefaultAiOperation, SystemOverviewRoute>;
  const values = Object.values(operations);
  const ready = readiness === null ? null : values.filter((entry) => entry.controlPlane === "ready").length;
  const blocked = readiness === null ? null : values.filter((entry) => entry.controlPlane === "blocked").length;
  return Object.freeze({
    total: PLATFORM_DEFAULT_AI_OPERATIONS.length,
    ready,
    blocked,
    controlPlane: readiness === null ? "not_obtained" : ready === PLATFORM_DEFAULT_AI_OPERATIONS.length ? "ready" : "attention",
    liveCallEvidence: "not_obtained",
    operations: Object.freeze(operations),
  });
}

type BackupSnapshot = Awaited<ReturnType<typeof readBackupOperationsSnapshot>>;
type BackupReadResult = Readonly<{
  access: SystemOverviewBackup["access"];
  snapshotRead: SystemOverviewBackup["snapshotRead"];
  snapshot: BackupSnapshot | null;
}>;

function emptyBackupProjection(access: SystemOverviewBackup["access"], snapshotRead: SystemOverviewBackup["snapshotRead"]): SystemOverviewBackup {
  const unavailable = snapshotRead !== "read";
  return Object.freeze({
    access,
    snapshotRead,
    sourceStatus: "not_obtained",
    latestValidRecord: Object.freeze({ status: unavailable ? "not_obtained" : "none", state: null, startedAt: null, completedAt: null, safeErrorCode: null }),
    freshness: Object.freeze({ status: access === "restricted" ? "restricted" : access === "not_obtained" ? "not_obtained" : "unknown", thresholdMs: SYSTEM_OVERVIEW_BACKUP_FRESHNESS_THRESHOLD_MS, readAt: null, sourceTimestamp: null }),
    recoveryDrill: Object.freeze({
      status: access === "restricted" ? "restricted" : "not_obtained",
      environment: null,
      scope: null,
      completedAt: null,
      freshness: access === "restricted" ? "restricted" : "not_obtained",
      sourceArtifactName: null,
      sourceArtifactSha256: null,
      sourceArtifactKind: null,
      validationSha256: null,
      checks: null,
      migrationCount: null,
      securityCounts: null,
      matchingBackup: access === "restricted" ? "unknown" : "unknown",
      runbookHref: RECOVERY_DRILL_RUNBOOK_HREF,
    }),
  });
}

function backupProjection(result: BackupReadResult, now: Date): SystemOverviewBackup {
  if (result.snapshot === null) return emptyBackupProjection(result.access, result.snapshotRead);

  const snapshot = result.snapshot;
  const latest = [snapshot.current, ...snapshot.history].find((run): run is NonNullable<typeof run> => run !== null) ?? null;
  const latestSuccessful = [snapshot.current, ...snapshot.history].find((run): run is NonNullable<typeof run> => run?.state === "succeeded" && run.backupName !== null && run.archiveSha256 !== null) ?? null;
  const sourceTimestamp = snapshot.current?.completedAt
    ?? snapshot.current?.startedAt
    ?? snapshot.history[0]?.completedAt
    ?? snapshot.history[0]?.startedAt
    ?? null;
  const sourceTime = sourceTimestamp === null ? null : Date.parse(sourceTimestamp);
  const freshnessStatus = snapshot.sourceStatus !== "ready" || sourceTime === null || !Number.isFinite(sourceTime) || sourceTime > now.getTime()
    ? "unknown"
    : now.getTime() - sourceTime <= SYSTEM_OVERVIEW_BACKUP_FRESHNESS_THRESHOLD_MS ? "fresh" : "stale";

  return Object.freeze({
    access: result.access,
    snapshotRead: result.snapshotRead,
    sourceStatus: snapshot.sourceStatus,
    latestValidRecord: Object.freeze({
      status: latest === null ? "none" : "available",
      state: latest?.state ?? null,
      startedAt: latest?.startedAt ?? null,
      completedAt: latest?.completedAt ?? null,
      safeErrorCode: latest?.errorCode ?? null,
    }),
    freshness: Object.freeze({
      status: freshnessStatus,
      thresholdMs: SYSTEM_OVERVIEW_BACKUP_FRESHNESS_THRESHOLD_MS,
      readAt: snapshot.readAt,
      sourceTimestamp,
    }),
    recoveryDrill: recoveryDrillProjection(snapshot, latestSuccessful, now),
  });
}

function recoveryDrillProjection(
  snapshot: BackupSnapshot,
  latestSuccessful: NonNullable<BackupSnapshot["current"]> | null,
  now: Date,
): SystemOverviewBackup["recoveryDrill"] {
  const drill = snapshot.recoveryDrill;
  if (drill === null) {
    return Object.freeze({
      status: snapshot.recoveryDrillSourceStatus === "invalid" ? "error" : "not_obtained",
      environment: null,
      scope: null,
      completedAt: null,
      freshness: snapshot.recoveryDrillSourceStatus === "invalid" ? "unknown" : "not_obtained",
      sourceArtifactName: null,
      sourceArtifactSha256: null,
      sourceArtifactKind: null,
      validationSha256: null,
      checks: null,
      migrationCount: null,
      securityCounts: null,
      matchingBackup: "unknown",
      runbookHref: RECOVERY_DRILL_RUNBOOK_HREF,
    });
  }
  const completedTime = Date.parse(drill.completedAt);
  const freshness = !Number.isFinite(completedTime) || completedTime > now.getTime()
    ? "unknown"
    : now.getTime() - completedTime <= SYSTEM_OVERVIEW_RECOVERY_DRILL_FRESHNESS_THRESHOLD_MS ? "fresh" : "stale";
  const productionRecoveryEvidence = drill.status === "verified"
    && drill.environment === "production"
    && drill.scope === "isolated-host"
    && drill.sourceArtifact?.kind === "production-backup";
  const matchingBackup = !productionRecoveryEvidence || latestSuccessful === null || drill.sourceArtifact === null
    ? "unknown"
    : drill.sourceArtifact.name === latestSuccessful.backupName && drill.sourceArtifact.sha256 === latestSuccessful.archiveSha256
      ? "matched"
      : "mismatch";
  return Object.freeze({
    status: drill.status,
    environment: drill.environment,
    scope: drill.scope,
    completedAt: drill.completedAt,
    freshness,
    sourceArtifactName: drill.sourceArtifact?.name ?? null,
    sourceArtifactSha256: drill.sourceArtifact?.sha256 ?? null,
    sourceArtifactKind: drill.sourceArtifact?.kind ?? null,
    validationSha256: drill.validationSha256,
    checks: drill.checks,
    migrationCount: drill.migrationCount,
    securityCounts: drill.securityCounts,
    matchingBackup,
    runbookHref: RECOVERY_DRILL_RUNBOOK_HREF,
  });
}

async function readPendingMcpAttestationCount(db: PrismaClient): Promise<number | null> {
  try {
    const rows = await db.$queryRaw<Array<{ count: bigint | number | string }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count"
      FROM "McpToolDefinition" AS definition
      INNER JOIN "McpConnection" AS connection
        ON connection."id" = definition."connectionId"
      WHERE definition."current" = TRUE
        AND definition."readOnlyEligible" = TRUE
        AND connection."status" = 'verified'::"McpConnectionStatus"
        AND connection."disabledAt" IS NULL
        AND connection."ownershipState" = 'confirmed'::"ResourceOwnershipState"
        AND connection."ownerUserId" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "AppUser" AS owner
          WHERE owner."id" = connection."ownerUserId"
            AND owner."disabledAt" IS NULL
        )
        AND (
          (connection."authKind" = 'none'::"McpAuthKind"
            AND connection."credentialId" IS NULL
            AND connection."credentialFingerprint" = ${NO_MCP_CREDENTIAL_FINGERPRINT})
          OR
          (connection."authKind" = 'bearer'::"McpAuthKind"
            AND EXISTS (
              SELECT 1 FROM "ExternalCredential" AS credential
              WHERE credential."id" = connection."credentialId"
                AND credential."kind" = 'mcp'::"ExternalCredentialKind"
                AND credential."secretFingerprint" = connection."credentialFingerprint"
            ))
        )
        AND connection."resolvedAddressFingerprint" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "McpToolAttestation" AS attestation
          WHERE attestation."controlPlaneVersion" = 2
            AND attestation."status" = 'active'::"McpToolAttestationStatus"
            AND attestation."version" = 1
            AND attestation."conclusion" = 'read_only_verified'
            AND attestation."riskLevel" IN ('low', 'medium', 'high')
            AND attestation."evidenceNote" = 'manual_read_only_review'
            AND attestation."note" IS NULL
            AND attestation."evidence" = '{}'::jsonb
            AND EXISTS (
              SELECT 1 FROM "AppUser" AS verifier
              WHERE verifier."id" = attestation."verifiedById"
                AND verifier."role" = 'admin'::"AppUserRole"
                AND verifier."disabledAt" IS NULL
            )
            AND attestation."connectionId" = definition."connectionId"
            AND attestation."toolDefinitionId" = definition."id"
            AND attestation."toolName" = definition."name"
            AND attestation."definitionFingerprint" = definition."definitionFingerprint"
            AND attestation."networkFingerprint" = connection."resolvedAddressFingerprint"
            AND attestation."credentialFingerprint" = connection."credentialFingerprint"
            AND attestation."connectionConfigurationRevision" = connection."configurationRevision"
        )
    `);
    const count = Number(rows[0]?.count);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

async function readFailureGroups(db: PrismaClient, since: Date, until: Date): Promise<Readonly<{
  providerCalls: SystemOverviewFailureAggregate;
  mcpCalls: SystemOverviewFailureAggregate;
  backgroundJobs: SystemOverviewFailureAggregate;
  automationRuns: SystemOverviewFailureAggregate;
  controlledActions: SystemOverviewFailureAggregate;
}>> {
  const [providerCalls, mcpCalls, backgroundJobs, automationRuns, controlledActions] = await Promise.all([
    (async () => {
      try {
        const rows = await db.providerCallAudit.groupBy({
          by: ["safeErrorCode"],
          // Keep this aggregate scoped to platform-hosted usage. Personal BYOK
          // calls are user-owned and must not appear as platform failures.
          where: {
            billingMode: "platform",
            payerKind: "platformCaller",
            status: { in: ["failed", "unknown"] },
            completedAt: { gte: since, lte: until },
          },
          _count: { _all: true },
        });
        return failureAggregate(rows);
      } catch {
        return failureAggregate(null);
      }
    })(),
    (async () => {
      try {
        const rows = await db.projectMcpActionDispatchAttempt.groupBy({
          by: ["safeErrorCode"],
          where: { status: { in: ["failed", "unknown", "expired", "invalidated"] }, completedAt: { gte: since, lte: until } },
          _count: { _all: true },
        });
        return failureAggregate(rows);
      } catch {
        return failureAggregate(null);
      }
    })(),
    (async () => {
      try {
        const rows = await db.backgroundJob.groupBy({
          by: ["failureCode"],
          where: { status: { in: ["failed", "unknown"] }, completedAt: { gte: since, lte: until } },
          _count: { _all: true },
        });
        return failureAggregate(rows);
      } catch {
        return failureAggregate(null);
      }
    })(),
    (async () => {
      try {
        const rows = await db.automationRun.groupBy({
          by: ["failureCode"],
          // AutomationRunStatus has no unknown state in the current schema.
          where: { status: { in: ["failed"] }, completedAt: { gte: since, lte: until } },
          _count: { _all: true },
        });
        return failureAggregate(rows);
      } catch {
        return failureAggregate(null);
      }
    })(),
    (async () => {
      try {
        const rows = await db.projectAction.groupBy({
          by: ["failureCode"],
          // ProjectActionStatus has no unknown state in the current schema.
          where: { status: { in: ["failed"] }, completedAt: { gte: since, lte: until } },
          _count: { _all: true },
        });
        return failureAggregate(rows);
      } catch {
        return failureAggregate(null);
      }
    })(),
  ]);
  return Object.freeze({ providerCalls, mcpCalls, backgroundJobs, automationRuns, controlledActions });
}

async function requireVerifiedAdminActor(actor: OverviewActor, db: PrismaClient): Promise<void> {
  if (actor === null || actor.role !== "admin" || actor.id.trim().length === 0) throw new AuthError("AUTH_FORBIDDEN");
  const stored = await db.appUser.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, disabledAt: true },
  });
  if (stored === null || stored.role !== "admin" || stored.disabledAt !== null) throw new AuthError("AUTH_FORBIDDEN");
}

async function readBackupResult(actor: OverviewActor, db: PrismaClient, now: Date): Promise<BackupReadResult> {
  try {
    if (!(await isInitialSuperAdmin(actor, db))) {
      return Object.freeze({ access: "restricted", snapshotRead: "restricted", snapshot: null });
    }
  } catch {
    // The actor is an admin, but the privileged ownership check did not complete.
    // Do not claim either access or a readable snapshot in this case.
    return Object.freeze({ access: "not_obtained", snapshotRead: "not_obtained", snapshot: null });
  }
  try {
    return Object.freeze({ access: "full", snapshotRead: "read", snapshot: await readBackupOperationsSnapshot({ now }) });
  } catch {
    return Object.freeze({ access: "full", snapshotRead: "error", snapshot: null });
  }
}

export async function getSystemOverview(
  actor: OverviewActor,
  db: PrismaClient = getDb(),
  now = new Date(),
): Promise<SystemOverview> {
  await requireVerifiedAdminActor(actor, db);
  await db.$queryRaw`SELECT 1`;
  const failureWindowStart = new Date(now.getTime() - SYSTEM_OVERVIEW_FAILURE_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
  const [users, activeMemberships, verifiedPlatformModels, issued, available, reserved, consumed, worker, routeReadiness, pendingMcpAttestations, failures, backupResult] = await Promise.all([
    db.appUser.count(),
    db.membershipSubscription.count({ where: { status: "active", startsAt: { lte: now }, expiresAt: { gt: now } } }),
    db.aiProviderConnection.count({ where: { scope: "platform", status: "verified", disabledAt: null } }),
    db.platformTokenGrant.aggregate({ _sum: { amount: true } }),
    db.platformTokenGrant.aggregate({ where: { revokedAt: null, expiresAt: { gt: now } }, _sum: { remainingTokens: true } }),
    db.platformTokenReservation.aggregate({ where: { status: { in: ["reserved", "held"] } }, _sum: { reservedTokens: true } }),
    db.platformTokenReservation.aggregate({ where: { status: "settled", settledTokens: { not: null } }, _sum: { settledTokens: true } }),
    readWorkerHealth(db, { now }),
    getPlatformDefaultAiRouteReadiness(actor, db).catch(() => null),
    readPendingMcpAttestationCount(db),
    readFailureGroups(db, failureWindowStart, now),
    readBackupResult(actor, db, now),
  ]);

  const defaultRoutes = routeProjection(routeReadiness?.operations ?? null);
  const backup = backupProjection(backupResult, now);
  const failureTotal = failures.providerCalls.total === null || failures.mcpCalls.total === null || failures.backgroundJobs.total === null || failures.automationRuns.total === null || failures.controlledActions.total === null
    ? null
    : failures.providerCalls.total + failures.mcpCalls.total + failures.backgroundJobs.total + failures.automationRuns.total + failures.controlledActions.total;
  const backupReady = backup.access === "full"
    && backup.snapshotRead === "read"
    && backup.latestValidRecord.status === "available"
    && backup.latestValidRecord.state === "succeeded"
    && backup.freshness.status === "fresh"
    && backup.recoveryDrill.status === "verified"
    && backup.recoveryDrill.environment === "production"
    && backup.recoveryDrill.scope === "isolated-host"
    && backup.recoveryDrill.sourceArtifactKind === "production-backup"
    && backup.recoveryDrill.freshness === "fresh"
    && backup.recoveryDrill.matchingBackup === "matched";
  const backupChecklistStatus = backup.access === "restricted"
    ? "restricted" as const
    : backup.access === "not_obtained"
      ? "unknown" as const
    : backupReady
      ? "ready" as const
      : backup.snapshotRead === "error"
        ? "attention" as const
        : backup.latestValidRecord.status === "none" && backup.freshness.status === "unknown"
          ? "unknown" as const
          : "attention" as const;
  const setupChecklist = Object.freeze([
    { key: "database" as const, label: "数据库连接", status: "ready" as const, detail: "当前请求已完成只读健康检查。" },
    { key: "worker" as const, label: "Worker 心跳", status: worker.status === "up" ? "ready" as const : "attention" as const, detail: worker.status === "up" ? "Worker 正在报告心跳。" : `Worker 状态：${worker.status}。` },
    { key: "platform-provider" as const, label: "平台托管模型", status: verifiedPlatformModels > 0 ? "ready" as const : "attention" as const, detail: verifiedPlatformModels > 0 ? `已验证 ${verifiedPlatformModels} 个平台连接。` : "尚未取得可用的平台托管模型连接。" },
    { key: "default-routes" as const, label: "默认模型路由", status: defaultRoutes.controlPlane === "not_obtained" ? "unknown" as const : defaultRoutes.controlPlane === "ready" ? "ready" as const : "attention" as const, detail: defaultRoutes.ready === null ? "尚未取得路由就绪证据。" : `${defaultRoutes.ready}/${defaultRoutes.total} 项控制面路由已就绪；真实模型调用仍未取得现场证据。` },
    { key: "backup-source" as const, label: "备份状态源", status: backupChecklistStatus, detail: backup.access === "restricted" ? "仅初始超级管理员可读取备份详情。" : backup.access === "not_obtained" ? "无法确认初始超级管理员权限；备份状态、记录、新鲜度和恢复演练均未取得。" : backup.snapshotRead === "error" ? "已取得权限，但备份状态读取失败；未取得可用证据。" : backup.latestValidRecord.status === "none" ? `状态源 ${backup.sourceStatus}；没有 current 或历史记录，新鲜度未知。` : `状态源 ${backup.sourceStatus} · 任务记录 ${backup.latestValidRecord.state ?? "未取得"} · 新鲜度 ${backup.freshness.status} · 恢复演练 ${backup.recoveryDrill.status}。` },
  ]);

  return Object.freeze({
    service: { application: "up", version: APP_VERSION, database: "up", worker, measuredAt: now.toISOString() },
    counts: { users, activeMemberships, verifiedPlatformModels },
    tokens: {
      issuedTokens: aggregateValue(issued._sum.amount),
      availableTokens: aggregateValue(available._sum.remainingTokens),
      reservedTokens: aggregateValue(reserved._sum.reservedTokens),
      consumedTokens: aggregateValue(consumed._sum.settledTokens),
    },
    defaultRoutes,
    mcp: { pendingAttestations: pendingMcpAttestations, evidence: pendingMcpAttestations === null ? "not_obtained" : "available" },
    failures: {
      total: failureTotal,
      window: Object.freeze({ days: SYSTEM_OVERVIEW_FAILURE_WINDOW_DAYS, from: failureWindowStart.toISOString(), to: now.toISOString() }),
      ...failures,
    },
    backup,
    setupChecklist,
  });
}
