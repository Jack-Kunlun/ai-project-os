import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import { toPublicProjectJob } from "@/lib/project-workflow";
import { accessibleProjectWhere } from "@/lib/access-control";
import { getProjectOperationsSummaries } from "@/lib/project-operations";
import { getProjectWorldSummaries } from "@/lib/project-world";
import {
  nonLegacyMcpMemoryGenerationWhere,
  nonLegacyMcpProjectItemWhere,
  nonLegacyMcpProjectSourceWhere,
} from "@/lib/legacy-mcp-source-quarantine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    const db = getDb();
    const projectWhere = { AND: [accessibleProjectWhere(user), { archivedAt: null }] };

    const [projects, activeJobCount, pendingAssetReviews, recentJobs, activePlatformRouteCount] = await Promise.all([
      db.project.findMany({
        where: projectWhere,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              sources: { where: nonLegacyMcpProjectSourceWhere },
              assets: { where: { status: { not: "deleted" } } },
              items: { where: { reviewStatus: "confirmed", ...nonLegacyMcpProjectItemWhere } },
              snapshots: true,
              repositoryLinks: { where: { status: "active" } },
              projectAgentRuns: { where: { indexGeneration: { is: nonLegacyMcpMemoryGenerationWhere } } },
            },
          },
          memoryIndexPointer: { select: { publishedAt: true } },
          backgroundJobs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              kind: true,
              status: true,
              stage: true,
              reconciliationRequired: true,
              createdAt: true,
              completedAt: true,
              attempts: {
                orderBy: { attemptNumber: "desc" },
                take: 1,
                select: {
                  id: true,
                  attemptNumber: true,
                  status: true,
                  leasedAt: true,
                  leaseExpiresAt: true,
                  heartbeatAt: true,
                  dispatchState: true,
                  safeFailureCode: true,
                  completedAt: true,
                },
              },
            },
          },
        },
      }),
      db.backgroundJob.count({
        where: { status: { in: ["queued", "waitingConsent", "running"] }, project: { is: projectWhere } },
      }),
      db.projectAsset.count({
        where: { status: "awaitingReview", project: projectWhere },
      }),
      db.backgroundJob.findMany({
        where: { projectId: { not: null }, project: { is: projectWhere } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          kind: true,
          status: true,
          stage: true,
          failureCode: true,
          reconciliationRequired: true,
          createdAt: true,
          completedAt: true,
          attempts: {
            orderBy: { attemptNumber: "desc" },
            take: 1,
            select: {
              id: true,
              attemptNumber: true,
              status: true,
              leasedAt: true,
              leaseExpiresAt: true,
              heartbeatAt: true,
              dispatchState: true,
              safeFailureCode: true,
              completedAt: true,
            },
          },
          project: { select: { id: true, name: true } },
        },
      }),
      db.platformDefaultAiRoute.count({ where: { status: "active" } }),
    ]);

    const projectOperations = await getProjectOperationsSummaries(projects.map((project) => project.id), 3, db);
    const projectWorlds = await getProjectWorldSummaries(projects.map((project) => project.id), db, projectOperations);
    const operations = projects.map((project) => ({ project: { id: project.id, name: project.name }, health: projectOperations.get(project.id)! }));
    const worlds = projects.map((project) => ({ project: { id: project.id, name: project.name }, world: projectWorlds.get(project.id)! }));
    const operationsSummary = operations.reduce((current, entry) => ({
      atRiskProjects: current.atRiskProjects + (entry.health.status === "atRisk" ? 1 : 0),
      overdueWorkItems: current.overdueWorkItems + entry.health.counts.overdue,
      blockedWorkItems: current.blockedWorkItems + entry.health.counts.blocked,
      pendingRecommendations: current.pendingRecommendations + entry.health.counts.pendingRecommendations,
      openImpactSuggestions: current.openImpactSuggestions + entry.health.counts.openImpacts,
      pendingActionApprovals: current.pendingActionApprovals + entry.health.counts.pendingApprovals,
    }), { atRiskProjects: 0, overdueWorkItems: 0, blockedWorkItems: 0, pendingRecommendations: 0, openImpactSuggestions: 0, pendingActionApprovals: 0 });
    const summary = projects.reduce(
      (current, project) => ({
        confirmedItems: current.confirmedItems + project._count.items,
        repositories: current.repositories + project._count.repositoryLinks,
        indexedProjects: current.indexedProjects + (project.memoryIndexPointer ? 1 : 0),
        routedProjects: current.routedProjects,
        assets: current.assets + project._count.assets,
      }),
      { confirmedItems: 0, repositories: 0, indexedProjects: 0, routedProjects: 0, assets: 0 },
    );
    summary.routedProjects = activePlatformRouteCount === 6 ? projects.length : 0;
    const worldSummary = worlds.reduce((current, entry) => ({
      atRiskWorlds: current.atRiskWorlds + (entry.world.status === "at_risk" ? 1 : 0),
      attentionWorlds: current.attentionWorlds + (entry.world.status === "needs_attention" ? 1 : 0),
      insufficientDataWorlds: current.insufficientDataWorlds + (entry.world.status === "insufficient_data" ? 1 : 0),
    }), { atRiskWorlds: 0, attentionWorlds: 0, insufficientDataWorlds: 0 });
    const hasAttention = operations.some((entry) => entry.health.status === "atRisk" || entry.health.status === "attention")
      || worlds.some((entry) => entry.world.status === "at_risk" || entry.world.status === "needs_attention" || entry.world.status === "insufficient_data");
    const state = projects.length === 0
      ? "zero-project"
      : hasAttention
        ? "needs-attention"
        : activeJobCount > 0
          ? "running"
          : operations.some((entry) => entry.health.status === "empty")
            ? "empty-plan"
            : "healthy";

    const publicProjects = projects.map((project) => ({
      ...project,
      backgroundJobs: project.backgroundJobs.map(toPublicProjectJob),
    }));
    const publicRecentJobs = recentJobs.map((job) => ({
      ...toPublicProjectJob(job),
      project: job.project,
    }));

    return NextResponse.json(
      {
        state,
        summary: {
          projects: projects.length,
          ...summary,
          activeJobs: activeJobCount,
          pendingAssetReviews,
          ...operationsSummary,
          ...worldSummary,
        },
        projects: publicProjects,
        recentJobs: publicRecentJobs,
        operations: operations
          .filter((entry) => entry.health.status !== "healthy")
          .sort((left, right) => (left.health.status === "atRisk" ? 0 : 1) - (right.health.status === "atRisk" ? 0 : 1) || right.health.counts.overdue - left.health.counts.overdue)
          .slice(0, 8),
        worlds: worlds
          .filter((entry) => entry.world.status !== "on_track")
          .sort((left, right) => {
            const rank = { at_risk: 0, needs_attention: 1, insufficient_data: 2, on_track: 3 } as const;
            return rank[left.world.status] - rank[right.world.status] || right.world.counts.activeConflicts - left.world.counts.activeConflicts;
          })
          .slice(0, 8),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
