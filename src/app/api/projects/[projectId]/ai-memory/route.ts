import { NextResponse } from "next/server";
import {
  ProjectAiConfigError,
  createProjectAiConfigService,
} from "@/lib/ai-memory";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projectIdSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

function mapProjectAiConfigError(error: ProjectAiConfigError): ApiError {
  switch (error.code) {
    case "PROJECT_AI_CONFIG_INVALID_INPUT":
      return new ApiError(400, error.code, "AI memory configuration is invalid");
    case "PROJECT_NOT_FOUND":
      return new ApiError(404, error.code, "Project not found");
    case "SOURCE_NOT_FOUND":
      return new ApiError(404, error.code, "One or more selected sources were not found");
    case "SOURCE_CHANGED":
      return new ApiError(409, error.code, "A selected source changed; refresh and retry");
    case "SOURCE_SCAN_BLOCKED":
      return new ApiError(422, error.code, "A selected source did not pass local sensitive-data scanning");
    case "SOURCE_TOO_LARGE":
      return new ApiError(422, error.code, "A selected source is too large for governed extraction");
    case "PROJECT_AI_CONFIG_WRITE_CONFLICT":
      return new ApiError(409, error.code, "AI memory configuration changed; refresh and retry");
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    await requireApiSession(request);
    const { projectId: rawProjectId } = await context.params;
    const projectId = projectIdSchema.parse(rawProjectId);
    const status = await createProjectAiConfigService({ db: getDb() })
      .getStatus(projectId);
    return NextResponse.json({ aiMemory: status });
  } catch (error) {
    return handleApiError(
      error instanceof ProjectAiConfigError
        ? mapProjectAiConfigError(error)
        : error,
    );
  }
}
