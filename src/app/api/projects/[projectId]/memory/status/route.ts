import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listAutoExtractSources, listWebAiCandidates } from "@/lib/web-auto-extract";
import { getProjectMemoryIndexStatus } from "@/lib/web-memory-index";
import { listRagAnswers } from "@/lib/web-rag";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const [index, sources, candidates, answers] = await Promise.all([
      getProjectMemoryIndexStatus(projectId, user),
      listAutoExtractSources(projectId, user),
      listWebAiCandidates(projectId, user),
      listRagAnswers(projectId, user),
    ]);
    return NextResponse.json({ index, sources, candidates, answers });
  } catch (error) {
    return handleApiError(error);
  }
}
