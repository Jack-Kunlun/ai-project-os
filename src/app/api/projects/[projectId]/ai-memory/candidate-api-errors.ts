import { AiCandidateError } from "@/lib/ai-memory";
import { ApiError } from "@/lib/api-errors";

export function mapAiCandidateError(error: AiCandidateError): ApiError {
  switch (error.code) {
    case "AI_CANDIDATE_INVALID_INPUT":
      return new ApiError(400, error.code, "AI candidate request is invalid");
    case "AI_CANDIDATE_NOT_FOUND":
    case "AI_CANDIDATE_RUN_NOT_FOUND":
      return new ApiError(404, error.code, "AI candidate was not found");
    case "AI_CANDIDATE_ALREADY_REVIEWED":
      return new ApiError(409, error.code, "AI candidate has already been reviewed");
    case "AI_CANDIDATE_VERSION_CONFLICT":
      return new ApiError(409, error.code, "AI candidate changed; refresh and retry");
    case "AI_CANDIDATE_RUN_NOT_ELIGIBLE":
    case "AI_CANDIDATE_RESPONSE_MISMATCH":
    case "AI_CANDIDATE_BATCH_CONFLICT":
    case "AI_CANDIDATE_WRITE_CONFLICT":
      return new ApiError(409, error.code, "AI candidate state is not writable");
  }
}
