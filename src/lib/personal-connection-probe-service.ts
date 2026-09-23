import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type PersonalConnectionProbeAction, type PersonalConnectionProbeKind, type PersonalConnectionProbeStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor, type AccountAccessActor } from "@/lib/account-access-guard";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { lockActorAccess } from "@/lib/access-linearization";

const REQUEST_KEY = z.string().uuid();
const CONNECTION_ID = z.string().uuid();
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const PROBE_TTL_MS = 5 * 60 * 1000;

export type PersonalConnectionProbeErrorCode =
  | "PERSONAL_CONNECTION_PROBE_INVALID_INPUT"
  | "PERSONAL_CONNECTION_PROBE_IDEMPOTENCY_CONFLICT"
  | "PERSONAL_CONNECTION_PROBE_IN_PROGRESS"
  | "PERSONAL_CONNECTION_PROBE_REQUIRED"
  | "PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT"
  | "PERSONAL_CONNECTION_PROBE_EXPIRED"
  | "PERSONAL_CONNECTION_PROBE_CONSUMED"
  | "PERSONAL_CONNECTION_PROBE_FAILED";

export class PersonalConnectionProbeError extends Error {
  constructor(readonly code: PersonalConnectionProbeErrorCode) {
    super(code);
    this.name = "PersonalConnectionProbeError";
  }
}

function fail(code: PersonalConnectionProbeErrorCode): never {
  throw new PersonalConnectionProbeError(code);
}

type ProbeDb = PrismaClient | Prisma.TransactionClient;
export type PersonalConnectionProbeActor = AccountAccessActor;

export type PersonalConnectionProbeConfiguration = Readonly<{
  kind: PersonalConnectionProbeKind;
  action: PersonalConnectionProbeAction;
  connectionId: string | null;
  clientRequestKey: string;
  configuration: unknown;
  secret: string | null;
  /**
   * Saved connections bind a probe to the encrypted credential row's current
   * version.  The version is HMACed before it reaches the proof row, so the
   * probe can defer plaintext secret reads until the final dispatch fence.
   */
  secretBindingFingerprint?: string | null;
  targetRepositoryPath?: string | null;
  targetTrackedRef?: string | null;
}>;

export type PersonalConnectionProbeOutcome = Readonly<{
  addressFingerprint: string | null;
  commitSha?: string | null;
  protocolVersion?: string | null;
  catalogFingerprint?: string | null;
  resultCount?: number | null;
  resultSnapshot?: unknown;
}>;

export type PersonalConnectionProbeView = Readonly<{
  draftProbeId: string | null;
  createRequestKey: string;
  status: "running" | "settled" | "rejected" | "held";
  safeErrorCode: string | null;
  expiresAt: string | null;
  result: Readonly<{
    commitSha: string | null;
    protocolVersion: string | null;
    resultCount: number | null;
  }>;
}>;

type ProbeRow = Readonly<{
  id: string;
  kind: PersonalConnectionProbeKind;
  action: PersonalConnectionProbeAction;
  connectionId: string | null;
  actorId: string;
  actorAccountAccessVersion: number;
  clientRequestKeyHash: string;
  requestFingerprint: string;
  configurationDigest: string;
  credentialSecretFingerprint: string | null;
  targetRepositoryPath: string | null;
  targetTrackedRef: string | null;
  resolvedAddressFingerprint: string | null;
  resultCommitSha: string | null;
  protocolVersion: string | null;
  catalogFingerprint: string | null;
  resultCount: number | null;
  resultSnapshot: unknown;
  status: PersonalConnectionProbeStatus;
  safeErrorCode: string | null;
  evidenceExpiresAt: Date | null;
  consumedAt: Date | null;
  consumedConnectionId: string | null;
}>;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function keyHash(value: string): string {
  return hash(`ai-project-os:personal-connection-probe:key:v1:${value}`);
}

async function digest(value: unknown): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update("ai-project-os:personal-connection-probe:configuration:v1", "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function equalDigest(left: string | null, right: string): boolean {
  if (left === null || !FINGERPRINT.test(left) || !FINGERPRINT.test(right)) return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function secretFingerprint(secret: string | null): Promise<string | null> {
  if (secret === null) return null;
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update("ai-project-os:personal-connection-probe:secret:v1", "utf8")
    .update("\0", "utf8")
    .update(secret, "utf8")
    .digest("hex");
}

async function credentialVersionFingerprint(fingerprint: string | null | undefined): Promise<string | null> {
  if (fingerprint === undefined || fingerprint === null) return null;
  if (!FINGERPRINT.test(fingerprint)) fail("PERSONAL_CONNECTION_PROBE_INVALID_INPUT");
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update("ai-project-os:personal-connection-probe:credential-version:v1", "utf8")
    .update("\0", "utf8")
    .update(fingerprint, "utf8")
    .digest("hex");
}

async function proofSecretFingerprint(input: PersonalConnectionProbeConfiguration): Promise<string | null> {
  return input.secretBindingFingerprint === undefined
    ? secretFingerprint(input.secret)
    : credentialVersionFingerprint(input.secretBindingFingerprint);
}

function requestFingerprint(input: PersonalConnectionProbeConfiguration, secretDigest: string | null): string {
  return hash(canonicalJson({
    kind: input.kind,
    action: input.action,
    connectionId: input.connectionId,
    clientRequestKey: input.clientRequestKey,
    configuration: input.configuration,
    credentialSecretFingerprint: secretDigest,
    targetRepositoryPath: input.targetRepositoryPath ?? null,
    targetTrackedRef: input.targetTrackedRef ?? null,
  }));
}

function configurationMaterial(input: PersonalConnectionProbeConfiguration, secretDigest: string | null): unknown {
  return {
    kind: input.kind,
    action: input.action,
    connectionId: input.connectionId,
    configuration: input.configuration,
    credentialSecretFingerprint: secretDigest,
    targetRepositoryPath: input.targetRepositoryPath ?? null,
    targetTrackedRef: input.targetTrackedRef ?? null,
  };
}

function mapStatus(value: PersonalConnectionProbeStatus): PersonalConnectionProbeView["status"] {
  return value;
}

function publicView(row: ProbeRow, createRequestKey: string): PersonalConnectionProbeView {
  const settled = row.status === "settled" && row.safeErrorCode === null && row.evidenceExpiresAt !== null && row.evidenceExpiresAt.getTime() > Date.now();
  return Object.freeze({
    draftProbeId: settled ? row.id : null,
    createRequestKey,
    status: mapStatus(row.status),
    safeErrorCode: row.safeErrorCode,
    expiresAt: settled ? row.evidenceExpiresAt!.toISOString() : null,
    result: Object.freeze({
      commitSha: row.resultCommitSha,
      protocolVersion: row.protocolVersion,
      resultCount: row.resultCount,
    }),
  });
}

async function mutationContext(db: ProbeDb): Promise<void> {
  await db.$executeRaw`SELECT set_config('app.personal_connection_probe_mutation_context', 'service-v1', true)`;
}

/**
 * Re-admit a draft probe immediately before its first external dispatch.
 * Draft probes have no saved connection row to bind here, so the actor access
 * epoch is the complete fence.  Keep the transaction short and release the
 * lock before the caller performs network or subprocess I/O.
 */
export async function acceptPersonalConnectionProbeDispatchBoundary(input: Readonly<{
  db: PrismaClient;
  actor: PersonalConnectionProbeActor;
}>): Promise<boolean> {
  try {
    return await input.db.$transaction(async (tx) => {
      await lockActorAccess(tx, input.actor.id);
      try {
        await assertAccountAccessForActor(tx, input.actor);
        return true;
      } catch {
        return false;
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
  } catch {
    return false;
  }
}

async function admit(
  input: PersonalConnectionProbeConfiguration,
  actor: PersonalConnectionProbeActor,
  db: PrismaClient,
  requestFingerprintValue: string,
  configurationDigestValue: string,
  secretDigest: string | null,
): Promise<Readonly<{ id: string; terminal: boolean }>> {
  const actorVersion = await assertAccountAccessForActor(db, actor);
  const key = keyHash(input.clientRequestKey);
  try {
    return await db.$transaction(async (tx) => {
      await mutationContext(tx);
      await lockActorAccess(tx, actor.id);
      const currentActor = await assertAccountAccessForActor(tx, actor);
      if (currentActor.accountAccessVersion !== actorVersion.accountAccessVersion) fail("PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
      const existing = await tx.personalConnectionProbeAttempt.findUnique({
        where: { actorId_clientRequestKeyHash: { actorId: actor.id, clientRequestKeyHash: key } },
        select: { id: true, requestFingerprint: true, status: true },
      });
      if (existing !== null) {
        if (existing.requestFingerprint !== requestFingerprintValue) fail("PERSONAL_CONNECTION_PROBE_IDEMPOTENCY_CONFLICT");
        if (existing.status === "running") fail("PERSONAL_CONNECTION_PROBE_IN_PROGRESS");
        return { id: existing.id, terminal: true };
      }
      const attempt = await tx.personalConnectionProbeAttempt.create({
        data: {
          id: randomUUID(),
          kind: input.kind,
          action: input.action,
          connectionId: input.connectionId,
          actorId: actor.id,
          actorAccountAccessVersion: currentActor.accountAccessVersion,
          clientRequestKeyHash: key,
          requestFingerprint: requestFingerprintValue,
          configurationDigest: configurationDigestValue,
          credentialSecretFingerprint: secretDigest,
          targetRepositoryPath: input.targetRepositoryPath ?? null,
          targetTrackedRef: input.targetTrackedRef ?? null,
          status: "running",
          evidenceExpiresAt: null,
          consumedAt: null,
          consumedConnectionId: null,
          terminalAt: null,
        },
        select: { id: true },
      });
      return { id: attempt.id, terminal: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await db.personalConnectionProbeAttempt.findUnique({ where: { actorId_clientRequestKeyHash: { actorId: actor.id, clientRequestKeyHash: key } }, select: { id: true, requestFingerprint: true } });
      if (existing?.requestFingerprint === requestFingerprintValue) return { id: existing.id, terminal: true };
      fail("PERSONAL_CONNECTION_PROBE_IDEMPOTENCY_CONFLICT");
    }
    throw error;
  }
}

async function updateAttempt(
  id: string,
  actor: PersonalConnectionProbeActor,
  status: PersonalConnectionProbeStatus,
  outcome: PersonalConnectionProbeOutcome | null,
  safeErrorCode: string | null,
  db: PrismaClient,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await mutationContext(tx);
    await lockActorAccess(tx, actor.id);
    const current = await tx.personalConnectionProbeAttempt.findUnique({ where: { id }, select: { actorId: true, actorAccountAccessVersion: true, status: true, createdAt: true } });
    if (current === null || current.actorId !== actor.id || current.status !== "running") return;
    let actorRow: Readonly<{ accountAccessVersion: number }>;
    try {
      actorRow = await assertAccountAccessForActor(tx, actor);
    } catch (error) {
      if (!(error instanceof AccountAccessGuardError)) throw error;
      await tx.personalConnectionProbeAttempt.update({ where: { id }, data: { status: "rejected", safeErrorCode: "PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT", terminalAt: new Date() } });
      return;
    }
    if (actorRow.accountAccessVersion !== current.actorAccountAccessVersion) {
      await tx.personalConnectionProbeAttempt.update({ where: { id }, data: { status: "rejected", safeErrorCode: "PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT", terminalAt: new Date() } });
      return;
    }
    await tx.personalConnectionProbeAttempt.update({
      where: { id },
      data: {
        status,
        safeErrorCode,
        resolvedAddressFingerprint: outcome?.addressFingerprint ?? null,
        resultCommitSha: outcome?.commitSha ?? null,
        protocolVersion: outcome?.protocolVersion ?? null,
        catalogFingerprint: outcome?.catalogFingerprint ?? null,
        resultCount: outcome?.resultCount ?? null,
        resultSnapshot: outcome?.resultSnapshot === undefined ? Prisma.DbNull : outcome.resultSnapshot as Prisma.InputJsonValue,
        evidenceExpiresAt: status === "settled" && safeErrorCode === null
          ? new Date(Math.min(Date.now() + PROBE_TTL_MS, current.createdAt.getTime() + PROBE_TTL_MS))
          : null,
        terminalAt: new Date(),
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
}

export async function runPersonalConnectionProbe(
  input: PersonalConnectionProbeConfiguration,
  actor: PersonalConnectionProbeActor,
  operation: () => Promise<PersonalConnectionProbeOutcome>,
  db: PrismaClient = getDb(),
): Promise<PersonalConnectionProbeView> {
  const clientRequestKey = REQUEST_KEY.safeParse(input.clientRequestKey);
  if (!clientRequestKey.success || (input.connectionId !== null && !CONNECTION_ID.safeParse(input.connectionId).success)) fail("PERSONAL_CONNECTION_PROBE_INVALID_INPUT");
  const secretDigest = await proofSecretFingerprint(input);
  const configurationDigestValue = await digest(configurationMaterial(input, secretDigest));
  const requestFingerprintValue = requestFingerprint(input, secretDigest);
  const admission = await admit(input, actor, db, requestFingerprintValue, configurationDigestValue, secretDigest);
  if (!admission.terminal) {
    try {
      const outcome = await operation();
      await updateAttempt(admission.id, actor, "settled", outcome, null, db);
    } catch (error) {
      const safeErrorCode = error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "PERSONAL_CONNECTION_PROBE_FAILED";
      await updateAttempt(admission.id, actor, "rejected", null, safeErrorCode, db);
    }
  }
  const row = await db.personalConnectionProbeAttempt.findUnique({ where: { id: admission.id } }) as ProbeRow | null;
  if (row === null) fail("PERSONAL_CONNECTION_PROBE_FAILED");
  return publicView(row, input.clientRequestKey);
}

export async function consumePersonalConnectionProbe(
  input: PersonalConnectionProbeConfiguration,
  actor: PersonalConnectionProbeActor,
  consumedConnectionId: string,
  tx: Prisma.TransactionClient,
  expectedProbeId?: string,
): Promise<Readonly<{ alreadyConsumedConnectionId: string | null; outcome: PersonalConnectionProbeOutcome }>> {
  if (!REQUEST_KEY.safeParse(input.clientRequestKey).success || !CONNECTION_ID.safeParse(consumedConnectionId).success) fail("PERSONAL_CONNECTION_PROBE_INVALID_INPUT");
  const secretDigest = await proofSecretFingerprint(input);
  const configurationDigestValue = await digest(configurationMaterial(input, secretDigest));
  const requestFingerprintValue = requestFingerprint(input, secretDigest);
  const key = keyHash(input.clientRequestKey);
  await mutationContext(tx);
  await lockActorAccess(tx, actor.id);
  const currentActor = await assertAccountAccessForActor(tx, actor);
  await tx.$queryRaw`SELECT "id" FROM "PersonalConnectionProbeAttempt" WHERE "id" IN (SELECT "id" FROM "PersonalConnectionProbeAttempt" WHERE "actorId" = ${actor.id}::uuid AND "clientRequestKeyHash" = ${key}) FOR UPDATE`;
  const proof = await tx.personalConnectionProbeAttempt.findUnique({ where: { actorId_clientRequestKeyHash: { actorId: actor.id, clientRequestKeyHash: key } } }) as ProbeRow | null;
  if (proof === null) fail("PERSONAL_CONNECTION_PROBE_REQUIRED");
  if (expectedProbeId !== undefined && proof.id !== expectedProbeId) fail("PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
  if (proof.actorAccountAccessVersion !== currentActor.accountAccessVersion || proof.actorId !== actor.id || proof.kind !== input.kind || proof.action !== input.action || proof.connectionId !== input.connectionId || proof.requestFingerprint !== requestFingerprintValue || !equalDigest(proof.configurationDigest, configurationDigestValue)) {
    fail("PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
  }
  if (proof.consumedAt !== null || proof.consumedConnectionId !== null) {
    // A consumed update proof is deliberately non-idempotent.  Returning its
    // outcome would let a retry execute the downstream connection write a
    // second time even though the one-use CAS already succeeded.
    if (input.action === "update") fail("PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
    if (proof.consumedConnectionId === consumedConnectionId && proof.status === "settled" && proof.safeErrorCode === null) {
      return { alreadyConsumedConnectionId: consumedConnectionId, outcome: { addressFingerprint: proof.resolvedAddressFingerprint, commitSha: proof.resultCommitSha, protocolVersion: proof.protocolVersion, catalogFingerprint: proof.catalogFingerprint, resultCount: proof.resultCount, resultSnapshot: proof.resultSnapshot } };
    }
    // A proof can only replay the exact connection mutation it already
    // authorized.  Returning another connection id here would let a caller
    // treat a consumed proof as a general capability for a second row.
    fail("PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
  }
  const now = new Date();
  if (proof.status !== "settled" || proof.safeErrorCode !== null || proof.evidenceExpiresAt === null) fail("PERSONAL_CONNECTION_PROBE_REQUIRED");
  if (proof.evidenceExpiresAt <= now) fail("PERSONAL_CONNECTION_PROBE_EXPIRED");
  const consumed = await tx.personalConnectionProbeAttempt.updateMany({
    where: { id: proof.id, actorId: actor.id, consumedAt: null, consumedConnectionId: null, status: "settled", safeErrorCode: null, evidenceExpiresAt: { gt: now } },
    data: { consumedAt: now, consumedConnectionId },
  });
  if (consumed.count !== 1) fail("PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_id', ${proof.id}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_actor_id', ${actor.id}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_connection_id', ${consumedConnectionId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_kind', ${proof.kind}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_action', ${proof.action}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_table', ${proof.kind === "git" ? "GitConnection" : "McpConnection"}, true)`;
  return { alreadyConsumedConnectionId: null, outcome: { addressFingerprint: proof.resolvedAddressFingerprint, commitSha: proof.resultCommitSha, protocolVersion: proof.protocolVersion, catalogFingerprint: proof.catalogFingerprint, resultCount: proof.resultCount, resultSnapshot: proof.resultSnapshot } };
}

export function probeFailureCode(error: unknown): string {
  if (error instanceof PersonalConnectionProbeError) return error.code;
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return "PERSONAL_CONNECTION_PROBE_FAILED";
}
