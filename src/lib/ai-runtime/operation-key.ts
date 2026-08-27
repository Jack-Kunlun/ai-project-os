import { createHash } from "node:crypto";
import {
  AI_OPERATIONS,
  NO_RAG_SNAPSHOT_MARKER,
  OPERATION_KEY_SCHEMA_VERSION,
  type AiOperation,
  type OperationKeyInput,
  type OperationKeySource,
} from "./types";

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@-]+$/;
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SECRET_OR_URL_PATTERN = /(https?:\/\/|api[-_]?key|bearer|password|secret|token|sk-)/i;
const OPERATION_KEY_FIELDS = [
  "schemaVersion",
  "projectId",
  "operation",
  "sourceManifest",
  "promptFingerprint",
  "promptVersion",
  "profileFingerprint",
  "providerFingerprint",
  "modelId",
  "modelFingerprint",
  "grantFingerprint",
  "effectivePolicyVersion",
  "processorFingerprint",
  "processorEndpointFingerprint",
  "processorRegionFingerprint",
  "processorRetentionFingerprint",
  "noRagSnapshotMarker",
] as const;

const SOURCE_FIELDS = [
  "sourceId",
  "contentFingerprint",
  "contentBytes",
  "evidenceManifestFingerprint",
] as const;

export class AiRuntimeContractError extends Error {
  readonly code = "AI_INVALID_OPERATION_KEY_INPUT" as const;

  constructor() {
    super("AI_INVALID_OPERATION_KEY_INPUT");
    this.name = "AiRuntimeContractError";
  }
}

function fail(): never {
  throw new AiRuntimeContractError();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail();
  }
}

function assertCanonicalText(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /\s/u.test(value)
  ) {
    fail();
  }
}

function canonicalUuid(value: unknown): string {
  assertCanonicalText(value);
  if (!UUID_PATTERN.test(value) || value !== value.toLowerCase()) {
    fail();
  }
  return value;
}

function canonicalFingerprint(value: unknown): string {
  if (typeof value !== "string" || value.normalize("NFC") !== value) {
    fail();
  }
  if (!FINGERPRINT_PATTERN.test(value)) {
    fail();
  }
  return value;
}

function assertNonNegativeSafeInteger(value: unknown): asserts value is number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || (value as number) < 0) {
    fail();
  }
}

function assertPositiveSafeInteger(value: unknown): asserts value is number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || (value as number) <= 0) {
    fail();
  }
}

function canonicalOperation(value: unknown): AiOperation {
  assertCanonicalText(value);
  if (!(AI_OPERATIONS as readonly string[]).includes(value)) {
    fail();
  }
  return value as AiOperation;
}

function canonicalModelId(value: unknown): string {
  assertCanonicalText(value);
  if (
    value.length > 128 ||
    !MODEL_ID_PATTERN.test(value) ||
    SECRET_OR_URL_PATTERN.test(value) ||
    /(^|[/:@_-])latest($|[/:@_-])/i.test(value)
  ) {
    fail();
  }
  return value;
}

function canonicalSource(value: unknown): OperationKeySource {
  if (!isPlainRecord(value)) {
    fail();
  }
  assertExactKeys(value, SOURCE_FIELDS);
  return {
    sourceId: canonicalUuid(value.sourceId),
    contentFingerprint: canonicalFingerprint(value.contentFingerprint),
    contentBytes: (() => {
      assertNonNegativeSafeInteger(value.contentBytes);
      return value.contentBytes;
    })(),
    evidenceManifestFingerprint: canonicalFingerprint(value.evidenceManifestFingerprint),
  };
}

function canonicalInput(value: unknown): OperationKeyInput {
  if (!isPlainRecord(value)) {
    fail();
  }
  assertExactKeys(value, OPERATION_KEY_FIELDS);

  if (value.schemaVersion !== OPERATION_KEY_SCHEMA_VERSION) {
    fail();
  }
  if (value.noRagSnapshotMarker !== NO_RAG_SNAPSHOT_MARKER) {
    fail();
  }
  if (!Array.isArray(value.sourceManifest) || value.sourceManifest.length === 0) {
    fail();
  }

  const sourceManifest = Array.from(value.sourceManifest, (entry) => canonicalSource(entry));
  const sourceIds = new Set(sourceManifest.map((source) => source.sourceId));
  if (sourceIds.size !== sourceManifest.length) {
    fail();
  }

  assertCanonicalText(value.promptVersion);
  if (!VERSION_PATTERN.test(value.promptVersion)) {
    fail();
  }
  assertPositiveSafeInteger(value.effectivePolicyVersion);

  return {
    schemaVersion: OPERATION_KEY_SCHEMA_VERSION,
    projectId: canonicalUuid(value.projectId),
    operation: canonicalOperation(value.operation),
    sourceManifest: sourceManifest.sort((left, right) =>
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
    ),
    promptFingerprint: canonicalFingerprint(value.promptFingerprint),
    promptVersion: value.promptVersion,
    profileFingerprint: canonicalFingerprint(value.profileFingerprint),
    providerFingerprint: canonicalFingerprint(value.providerFingerprint),
    modelId: canonicalModelId(value.modelId),
    modelFingerprint: canonicalFingerprint(value.modelFingerprint),
    grantFingerprint: canonicalFingerprint(value.grantFingerprint),
    effectivePolicyVersion: value.effectivePolicyVersion,
    processorFingerprint: canonicalFingerprint(value.processorFingerprint),
    processorEndpointFingerprint: canonicalFingerprint(value.processorEndpointFingerprint),
    processorRegionFingerprint: canonicalFingerprint(value.processorRegionFingerprint),
    processorRetentionFingerprint: canonicalFingerprint(value.processorRetentionFingerprint),
    noRagSnapshotMarker: NO_RAG_SNAPSHOT_MARKER,
  };
}

/**
 * Returns the canonical, non-sensitive operation manifest used as the hash input.
 * Only canonical UUIDs, fingerprints, versions, operation and counts are
 * accepted; endpoint URLs and source/prompt bodies are not representable here.
 */
export function serializeOperationKeyInput(value: unknown): string {
  return JSON.stringify(canonicalInput(value));
}

export function buildOperationKey(value: unknown): string {
  return createHash("sha256").update(serializeOperationKeyInput(value), "utf8").digest("hex");
}
