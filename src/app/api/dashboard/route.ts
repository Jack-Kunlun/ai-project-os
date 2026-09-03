import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import { toPublicProjectJob } from "@/lib/project-workflow";
import { accessibleProjectWhere } from "@/lib/access-control";
import { getProjectOperationsSummaries } from "@/lib/project-operations";
import { getProjectWorldSummaries } from "@/lib/project-world";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    const db = getDb();
    const projectWhere = { AND: [accessibleProjectWhere(user), { archivedAt: null }] };

    const [projects, activeJobCount, pendingAssetReviews, recentJobs] = await Promise.all([
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
              sources: { where: { retiredAt: null } },
              assets: { where: { status: { not: "deleted" } } },
              items: { where: { reviewStatus: "confirmed" } },
              snapshots: true,
              repositoryLinks: { where: { status: "active" } },
              webAiRoutes: true,
              projectAgentRuns: true,
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
        routedProjects: current.routedProjects + (project._count.webAiRoutes === 4 ? 1 : 0),
        assets: current.assets + project._count.assets,
      }),
      { confirmedItems: 0, repositories: 0, indexedProjects: 0, routedProjects: 0, assets: 0 },
    );
    const worldSummary = worlds.reduce((current, entry) => ({
      atRiskWorlds: current.atRiskWorlds + (entry.world.status === "at_risk" ? 1 : 0),
      attentionWorlds: current.attentionWorlds + (entry.world.status === "needs_attention" ? 1 : 0),
      insufficientDataWorlds: current.insufficientDataWorlds + (entry.world.status === "insufficient_data" ? 1 : 0),
    }), { atRiskWorlds: 0, attentionWorlds: 0, insufficientDataWorlds: 0 });

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
    return handleApiError(error);
  }
}
