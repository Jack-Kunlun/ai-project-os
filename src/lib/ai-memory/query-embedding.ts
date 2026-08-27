import { createHash, randomUUID } from "node:crypto";
import {
  EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
} from "./corpus-index";
import type { ProjectQueryEmbedding } from "./project-search";
import {
  buildOpenAiEmbeddingsTransportPlan,
  classifyProviderResult,
  executeOpenAiEmbeddingsTransport,
  getOpenAiEmbeddingProfile,
  type ExecuteOpenAiEmbeddingsOptions,
  type OpenAiCredentialHandle,
} from "@/lib/ai-runtime";

export const PROJECT_QUERY_TRANSFER_CONSENT_VERSION =
  "project-query-to-openai:v1" as const;

const MAX_QUERY_BYTES = 2_000;
const UNSAFE_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export type ProjectQueryEmbeddingErrorCode =
  | "PROJECT_QUERY_EMBEDDING_INVALID_INPUT"
  | "PROJECT_QUERY_EMBEDDING_PROVIDER_FAILED";

export class ProjectQueryEmbeddingError extends Error {
  constructor(
    readonly code: ProjectQueryEmbeddingErrorCode,
    readonly safeCode: string | null = null,
  ) {
    super(code);
    this.name = "ProjectQueryEmbeddingError";
  }
}

function fail(
  code: ProjectQueryEmbeddingErrorCode,
  safeCode: string | null = null,
): never {
  throw new ProjectQueryEmbeddingError(code, safeCode);
}

function canonicalQuery(value: unknown): string {
  if (typeof value !== "string") {
    return fail("PROJECT_QUERY_EMBEDDING_INVALID_INPUT");
  }
  let normalized: string;
  try {
    normalized = value.normalize("NFC").trim();
  } catch {
    return fail("PROJECT_QUERY_EMBEDDING_INVALID_INPUT");
  }
  if (
    normalized.length === 0 ||
    normalized !== value ||
    Buffer.byteLength(value, "utf8") > MAX_QUERY_BYTES ||
    UNSAFE_CONTROL_PATTERN.test(value)
  ) {
    return fail("PROJECT_QUERY_EMBEDDING_INVALID_INPUT");
  }
  return value;
}

function unitVector(value: readonly number[]): readonly number[] {
  const norm = Math.sqrt(value.reduce(
    (sum, component) => sum + component * component,
    0,
  ));
  if (!Number.isFinite(norm) || norm <= 0) {
    return fail("PROJECT_QUERY_EMBEDDING_PROVIDER_FAILED");
  }
  const normalized = value.map((component) => Math.fround(component / norm));
  const normalizedNorm = Math.sqrt(normalized.reduce(
    (sum, component) => sum + component * component,
    0,
  ));
  if (!Number.isFinite(normalizedNorm) || normalizedNorm < 0.999 || normalizedNorm > 1.001) {
    return fail("PROJECT_QUERY_EMBEDDING_PROVIDER_FAILED");
  }
  return Object.freeze(normalized);
}

export async function createOpenAiProjectQueryEmbedding(
  input: Readonly<{
    query: string;
    consentVersion: typeof PROJECT_QUERY_TRANSFER_CONSENT_VERSION;
    acknowledgeExternalQueryTransfer: true;
  }>,
  credential: OpenAiCredentialHandle,
  options: ExecuteOpenAiEmbeddingsOptions = {},
): Promise<ProjectQueryEmbedding> {
  if (
    typeof input !== "object" ||
    input === null ||
    Object.keys(input).sort().join(",") !==
      "acknowledgeExternalQueryTransfer,consentVersion,query" ||
    input.consentVersion !== PROJECT_QUERY_TRANSFER_CONSENT_VERSION ||
    input.acknowledgeExternalQueryTransfer !== true
  ) {
    return fail("PROJECT_QUERY_EMBEDDING_INVALID_INPUT");
  }
  const query = canonicalQuery(input.query);
  const runId = randomUUID();
  const inputId = randomUUID();
  const operationKey = createHash("sha256")
    .update(PROJECT_QUERY_TRANSFER_CONSENT_VERSION, "utf8")
    .update("\0", "utf8")
    .update(query, "utf8")
    .digest("hex");
  const plan = buildOpenAiEmbeddingsTransportPlan(
    getOpenAiEmbeddingProfile(),
    {
      runId,
      operationKey,
      inputs: [{ inputId, content: query }],
    },
  );
  const result = await executeOpenAiEmbeddingsTransport(
    plan,
    credential,
    options,
  );
  const classification = classifyProviderResult(result.providerResult);
  const vector = result.verifiedResponse?.vectors[0];
  if (
    classification.runStatus !== "succeeded" ||
    result.verifiedResponse === null ||
    result.verifiedResponse.vectors.length !== 1 ||
    vector === undefined ||
    vector.inputId !== inputId
  ) {
    return fail(
      "PROJECT_QUERY_EMBEDDING_PROVIDER_FAILED",
      classification.safeCode,
    );
  }
  return Object.freeze({
    profileFingerprint: EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
    vector: unitVector(vector.vector),
  });
}
