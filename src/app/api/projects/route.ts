import { NextResponse } from "next/server";
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

export async function GET(request: Request) {
  try {
    await requireApiSession(request);
    const db = getDb();
    const projects = await db.project.findMany({
      orderBy: { updatedAt: "desc" },
      select: projectSummarySelect,
    });

    return NextResponse.json({
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
