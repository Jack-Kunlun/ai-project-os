import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWithAvailableSlug, isUniqueConstraintError } from "@/lib/project-slug";
import { createProjectSchema, slugifyProjectName } from "@/lib/validation";
import { toPublicProjectJob } from "@/lib/project-workflow";

export const dynamic = "force-dynamic";

const projectSummarySelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      sources: true,
      items: { where: { reviewStatus: "confirmed" } },
      scans: true,
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
} as const;

const listProjectsQuerySchema = z.object({
  view: z.enum(["active", "archived"]).default("active"),
}).strict();

export async function GET(request: Request) {
  try {
    await requireApiSession(request);
    const db = getDb();
    const searchParams = new URL(request.url).searchParams;
    for (const key of new Set(searchParams.keys())) {
      if (searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
    const query = listProjectsQuerySchema.parse(Object.fromEntries(searchParams));
    const archived = query.view === "archived";
    const [projects, activeCount, archivedCount] = await Promise.all([
      db.project.findMany({
        where: { archivedAt: archived ? { not: null } : null },
        orderBy: { updatedAt: "desc" },
        select: projectSummarySelect,
      }),
      db.project.count({ where: { archivedAt: null } }),
      db.project.count({ where: { archivedAt: { not: null } } }),
    ]);

    return NextResponse.json({
      view: query.view,
      counts: { active: activeCount, archived: archivedCount },
      projects: projects.map((project) => ({
        ...project,
        backgroundJobs: project.backgroundJobs.map(toPublicProjectJob),
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const db = getDb();
    const input = createProjectSchema.parse(await readJsonBody(request));
    const project = await createWithAvailableSlug({
      requestedSlug: input.slug,
      baseSlug: slugifyProjectName(input.name),
      create: (slug) =>
        db.project.create({
          data: {
            name: input.name,
            slug,
            description: input.description || null,
          },
          select: projectSummarySelect,
        }),
    });

    return NextResponse.json({
      project: {
        ...project,
        backgroundJobs: project.backgroundJobs.map(toPublicProjectJob),
      },
    }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return handleApiError(new ApiError(400, "PROJECT_SLUG_CONFLICT", "A project with this slug already exists"));
    }

    return handleApiError(error);
  }
}
