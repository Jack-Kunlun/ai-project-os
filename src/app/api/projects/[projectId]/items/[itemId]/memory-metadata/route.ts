import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { updateProjectItemMemoryMetadata } from "@/lib/memory-quality";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; itemId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const item = await updateProjectItemMemoryMetadata(projectId, idSchema.parse(params.itemId), await readJsonBody(request), user);
    return NextResponse.json({ item });
  } catch (error) {
    return handleApiError(error);
  }
}
