import type { PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";

export const PROJECT_USAGE_PERIODS = [7, 30, 90] as const;
export type ProjectUsagePeriod = (typeof PROJECT_USAGE_PERIODS)[number];

type UsageAccumulator = {
  recordCount: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  succeededRequests: number;
  failedRequests: number;
  unknownRequests: number;
  runningRequests: number;
};

function emptyUsage(): UsageAccumulator {
  return {
    recordCount: 0,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    succeededRequests: 0,
    failedRequests: 0,
    unknownRequests: 0,
    runningRequests: 0,
  };
}

function addUsage(
  target: UsageAccumulator,
  input: Readonly<{
    recordCount: number;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    status: string;
  }>,
): void {
  target.recordCount += input.recordCount;
  target.requestCount += input.requestCount;
  target.inputTokens += input.inputTokens;
  target.outputTokens += input.outputTokens;
  if (input.status === "succeeded") target.succeededRequests += input.requestCount;
  else if (input.status === "failed" || input.status === "cancelled") target.failedRequests += input.requestCount;
  else if (input.status === "unknown") target.unknownRequests += input.requestCount;
  else target.runningRequests += input.requestCount;
}

function publicUsage(value: UsageAccumulator) {
  return Object.freeze({ ...value, totalTokens: value.inputTokens + value.outputTokens });
}

export async function getProjectUsageSummary(
  projectId: string,
  days: ProjectUsagePeriod,
  db: PrismaClient = getDb(),
) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, archivedAt: true },
  });
  if (project === null) return null;

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1_000);
  const [webRows, legacyRows] = await Promise.all([
    db.providerCallAudit.groupBy({
      by: ["providerConnectionId", "operation", "modelId", "status"],
      where: { createdAt: { gte: periodStart, lt: periodEnd }, job: { projectId } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true },
    }),
    db.aiRun.groupBy({
      by: ["operation", "modelId", "status"],
      where: { projectId, createdAt: { gte: periodStart, lt: periodEnd } },
      _count: { _all: true },
      _sum: { requestCount: true, inputTokens: true, outputTokens: true },
    }),
  ]);
  const providerIds = [...new Set(webRows.map((row) => row.providerConnectionId))];
  const providers = providerIds.length === 0 ? [] : await db.aiProviderConnection.findMany({
    where: { id: { in: providerIds } },
    select: { id: true, name: true, kind: true },
  });
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const totals = emptyUsage();
  const providerUsage = new Map<string, UsageAccumulator & {
    providerName: string;
    providerKind: string;
    modelId: string;
    source: "current" | "legacy";
  }>();
  const operationUsage = new Map<string, UsageAccumulator>();

  for (const row of webRows) {
    const usage = {
      recordCount: row._count._all,
      requestCount: row._count._all,
      inputTokens: row._sum.inputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
      status: row.status,
    };
    addUsage(totals, usage);
    const provider = providersById.get(row.providerConnectionId);
    const providerKey = `current:${row.providerConnectionId}:${row.modelId}`;
    const providerEntry = providerUsage.get(providerKey) ?? Object.assign(emptyUsage(), {
      providerName: provider?.name ?? "已移除供应商",
      providerKind: provider?.kind ?? "unknown",
      modelId: row.modelId,
      source: "current" as const,
    });
    addUsage(providerEntry, usage);
    providerUsage.set(providerKey, providerEntry);
    const operationEntry = operationUsage.get(row.operation) ?? emptyUsage();
    addUsage(operationEntry, usage);
    operationUsage.set(row.operation, operationEntry);
  }

  for (const row of legacyRows) {
    const requestCount = row._sum.requestCount ?? 0;
    const usage = {
      recordCount: row._count._all,
      requestCount,
      inputTokens: row._sum.inputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
      status: row.status,
    };
    addUsage(totals, usage);
    const providerKey = `legacy:${row.modelId}`;
    const providerEntry = providerUsage.get(providerKey) ?? Object.assign(emptyUsage(), {
      providerName: "旧运行台账",
      providerKind: "legacy",
      modelId: row.modelId,
      source: "legacy" as const,
    });
    addUsage(providerEntry, usage);
    providerUsage.set(providerKey, providerEntry);
    const operationEntry = operationUsage.get(row.operation) ?? emptyUsage();
    addUsage(operationEntry, usage);
    operationUsage.set(row.operation, operationEntry);
  }

  const byProvider = [...providerUsage.values()]
    .map((entry) => Object.freeze({
      providerName: entry.providerName,
      providerKind: entry.providerKind,
      modelId: entry.modelId,
      source: entry.source,
      ...publicUsage(entry),
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens || right.requestCount - left.requestCount || left.modelId.localeCompare(right.modelId));
  const byOperation = [...operationUsage.entries()]
    .map(([operation, entry]) => Object.freeze({ operation, ...publicUsage(entry) }))
    .sort((left, right) => right.totalTokens - left.totalTokens || right.requestCount - left.requestCount || left.operation.localeCompare(right.operation));

  return Object.freeze({
    project: Object.freeze({ ...project, archivedAt: project.archivedAt?.toISOString() ?? null }),
    period: Object.freeze({ days, start: periodStart.toISOString(), end: periodEnd.toISOString() }),
    totals: publicUsage(totals),
    byProvider: Object.freeze(byProvider),
    byOperation: Object.freeze(byOperation),
    pricing: Object.freeze({ available: false, reason: "未维护供应商价格快照，因此不估算费用" }),
    sources: Object.freeze({
      current: "ProviderCallAudit，每次页面运行时模型请求计一次",
      legacy: "AiRun 汇总台账，按 requestCount 计数且不与现行审计重复",
    }),
  });
}
