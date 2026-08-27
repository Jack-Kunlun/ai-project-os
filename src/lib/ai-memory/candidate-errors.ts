export type AiCandidateErrorCode =
  | "AI_CANDIDATE_INVALID_INPUT"
  | "AI_CANDIDATE_RUN_NOT_FOUND"
  | "AI_CANDIDATE_RUN_NOT_ELIGIBLE"
  | "AI_CANDIDATE_RESPONSE_MISMATCH"
  | "AI_CANDIDATE_BATCH_CONFLICT"
  | "AI_CANDIDATE_NOT_FOUND"
  | "AI_CANDIDATE_ALREADY_REVIEWED"
  | "AI_CANDIDATE_WRITE_CONFLICT";

export class AiCandidateError extends Error {
  constructor(readonly code: AiCandidateErrorCode) {
    super(code);
    this.name = "AiCandidateError";
  }
}

export function throwAiCandidateError(code: AiCandidateErrorCode): never {
  throw new AiCandidateError(code);
}
