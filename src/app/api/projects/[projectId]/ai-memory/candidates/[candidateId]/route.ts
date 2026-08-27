import { NextResponse } from "next/server";
import {
  AiCandidateError,
  createAiCandidateService,
} from "@/lib/ai-memory";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import {
  aiCandidateIdSchema,
  projectIdSchema,
  reviewAiCandidateSchema,
} from "@/lib/validation";
import { mapAiCandidateError } from "../../candidate-api-errors";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; candidateId: string }> },
) {
  try {
    const params = await context.params;
    const projectId = projectIdSchema.parse(params.projectId);
    const candidateId = aiCandidateIdSchema.parse(params.candidateId);
    const input = reviewAiCandidateSchema.parse(await readJsonBody(request));
    const service = createAiCandidateService({ db: getDb() });
    const candidate = input.action === "accept"
      ? await service.acceptCandidate({
          projectId,
          candidateId,
          reviewedBy: "local:user",
          expectedItemUpdatedAt: new Date(input.expectedItemUpdatedAt),
          item: {
            type: input.type,
            title: input.title,
            content: input.content,
            occurredAt: input.occurredAt === null ? null : new Date(input.occurredAt),
          },
        })
      : await service.dismissCandidate({
          projectId,
          candidateId,
          reviewedBy: "local:user",
          expectedItemUpdatedAt: new Date(input.expectedItemUpdatedAt),
        });
    return NextResponse.json({ candidate });
  } catch (error) {
    return handleApiError(
      error instanceof AiCandidateError ? mapAiCandidateError(error) : error,
    );
  }
}
