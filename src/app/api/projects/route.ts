import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWithAvailableSlug, isUniqueConstraintError } from "@/lib/project-slug";
import { createProjectSchema, slugifyProjectName } from "@/lib/validation";

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
      items: true,
      scans: true,
      snapshots: true,
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

    return NextResponse.json({ projects });
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

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return handleApiError(new ApiError(400, "PROJECT_SLUG_CONFLICT", "A project with this slug already exists"));
    }

    return handleApiError(error);
  }
}
