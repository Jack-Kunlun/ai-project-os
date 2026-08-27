import { createHash, randomUUID } from "node:crypto";
import {
  AiCandidateReviewStatus,
  Prisma,
  type PrismaClient,
  ProjectItemReviewStatus,
  ProjectItemRevisionAction,
  ProjectItemType,
} from "@prisma/client";
import {
  OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION,
  buildOpenAiCandidateExcerptFingerprint,
  buildOpenAiCandidateSetFingerprint,
  buildOpenAiCandidateStatementFingerprint,
  type VerifiedOpenAiAutoExtractCandidate,
} from "@/lib/ai-runtime";
import { hashSourceContent } from "@/lib/source";
import {
  appendProjectItemRevision,
  createPrimaryProjectItemEvidence,
} from "@/lib/project-item-history";
import { AiCandidateError, throwAiCandidateError } from "./candidate-errors";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/;
const REVIEWER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const UNSAFE_MODEL_ID_PATTERN =
  /(https?:\/\/|api[-_]?key|bearer|password|secret|token|sk-|(^|[\/:@_-])latest($|[\/:@_-]))/i;
const UNSAFE_TEXT_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const MAX_CANDIDATE_COUNT = 100;
const DEFAULT_TRANSACTION_RETRY_LIMIT = 3;

const candidateClaimSelect = {
  id: true,
  projectId: true,
  batchId: true,
  aiRunId: true,
  sourceId: true,
  itemType: true,
  statement: true,
  statementFingerprint: true,
  sourceExcerpt: true,
  sourceExcerptFingerprint: true,
  sourceStart: true,
  sourceEnd: true,
  reviewStatus: true,
  reviewedAt: true,
  reviewedBy: true,
  projectItemId: true,
  createdAt: true,
  batch: {
    select: {
      candidateSetFingerprint: true,
      candidateCount: true,
    },
  },
  projectItem: {
    select: {
      id: true,
      type: true,
      reviewStatus: true,
      title: true,
      content: true,
      sourceExcerpt: true,
      occurredAt: true,
      confirmedAt: true,
      sourceId: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.AiCandidateClaimSelect;

export type AiCandidateClaimView = Prisma.AiCandidateClaimGetPayload<{
  select: typeof candidateClaimSelect;
}>;

interface NormalizedVerifiedResponse {
  providerResponseId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  requestCount: 1;
  candidates: readonly Readonly<VerifiedOpenAiAutoExtractCandidate>[];
  candidateSetFingerprint: string;
}

export interface PersistVerifiedAiCandidatesRequest {
  projectId: string;
  aiRunId: string;
  verifiedResponse: unknown;
}

export interface PersistedAiCandidateBatch {
  id: string;
  projectId: string;
  aiRunId: string;
  candidateSetFingerprint: string;
  candidateCount: number;
  createdAt: Date;
  claims: readonly AiCandidateClaimView[];
}

export interface ListAiCandidatesRequest {
  projectId: string;
  reviewStatus?: AiCandidateReviewStatus;
  take?: number;
}

export interface AcceptAiCandidateRequest {
  projectId: string;
  candidateId: string;
  reviewedBy: string;
  expectedItemUpdatedAt: Date;
  item: {
    type: ProjectItemType;
    title: string;
    content: string;
    occurredAt?: Date | null;
  };
}

export interface DismissAiCandidateRequest {
  projectId: string;
  candidateId: string;
  reviewedBy: string;
  expectedItemUpdatedAt: Date;
}

export interface CreateAiCandidateServiceOptions {
  db: PrismaClient;
  now?: () => Date;
  transactionRetryLimit?: number;
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

function exactDataFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  try {
    const keys = Object.keys(value).sort();
    const expected = [...fields].sort();
    return (
      keys.length === expected.length &&
      keys.every((key, index) => key === expected[index]) &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
      })
    );
  } catch {
    return false;
  }
}

function dataField(value: Record<string, unknown>, field: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof AiCandidateError) throw error;
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
}

function denseDataArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATE_COUNT) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  try {
    const keys = Object.keys(value);
    if (keys.length !== value.length || !keys.every((key, index) => key === String(index))) {
      return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    return keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
      }
      return descriptor.value;
    });
  } catch (error) {
    if (error instanceof AiCandidateError) throw error;
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    value.trim().length === 0 ||
    UNSAFE_TEXT_CONTROL_PATTERN.test(value) ||
    hasUnpairedSurrogate(value)
  ) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  return value as number;
}

function validateUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  return value;
}

function validateFingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  return value;
}

function normalizeVerifiedResponse(value: unknown): NormalizedVerifiedResponse {
  const rootFields = [
    "contractVersion",
    "providerResponseId",
    "modelId",
    "usage",
    "candidates",
    "candidateSetFingerprint",
  ] as const;
  if (!isPlainRecord(value) || !exactDataFields(value, rootFields)) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  if (dataField(value, "contractVersion") !== OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }

  const providerResponseId = dataField(value, "providerResponseId");
  const modelId = dataField(value, "modelId");
  if (
    typeof providerResponseId !== "string" ||
    !PROVIDER_RESPONSE_ID_PATTERN.test(providerResponseId) ||
    typeof modelId !== "string" ||
    !MODEL_ID_PATTERN.test(modelId) ||
    UNSAFE_MODEL_ID_PATTERN.test(modelId)
  ) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }

  const usage = dataField(value, "usage");
  if (
    !isPlainRecord(usage) ||
    !exactDataFields(usage, ["inputTokens", "outputTokens", "requestCount"])
  ) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  const inputTokens = safeInteger(dataField(usage, "inputTokens"));
  const outputTokens = safeInteger(dataField(usage, "outputTokens"));
  if (dataField(usage, "requestCount") !== 1) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }

  const normalizedCandidates = denseDataArray(dataField(value, "candidates")).map(
    (rawCandidate): Readonly<VerifiedOpenAiAutoExtractCandidate> => {
      const fields = [
        "itemType",
        "statement",
        "statementFingerprint",
        "sourceId",
        "sourceExcerpt",
        "sourceExcerptFingerprint",
        "sourceStart",
        "sourceEnd",
      ] as const;
      if (!isPlainRecord(rawCandidate) || !exactDataFields(rawCandidate, fields)) {
        return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
      }
      const statement = safeText(dataField(rawCandidate, "statement"), 20_000);
      const itemType = dataField(rawCandidate, "itemType");
      if (
        itemType !== ProjectItemType.decision &&
        itemType !== ProjectItemType.progress &&
        itemType !== ProjectItemType.issue &&
        itemType !== ProjectItemType.risk
      ) {
        return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
      }
      const sourceExcerpt = safeText(dataField(rawCandidate, "sourceExcerpt"), 10_000);
      const sourceId = validateUuid(dataField(rawCandidate, "sourceId"));
      const statementFingerprint = validateFingerprint(
        dataField(rawCandidate, "statementFingerprint"),
      );
      const sourceExcerptFingerprint = validateFingerprint(
        dataField(rawCandidate, "sourceExcerptFingerprint"),
      );
      const sourceStart = safeInteger(dataField(rawCandidate, "sourceStart"));
      const sourceEnd = safeInteger(dataField(rawCandidate, "sourceEnd"));
      if (
        statementFingerprint !== buildOpenAiCandidateStatementFingerprint(statement) ||
        sourceExcerptFingerprint !== buildOpenAiCandidateExcerptFingerprint(sourceExcerpt) ||
        sourceEnd !== sourceStart + Buffer.byteLength(sourceExcerpt, "utf8")
      ) {
        return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
      }
      return Object.freeze({
        itemType,
        statement,
        statementFingerprint,
        sourceId,
        sourceExcerpt,
        sourceExcerptFingerprint,
        sourceStart,
        sourceEnd,
      });
    },
  );

  normalizedCandidates.sort((left, right) => {
    if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
    if (left.sourceStart !== right.sourceStart) return left.sourceStart - right.sourceStart;
    if (left.statement !== right.statement) return left.statement < right.statement ? -1 : 1;
    return left.sourceExcerpt < right.sourceExcerpt
      ? -1
      : left.sourceExcerpt > right.sourceExcerpt
        ? 1
        : 0;
  });
  for (let index = 1; index < normalizedCandidates.length; index += 1) {
    const previous = normalizedCandidates[index - 1];
    const current = normalizedCandidates[index];
    if (
      previous?.sourceId === current?.sourceId &&
      previous.statement === current.statement &&
      previous.sourceExcerpt === current.sourceExcerpt
    ) {
      return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
  }

  const candidateSetFingerprint = validateFingerprint(
    dataField(value, "candidateSetFingerprint"),
  );
  if (
    candidateSetFingerprint !==
    buildOpenAiCandidateSetFingerprint(normalizedCandidates)
  ) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }

  return Object.freeze({
    providerResponseId,
    modelId,
    inputTokens,
    outputTokens,
    requestCount: 1,
    candidates: Object.freeze(normalizedCandidates),
    candidateSetFingerprint,
  });
}

function candidateIdentityFingerprint(
  candidate: Pick<
    VerifiedOpenAiAutoExtractCandidate,
    | "sourceId"
    | "itemType"
    | "statement"
    | "statementFingerprint"
    | "sourceExcerpt"
    | "sourceExcerptFingerprint"
    | "sourceStart"
    | "sourceEnd"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceId: candidate.sourceId,
        itemType: candidate.itemType,
        statement: candidate.statement,
        statementFingerprint: candidate.statementFingerprint,
        sourceExcerpt: candidate.sourceExcerpt,
        sourceExcerptFingerprint: candidate.sourceExcerptFingerprint,
        sourceStart: candidate.sourceStart,
        sourceEnd: candidate.sourceEnd,
      }),
      "utf8",
    )
    .digest("hex");
}

function verifyExistingBatch(
  existing: {
    id: string;
    projectId: string;
    aiRunId: string;
    candidateSetFingerprint: string;
    candidateCount: number;
    createdAt: Date;
    claims: readonly AiCandidateClaimView[];
  },
  response: NormalizedVerifiedResponse,
): PersistedAiCandidateBatch {
  if (
    existing.candidateSetFingerprint !== response.candidateSetFingerprint ||
    existing.candidateCount !== response.candidates.length ||
    existing.claims.length !== response.candidates.length
  ) {
    return throwAiCandidateError("AI_CANDIDATE_BATCH_CONFLICT");
  }
  const existingFingerprints = existing.claims
    .map(candidateIdentityFingerprint)
    .sort();
  const responseFingerprints = response.candidates
    .map(candidateIdentityFingerprint)
    .sort();
  if (
    existingFingerprints.some(
      (fingerprint, index) => fingerprint !== responseFingerprints[index],
    )
  ) {
    return throwAiCandidateError("AI_CANDIDATE_BATCH_CONFLICT");
  }
  return Object.freeze({ ...existing, claims: Object.freeze(existing.claims) });
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === code;
  } catch {
    return false;
  }
}

function validateReviewer(value: unknown): string {
  if (typeof value !== "string" || !REVIEWER_PATTERN.test(value)) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  return value;
}

function validateDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  return new Date(value.getTime());
}

function normalizeItemInput(value: AcceptAiCandidateRequest["item"]): {
  type: ProjectItemType;
  title: string;
  content: string;
  occurredAt: Date | null;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.values(ProjectItemType).includes(value.type)
  ) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  const title = safeText(value.title, 160).trim();
  const content = safeText(value.content, 20_000).trim();
  const occurredAt = value.occurredAt ?? null;
  if (occurredAt !== null && (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime()))) {
    return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
  }
  return { type: value.type, title, content, occurredAt };
}

function candidateTitle(statement: string): string {
  const characters = Array.from(statement.trim());
  if (characters.length <= 160) return characters.join("");
  return `${characters.slice(0, 157).join("")}...`;
}

class AiCandidateServiceImpl {
  private readonly db: PrismaClient;
  private readonly now: () => Date;
  private readonly transactionRetryLimit: number;

  constructor(options: CreateAiCandidateServiceOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.db?.$transaction !== "function"
    ) {
      throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    const retryLimit = options.transactionRetryLimit ?? DEFAULT_TRANSACTION_RETRY_LIMIT;
    if (!Number.isSafeInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) {
      throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.transactionRetryLimit = retryLimit;
  }

  private async serializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    allowUniqueRetry = false,
  ): Promise<T> {
    for (let attempt = 0; attempt < this.transactionRetryLimit; attempt += 1) {
      try {
        return await this.db.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable = isPrismaCode(error, "P2034") ||
          (allowUniqueRetry && isPrismaCode(error, "P2002"));
        if (retryable && attempt + 1 < this.transactionRetryLimit) continue;
        if (error instanceof AiCandidateError) throw error;
        if (retryable) return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
        throw error;
      }
    }
    return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
  }

  async persistVerifiedCandidates(
    request: PersistVerifiedAiCandidatesRequest,
  ): Promise<PersistedAiCandidateBatch> {
    if (typeof request !== "object" || request === null) {
      return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    const projectId = validateUuid(request.projectId);
    const aiRunId = validateUuid(request.aiRunId);
    const response = normalizeVerifiedResponse(request.verifiedResponse);

    return this.serializable(
      (tx) => this.persistNormalizedCandidates(tx, projectId, aiRunId, response),
      true,
    );
  }

  async persistVerifiedCandidatesInTransaction(
    tx: Prisma.TransactionClient,
    request: PersistVerifiedAiCandidatesRequest,
  ): Promise<PersistedAiCandidateBatch> {
    if (
      typeof tx !== "object" ||
      tx === null ||
      typeof tx.aiRun?.findUnique !== "function" ||
      typeof request !== "object" ||
      request === null
    ) {
      return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    return this.persistNormalizedCandidates(
      tx,
      validateUuid(request.projectId),
      validateUuid(request.aiRunId),
      normalizeVerifiedResponse(request.verifiedResponse),
    );
  }

  private async persistNormalizedCandidates(
    tx: Prisma.TransactionClient,
    projectId: string,
    aiRunId: string,
    response: NormalizedVerifiedResponse,
  ): Promise<PersistedAiCandidateBatch> {
    const run = await tx.aiRun.findUnique({
      where: { projectId_id: { projectId, id: aiRunId } },
      select: {
        operation: true,
        status: true,
        modelId: true,
        providerResponseId: true,
        inputTokens: true,
        outputTokens: true,
        requestCount: true,
        inputSources: {
          select: {
            sourceId: true,
            contentFingerprint: true,
            contentBytes: true,
            source: { select: { contentText: true } },
          },
        },
        candidateBatch: {
          select: {
            id: true,
            projectId: true,
            aiRunId: true,
            candidateSetFingerprint: true,
            candidateCount: true,
            createdAt: true,
            claims: {
              select: candidateClaimSelect,
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });
    if (run === null) return throwAiCandidateError("AI_CANDIDATE_RUN_NOT_FOUND");
    if (run.operation !== "autoExtract" || run.status !== "succeeded") {
      return throwAiCandidateError("AI_CANDIDATE_RUN_NOT_ELIGIBLE");
    }
    if (
      run.modelId !== response.modelId ||
      run.providerResponseId !== response.providerResponseId ||
      run.inputTokens !== response.inputTokens ||
      run.outputTokens !== response.outputTokens ||
      run.requestCount !== response.requestCount
    ) {
      return throwAiCandidateError("AI_CANDIDATE_RESPONSE_MISMATCH");
    }
    if (run.candidateBatch !== null) {
      return verifyExistingBatch(run.candidateBatch, response);
    }

    const sourceById = new Map(
      run.inputSources.map((input) => [input.sourceId, input]),
    );
    for (const input of run.inputSources) {
      if (
        hashSourceContent(input.source.contentText) !== input.contentFingerprint ||
        Buffer.byteLength(input.source.contentText, "utf8") !== input.contentBytes
      ) {
        return throwAiCandidateError("AI_CANDIDATE_RESPONSE_MISMATCH");
      }
    }
    for (const candidate of response.candidates) {
      const input = sourceById.get(candidate.sourceId);
      if (input === undefined) {
        return throwAiCandidateError("AI_CANDIDATE_RESPONSE_MISMATCH");
      }
      const codeUnitStart = input.source.contentText.indexOf(candidate.sourceExcerpt);
      const sourceStart = codeUnitStart < 0
        ? -1
        : Buffer.byteLength(
            input.source.contentText.slice(0, codeUnitStart),
            "utf8",
          );
      if (
        sourceStart !== candidate.sourceStart ||
        candidate.sourceEnd !==
          sourceStart + Buffer.byteLength(candidate.sourceExcerpt, "utf8")
      ) {
        return throwAiCandidateError("AI_CANDIDATE_RESPONSE_MISMATCH");
      }
    }

    const batchId = randomUUID();
    const publishedAt = this.now();
    if (!Number.isFinite(publishedAt.getTime())) {
      return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    await tx.aiCandidateBatch.create({
      data: {
        id: batchId,
        projectId,
        aiRunId,
        candidateSetFingerprint: response.candidateSetFingerprint,
        candidateCount: response.candidates.length,
        createdAt: publishedAt,
      },
    });
    for (const candidate of response.candidates) {
      const candidateId = randomUUID();
      const projectItemId = randomUUID();
      const source = sourceById.get(candidate.sourceId);
      if (source === undefined) {
        return throwAiCandidateError("AI_CANDIDATE_RESPONSE_MISMATCH");
      }
      const createdItem = await tx.projectItem.create({
        data: {
          id: projectItemId,
          projectId,
          type: candidate.itemType,
          reviewStatus: ProjectItemReviewStatus.candidate,
          sourceId: candidate.sourceId,
          title: candidateTitle(candidate.statement),
          content: candidate.statement,
          sourceExcerpt: candidate.sourceExcerpt,
          occurredAt: null,
          confirmedAt: null,
          metadata: {
            origin: "ai_candidate",
            aiRunId,
            candidateClaimId: candidateId,
            statementFingerprint: candidate.statementFingerprint,
            candidateSetFingerprint: response.candidateSetFingerprint,
          },
          createdAt: publishedAt,
          updatedAt: publishedAt,
        },
      });
      const evidence = await createPrimaryProjectItemEvidence(tx, {
        projectId,
        projectItemId,
        projectSourceId: candidate.sourceId,
        sourceText: source.source.contentText,
        sourceExcerpt: candidate.sourceExcerpt,
        createdAt: publishedAt,
      });
      await appendProjectItemRevision(tx, {
        item: createdItem,
        action: ProjectItemRevisionAction.aiCreated,
        actorId: "ai:model",
        evidences: [evidence],
        createdAt: publishedAt,
      });
      await tx.aiCandidateClaim.create({
        data: {
          id: candidateId,
          projectId,
          batchId,
          aiRunId,
          sourceId: candidate.sourceId,
          itemType: candidate.itemType,
          statement: candidate.statement,
          statementFingerprint: candidate.statementFingerprint,
          sourceExcerpt: candidate.sourceExcerpt,
          sourceExcerptFingerprint: candidate.sourceExcerptFingerprint,
          sourceStart: candidate.sourceStart,
          sourceEnd: candidate.sourceEnd,
          projectItemId,
          createdAt: publishedAt,
        },
      });
    }
    const created = await tx.aiCandidateBatch.findUnique({
      where: { projectId_id: { projectId, id: batchId } },
      select: {
        id: true,
        projectId: true,
        aiRunId: true,
        candidateSetFingerprint: true,
        candidateCount: true,
        createdAt: true,
        claims: {
          select: candidateClaimSelect,
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (created === null) {
      return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
    }
    return verifyExistingBatch(created, response);
  }

  async listCandidates(
    request: ListAiCandidatesRequest,
  ): Promise<readonly AiCandidateClaimView[]> {
    const projectId = validateUuid(request.projectId);
    const take = request.take ?? 100;
    if (!Number.isSafeInteger(take) || take < 1 || take > 100) {
      return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    if (
      request.reviewStatus !== undefined &&
      !Object.values(AiCandidateReviewStatus).includes(request.reviewStatus)
    ) {
      return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
    }
    const claims = await this.db.aiCandidateClaim.findMany({
      where: {
        projectId,
        ...(request.reviewStatus === undefined
          ? {}
          : { reviewStatus: request.reviewStatus }),
      },
      select: candidateClaimSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take,
    });
    return Object.freeze(claims);
  }

  async acceptCandidate(
    request: AcceptAiCandidateRequest,
  ): Promise<AiCandidateClaimView> {
    const projectId = validateUuid(request.projectId);
    const candidateId = validateUuid(request.candidateId);
    const reviewedBy = validateReviewer(request.reviewedBy);
    const expectedItemUpdatedAt = validateDate(request.expectedItemUpdatedAt);
    const itemInput = normalizeItemInput(request.item);

    return this.serializable(async (tx) => {
      const claim = await tx.aiCandidateClaim.findUnique({
        where: { projectId_id: { projectId, id: candidateId } },
        select: {
          id: true,
          aiRunId: true,
          sourceId: true,
          projectItemId: true,
          reviewStatus: true,
          projectItem: {
            select: { reviewStatus: true, updatedAt: true },
          },
        },
      });
      if (claim === null) return throwAiCandidateError("AI_CANDIDATE_NOT_FOUND");
      if (claim.reviewStatus !== AiCandidateReviewStatus.candidate) {
        return throwAiCandidateError("AI_CANDIDATE_ALREADY_REVIEWED");
      }
      if (
        claim.projectItem.reviewStatus !== ProjectItemReviewStatus.candidate ||
        claim.projectItem.updatedAt.getTime() !== expectedItemUpdatedAt.getTime()
      ) {
        return throwAiCandidateError("AI_CANDIDATE_VERSION_CONFLICT");
      }

      const currentTime = this.now();
      if (!Number.isFinite(currentTime.getTime())) {
        return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
      }
      const reviewedAt = new Date(Math.max(
        currentTime.getTime(),
        claim.projectItem.updatedAt.getTime() + 1,
      ));
      const evidence = await tx.projectItemEvidence.findFirst({
        where: {
          projectId,
          projectItemId: claim.projectItemId,
          role: "primary",
          evidenceState: "active",
          isActive: true,
        },
        select: {
          id: true,
          role: true,
          projectSourceId: true,
          sourceExcerpt: true,
          sourceExcerptFingerprint: true,
          rangeStart: true,
          rangeEnd: true,
        },
      });
      if (evidence === null) {
        return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
      }
      const confirmed = await tx.projectItem.updateMany({
        where: {
          projectId,
          id: claim.projectItemId,
          reviewStatus: ProjectItemReviewStatus.candidate,
          updatedAt: expectedItemUpdatedAt,
        },
        data: {
          type: itemInput.type,
          title: itemInput.title,
          content: itemInput.content,
          occurredAt: itemInput.occurredAt,
          reviewStatus: ProjectItemReviewStatus.confirmed,
          confirmedAt: reviewedAt,
          updatedAt: reviewedAt,
        },
      });
      if (confirmed.count !== 1) {
        return throwAiCandidateError("AI_CANDIDATE_VERSION_CONFLICT");
      }
      const confirmedItem = await tx.projectItem.findUnique({
        where: { projectId_id: { projectId, id: claim.projectItemId } },
      });
      if (confirmedItem === null) {
        return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
      }
      await appendProjectItemRevision(tx, {
        item: confirmedItem,
        action: ProjectItemRevisionAction.confirmed,
        actorId: reviewedBy,
        evidences: [evidence],
        createdAt: reviewedAt,
      });
      const updated = await tx.aiCandidateClaim.updateMany({
        where: {
          projectId,
          id: candidateId,
          reviewStatus: AiCandidateReviewStatus.candidate,
        },
        data: {
          reviewStatus: AiCandidateReviewStatus.accepted,
          reviewedAt,
          reviewedBy,
        },
      });
      if (updated.count !== 1) {
        return throwAiCandidateError("AI_CANDIDATE_ALREADY_REVIEWED");
      }
      const result = await tx.aiCandidateClaim.findUnique({
        where: { projectId_id: { projectId, id: candidateId } },
        select: candidateClaimSelect,
      });
      if (result === null) return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
      return result;
    });
  }

  async dismissCandidate(
    request: DismissAiCandidateRequest,
  ): Promise<AiCandidateClaimView> {
    const projectId = validateUuid(request.projectId);
    const candidateId = validateUuid(request.candidateId);
    const reviewedBy = validateReviewer(request.reviewedBy);
    const expectedItemUpdatedAt = validateDate(request.expectedItemUpdatedAt);

    return this.serializable(async (tx) => {
      const existing = await tx.aiCandidateClaim.findUnique({
        where: { projectId_id: { projectId, id: candidateId } },
        select: {
          reviewStatus: true,
          projectItemId: true,
          projectItem: {
            select: { reviewStatus: true, updatedAt: true },
          },
        },
      });
      if (existing === null) return throwAiCandidateError("AI_CANDIDATE_NOT_FOUND");
      if (existing.reviewStatus !== AiCandidateReviewStatus.candidate) {
        return throwAiCandidateError("AI_CANDIDATE_ALREADY_REVIEWED");
      }
      if (
        existing.projectItem.reviewStatus !== ProjectItemReviewStatus.candidate ||
        existing.projectItem.updatedAt.getTime() !== expectedItemUpdatedAt.getTime()
      ) {
        return throwAiCandidateError("AI_CANDIDATE_VERSION_CONFLICT");
      }
      const currentTime = this.now();
      if (!Number.isFinite(currentTime.getTime())) {
        return throwAiCandidateError("AI_CANDIDATE_INVALID_INPUT");
      }
      const reviewedAt = new Date(Math.max(
        currentTime.getTime(),
        existing.projectItem.updatedAt.getTime() + 1,
      ));
      const evidence = await tx.projectItemEvidence.findFirst({
        where: {
          projectId,
          projectItemId: existing.projectItemId,
          role: "primary",
          evidenceState: "active",
          isActive: true,
        },
        select: {
          id: true,
          role: true,
          projectSourceId: true,
          sourceExcerpt: true,
          sourceExcerptFingerprint: true,
          rangeStart: true,
          rangeEnd: true,
        },
      });
      if (evidence === null) {
        return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
      }
      const dismissed = await tx.projectItem.updateMany({
        where: {
          projectId,
          id: existing.projectItemId,
          reviewStatus: ProjectItemReviewStatus.candidate,
          updatedAt: expectedItemUpdatedAt,
        },
        data: {
          reviewStatus: ProjectItemReviewStatus.dismissed,
          confirmedAt: null,
          updatedAt: reviewedAt,
        },
      });
      if (dismissed.count !== 1) {
        return throwAiCandidateError("AI_CANDIDATE_VERSION_CONFLICT");
      }
      const dismissedItem = await tx.projectItem.findUnique({
        where: { projectId_id: { projectId, id: existing.projectItemId } },
      });
      if (dismissedItem === null) {
        return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
      }
      await appendProjectItemRevision(tx, {
        item: dismissedItem,
        action: ProjectItemRevisionAction.dismissed,
        actorId: reviewedBy,
        evidences: [evidence],
        createdAt: reviewedAt,
      });
      const updated = await tx.aiCandidateClaim.updateMany({
        where: {
          projectId,
          id: candidateId,
          reviewStatus: AiCandidateReviewStatus.candidate,
        },
        data: {
          reviewStatus: AiCandidateReviewStatus.dismissed,
          reviewedAt,
          reviewedBy,
        },
      });
      if (updated.count !== 1) {
        return throwAiCandidateError("AI_CANDIDATE_ALREADY_REVIEWED");
      }
      const result = await tx.aiCandidateClaim.findUnique({
        where: { projectId_id: { projectId, id: candidateId } },
        select: candidateClaimSelect,
      });
      if (result === null) return throwAiCandidateError("AI_CANDIDATE_WRITE_CONFLICT");
      return result;
    });
  }
}

export function createAiCandidateService(
  options: CreateAiCandidateServiceOptions,
): Pick<
  AiCandidateServiceImpl,
  | "persistVerifiedCandidates"
  | "persistVerifiedCandidatesInTransaction"
  | "listCandidates"
  | "acceptCandidate"
  | "dismissCandidate"
> {
  return new AiCandidateServiceImpl(options);
}
