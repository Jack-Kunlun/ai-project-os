import {
  buildOpenAiGroundedRagTransportPlan,
  getOpenAiGenerateWithContextProfile,
  verifyOpenAiGroundedRagResponse,
  type OpenAiGroundedRagTransportPlan,
  type SafeUsage,
} from "@/lib/ai-runtime";
import {
  GroundedRagError,
  getIssuedGroundedRagPlan,
  verifyGroundedRagOutput,
  type GroundedRagPlan,
  type GroundedRagResult,
} from "./grounded-rag";

export type OpenAiGroundedRagExecutionIdentity = Readonly<{
  runId: string;
  operationKey: string;
}>;

export type VerifiedOpenAiGroundedRagRun = Readonly<{
  providerResponseId: string;
  modelId: string;
  usage: Readonly<SafeUsage>;
  outputFingerprint: string;
  result: GroundedRagResult;
}>;

const groundedPlans = new WeakMap<object, GroundedRagPlan>();

function invalidInput(): never {
  throw new GroundedRagError("GROUNDED_RAG_INVALID_INPUT");
}

/**
 * Binds an issued project RAG plan to the fixed OpenAI request contract. This
 * compiler performs no network access and reads no credential.
 */
export function compileOpenAiGroundedRagPlan(
  rawPlan: GroundedRagPlan,
  execution: OpenAiGroundedRagExecutionIdentity,
): OpenAiGroundedRagTransportPlan {
  const plan = getIssuedGroundedRagPlan(rawPlan);
  if (plan === null) return invalidInput();
  const transportPlan = buildOpenAiGroundedRagTransportPlan(
    getOpenAiGenerateWithContextProfile(),
    {
      runId: execution?.runId,
      operationKey: execution?.operationKey,
      projectId: plan.projectId,
      snapshotId: plan.snapshotId,
      snapshotManifestFingerprint: plan.snapshotManifestFingerprint,
      contextFingerprint: plan.contextFingerprint,
      question: plan.question,
      contexts: plan.contexts.map((context) => ({
        citationKey: context.citationKey,
        sourceId: context.sourceId,
        chunkId: context.chunkId,
        sourceKind: context.sourceKind,
        externalRef: context.externalRef,
        contentHash: context.contentHash,
        contentText: context.contentText,
        rangeUnit: context.rangeUnit,
        rangeStart: context.rangeStart,
        rangeEnd: context.rangeEnd,
      })),
    },
  );
  groundedPlans.set(transportPlan, plan);
  return transportPlan;
}

export function verifyOpenAiGroundedRagPlanResponse(
  rawPlan: GroundedRagPlan,
  transportPlan: OpenAiGroundedRagTransportPlan,
  rawResponse: unknown,
): VerifiedOpenAiGroundedRagRun {
  const plan = getIssuedGroundedRagPlan(rawPlan);
  if (plan === null || groundedPlans.get(transportPlan) !== plan) {
    return invalidInput();
  }
  const verified = verifyOpenAiGroundedRagResponse(transportPlan, rawResponse);
  return Object.freeze({
    providerResponseId: verified.providerResponseId,
    modelId: verified.modelId,
    usage: verified.usage,
    outputFingerprint: verified.outputFingerprint,
    result: verifyGroundedRagOutput(plan, verified.output),
  });
}
