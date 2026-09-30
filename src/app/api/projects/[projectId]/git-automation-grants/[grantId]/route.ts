import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getProjectGitAutomationGrant } from "@/lib/project-git-automation-grant-service";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ projectId: string; grantId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await getProjectGitAutomationGrant(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.grantId),
      actor,
    );
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
