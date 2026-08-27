import {
  GroundedRagError,
  getIssuedGroundedRagPlan,
  verifyGroundedClaimSet,
  verifyGroundedConflictSet,
  type GroundedClaim,
  type GroundedConflict,
  type GroundedRagPlan,
} from "./grounded-rag";
import {
  OPENAI_PROJECT_ANALYSIS_PROMPT_VERSION,
  OPENAI_SOURCE_SUMMARY_PROMPT_VERSION,
} from "@/lib/ai-runtime";

export const GROUNDED_ANALYSIS_VERSION = "grounded-analysis:v1" as const;
export const GROUNDED_SOURCE_SUMMARY_PROMPT_VERSION =
  OPENAI_SOURCE_SUMMARY_PROMPT_VERSION;
export const GROUNDED_PROJECT_BRIEF_PROMPT_VERSION =
  OPENAI_PROJECT_ANALYSIS_PROMPT_VERSION;

const REFUSAL_ANSWER = "当前证据不足，无法生成可核验分析。" as const;

export type GroundedAnalysisOperation = "sourceSummary" | "projectAnalysis";

export type GroundedSourceSummary = Readonly<{
  kind: "source_summary";
  title: "资料摘要";
  paragraphs: readonly GroundedClaim[];
  snapshotId: string;
  contextFingerprint: string;
}>;

export type GroundedProjectBrief = Readonly<{
  kind: "project_brief";
  title: "项目分析简报";
  progress: readonly GroundedClaim[];
  risks: readonly GroundedClaim[];
  unknowns: readonly GroundedClaim[];
  conflicts: readonly GroundedConflict[];
  questions: readonly GroundedClaim[];
  snapshotId: string;
  contextFingerprint: string;
}>;

export type GroundedAnalysisRefusal = Readonly<{
  kind: "refusal";
  reasonCode: "INSUFFICIENT_EVIDENCE";
  answer: typeof REFUSAL_ANSWER;
  snapshotId: string;
  contextFingerprint: string;
}>;

export type GroundedAnalysisResult =
  | GroundedSourceSummary
  | GroundedProjectBrief
  | GroundedAnalysisRefusal;

function fail(): never {
  throw new GroundedRagError("GROUNDED_RAG_INVALID_OUTPUT");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  let keys: string[];
  try {
    keys = Object.keys(value).sort();
  } catch {
    return fail();
  }
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    return fail();
  }
}

function refusal(plan: GroundedRagPlan, value: Record<string, unknown>): GroundedAnalysisRefusal {
  exactKeys(value, ["kind", "reasonCode"]);
  if (value.reasonCode !== "INSUFFICIENT_EVIDENCE") return fail();
  return Object.freeze({
    kind: "refusal" as const,
    reasonCode: "INSUFFICIENT_EVIDENCE" as const,
    answer: REFUSAL_ANSWER,
    snapshotId: plan.snapshotId,
    contextFingerprint: plan.contextFingerprint,
  });
}

function verifySourceSummary(
  plan: GroundedRagPlan,
  value: Record<string, unknown>,
): GroundedSourceSummary {
  exactKeys(value, ["kind", "paragraphs"]);
  const paragraphs = verifyGroundedClaimSet(plan, value.paragraphs, {
    minimum: 1,
    maximum: 12,
  });
  return Object.freeze({
    kind: "source_summary" as const,
    title: "资料摘要" as const,
    paragraphs,
    snapshotId: plan.snapshotId,
    contextFingerprint: plan.contextFingerprint,
  });
}

function verifyProjectBrief(
  plan: GroundedRagPlan,
  value: Record<string, unknown>,
): GroundedProjectBrief {
  exactKeys(value, [
    "kind",
    "progress",
    "risks",
    "unknowns",
    "conflicts",
    "questions",
  ]);
  const progress = verifyGroundedClaimSet(plan, value.progress, {
    minimum: 0,
    maximum: 8,
  });
  const risks = verifyGroundedClaimSet(plan, value.risks, {
    minimum: 0,
    maximum: 8,
  });
  const unknowns = verifyGroundedClaimSet(plan, value.unknowns, {
    minimum: 0,
    maximum: 8,
  });
  const conflicts = verifyGroundedConflictSet(plan, value.conflicts, {
    minimum: 0,
    maximum: 5,
  });
  const questions = verifyGroundedClaimSet(plan, value.questions, {
    minimum: 0,
    maximum: 8,
  });
  const claims = [...progress, ...risks, ...unknowns, ...questions];
  if (claims.length + conflicts.length === 0) return fail();
  const claimTexts = new Set(claims.map((claim) => claim.text));
  if (claimTexts.size !== claims.length) return fail();
  return Object.freeze({
    kind: "project_brief" as const,
    title: "项目分析简报" as const,
    progress,
    risks,
    unknowns,
    conflicts,
    questions,
    snapshotId: plan.snapshotId,
    contextFingerprint: plan.contextFingerprint,
  });
}

export function verifyGroundedAnalysisOutput(
  operation: GroundedAnalysisOperation,
  rawPlan: GroundedRagPlan,
  value: unknown,
): GroundedAnalysisResult {
  const plan = getIssuedGroundedRagPlan(rawPlan);
  if (plan === null) {
    throw new GroundedRagError("GROUNDED_RAG_INVALID_INPUT");
  }
  if (!isPlainRecord(value) || typeof value.kind !== "string") return fail();
  if (value.kind === "refusal") return refusal(plan, value);
  if (operation === "sourceSummary" && value.kind === "source_summary") {
    return verifySourceSummary(plan, value);
  }
  if (operation === "projectAnalysis" && value.kind === "project_brief") {
    return verifyProjectBrief(plan, value);
  }
  return fail();
}
