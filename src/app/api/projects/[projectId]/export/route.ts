import { NextResponse } from "next/server";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { exportProjectData } from "@/lib/project-export";
import { createProjectExportSchema, projectIdSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const { projectId: rawProjectId } = await context.params;
    const projectId = projectIdSchema.parse(rawProjectId);
    const input = createProjectExportSchema.parse(await readJsonBody(request));
    const exported = await exportProjectData({
      projectId,
      requestedById: user.id,
      expectedUpdatedAt: new Date(input.expectedUpdatedAt),
    });
    const date = exported.audit.createdAt.toISOString().slice(0, 10).replaceAll("-", "");
    return new NextResponse(exported.json, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="ai-project-os-${projectId}-${date}.json"`,
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-ai-project-os-export-audit-id": exported.audit.id,
        "x-ai-project-os-export-sha256": exported.audit.contentHash,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
