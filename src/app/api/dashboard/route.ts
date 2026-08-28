import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireApiSession(request);
    const db = getDb();

    const [projects, providers, activeJobCount, recentJobs] = await Promise.all([
      db.project.findMany({
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              sources: true,
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
              createdAt: true,
              completedAt: true,
            },
          },
        },
      }),
      db.aiProviderConnection.findMany({
        where: { disabledAt: null },
        select: {
          status: true,
          defaultEmbeddingModelId: true,
          embeddingDimensions: true,
        },
      }),
      db.backgroundJob.count({ where: { status: { in: ["queued", "running"] } } }),
      db.backgroundJob.findMany({
        where: { projectId: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          kind: true,
          status: true,
          stage: true,
          failureCode: true,
          createdAt: true,
          completedAt: true,
          project: { select: { id: true, name: true } },
        },
      }),
    ]);

    const verifiedProviders = providers.filter((provider) => provider.status === "verified");
    const summary = projects.reduce(
      (current, project) => ({
        confirmedItems: current.confirmedItems + project._count.items,
        repositories: current.repositories + project._count.repositoryLinks,
        indexedProjects: current.indexedProjects + (project.memoryIndexPointer ? 1 : 0),
        routedProjects: current.routedProjects + (project._count.webAiRoutes === 3 ? 1 : 0),
      }),
      { confirmedItems: 0, repositories: 0, indexedProjects: 0, routedProjects: 0 },
    );

    return NextResponse.json(
      {
        summary: {
          projects: projects.length,
          ...summary,
          activeJobs: activeJobCount,
          generationProviders: verifiedProviders.length,
          embeddingProviders: verifiedProviders.filter(
            (provider) => provider.defaultEmbeddingModelId !== null && provider.embeddingDimensions !== null,
          ).length,
        },
        projects,
        recentJobs,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
