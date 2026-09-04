import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  ACCESS_ACTOR_LOCK_NAMESPACE,
  ACCESS_PROJECT_LOCK_NAMESPACE,
  ACCESS_WORKSPACE_LOCK_NAMESPACE,
} from "./access-linearization";
import {
  membershipFingerprint,
  membershipManifestFingerprint,
} from "./membership-governance";

export const MEMBERSHIP_GOVERNANCE_MANIFEST_KIND = "membership-governance-manifest" as const;
export const MEMBERSHIP_GOVERNANCE_APPROVAL_KIND = "membership-governance-approval" as const;
export const MEMBERSHIP_GOVERNANCE_MANIFEST_VERSION = 1 as const;
export const MEMBERSHIP_GOVERNANCE_MANIFEST_COVERAGE = "all_pending" as const;
export const MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV =
  "MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_JSON" as const;
export const MEMBERSHIP_GOVERNANCE_APPLY_DATABASE_URL_ENV =
  "MEMBERSHIP_GOVERNANCE_APPLY_DATABASE_URL" as const;
export const MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL_ENV =
  "MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL" as const;
export const MEMBERSHIP_GOVERNANCE_MANIFEST_LOCK_NAMESPACE = 29082031;
export const MEMBERSHIP_GOVERNANCE_MEMBERSHIP_LOCK_NAMESPACE = 29082032;

export const MEMBERSHIP_GOVERNANCE_MAX_MANIFEST_BYTES = 512 * 1024;
export const MEMBERSHIP_GOVERNANCE_MAX_APPROVAL_BYTES = 16 * 1024;
export const MEMBERSHIP_GOVERNANCE_MAX_ITEMS = 10_000;
export const MEMBERSHIP_GOVERNANCE_MAX_SIGNERS = 128;
const MEMBERSHIP_GOVERNANCE_MAX_DISCOVERY_RETRIES = 2;
const MEMBERSHIP_GOVERNANCE_LOCK_TIMEOUT = "15000ms";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const SIGNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WORKSPACE_ROLES = new Set(["owner", "admin", "member", "viewer"]);
const PROJECT_ROLES = new Set(["owner", "editor", "viewer"]);

export type MembershipGovernanceManifestMembershipKind = "workspace" | "project";
export type MembershipGovernanceManifestDecision = "confirm" | "revoke";

export interface MembershipGovernanceManifestItem {
  readonly membershipKind: MembershipGovernanceManifestMembershipKind;
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly userId: string;
  readonly expectedRole: string;
  readonly expectedAccessState: "pending";
  readonly expectedMembershipFingerprint: string;
  readonly decision: MembershipGovernanceManifestDecision;
}

export interface MembershipGovernanceManifest {
  readonly kind: typeof MEMBERSHIP_GOVERNANCE_MANIFEST_KIND;
  readonly version: typeof MEMBERSHIP_GOVERNANCE_MANIFEST_VERSION;
  readonly executionNonce: string;
  readonly expectedInventoryFingerprint: string;
  readonly expiresAt: string;
  readonly reason: string;
  readonly coverage: typeof MEMBERSHIP_GOVERNANCE_MANIFEST_COVERAGE;
  readonly items: readonly MembershipGovernanceManifestItem[];
}

export interface MembershipGovernanceApproval {
  readonly kind: typeof MEMBERSHIP_GOVERNANCE_APPROVAL_KIND;
  readonly version: typeof MEMBERSHIP_GOVERNANCE_MANIFEST_VERSION;
  readonly signerId: string;
  readonly signature: string;
}

export interface VerifiedMembershipGovernanceApproval {
  readonly signerId: string;
  readonly publicKeyFingerprint: string;
  readonly signatureFingerprint: string;
  readonly publicKeyDer: Buffer;
  readonly signature: Buffer;
  readonly verifiedAt: Date;
}

export interface TrustedMembershipGovernanceSigner {
  readonly signerId: string;
  readonly publicKey: KeyObject;
  readonly publicKeyFingerprint: string;
  readonly publicKeyDer: Buffer;
}

export type MembershipGovernanceManifestErrorCode =
  | "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID"
  | "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID"
  | "MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID"
  | "MEMBERSHIP_GOVERNANCE_SIGNATURE_INVALID"
  | "MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED"
  | "MEMBERSHIP_GOVERNANCE_FILE_INVALID"
  | "MEMBERSHIP_GOVERNANCE_DATABASE_URL_REQUIRED"
  | "MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL_REQUIRED"
  | "MEMBERSHIP_GOVERNANCE_MANIFEST_EXPIRED"
  | "MEMBERSHIP_GOVERNANCE_ALREADY_APPLIED"
  | "MEMBERSHIP_GOVERNANCE_NONCE_CONFLICT"
  | "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH"
  | "MEMBERSHIP_GOVERNANCE_PENDING_SET_MISMATCH"
  | "MEMBERSHIP_GOVERNANCE_OWNER_LOCKOUT"
  | "MEMBERSHIP_GOVERNANCE_APPLY_CONFLICT"
  | "MEMBERSHIP_GOVERNANCE_APPLY_FAILED";

export class MembershipGovernanceManifestError extends Error {
  readonly code: MembershipGovernanceManifestErrorCode;

  constructor(code: MembershipGovernanceManifestErrorCode, message: string = code) {
    super(message);
    this.name = "MembershipGovernanceManifestError";
    this.code = code;
  }
}

function fail(code: MembershipGovernanceManifestErrorCode, message: string = code): never {
  throw new MembershipGovernanceManifestError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: MembershipGovernanceManifestErrorCode): void {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    fail(code, "manifest contains unknown or missing fields");
  }
}

function stringValue(value: unknown, code: MembershipGovernanceManifestErrorCode, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(code, "manifest string field is invalid");
  }
  return value;
}

function uuidValue(value: unknown, code: MembershipGovernanceManifestErrorCode): string {
  const candidate = stringValue(value, code, 36);
  if (!UUID_PATTERN.test(candidate)) fail(code, "manifest UUID field is invalid");
  return candidate.toLowerCase();
}

function fingerprintValue(value: unknown, code: MembershipGovernanceManifestErrorCode): string {
  const candidate = stringValue(value, code, 64).toLowerCase();
  if (!FINGERPRINT_PATTERN.test(candidate)) fail(code, "manifest fingerprint field is invalid");
  return candidate;
}

function dateValue(value: unknown): string {
  const candidate = stringValue(value, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", 24);
  if (!ISO_UTC_PATTERN.test(candidate)) fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "expiresAt must be canonical UTC ISO-8601");
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== candidate) {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "expiresAt is not a valid UTC timestamp");
  }
  return candidate;
}

function reasonValue(value: unknown): string {
  const candidate = stringValue(value, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", 500);
  if (candidate.trim() !== candidate) fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "reason must not have surrounding whitespace");
  return candidate;
}

function compareItems(left: Pick<MembershipGovernanceManifestItem, "membershipKind" | "membershipId">, right: Pick<MembershipGovernanceManifestItem, "membershipKind" | "membershipId">): number {
  if (left.membershipKind !== right.membershipKind) return left.membershipKind < right.membershipKind ? -1 : 1;
  if (left.membershipId === right.membershipId) return 0;
  return left.membershipId < right.membershipId ? -1 : 1;
}

function parseManifestItem(value: unknown): MembershipGovernanceManifestItem {
  if (!isRecord(value)) fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "manifest item must be an object");
  exactKeys(value, [
    "membershipKind",
    "membershipId",
    "workspaceId",
    "projectId",
    "userId",
    "expectedRole",
    "expectedAccessState",
    "expectedMembershipFingerprint",
    "decision",
  ], "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID");
  const membershipKind = value.membershipKind;
  if (membershipKind !== "workspace" && membershipKind !== "project") {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "membershipKind is invalid");
  }
  const membershipId = uuidValue(value.membershipId, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID");
  const workspaceId = uuidValue(value.workspaceId, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID");
  const projectId = value.projectId === null
    ? null
    : uuidValue(value.projectId, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID");
  if (membershipKind === "workspace" && projectId !== null) {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "workspace items must have projectId=null");
  }
  if (membershipKind === "project" && projectId === null) {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "project items must have a projectId");
  }
  const userId = uuidValue(value.userId, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID");
  const expectedRole = stringValue(value.expectedRole, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", 16);
  const validRoles = membershipKind === "workspace" ? WORKSPACE_ROLES : PROJECT_ROLES;
  if (!validRoles.has(expectedRole)) fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "expectedRole is invalid");
  if (value.expectedAccessState !== "pending") {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "expectedAccessState must be pending");
  }
  const expectedMembershipFingerprint = fingerprintValue(
    value.expectedMembershipFingerprint,
    "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID",
  );
  if (value.decision !== "confirm" && value.decision !== "revoke") {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "decision is invalid");
  }
  return Object.freeze({
    membershipKind,
    membershipId,
    workspaceId,
    projectId,
    userId,
    expectedRole,
    expectedAccessState: "pending",
    expectedMembershipFingerprint,
    decision: value.decision,
  });
}

function parseJsonWithUniqueObjectKeys(text: string, code: MembershipGovernanceManifestErrorCode): unknown {
  let index = 0;
  const length = text.length;
  const whitespace = () => {
    while (index < length && /\s/u.test(text[index] ?? "")) index += 1;
  };
  const parseString = (): void => {
    if (text[index] !== '"') fail(code, "invalid JSON string");
    index += 1;
    while (index < length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return;
      }
      if (character === "\\") {
        index += 1;
        if (index >= length) fail(code, "invalid JSON escape");
        if (text[index] === "u") {
          if (!/^[0-9a-f]{4}$/iu.test(text.slice(index + 1, index + 5))) fail(code, "invalid JSON unicode escape");
          index += 5;
        } else {
          index += 1;
        }
        continue;
      }
      if (character !== undefined && character < " ") fail(code, "invalid JSON control character");
      index += 1;
    }
    fail(code, "unterminated JSON string");
  };
  const parseValue = (): void => {
    whitespace();
    const character = text[index];
    if (character === '"') {
      parseString();
      return;
    }
    if (character === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < length) {
        whitespace();
        const start = index;
        parseString();
        let key: string;
        try {
          key = JSON.parse(text.slice(start, index)) as string;
        } catch {
          fail(code, "invalid JSON object key");
        }
        if (keys.has(key)) fail(code, "duplicate JSON object key");
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail(code, "JSON object key must be followed by colon");
        index += 1;
        parseValue();
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(code, "JSON object requires comma");
        index += 1;
      }
      fail(code, "unterminated JSON object");
    }
    if (character === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < length) {
        parseValue();
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(code, "JSON array requires comma");
        index += 1;
      }
      fail(code, "unterminated JSON array");
    }
    if (character !== undefined && /[-0-9]/u.test(character)) {
      const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
      if (match === null) fail(code, "invalid JSON number");
      index += match[0].length;
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    fail(code, "invalid JSON value");
  };
  parseValue();
  whitespace();
  if (index !== length) fail(code, "trailing JSON content");
  try {
    return JSON.parse(text);
  } catch {
    fail(code, "invalid JSON document");
  }
}

export function parseMembershipGovernanceManifestText(text: string): MembershipGovernanceManifest {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MEMBERSHIP_GOVERNANCE_MAX_MANIFEST_BYTES) {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "manifest exceeds the size limit");
  }
  const value = parseJsonWithUniqueObjectKeys(text, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID");
  if (!isRecord(value)) fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "manifest must be an object");
  exactKeys(value, [
    "kind",
    "version",
    "executionNonce",
    "expectedInventoryFingerprint",
    "expiresAt",
    "reason",
    "coverage",
    "items",
  ], "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID");
  if (value.kind !== MEMBERSHIP_GOVERNANCE_MANIFEST_KIND || value.version !== MEMBERSHIP_GOVERNANCE_MANIFEST_VERSION) {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "manifest kind or version is invalid");
  }
  if (value.coverage !== MEMBERSHIP_GOVERNANCE_MANIFEST_COVERAGE) {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "manifest coverage is invalid");
  }
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MEMBERSHIP_GOVERNANCE_MAX_ITEMS) {
    fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "manifest items must be non-empty and bounded");
  }
  const items = value.items.map(parseManifestItem);
  for (let index = 1; index < items.length; index += 1) {
    if (compareItems(items[index - 1]!, items[index]!) >= 0) {
      fail("MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID", "manifest items must be unique and sorted");
    }
  }
  return Object.freeze({
    kind: MEMBERSHIP_GOVERNANCE_MANIFEST_KIND,
    version: MEMBERSHIP_GOVERNANCE_MANIFEST_VERSION,
    executionNonce: uuidValue(value.executionNonce, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID"),
    expectedInventoryFingerprint: fingerprintValue(value.expectedInventoryFingerprint, "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID"),
    expiresAt: dateValue(value.expiresAt),
    reason: reasonValue(value.reason),
    coverage: MEMBERSHIP_GOVERNANCE_MANIFEST_COVERAGE,
    items: Object.freeze(items),
  });
}

export function canonicalMembershipGovernanceManifest(manifest: MembershipGovernanceManifest): string {
  // Property order is part of the v1 protocol.  The parser normalizes UUIDs
  // and fingerprints and rejects unsorted items before this function is used.
  return JSON.stringify({
    kind: MEMBERSHIP_GOVERNANCE_MANIFEST_KIND,
    version: MEMBERSHIP_GOVERNANCE_MANIFEST_VERSION,
    executionNonce: manifest.executionNonce,
    expectedInventoryFingerprint: manifest.expectedInventoryFingerprint,
    expiresAt: manifest.expiresAt,
    reason: manifest.reason,
    coverage: MEMBERSHIP_GOVERNANCE_MANIFEST_COVERAGE,
    items: manifest.items.map((item) => ({
      membershipKind: item.membershipKind,
      membershipId: item.membershipId,
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      userId: item.userId,
      expectedRole: item.expectedRole,
      expectedAccessState: "pending",
      expectedMembershipFingerprint: item.expectedMembershipFingerprint,
      decision: item.decision,
    })),
  });
}

export function membershipGovernanceManifestFingerprint(manifest: MembershipGovernanceManifest): string {
  return sha256Hex(canonicalMembershipGovernanceManifest(manifest));
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64Value(value: unknown, code: MembershipGovernanceManifestErrorCode): Buffer {
  const candidate = stringValue(value, code, 4096);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(candidate) || candidate.length % 4 !== 0) {
    fail(code, "signature must be canonical base64");
  }
  const bytes = Buffer.from(candidate, "base64");
  if (bytes.toString("base64") !== candidate) fail(code, "signature must be canonical base64");
  return bytes;
}

export function parseMembershipGovernanceApprovalText(text: string): MembershipGovernanceApproval {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MEMBERSHIP_GOVERNANCE_MAX_APPROVAL_BYTES) {
    fail("MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", "approval exceeds the size limit");
  }
  const value = parseJsonWithUniqueObjectKeys(text, "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID");
  if (!isRecord(value)) fail("MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", "approval must be an object");
  exactKeys(value, ["kind", "version", "signerId", "signature"], "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID");
  if (value.kind !== MEMBERSHIP_GOVERNANCE_APPROVAL_KIND || value.version !== MEMBERSHIP_GOVERNANCE_MANIFEST_VERSION) {
    fail("MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", "approval kind or version is invalid");
  }
  const signerId = stringValue(value.signerId, "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", 128);
  if (!SIGNER_ID_PATTERN.test(signerId)) fail("MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", "signerId is invalid");
  const signature = stringValue(value.signature, "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", 4096);
  const bytes = base64Value(signature, "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID");
  if (bytes.length !== 64) fail("MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", "Ed25519 signature must be 64 bytes");
  return Object.freeze({
    kind: MEMBERSHIP_GOVERNANCE_APPROVAL_KIND,
    version: MEMBERSHIP_GOVERNANCE_MANIFEST_VERSION,
    signerId,
    signature,
  });
}

export function parseTrustedMembershipGovernanceSignerRegistry(text: string): ReadonlyMap<string, TrustedMembershipGovernanceSigner> {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 256 * 1024) {
    fail("MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID", "trusted signer registry exceeds the size limit");
  }
  const value = parseJsonWithUniqueObjectKeys(text, "MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID");
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).length > MEMBERSHIP_GOVERNANCE_MAX_SIGNERS) {
    fail("MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID", "trusted signer registry must be a bounded object");
  }
  const registry = new Map<string, TrustedMembershipGovernanceSigner>();
  for (const [signerId, pem] of Object.entries(value)) {
    if (!SIGNER_ID_PATTERN.test(signerId) || typeof pem !== "string" || pem.length < 32 || pem.length > 8192) {
      fail("MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID", "trusted signer entry is invalid");
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: pem, format: "pem", type: "spki" });
    } catch {
      fail("MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID", "trusted signer key is invalid");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      fail("MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID", "trusted signer key must be Ed25519");
    }
    const der = publicKey.export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(der)) fail("MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID", "trusted signer key export failed");
    const publicKeyDer = Buffer.from(der);
    registry.set(signerId, Object.freeze({
      signerId,
      publicKey,
      publicKeyFingerprint: sha256Hex(publicKeyDer),
      publicKeyDer,
    }));
  }
  return registry;
}

/**
 * Hash the complete normalized trusted registry, including signer IDs and
 * their non-secret Ed25519 SPKI DER bytes.  Registry JSON property order and
 * PEM whitespace therefore cannot create an ambiguous evidence record.
 */
export function membershipGovernanceTrustedSignerRegistryFingerprint(
  registry: ReadonlyMap<string, TrustedMembershipGovernanceSigner>,
): string {
  const entries = [...registry.values()]
    .map((signer) => ({
      signerId: signer.signerId,
      publicKeyDer: Buffer.from(signer.publicKeyDer).toString("base64"),
    }))
    .sort((left, right) => left.signerId < right.signerId ? -1 : left.signerId > right.signerId ? 1 : 0);
  return sha256Hex(JSON.stringify(entries));
}

export function verifyMembershipGovernanceApprovals(
  manifest: MembershipGovernanceManifest,
  approvals: readonly MembershipGovernanceApproval[],
  registry: ReadonlyMap<string, TrustedMembershipGovernanceSigner>,
  verifiedAt = new Date(),
): readonly VerifiedMembershipGovernanceApproval[] {
  if (!Array.isArray(approvals)) {
    fail("MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", "approvals must be an array");
  }
  if (approvals.length < 2) fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED", "at least two approvals are required");
  if (approvals.length > MEMBERSHIP_GOVERNANCE_MAX_SIGNERS) {
    fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED", "approval count exceeds the signer limit");
  }
  const payload = Buffer.from(canonicalMembershipGovernanceManifest(manifest), "utf8");
  const result: VerifiedMembershipGovernanceApproval[] = [];
  const signerIds = new Set<string>();
  const keyFingerprints = new Set<string>();
  for (const approval of approvals) {
    if (signerIds.has(approval.signerId)) fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED", "approval signerId must be unique");
    signerIds.add(approval.signerId);
    const trusted = registry.get(approval.signerId);
    if (trusted === undefined) fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_INVALID", "approval signer is not trusted");
    if (keyFingerprints.has(trusted.publicKeyFingerprint)) {
      fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED", "approval keys must be distinct");
    }
    keyFingerprints.add(trusted.publicKeyFingerprint);
    const signature = base64Value(approval.signature, "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID");
    if (signature.length !== 64 || !verifySignature(null, payload, trusted.publicKey, signature)) {
      fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_INVALID", "approval signature is invalid");
    }
    result.push(Object.freeze({
      signerId: approval.signerId,
      publicKeyFingerprint: trusted.publicKeyFingerprint,
      signatureFingerprint: sha256Hex(signature),
      publicKeyDer: Buffer.from(trusted.publicKeyDer),
      signature: Buffer.from(signature),
      verifiedAt,
    }));
  }
  if (result.length < 2 || signerIds.size < 2 || keyFingerprints.size < 2) {
    fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED", "two distinct signer and key proofs are required");
  }
  return Object.freeze(result);
}

export function buildMembershipGovernanceSafeSnapshot(manifest: MembershipGovernanceManifest): Record<string, unknown> {
  return {
    kind: manifest.kind,
    version: manifest.version,
    executionNonce: manifest.executionNonce,
    expectedInventoryFingerprint: manifest.expectedInventoryFingerprint,
    expiresAt: manifest.expiresAt,
    reason: manifest.reason,
    coverage: manifest.coverage,
    items: manifest.items.map((item) => ({ ...item })),
  };
}

interface InventoryRow {
  membership_kind: string;
  membership_id: string;
  workspace_id: string;
  project_id: string | null;
  user_id: string;
  role: string;
  access_state: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProjectModeRow {
  id: string;
  membership_inheritance_mode: string;
}

interface WorkspaceRow {
  id: string;
}

export interface MembershipGovernanceQueryResult<Row = unknown> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface MembershipGovernanceQueryClient {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<MembershipGovernanceQueryResult<Row>>;
}

export type MembershipGovernanceApplyResult = Readonly<{
  status: "applied" | "alreadyApplied";
  manifestFingerprint: string;
  executionId: string;
  itemCount: number;
}>;

const INVENTORY_SQL = `
  SELECT
    'workspace'::text AS membership_kind,
    membership."id"::text AS membership_id,
    membership."workspaceId"::text AS workspace_id,
    NULL::text AS project_id,
    membership."userId"::text AS user_id,
    membership."role"::text AS role,
    membership."accessState"::text AS access_state,
    to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at,
    to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS updated_at
  FROM "WorkspaceMembership" AS membership
  UNION ALL
  SELECT
    'project'::text AS membership_kind,
    membership."id"::text AS membership_id,
    project."workspaceId"::text AS workspace_id,
    membership."projectId"::text AS project_id,
    membership."userId"::text AS user_id,
    membership."role"::text AS role,
    membership."accessState"::text AS access_state,
    to_char(membership."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at,
    to_char(membership."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS updated_at
  FROM "ProjectMembership" AS membership
  JOIN "Project" AS project ON project."id" = membership."projectId"
  ORDER BY membership_kind, membership_id
`;

const PROJECT_MODES_SQL = `
  SELECT "id"::text AS id, "membershipInheritanceMode"::text AS membership_inheritance_mode
  FROM "Project"
  ORDER BY "id"
`;

const WORKSPACES_SQL = `
  SELECT "id"::text AS id
  FROM "Workspace"
  ORDER BY "id"
`;

const ENABLED_USERS_SQL = `
  SELECT "id"::text AS id
  FROM "AppUser"
  WHERE "disabledAt" IS NULL
  ORDER BY "id"
`;

function rowCount(result: MembershipGovernanceQueryResult): number {
  return result.rowCount ?? result.rows.length;
}

function normalizedInventory(rows: readonly InventoryRow[]): readonly InventoryRow[] {
  return rows.map((row) => {
    if (row.membership_kind !== "workspace" && row.membership_kind !== "project") {
      fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "database membership kind is invalid");
    }
    const membershipId = uuidValue(row.membership_id, "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH");
    const workspaceId = uuidValue(row.workspace_id, "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH");
    const projectId = row.project_id === null ? null : uuidValue(row.project_id, "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH");
    const userId = uuidValue(row.user_id, "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH");
    if (!WORKSPACE_ROLES.has(row.role) && row.membership_kind === "workspace") {
      fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "database workspace role is invalid");
    }
    if (!PROJECT_ROLES.has(row.role) && row.membership_kind === "project") {
      fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "database project role is invalid");
    }
    if (!["pending", "confirmed", "revoked"].includes(row.access_state)) {
      fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "database membership access state is invalid");
    }
    if (row.membership_kind === "workspace" && projectId !== null) {
      fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "workspace membership has a project scope");
    }
    if (row.membership_kind === "project" && projectId === null) {
      fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "project membership has no project scope");
    }
    return {
      ...row,
      membership_id: membershipId,
      workspace_id: workspaceId,
      project_id: projectId,
      user_id: userId,
      role: row.role,
      access_state: row.access_state,
    };
  });
}

function inventoryFingerprint(rows: readonly InventoryRow[]): string {
  return membershipManifestFingerprint(rows.map((row) => ({
    membershipKind: row.membership_kind === "workspace" ? "workspace" : "project",
    membershipId: row.membership_id,
    membershipFingerprint: membershipFingerprint({
      membershipId: row.membership_id,
      resourceId: row.membership_kind === "workspace" ? row.workspace_id : row.project_id ?? "",
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  })));
}

function itemKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function assertInventoryMatchesManifest(
  manifest: MembershipGovernanceManifest,
  rows: readonly InventoryRow[],
): readonly InventoryRow[] {
  const actualFingerprint = inventoryFingerprint(rows);
  if (actualFingerprint !== manifest.expectedInventoryFingerprint) {
    fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "database inventory fingerprint changed");
  }
  const pending = rows.filter((row) => row.access_state === "pending");
  if (pending.length !== manifest.items.length) {
    fail("MEMBERSHIP_GOVERNANCE_PENDING_SET_MISMATCH", "manifest does not cover the current pending membership set");
  }
  const actualByKey = new Map(pending.map((row) => [itemKey(row.membership_kind, row.membership_id), row]));
  for (const item of manifest.items) {
    const row = actualByKey.get(itemKey(item.membershipKind, item.membershipId));
    if (row === undefined) fail("MEMBERSHIP_GOVERNANCE_PENDING_SET_MISMATCH", "manifest item is not a current pending membership");
    const actualMembershipFingerprint = membershipFingerprint({
      membershipId: row.membership_id,
      resourceId: row.membership_kind === "workspace" ? row.workspace_id : row.project_id ?? "",
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    if (
      row.workspace_id !== item.workspaceId
      || row.project_id !== item.projectId
      || row.user_id !== item.userId
      || row.role !== item.expectedRole
      || row.access_state !== item.expectedAccessState
      || actualMembershipFingerprint !== item.expectedMembershipFingerprint
    ) {
      fail("MEMBERSHIP_GOVERNANCE_PENDING_SET_MISMATCH", "manifest item identity or fingerprint changed");
    }
  }
  return pending;
}

function finalState(row: InventoryRow, decisions: ReadonlyMap<string, MembershipGovernanceManifestItem>): string {
  const decision = decisions.get(itemKey(row.membership_kind, row.membership_id));
  if (decision === undefined) return row.access_state;
  return decision.decision === "confirm" ? "confirmed" : "revoked";
}

function assertOwnerInvariants(
  rows: readonly InventoryRow[],
  workspaces: readonly WorkspaceRow[],
  projectModes: readonly ProjectModeRow[],
  enabledUserIds: ReadonlySet<string>,
  decisions: ReadonlyMap<string, MembershipGovernanceManifestItem>,
): void {
  const workspaceOwners = new Set<string>();
  for (const row of rows) {
    if (
      row.membership_kind === "workspace"
      && row.role === "owner"
      && finalState(row, decisions) === "confirmed"
      && enabledUserIds.has(row.user_id)
    ) {
      workspaceOwners.add(row.workspace_id);
    }
  }
  for (const workspace of workspaces) {
    const workspaceId = workspace.id;
    if (!workspaceOwners.has(workspaceId)) fail("MEMBERSHIP_GOVERNANCE_OWNER_LOCKOUT", "manifest would leave a workspace without a confirmed owner");
  }

  const projectOnlyIds = projectModes
    .filter((row) => row.membership_inheritance_mode === "project_only")
    .map((row) => row.id);
  const projectOwners = new Set<string>();
  for (const row of rows) {
    if (
      row.membership_kind === "project"
      && row.role === "owner"
      && finalState(row, decisions) === "confirmed"
      && enabledUserIds.has(row.user_id)
    ) {
      projectOwners.add(row.project_id ?? "");
    }
  }
  for (const projectId of projectOnlyIds) {
    if (!projectOwners.has(projectId)) fail("MEMBERSHIP_GOVERNANCE_OWNER_LOCKOUT", "manifest would leave a project-only project without a confirmed owner");
  }
}

async function advisoryLock(db: MembershipGovernanceQueryClient, key: string, namespace: number): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, $2))", [key, namespace]);
}

async function lockSorted(db: MembershipGovernanceQueryClient, values: readonly string[], namespace: number): Promise<void> {
  for (const value of [...new Set(values)].sort()) await advisoryLock(db, value, namespace);
}

type SessionAdvisoryLock = Readonly<{ key: string; namespace: number }>;

/**
 * Discovery locks must survive the gap between inventory discovery and the
 * SERIALIZABLE transaction.  A transaction-scoped lock would be acquired
 * after the snapshot had already been fixed and would also leave a deadlock
 * window when a new resource appears between the two reads.
 */
async function sessionAdvisoryLock(
  db: MembershipGovernanceQueryClient,
  key: string,
  namespace: number,
): Promise<void> {
  await db.query("SELECT pg_advisory_lock(hashtextextended($1::text, $2))", [key, namespace]);
}

async function sessionAdvisoryUnlock(
  db: MembershipGovernanceQueryClient,
  key: string,
  namespace: number,
): Promise<void> {
  await db.query("SELECT pg_advisory_unlock(hashtextextended($1::text, $2))", [key, namespace]);
}

async function lockSessionSorted(
  db: MembershipGovernanceQueryClient,
  values: readonly string[],
  namespace: number,
  held: SessionAdvisoryLock[],
): Promise<void> {
  for (const value of [...new Set(values)].sort()) {
    await sessionAdvisoryLock(db, value, namespace);
    held.push(Object.freeze({ key: value, namespace }));
  }
}

async function releaseSessionLocks(
  db: MembershipGovernanceQueryClient,
  held: readonly SessionAdvisoryLock[],
): Promise<void> {
  for (const lock of [...held].reverse()) {
    try {
      await sessionAdvisoryUnlock(db, lock.key, lock.namespace);
    } catch {
      // The dedicated apply client is closed by the caller.  A failed unlock
      // therefore cannot leak a lock beyond the database session lifetime.
    }
  }
}

class MembershipGovernanceInventoryDiscoveryDrift extends Error {
  constructor() {
    super("membership governance inventory changed during lock discovery");
    this.name = "MembershipGovernanceInventoryDiscoveryDrift";
  }
}

interface ResourceKeyRow {
  resource_kind: string;
  resource_id: string;
}

const RESOURCE_KEYS_SQL = `
  SELECT 'workspace'::text AS resource_kind, "id"::text AS resource_id
  FROM "Workspace"
  UNION ALL
  SELECT 'project'::text AS resource_kind, "id"::text AS resource_id
  FROM "Project"
  ORDER BY resource_kind, resource_id
`;

function normalizedResourceKeys(rows: readonly ResourceKeyRow[]): Readonly<{ workspaceIds: readonly string[]; projectIds: readonly string[] }> {
  const workspaceIds: string[] = [];
  const projectIds: string[] = [];
  for (const row of rows) {
    const id = uuidValue(row.resource_id, "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH");
    if (row.resource_kind === "workspace") workspaceIds.push(id);
    else if (row.resource_kind === "project") projectIds.push(id);
    else fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "database resource kind is invalid");
  }
  return Object.freeze({
    workspaceIds: Object.freeze([...new Set(workspaceIds)].sort()),
    projectIds: Object.freeze([...new Set(projectIds)].sort()),
  });
}

function inventoryLockKeys(rows: readonly InventoryRow[]): Readonly<{
  actorIds: readonly string[];
  workspaceIds: readonly string[];
  projectIds: readonly string[];
}> {
  return Object.freeze({
    actorIds: Object.freeze([...new Set(rows.map((row) => row.user_id))].sort()),
    workspaceIds: Object.freeze([...new Set(rows.map((row) => row.workspace_id))].sort()),
    projectIds: Object.freeze([
      ...new Set(rows.flatMap((row) => row.project_id === null ? [] : [row.project_id])),
    ].sort()),
  });
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameInventoryLockKeys(left: ReturnType<typeof inventoryLockKeys>, right: ReturnType<typeof inventoryLockKeys>): boolean {
  return sameValues(left.actorIds, right.actorIds)
    && sameValues(left.workspaceIds, right.workspaceIds)
    && sameValues(left.projectIds, right.projectIds);
}

function sameResourceKeys(
  left: Readonly<{ workspaceIds: readonly string[]; projectIds: readonly string[] }>,
  right: Readonly<{ workspaceIds: readonly string[]; projectIds: readonly string[] }>,
): boolean {
  return sameValues(left.workspaceIds, right.workspaceIds) && sameValues(left.projectIds, right.projectIds);
}

async function lockMembershipRows(db: MembershipGovernanceQueryClient, rows: readonly InventoryRow[]): Promise<void> {
  const keys = rows
    .map((row) => itemKey(row.membership_kind, row.membership_id))
    .sort();
  await lockSorted(db, keys, MEMBERSHIP_GOVERNANCE_MEMBERSHIP_LOCK_NAMESPACE);
  const workspaceIds = rows.filter((row) => row.membership_kind === "workspace").map((row) => row.membership_id);
  const projectIds = rows.filter((row) => row.membership_kind === "project").map((row) => row.membership_id);
  if (workspaceIds.length > 0) {
    const result = await db.query<{ id: string }>(
      `SELECT "id"::text AS id FROM "WorkspaceMembership" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR UPDATE`,
      [workspaceIds],
    );
    if (result.rows.length !== workspaceIds.length) fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "workspace membership rows changed while locking");
  }
  if (projectIds.length > 0) {
    const result = await db.query<{ id: string }>(
      `SELECT "id"::text AS id FROM "ProjectMembership" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR UPDATE`,
      [projectIds],
    );
    if (result.rows.length !== projectIds.length) fail("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH", "project membership rows changed while locking");
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function trustedMembershipGovernanceSignerRegistryFromEnvironment(): Readonly<{
  registry: ReadonlyMap<string, TrustedMembershipGovernanceSigner>;
  fingerprint: string;
}> {
  const registryText = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
  if (typeof registryText !== "string" || registryText.length === 0) {
    fail("MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID", "trusted signer registry is required");
  }
  const registry = parseTrustedMembershipGovernanceSignerRegistry(registryText);
  return Object.freeze({
    registry,
    fingerprint: membershipGovernanceTrustedSignerRegistryFingerprint(registry),
  });
}

async function probeAppliedMembershipGovernanceManifest(
  db: MembershipGovernanceQueryClient,
  manifestFingerprint: string,
): Promise<MembershipGovernanceApplyResult | null> {
  let inTransaction = false;
  let statementTimeoutConfigured = false;
  try {
    await db.query(`SET statement_timeout = '${MEMBERSHIP_GOVERNANCE_LOCK_TIMEOUT}'`);
    statementTimeoutConfigured = true;
    await db.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    inTransaction = true;
    await db.query("SET LOCAL search_path = pg_catalog, public");
    const existing = await db.query<{ id: string; item_count: number }>(
      `SELECT "id"::text AS id, "itemCount" AS item_count
       FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $1`,
      [manifestFingerprint],
    );
    await db.query("COMMIT");
    inTransaction = false;
    const applied = existing.rows[0];
    if (applied === undefined) return null;
    return Object.freeze({
      status: "alreadyApplied",
      manifestFingerprint,
      executionId: applied.id,
      itemCount: Number(applied.item_count),
    });
  } catch {
    if (inTransaction) {
      try {
        await db.query("ROLLBACK");
      } catch {
        // Keep the original apply conflict as the public result.
      }
    }
    return null;
  } finally {
    if (statementTimeoutConfigured) {
      try {
        await db.query("SET statement_timeout = '0'");
      } catch {
        // The dedicated apply client is closed by the caller. Keep the probe
        // fallback redacted if cleanup itself fails.
      }
    }
  }
}

async function applyMembershipGovernanceManifestOnce(
  db: MembershipGovernanceQueryClient,
  manifest: MembershipGovernanceManifest,
  approvals: readonly VerifiedMembershipGovernanceApproval[],
  trustedSignerRegistryFingerprint: string,
  executorLabel: string,
  now = new Date(),
): Promise<MembershipGovernanceApplyResult> {
  const signerIds = new Set(approvals.map((approval) => approval.signerId));
  const keyFingerprints = new Set(approvals.map((approval) => approval.publicKeyFingerprint));
  if (approvals.length < 2 || signerIds.size < 2 || keyFingerprints.size < 2) {
    fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED");
  }
  const canonicalManifest = canonicalMembershipGovernanceManifest(manifest);
  const manifestFingerprint = sha256Hex(canonicalManifest);
  if (!SIGNER_ID_PATTERN.test(executorLabel)) {
    fail("MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL_REQUIRED", "executor label is invalid");
  }
  for (let attempt = 0; attempt < MEMBERSHIP_GOVERNANCE_MAX_DISCOVERY_RETRIES; attempt += 1) {
    const heldSessionLocks: SessionAdvisoryLock[] = [];
    let inTransaction = false;
    let lockTimeoutConfigured = false;
    let statementTimeoutConfigured = false;
    let searchPathConfigured = false;
    try {
      // Bound both session advisory-lock waits and relation-lock waits. The
      // dedicated CLI connection resets this setting before it is released;
      // a timeout is a redacted retryable conflict, never a partial apply.
      await db.query(`SET lock_timeout = '${MEMBERSHIP_GOVERNANCE_LOCK_TIMEOUT}'`);
      lockTimeoutConfigured = true;
      await db.query(`SET statement_timeout = '${MEMBERSHIP_GOVERNANCE_LOCK_TIMEOUT}'`);
      statementTimeoutConfigured = true;
      // Discovery runs before BEGIN and uses unqualified application table
      // names. Pin the dedicated connection to the application schema before
      // the first discovery read, then reset it before the next attempt/close.
      await db.query("SET search_path = pg_catalog, public");
      searchPathConfigured = true;
      // The manifest lock is session scoped because discovery happens before
      // BEGIN.  This makes same-manifest callers serialize before either can
      // fix a SERIALIZABLE snapshot.
      await sessionAdvisoryLock(db, manifestFingerprint, MEMBERSHIP_GOVERNANCE_MANIFEST_LOCK_NAMESPACE);
      heldSessionLocks.push(Object.freeze({
        key: manifestFingerprint,
        namespace: MEMBERSHIP_GOVERNANCE_MANIFEST_LOCK_NAMESPACE,
      }));

      // Discovery is only used to determine the keys that must be fenced. The
      // authoritative inventory is read after the relation locks below.
      const discoveryRows = normalizedInventory(
        (await db.query<InventoryRow>(INVENTORY_SQL)).rows,
      );
      const discoveryResources = normalizedResourceKeys(
        (await db.query<ResourceKeyRow>(RESOURCE_KEYS_SQL)).rows,
      );
      const discoveryInventoryKeys = inventoryLockKeys(discoveryRows);
      await lockSessionSorted(db, discoveryInventoryKeys.actorIds, ACCESS_ACTOR_LOCK_NAMESPACE, heldSessionLocks);
      await lockSessionSorted(db, discoveryResources.workspaceIds, ACCESS_WORKSPACE_LOCK_NAMESPACE, heldSessionLocks);
      await lockSessionSorted(db, discoveryResources.projectIds, ACCESS_PROJECT_LOCK_NAMESPACE, heldSessionLocks);

      await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      inTransaction = true;
      await db.query("SET LOCAL search_path = pg_catalog, public");
      await db.query("SET LOCAL statement_timeout = '15000ms'");

      // Relation locks are acquired before the first authoritative application
      // table read.  Normal membership/resource mutations acquire the same
      // actor -> workspace -> project fence before their writes, so a writer
      // cannot hold a conflicting RowExclusive lock while waiting on one of
      // the session locks above.
      await db.query('LOCK TABLE "AppUser" IN SHARE MODE');
      await db.query('LOCK TABLE "Workspace" IN SHARE MODE');
      await db.query('LOCK TABLE "Project" IN SHARE MODE');
      await db.query('LOCK TABLE "WorkspaceMembership" IN SHARE MODE');
      await db.query('LOCK TABLE "ProjectMembership" IN SHARE MODE');

      const existing = await db.query<{ id: string; item_count: number }>(
        `SELECT "id"::text AS id, "itemCount" AS item_count
         FROM "MembershipGovernanceExecution" WHERE "manifestFingerprint" = $1`,
        [manifestFingerprint],
      );
      if (existing.rows.length > 0) {
        await db.query("ROLLBACK");
        inTransaction = false;
        const applied = existing.rows[0]!;
        return Object.freeze({
          status: "alreadyApplied",
          manifestFingerprint,
          executionId: applied.id,
          itemCount: Number(applied.item_count),
        });
      }
      const nonceConflict = await db.query<{ manifest_fingerprint: string }>(
        `SELECT "manifestFingerprint" AS manifest_fingerprint
         FROM "MembershipGovernanceExecution" WHERE "executionNonce" = $1`,
        [manifest.executionNonce],
      );
      if (nonceConflict.rows.length > 0 && nonceConflict.rows[0]!.manifest_fingerprint !== manifestFingerprint) {
        fail("MEMBERSHIP_GOVERNANCE_NONCE_CONFLICT", "execution nonce was already used by another manifest");
      }

      const lockedRows = normalizedInventory(
        (await db.query<InventoryRow>(INVENTORY_SQL)).rows,
      );
      const lockedResources = normalizedResourceKeys(
        (await db.query<ResourceKeyRow>(RESOURCE_KEYS_SQL)).rows,
      );
      // A row/resource committed before the relation locks were acquired was
      // not part of discovery. Do not add a higher-level lock here: release
      // the whole fence and retry from manifest -> actor -> workspace ->
      // project, otherwise the lock order can deadlock with normal writers.
      if (
        !sameInventoryLockKeys(discoveryInventoryKeys, inventoryLockKeys(lockedRows))
        || !sameResourceKeys(discoveryResources, lockedResources)
      ) {
        throw new MembershipGovernanceInventoryDiscoveryDrift();
      }

      // Membership row locks are the final lock level.  The relation locks
      // make this row set stable; the second read below is a fail-closed guard
      // against any caller that bypasses the normal access fence.
      await lockMembershipRows(db, lockedRows);
      const rows = normalizedInventory(
        (await db.query<InventoryRow>(INVENTORY_SQL)).rows,
      );
      const resourcesAfterRows = normalizedResourceKeys(
        (await db.query<ResourceKeyRow>(RESOURCE_KEYS_SQL)).rows,
      );
      if (
        !sameInventoryLockKeys(inventoryLockKeys(lockedRows), inventoryLockKeys(rows))
        || !sameResourceKeys(lockedResources, resourcesAfterRows)
      ) {
        throw new MembershipGovernanceInventoryDiscoveryDrift();
      }

      const pending = assertInventoryMatchesManifest(manifest, rows);
      const expiry = new Date(manifest.expiresAt);
      // Check the database clock after all potentially blocking locks. A
      // manifest that expires while waiting must never reach a member write.
      const dbClock = (await db.query<{ now: Date | string }>("SELECT clock_timestamp() AS now")).rows[0]?.now;
      if (dbClock === undefined) fail("MEMBERSHIP_GOVERNANCE_APPLY_FAILED", "database clock is unavailable");
      const currentTime = new Date(dbClock);
      if (Number.isNaN(currentTime.getTime()) || expiry <= currentTime || expiry <= now) {
        fail("MEMBERSHIP_GOVERNANCE_MANIFEST_EXPIRED", "manifest is expired");
      }
      const workspaces = (await db.query<WorkspaceRow>(WORKSPACES_SQL)).rows.map((row) => ({
        id: uuidValue(row.id, "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH"),
      }));
      const enabledUserIds = new Set(
        (await db.query<WorkspaceRow>(ENABLED_USERS_SQL)).rows.map((row) => (
          uuidValue(row.id, "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH")
        )),
      );
      const projectModes = (await db.query<ProjectModeRow>(PROJECT_MODES_SQL)).rows.map((row) => ({
        id: uuidValue(row.id, "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH"),
        membership_inheritance_mode: row.membership_inheritance_mode,
      }));
      const decisions = new Map(manifest.items.map((item) => [itemKey(item.membershipKind, item.membershipId), item]));
      assertOwnerInvariants(rows, workspaces, projectModes, enabledUserIds, decisions);

      const safeReason = `membership governance manifest ${manifestFingerprint}`;
      for (const row of pending) {
        const item = decisions.get(itemKey(row.membership_kind, row.membership_id));
        if (item === undefined) fail("MEMBERSHIP_GOVERNANCE_PENDING_SET_MISMATCH");
        const nextState = item.decision === "confirm" ? "confirmed" : "revoked";
        const table = row.membership_kind === "workspace" ? "WorkspaceMembership" : "ProjectMembership";
        const update = await db.query(
          `UPDATE "${table}" SET "accessState" = $2::"MembershipAccessState"
           WHERE "id" = $1 AND "accessState" = 'pending' RETURNING "id"`,
          [row.membership_id, nextState],
        );
        if (rowCount(update) !== 1) fail("MEMBERSHIP_GOVERNANCE_APPLY_CONFLICT", "membership changed while applying manifest");
        await db.query(
          `INSERT INTO "MembershipAccessAudit" (
            "id", "membershipKind", "membershipId", "workspaceId", "projectId", "userId",
            "action", "previousState", "newState", "roleSnapshot", "actorId", "reason",
            "membershipFingerprint", "manifestFingerprint"
          ) VALUES ($4, $5::"MembershipAccessAuditMembershipKind", $1, $6, $3::uuid, $7,
            $8::"MembershipAccessAuditAction", 'pending'::"MembershipAccessState", $2::"MembershipAccessState",
            $9, NULL, $10, $11, $12)`,
          [
            row.membership_id,
            nextState,
            row.project_id,
            randomUUID(),
            row.membership_kind,
            row.workspace_id,
            row.user_id,
            nextState,
            row.role,
            safeReason,
            item.expectedMembershipFingerprint,
            manifestFingerprint,
          ],
        );
      }

      const executionId = randomUUID();
      await db.query(
        `INSERT INTO "MembershipGovernanceExecution" (
          "id", "manifestFingerprint", "executionNonce", "expectedInventoryFingerprint", "version",
          "trustedSignerRegistryFingerprint", "coverage", "expiresAt", "reason", "itemCount", "canonicalManifest", "snapshot", "executorLabel"
        ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
        [
          executionId,
          manifestFingerprint,
          manifest.executionNonce,
          manifest.expectedInventoryFingerprint,
          trustedSignerRegistryFingerprint,
          manifest.coverage,
          manifest.expiresAt,
          manifest.reason,
          manifest.items.length,
          canonicalManifest,
          JSON.stringify(buildMembershipGovernanceSafeSnapshot(manifest)),
          executorLabel,
        ],
      );
      for (const approval of approvals) {
        await db.query(
          `INSERT INTO "MembershipGovernanceApproval" (
            "id", "executionId", "signerId", "publicKeyFingerprint", "signatureFingerprint", "publicKeyDer", "signature", "verifiedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            executionId,
            approval.signerId,
            approval.publicKeyFingerprint,
            approval.signatureFingerprint,
            approval.publicKeyDer,
            approval.signature,
            approval.verifiedAt,
          ],
        );
      }
      await db.query("COMMIT");
      inTransaction = false;
      return Object.freeze({
        status: "applied",
        manifestFingerprint,
        executionId,
        itemCount: manifest.items.length,
      });
    } catch (error) {
      if (inTransaction) {
        try {
          await db.query("ROLLBACK");
        } catch {
          // Preserve the original redacted error code.
        }
      }
      if (error instanceof MembershipGovernanceInventoryDiscoveryDrift) {
        if (attempt + 1 < MEMBERSHIP_GOVERNANCE_MAX_DISCOVERY_RETRIES) continue;
        throw new MembershipGovernanceManifestError(
          "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH",
          "database inventory changed during lock discovery",
        );
      }
      if (error instanceof MembershipGovernanceManifestError) throw error;
      const code = databaseErrorCode(error);
      if (code === "40001" || code === "40P01" || code === "23505" || code === "55P03" || code === "57014") {
        throw new MembershipGovernanceManifestError("MEMBERSHIP_GOVERNANCE_APPLY_CONFLICT");
      }
      throw new MembershipGovernanceManifestError("MEMBERSHIP_GOVERNANCE_APPLY_FAILED");
    } finally {
      await releaseSessionLocks(db, heldSessionLocks);
      if (searchPathConfigured) {
        try {
          await db.query("RESET search_path");
        } catch {
          // The dedicated apply client is closed by the caller. Keep the
          // public error redacted if the cleanup statement itself fails.
        }
      }
      if (lockTimeoutConfigured) {
        try {
          await db.query("SET lock_timeout = '0'");
        } catch {
          // The dedicated apply client is closed by the caller. Keep the
          // public error redacted if the cleanup statement itself fails.
        }
      }
      if (statementTimeoutConfigured) {
        try {
          await db.query("SET statement_timeout = '0'");
        } catch {
          // The dedicated apply client is closed by the caller. Keep the
          // public error redacted if the cleanup statement itself fails.
        }
      }
    }
  }
  throw new MembershipGovernanceManifestError("MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH");
}

export async function applyMembershipGovernanceManifest(
  db: MembershipGovernanceQueryClient,
  manifestText: string,
  approvalTexts: readonly string[],
  executorLabel: string,
  now = new Date(),
): Promise<MembershipGovernanceApplyResult> {
  // This is the final write boundary. Never accept a caller-supplied
  // manifest/approval DTO or VerifiedMembershipGovernanceApproval as
  // authorization. Text files are parsed and normalized exactly once at this
  // boundary; all subsequent work uses the frozen copies, so mutable objects
  // or getters cannot change the bytes after verification.
  const normalizedManifest = parseMembershipGovernanceManifestText(manifestText);
  if (!Array.isArray(approvalTexts)) {
    fail("MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID", "approval texts must be an array");
  }
  if (approvalTexts.length < 2) {
    fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED", "at least two approvals are required");
  }
  if (approvalTexts.length > MEMBERSHIP_GOVERNANCE_MAX_SIGNERS) {
    fail("MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED", "approval count exceeds the signer limit");
  }
  const normalizedApprovalTexts = Object.freeze([...approvalTexts]);
  const normalizedApprovals = Object.freeze(normalizedApprovalTexts.map((text) => parseMembershipGovernanceApprovalText(text)));
  const trustedRegistry = trustedMembershipGovernanceSignerRegistryFromEnvironment();
  const verifiedApprovals = verifyMembershipGovernanceApprovals(
    normalizedManifest,
    normalizedApprovals,
    trustedRegistry.registry,
  );
  const canonicalManifest = canonicalMembershipGovernanceManifest(normalizedManifest);
  try {
    return await applyMembershipGovernanceManifestOnce(
      db,
      normalizedManifest,
      verifiedApprovals,
      trustedRegistry.fingerprint,
      executorLabel,
      now,
    );
  } catch (error) {
    if (
      error instanceof MembershipGovernanceManifestError
      && error.code === "MEMBERSHIP_GOVERNANCE_APPLY_CONFLICT"
    ) {
      const replay = await probeAppliedMembershipGovernanceManifest(
        db,
        sha256Hex(canonicalManifest),
      );
      if (replay !== null) return replay;
    }
    throw error;
  }
}

export function parseMembershipGovernanceExecutorLabel(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.trim() !== value) {
    fail("MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL_REQUIRED", "executor label is required");
  }
  return value;
}

export async function readMembershipGovernanceJsonFile(path: string, maxBytes: number, code: MembershipGovernanceManifestErrorCode): Promise<string> {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) fail("MEMBERSHIP_GOVERNANCE_FILE_INVALID", "file path is invalid");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    fail("MEMBERSHIP_GOVERNANCE_FILE_INVALID", "governance file cannot be read");
  }
  if (bytes.length > maxBytes) fail(code, "governance file exceeds the size limit");
  return bytes.toString("utf8");
}

export function buildMembershipGovernanceDatabaseClient(databaseUrl: string): Client {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    fail("MEMBERSHIP_GOVERNANCE_DATABASE_URL_REQUIRED", "apply database URL is required");
  }
  return new Client({
    connectionString: databaseUrl,
    application_name: "ai-project-os-membership-governance-apply",
    connectionTimeoutMillis: 5_000,
  });
}
