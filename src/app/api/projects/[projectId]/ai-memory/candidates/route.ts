import { NextResponse } from "next/server";
import {
  AiCandidateError,
  createAiCandidateService,
} from "@/lib/ai-memory";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listAiCandidatesQuerySchema,
  projectIdSchema,
} from "@/lib/validation";
import { mapAiCandidateError } from "../candidate-api-errors";

export const dynamic = "force-dynamic";

function parseQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (key !== "reviewStatus" && key !== "take") {
      throw new ApiError(400, "AI_CANDIDATE_INVALID_INPUT", "AI candidate query is invalid");
    }
    if (params.getAll(key).length !== 1) {
      throw new ApiError(400, "AI_CANDIDATE_INVALID_INPUT", "AI candidate query is invalid");
    }
  }
  return listAiCandidatesQuerySchema.parse({
    ...(params.has("reviewStatus")
      ? { reviewStatus: params.get("reviewStatus") }
      : {}),
    ...(params.has("take") ? { take: params.get("take") } : {}),
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    await requireApiSession(request);
    const { projectId: rawProjectId } = await context.params;
    const projectId = projectIdSchema.parse(rawProjectId);
    const query = parseQuery(request);
    const db = getDb();
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (project === null) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const candidates = await createAiCandidateService({ db }).listCandidates({
      projectId,
      reviewStatus: query.reviewStatus,
      take: query.take,
    });
    return NextResponse.json({ candidates });
  } catch (error) {
    return handleApiError(
      error instanceof AiCandidateError ? mapAiCandidateError(error) : error,
    );
  }
}
