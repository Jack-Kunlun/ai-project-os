import type { AutomationRuleKind, Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { requiresAiWorkbenchConfirmation } from "@/lib/automation-capabilities";
import { getProjectOperationsSummary } from "@/lib/project-operations";

export type AutomationNotificationPreview = Readonly<{
  audience: "creator" | "creatorAndEligibleAssignees";
  condition: "always" | "onFailure" | "waitingConsent";
  count: number;
}>;

export type AutomationScopePreview = Readonly<{
  label: string;
  sourceCount: number;
  safeDomains: readonly string[];
  notification: AutomationNotificationPreview;
  modelExternalTransfer: boolean;
  requiresConfirmation: boolean;
  delivery: "localNotification" | "waitingConsent";
}>;

export type AutomationScopePreviewOptions = Readonly<{
  creatorId?: string;
  config?: unknown;
}>;

function safeHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function creatorNotification(condition: AutomationNotificationPreview["condition"]): AutomationNotificationPreview {
  return Object.freeze({ audience: "creator", condition, count: 1 });
}

function recordConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function planHealthNotificationPreview(
  projectId: string,
  options: AutomationScopePreviewOptions,
  tx: PrismaClient | Prisma.TransactionClient,
): Promise<AutomationNotificationPreview> {
  const config = recordConfig(options.config);
  const dueSoonDays = typeof config.dueSoonDays === "number" && Number.isInteger(config.dueSoonDays) ? config.dueSoonDays : 3;
  const includeAssignees = config.includeAssignees !== false;
  const health = await getProjectOperationsSummary(projectId, dueSoonDays, tx);
  const candidateIds = options.creatorId === undefined
    ? [...(includeAssignees ? health.signals.flatMap((signal) => signal.assigneeId === null ? [] : [signal.assigneeId]) : [])]
    : [options.creatorId, ...(includeAssignees ? health.signals.flatMap((signal) => signal.assigneeId === null ? [] : [signal.assigneeId]) : [])];
  if (candidateIds.length === 0) return Object.freeze({ audience: "creatorAndEligibleAssignees", condition: "always", count: 0 });
  const eligibleRecipients = await tx.appUser.findMany({
    where: {
      id: { in: [...new Set(candidateIds)] },
      disabledAt: null,
      OR: [
        { projectMemberships: { some: { projectId, accessState: "confirmed", role: { in: ["owner", "editor"] } } } },
        { workspaceMemberships: { some: { workspace: { projects: { some: { id: projectId, membershipInheritanceMode: "workspaceInherited" } } }, accessState: "confirmed", role: { in: ["owner", "admin"] } } } },
      ],
    },
    select: { id: true },
  });
  return Object.freeze({ audience: "creatorAndEligibleAssignees", condition: "always", count: eligibleRecipients.length });
}

export async function buildAutomationScopePreview(
  projectId: string,
  kind: AutomationRuleKind,
  tx: PrismaClient | Prisma.TransactionClient,
  options: AutomationScopePreviewOptions = {},
): Promise<AutomationScopePreview> {
  const requiresConfirmation = requiresAiWorkbenchConfirmation(kind);
  const modelExternalTransfer = false;
  if (kind === "webSourceSync") {
    const sources = await tx.webSource.findMany({
      where: { projectId, status: { not: "disabled" } },
      orderBy: { id: "asc" },
      select: { url: true },
    });
    return Object.freeze({
      label: "当前项目中已启用的网页来源",
      sourceCount: sources.length,
      safeDomains: Object.freeze([...new Set(sources.map((source) => safeHost(source.url)).filter((host): host is string => host !== null))]),
      notification: creatorNotification("onFailure"),
      modelExternalTransfer,
      requiresConfirmation,
      delivery: "localNotification",
    });
  }
  if (kind === "repositorySync") {
    const links = await tx.projectGitRepositoryLink.count({ where: { projectId, status: "active" } });
    return Object.freeze({
      label: "当前项目中的活动仓库链接（自动化能力冻结）",
      sourceCount: links,
      safeDomains: Object.freeze([]),
      notification: creatorNotification("onFailure"),
      modelExternalTransfer,
      requiresConfirmation,
      delivery: "localNotification",
    });
  }
  if (kind === "projectPlanHealth") {
    return Object.freeze({
      label: "当前项目计划、负责人和证据状态（仅本地读取）",
      sourceCount: 0,
      safeDomains: Object.freeze([]),
      notification: await planHealthNotificationPreview(projectId, options, tx),
      modelExternalTransfer,
      requiresConfirmation,
      delivery: "localNotification",
    });
  }
  if (requiresConfirmation) {
    return Object.freeze({
      label: "项目资料与已确认事实范围（仅生成待确认通知）",
      sourceCount: 0,
      safeDomains: Object.freeze([]),
      notification: creatorNotification("waitingConsent"),
      modelExternalTransfer: false,
      requiresConfirmation: true,
      delivery: "waitingConsent",
    });
  }
  return Object.freeze({
    label: kind === "memoryQuality" ? "项目已确认事实与资料质量（仅本地读取）" : "项目本地资料范围",
    sourceCount: 0,
    safeDomains: Object.freeze([]),
    notification: creatorNotification("always"),
    modelExternalTransfer,
    requiresConfirmation,
    delivery: "localNotification",
  });
}
