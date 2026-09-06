import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWithAvailableSlug, isUniqueConstraintError } from "@/lib/project-slug";
import { createProjectSchema, slugifyProjectName } from "@/lib/validation";
import { toPublicProjectJob } from "@/lib/project-workflow";
import { accessibleProjectWhere, resolveProjectCreationWorkspace } from "@/lib/access-control";
import { AccessControlError } from "@/lib/access-control";
import { lockActorsAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import { appendProjectMembershipAudit, findConfirmedWorkspaceMembership } from "@/lib/membership-governance";
import { DEFAULT_LIST_PAGE_SIZE, listPagination, MAX_LIST_PAGE_SIZE } from "@/lib/list-pagination";
import {
  nonLegacyMcpMemoryGenerationWhere,
  nonLegacyMcpProjectItemWhere,
  nonLegacyMcpProjectSourceWhere,
} from "@/lib/legacy-mcp-source-quarantine";

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
      sources: { where: nonLegacyMcpProjectSourceWhere },
      assets: { where: { status: { not: "deleted" } } },
      items: { where: { reviewStatus: "confirmed", ...nonLegacyMcpProjectItemWhere } },
      scans: true,
      snapshots: true,
      repositoryLinks: { where: { status: "active" } },
      webAiRoutes: true,
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
      createdAt: true,
      completedAt: true,
    },
  },
} as const;

const listProjectsQuerySchema = z.object({
  view: z.enum(["active", "archived"]).default("active"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
  search: z.string().trim().max(120).default(""),
}).strict();

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    const db = getDb();
    const searchParams = new URL(request.url).searchParams;
    for (const key of new Set(searchParams.keys())) {
      if (searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
    const query = listProjectsQuerySchema.parse(Object.fromEntries(searchParams));
    const archived = query.view === "archived";
    const accessWhere = accessibleProjectWhere(user);
    const where: Prisma.ProjectWhereInput = {
      AND: [
        accessWhere,
        { archivedAt: archived ? { not: null } : null },
        ...(query.search ? [{
          OR: [
            { name: { contains: query.search, mode: "insensitive" as const } },
            { description: { contains: query.search, mode: "insensitive" as const } },
            { slug: { contains: query.search, mode: "insensitive" as const } },
          ],
        }] : []),
      ],
    };
    const [projects, total, activeCount, archivedCount, createMembershipCount] = await Promise.all([
      db.project.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: projectSummarySelect,
      }),
      db.project.count({ where }),
      db.project.count({ where: { AND: [accessWhere, { archivedAt: null }] } }),
      db.project.count({ where: { AND: [accessWhere, { archivedAt: { not: null } }] } }),
      db.workspaceMembership.count({
        where: { userId: user.id, accessState: "confirmed", role: { in: ["owner", "admin"] } },
      }),
    ]);

    return NextResponse.json({
      view: query.view,
      canCreateProject: createMembershipCount > 0,
      counts: { active: activeCount, archived: archivedCount },
      pagination: listPagination(query.page, query.pageSize, total),
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
    const user = await requireApiSession(request);
    const db = getDb();
    const workspaceId = await resolveProjectCreationWorkspace(user, db);
    const input = createProjectSchema.parse(await readJsonBody(request));
    const project = await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [user.id]);
      await lockWorkspaceAccess(tx, workspaceId);
      const currentMembership = await findConfirmedWorkspaceMembership(tx, workspaceId, user.id);
      if (currentMembership === null || (currentMembership.role !== "owner" && currentMembership.role !== "admin")) {
        throw new AccessControlError("ACCESS_FORBIDDEN");
      }
      return createWithAvailableSlug({
        requestedSlug: input.slug,
        baseSlug: slugifyProjectName(input.name),
        create: async (slug) => {
          const createdProject = await tx.project.create({
            data: {
              name: input.name,
              slug,
              description: input.description || null,
              workspaceId,
              membershipInheritanceMode: "workspaceInherited",
            },
            select: projectSummarySelect,
          });
          const ownerMembership = await tx.projectMembership.create({ data: { projectId: createdProject.id, userId: user.id, role: "owner", accessState: "confirmed" } });
          await appendProjectMembershipAudit(tx, { ...ownerMembership, workspaceId }, { action: "confirmed", previousState: null, actorId: user.id, reason: "project_owner_created" });
          return createdProject;
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

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
