import type { AiOperation } from "@prisma/client";

/** Operations currently wired to the synchronous Web AI runtime. */
export const PROJECT_AI_RUNTIME_OPERATIONS = Object.freeze([
  "embedding",
  "visionExtract",
  "autoExtract",
  "projectAnalysis",
  "generateWithContext",
] as const);

export type ProjectAiRuntimeOperation = typeof PROJECT_AI_RUNTIME_OPERATIONS[number];

export function isProjectAiRuntimeOperation(operation: AiOperation): operation is ProjectAiRuntimeOperation {
  return PROJECT_AI_RUNTIME_OPERATIONS.includes(operation as ProjectAiRuntimeOperation);
}

export function getProjectAiOperationCapability(operation: AiOperation) {
  const operationExecutionAvailable = isProjectAiRuntimeOperation(operation);
  return Object.freeze({
    operationExecutionAvailable,
    controlPlaneOnly: !operationExecutionAvailable,
  });
}
