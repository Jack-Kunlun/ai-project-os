import { NextResponse } from "next/server";
import { z } from "zod";
import { importProjectActionResult } from "@/lib/action-result-intake";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; actionId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const resultImport = await importProjectActionResult(
      projectId,
      idSchema.parse(params.actionId),
      await readJsonBody(request),
      user,
    );
    return NextResponse.json({ resultImport }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
