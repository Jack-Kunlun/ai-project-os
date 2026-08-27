import { createHash } from "node:crypto";
import { throwAiRuntimeServiceError } from "./errors";

export const EVIDENCE_MANIFEST_SCHEMA_VERSION = "ai-evidence-manifest:v1" as const;
export const INPUT_MANIFEST_SCHEMA_VERSION = "ai-input-manifest:v1" as const;

export interface EvidenceManifestEntry {
  sourceId: string;
  contentFingerprint: string;
  contentBytes: number;
  scannerVersion: string;
}

export interface InputManifestEntry extends EvidenceManifestEntry {
  evidenceManifestFingerprint: string;
}

export type InputManifest = readonly InputManifestEntry[];

const EVIDENCE_ENTRY_FIELDS = [
  "sourceId",
  "contentFingerprint",
  "contentBytes",
  "scannerVersion",
] as const;
const INPUT_ENTRY_FIELDS = [...EVIDENCE_ENTRY_FIELDS, "evidenceManifestFingerprint"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SCANNER_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const SECRET_OR_URL_PATTERN = /(https?:\/\/|api[-_]?key|bearer|password|secret|token|sk-)/i;

function invalidManifest(): never {
  return throwAiRuntimeServiceError("AI_INVALID_OPERATION_KEY_INPUT");
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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort();
    const canonicalExpected = [...expected].sort();
    return (
      actual.length === canonicalExpected.length &&
      actual.every((key, index) => key === canonicalExpected[index])
    );
  } catch {
    return false;
  }
}

function assertSafeText(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    /\s/u.test(value) ||
    SECRET_OR_URL_PATTERN.test(value)
  ) {
    invalidManifest();
  }
}

function canonicalUuid(value: unknown): string {
  assertSafeText(value);
  if (!UUID_PATTERN.test(value) || value !== value.toLowerCase()) {
    invalidManifest();
  }
  return value;
}

function canonicalFingerprint(value: unknown): string {
  assertSafeText(value);
  if (!FINGERPRINT_PATTERN.test(value)) {
    invalidManifest();
  }
  return value;
}

function canonicalScannerVersion(value: unknown): string {
  assertSafeText(value);
  if (!SCANNER_VERSION_PATTERN.test(value)) {
    invalidManifest();
  }
  return value;
}

function canonicalBytes(value: unknown): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || (value as number) < 0) {
    invalidManifest();
  }
  return value as number;
}

function canonicalEvidenceEntry(value: unknown): EvidenceManifestEntry {
  if (!isPlainRecord(value) || !hasExactKeys(value, EVIDENCE_ENTRY_FIELDS)) {
    invalidManifest();
  }
  return {
    sourceId: canonicalUuid(value.sourceId),
    contentFingerprint: canonicalFingerprint(value.contentFingerprint),
    contentBytes: canonicalBytes(value.contentBytes),
    scannerVersion: canonicalScannerVersion(value.scannerVersion),
  };
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalInputEntry(value: unknown): InputManifestEntry {
  if (!isPlainRecord(value) || !hasExactKeys(value, INPUT_ENTRY_FIELDS)) {
    invalidManifest();
  }
  const entry = canonicalEvidenceEntry({
    sourceId: value.sourceId,
    contentFingerprint: value.contentFingerprint,
    contentBytes: value.contentBytes,
    scannerVersion: value.scannerVersion,
  });
  const evidenceManifestFingerprint = canonicalFingerprint(value.evidenceManifestFingerprint);
  if (evidenceManifestFingerprint !== buildEvidenceManifestFingerprint(entry)) {
    invalidManifest();
  }
  return { ...entry, evidenceManifestFingerprint };
}

function sortAndRejectDuplicateSources<T extends EvidenceManifestEntry>(
  entries: readonly T[],
): T[] {
  const sorted = [...entries].sort((left, right) =>
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.sourceId === sorted[index]?.sourceId) {
      invalidManifest();
    }
  }
  return sorted;
}

function canonicalInputManifest(value: unknown): InputManifest {
  if (!Array.isArray(value) || value.length === 0) {
    invalidManifest();
  }
  return Object.freeze(
    sortAndRejectDuplicateSources(value.map((entry) => canonicalInputEntry(entry))).map((entry) =>
      Object.freeze(entry),
    ),
  );
}

export function normalizeInputManifest(value: unknown): InputManifest {
  return canonicalInputManifest(value);
}

/** Validates and returns one safe source evidence entry. */
export function validateEvidenceManifestEntry(value: unknown): EvidenceManifestEntry {
  return canonicalEvidenceEntry(value);
}

/** Builds a versioned fingerprint over one source's safe evidence metadata. */
export function buildEvidenceManifestFingerprint(value: unknown): string {
  const entry = canonicalEvidenceEntry(value);
  return hashCanonical({
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    sourceId: entry.sourceId,
    contentFingerprint: entry.contentFingerprint,
    contentBytes: entry.contentBytes,
    scannerVersion: entry.scannerVersion,
  });
}

/** Builds a sorted, immutable input manifest containing source evidence hashes. */
export function buildInputManifest(value: unknown): InputManifest {
  if (!Array.isArray(value) || value.length === 0) {
    invalidManifest();
  }
  const entries = sortAndRejectDuplicateSources(value.map((entry) => canonicalEvidenceEntry(entry)));
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        ...entry,
        evidenceManifestFingerprint: buildEvidenceManifestFingerprint(entry),
      }),
    ),
  );
}

/** Fingerprints the complete sorted manifest, including every source field. */
export function buildInputManifestFingerprint(value: unknown): string {
  const manifest = canonicalInputManifest(value);
  return hashCanonical({
    schemaVersion: INPUT_MANIFEST_SCHEMA_VERSION,
    sources: manifest,
  });
}

/** Sums manifest bytes with safe-integer overflow protection. */
export function sumInputBytes(value: unknown): number {
  const manifest = canonicalInputManifest(value);
  let total = 0;
  for (const entry of manifest) {
    if (total > Number.MAX_SAFE_INTEGER - entry.contentBytes) {
      invalidManifest();
    }
    total += entry.contentBytes;
  }
  return total;
}

/** Compares canonical manifests while ignoring only source ordering. */
export function inputManifestsEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(canonicalInputManifest(left)) === JSON.stringify(canonicalInputManifest(right));
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "AI_INVALID_OPERATION_KEY_INPUT") {
      return false;
    }
    throw error;
  }
}

/** Asserts exact canonical equality for a persisted manifest and its children. */
export function assertExactInputManifest(expected: unknown, actual: unknown): void {
  if (!inputManifestsEqual(expected, actual)) {
    invalidManifest();
  }
}

export const areInputManifestsEqual = inputManifestsEqual;
export const assertInputManifestEqual = assertExactInputManifest;
