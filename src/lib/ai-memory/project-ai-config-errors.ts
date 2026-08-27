export type ProjectAiConfigErrorCode =
  | "PROJECT_AI_CONFIG_INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_CHANGED"
  | "SOURCE_SCAN_BLOCKED"
  | "SOURCE_TOO_LARGE"
  | "PROJECT_AI_CONFIG_WRITE_CONFLICT";

export class ProjectAiConfigError extends Error {
  constructor(public readonly code: ProjectAiConfigErrorCode) {
    super(code);
    this.name = "ProjectAiConfigError";
  }
}

export function throwProjectAiConfigError(
  code: ProjectAiConfigErrorCode,
): never {
  throw new ProjectAiConfigError(code);
}
