export const PLATFORM_OPERATIONS = ["embedding", "visionExtract", "autoExtract", "sourceSummary", "projectAnalysis", "generateWithContext"] as const;
export type PlatformOperation = typeof PLATFORM_OPERATIONS[number];
export type OperationCandidate = Readonly<{
  providerConnectionId: string; providerName: string; providerKind: string; modelId: string;
  embeddingDimensions: number | null; maxOutputTokens: number | null;
}>;
export type OperationProof = Readonly<{ probeId: string; clientRequestKey: string; expiresAt: string }>;
export type OperationTarget = Readonly<{ operation: PlatformOperation; candidate: OperationCandidate; proof?: OperationProof; confirmEmbeddingImpact: boolean }>;
export type BatchMode = "test" | "testAndApply" | "apply";
export type OperationStatus = "queued" | "testing" | "passed" | "applying" | "enabled" | "failed" | "applyFailed" | "unknown" | "applyUnknown" | "stopped" | "expired";
export type OperationResult = Readonly<{ target: OperationTarget; status: OperationStatus; proof?: OperationProof; message?: string }>;
export type ProbeOutcome = Readonly<{ status: string; probeId: string | null; expiresAt: string | null; safeErrorCode: string | null; message?: string }>;
export type ApplyOutcome = Readonly<{ ok: boolean; message?: string }>;

/** These operation-endpoint errors are thrown before dispatch; transport/reconciliation errors stay uncertain. */
export function probeHttpFailureStatus(status: number, payload: unknown): "rejected" | "unknown" {
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  const beforeDispatch = [
    "AUTH_REQUIRED", "ACCESS_FORBIDDEN", "ACCOUNT_DISABLED",
    "PLATFORM_PROVIDER_PROBE_INVALID_INPUT", "PLATFORM_PROVIDER_PROBE_ADMIN_REQUIRED",
    "PLATFORM_PROVIDER_PROBE_PROVIDER_NOT_FOUND", "PLATFORM_PROVIDER_PROBE_PROVIDER_DISABLED",
    "PLATFORM_PROVIDER_PROBE_CANONICAL_ENDPOINT_REQUIRED", "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT",
    "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED", "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED",
    "PLATFORM_PROVIDER_PROBE_IDEMPOTENCY_CONFLICT", "PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED",
    "PLATFORM_PROVIDER_PROBE_PROVIDER_EMBEDDING_UNSUPPORTED", "PLATFORM_PROVIDER_PROBE_PROVIDER_VISION_UNSUPPORTED",
    "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH",
  ];
  return status >= 400 && status < 500 && typeof code === "string" && beforeDispatch.includes(code) ? "rejected" : "unknown";
}

// Include the complete selection: changing a model or its settings invalidates its proof.
export function candidateKey(candidate: OperationCandidate): string {
  return JSON.stringify([candidate.providerConnectionId, candidate.modelId, candidate.embeddingDimensions, candidate.maxOutputTokens]);
}

export function proofUsable(proof: OperationProof | undefined, now = Date.now()): proof is OperationProof {
  return proof !== undefined && Number.isFinite(Date.parse(proof.expiresAt)) && Date.parse(proof.expiresAt) > now;
}

export function batchBudgetProblem(budget: { status: string; availableUnits: number; startsAt: string; expiresAt: string } | null, count: number, now = Date.now()): string | null {
  if (budget === null) return "先设置模型测试额度，再开始测试。";
  if (budget.status !== "active" || !Number.isFinite(Date.parse(budget.startsAt)) || Date.parse(budget.startsAt) > now || !(Date.parse(budget.expiresAt) > now)) return "当前测试额度尚未生效或已过期，请设置新的有效周期。";
  if (budget.availableUnits < count) return "可用测试次数不足，请减少所选能力或设置新的测试额度。";
  return null;
}

/** One request per operation. Finish the current item before observing stop; never replay an uncertain probe. */
export async function runOperationBatch(targets: readonly OperationTarget[], mode: BatchMode, dependencies: {
  probe: (target: OperationTarget, clientRequestKey: string) => Promise<ProbeOutcome>;
  apply: (target: OperationTarget, proof: OperationProof) => Promise<ApplyOutcome>;
  requestKey: () => string;
  now: () => number;
  shouldStop: () => boolean;
  update: (result: OperationResult) => void;
}): Promise<void> {
  let uncertain = false;
  for (const target of targets) {
    const update = (status: OperationStatus, proof?: OperationProof, message?: string) => dependencies.update({ target, status, proof, message });
    if (uncertain || dependencies.shouldStop()) { update("stopped"); continue; }
    let proof = target.proof;
    if (mode !== "apply") {
      // A new explicit test has a new key; an enable retry always retains its existing proof and key.
      const clientRequestKey = dependencies.requestKey();
      update("testing");
      try {
        const result = await dependencies.probe(target, clientRequestKey);
        if (result.status === "settled" && result.safeErrorCode === null && typeof result.probeId === "string" && result.probeId.length > 0 && typeof result.expiresAt === "string" && Number.isFinite(Date.parse(result.expiresAt))) {
          proof = { probeId: result.probeId, clientRequestKey, expiresAt: result.expiresAt };
          if (!proofUsable(proof, dependencies.now())) { update("expired"); continue; }
          update("passed", proof);
        } else if (["released", "rejected"].includes(result.status) || (result.status === "settled" && typeof result.safeErrorCode === "string" && result.safeErrorCode.length > 0)) {
          update("failed", undefined, result.message); continue;
        } else {
          update("unknown", undefined, result.message); uncertain = true; continue;
        }
      } catch {
        update("unknown"); uncertain = true; continue;
      }
    }
    if (mode === "test") continue;
    // Allow the server to resolve a repeated apply even after expiry: a consumed proof is idempotent.
    // Fresh apply eligibility is checked by the UI and again by the authoritative server.
    if (proof === undefined) { update("expired"); continue; }
    update("applying", proof);
    try {
      const result = await dependencies.apply(target, proof);
      update(result.ok ? "enabled" : "applyFailed", result.ok ? undefined : proof, result.message);
    } catch {
      update("applyUnknown", proof); uncertain = true;
    }
  }
}
