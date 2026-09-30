import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { revokeProjectGitAutomationGrant } from "@/lib/project-git-automation-grant-service";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; grantId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await revokeProjectGitAutomationGrant(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.grantId),
      await readJsonBody(request),
      actor,
    );
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
