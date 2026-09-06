import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { CredentialVaultError, readCredentialSecret } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import {
  actionRevisionFromFingerprint,
  databaseNow,
  loadAction,
  loadActionRow,
  lockAdmission,
  ownerAdmission,
  persistedActionHashesValid,
  sourceSnapshotMatchesAction,
  validateGrantTuple,
  ProjectMcpActionServiceError,
  type ActionControlRow,
  type GrantRow,
} from "@/lib/project-mcp-action-service";
import { callMcpToolDetailed, type McpDetailedToolCallResult } from "@/lib/mcp/client";
import { McpCapabilityError } from "@/lib/mcp/errors";
import { stableMcpJson } from "@/lib/mcp/schema";
import { isSerializableTransactionConflict } from "@/lib/prisma-transaction";

const UUID = z.string().uuid();
const VERSION = z.number().int().positive();
const HASH = z.string().regex(/^[0-9a-f]{64}$/u);
const dispatchSchema = z.object({
  expectedStateVersion: VERSION,
  expectedActionRevision: HASH,
  acknowledgeSingleUse: z.literal(true),
}).strict();

const MCP_TRANSPORT_TIMEOUT_MS = 20_000;
const DISPATCH_RESERVATION_SLACK_MS = 40_000;
const DISPATCH_RESERVATION_MS = MCP_TRANSPORT_TIMEOUT_MS + DISPATCH_RESERVATION_SLACK_MS;
const MAX_SERIALIZABLE_RETRIES = 3;

export type ProjectMcpActionDispatchOutcome = "succeeded" | "failed" | "unknown" | "expired" | "invalidated";

export class ProjectMcpActionDispatchError extends Error {
  constructor(readonly code:
    | "PROJECT_MCP_ACTION_DISPATCH_INVALID_INPUT"
    | "PROJECT_MCP_ACTION_DISPATCH_CONFLICT"
    | "PROJECT_MCP_ACTION_DISPATCH_FAILED") {
    super(code);
    this.name = "ProjectMcpActionDispatchError";
  }
}

type Tx = Prisma.TransactionClient;
type Actor = Readonly<{ id: string; role: string }>;

function fail(code: ConstructorParameters<typeof ProjectMcpActionDispatchError>[0]): never {
  throw new ProjectMcpActionDispatchError(code);
}

function parseUuid(value: unknown): string {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : fail("PROJECT_MCP_ACTION_DISPATCH_INVALID_INPUT");
}

function parseActor(actor: Actor): string {
  return parseUuid(actor.id);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reservationTokenHash(value: string): string {
  return sha256(`project-mcp-action-dispatch-reservation:v1:${value}`);
}

function safeErrorCode(error: unknown, fallback = "MCP_DISPATCH_FAILED"): string {
  if (error instanceof McpCapabilityError) return error.code;
  if (error instanceof CredentialVaultError) return error.code;
  if (error instanceof ProjectMcpActionDispatchError) return error.code;
  return fallback;
}

async function withSerializableRetry<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializableTransactionConflict(error) && attempt + 1 < MAX_SERIALIZABLE_RETRIES) continue;
      if (isSerializableTransactionConflict(error)) return fail("PROJECT_MCP_ACTION_DISPATCH_CONFLICT");
      throw error;
    }
  }
  return fail("PROJECT_MCP_ACTION_DISPATCH_CONFLICT");
}

type DispatchAttemptRow = Readonly<{
  id: string;
  projectId: string;
  actionId: string;
  rpcRequestId: string;
  reservationTokenHash: string;
  status: "reserved" | "succeeded" | "failed" | "unknown" | "expired" | "invalidated";
  actionFingerprint: string;
  definitionFingerprint: string;
  networkFingerprint: string;
  credentialFingerprint: string;
  connectionConfigurationRevision: number;
  reservationExpiresAt: Date;
  boundaryReachedAt: Date | null;
  completedAt: Date | null;
}>;

type Reservation = Readonly<{
  kind: "reserved";
  actionId: string;
  projectId: string;
  attemptId: string;
  rpcRequestId: string;
  token: string;
  tokenHash: string;
}>;

type ReadyDispatch = Readonly<{
  kind: "ready";
  action: ActionControlRow;
  attempt: DispatchAttemptRow;
  endpointUrl: string;
  allowPrivateNetwork: boolean;
  credentialId: string | null;
  authKind: "none" | "bearer";
  toolName: string;
  inputSchema: unknown;
  outputSchema: unknown;
  networkFingerprint: string;
  credentialFingerprint: string;
  arguments: unknown;
}>;

type Replay = Readonly<{ kind: "replay"; action: Readonly<Record<string, unknown>> }>;

type Terminalized = Readonly<{ kind: "terminal"; action: Readonly<Record<string, unknown>> }>;

type TerminalRequest = Readonly<{
  kind: "terminalize";
  status: "unknown" | "expired" | "invalidated";
  safeErrorCode: string;
}>;

type BoundaryLockSeed = Readonly<{
  action: Readonly<{
    id: string;
    grantId: string;
    delegationId: string;
    attestationId: string;
    connectionId: string;
    toolDefinitionId: string;
    proposerProjectMembershipId: string;
    lastActorProjectMembershipId: string;
    lastActorId: string;
    connectionOwnerId: string;
  }>;
  actorIds: readonly string[];
  membershipIds: readonly string[];
}>;

function projectDispatchResult(result: McpDetailedToolCallResult): Readonly<{
  status: ProjectMcpActionDispatchOutcome;
  safeErrorCode: string | null;
  httpStatus: number | null;
  payload: unknown | null;
  resultFingerprint: string | null;
  resultBytes: number | null;
  resultNodes: number | null;
  resultDepth: number | null;
}> {
  if (result.outcome === "succeeded" && result.result !== undefined) {
    const payload = {
      text: result.result.text,
      structuredContent: result.result.structuredContent,
      omittedContentCount: result.result.omittedContentCount,
    };
    const encoded = JSON.stringify(stableMcpJson(payload));
    return Object.freeze({
      status: "succeeded",
      safeErrorCode: null,
      httpStatus: result.httpStatus,
      payload: stableMcpJson(payload),
      resultFingerprint: result.result.resultFingerprint,
      resultBytes: result.result.resultBytes ?? Buffer.byteLength(encoded, "utf8"),
      resultNodes: result.result.resultNodes ?? 1,
      resultDepth: result.result.resultDepth ?? 0,
    });
  }
  return Object.freeze({
    status: result.outcome,
    safeErrorCode: result.safeErrorCode ?? "MCP_DISPATCH_UNKNOWN",
    httpStatus: result.httpStatus,
    payload: null,
    resultFingerprint: null,
    resultBytes: null,
    resultNodes: null,
    resultDepth: null,
  });
}

async function appendRuntimeLedger(
  tx: Tx,
  action: ActionControlRow,
  statusBefore: string | null,
  attemptId: string | null,
  rpcRequestId: string | null,
  result: Readonly<{
    status: ProjectMcpActionDispatchOutcome | "dispatch_reserved";
    safeErrorCode?: string | null;
    resultFingerprint?: string | null;
    resultBytes?: number | null;
    resultNodes?: number | null;
    resultDepth?: number | null;
  }>,
): Promise<void> {
  await tx.projectMcpActionRuntimeLedger.create({
    data: {
      id: randomUUID(),
      projectId: action.projectId,
      actionId: action.id,
      attemptId,
      rpcRequestId,
      actorKind: "owner",
      actorId: action.lastActorId,
      actorProjectMembershipId: action.lastActorProjectMembershipId,
      actorMembershipCreatedAt: action.lastActorMembershipCreatedAt,
      event: result.status === "dispatch_reserved" ? "reserved" : result.status,
      statusBefore: statusBefore as never,
      statusAfter: (result.status === "dispatch_reserved" ? "dispatchReserved" : result.status) as never,
      stateVersion: action.stateVersion,
      actionFingerprint: action.actionFingerprint,
      definitionFingerprint: action.definitionFingerprint,
      networkFingerprint: action.networkFingerprint,
      credentialFingerprint: action.credentialFingerprint,
      connectionConfigurationRevision: action.connectionConfigurationRevision,
      safeErrorCode: result.safeErrorCode ?? null,
      resultFingerprint: result.resultFingerprint ?? null,
      resultBytes: result.resultBytes ?? null,
      resultNodes: result.resultNodes ?? null,
      resultDepth: result.resultDepth ?? null,
      transactionId: BigInt(0),
      transitionAt: new Date(0),
      createdAt: new Date(0),
    },
  });
}

async function loadAttempt(tx: Tx, projectId: string, actionId: string): Promise<DispatchAttemptRow | null> {
  return tx.projectMcpActionDispatchAttempt.findFirst({
    where: { projectId, actionId },
    select: {
      id: true,
      projectId: true,
      actionId: true,
      rpcRequestId: true,
      reservationTokenHash: true,
      status: true,
      actionFingerprint: true,
      definitionFingerprint: true,
      networkFingerprint: true,
      credentialFingerprint: true,
      connectionConfigurationRevision: true,
      reservationExpiresAt: true,
      boundaryReachedAt: true,
      completedAt: true,
    },
  });
}

async function terminalizeApprovedWithoutAttempt(
  tx: Tx,
  action: ActionControlRow,
  status: "expired" | "invalidated",
  actorId: string,
  membership: Readonly<{ id: string; createdAt: Date }>,
  safeCode: string,
): Promise<Terminalized> {
  const updated = await tx.projectMcpAction.updateMany({
    where: { id: action.id, projectId: action.projectId, status: "approved", stateVersion: action.stateVersion, actionFingerprint: action.actionFingerprint },
    data: {
      status,
      stateVersion: { increment: 1 },
      lastActorId: actorId,
      lastActorProjectMembershipId: membership.id,
      lastActorMembershipCreatedAt: membership.createdAt,
    },
  });
  if (updated.count !== 1) return Object.freeze({ kind: "terminal", action: await loadAction(tx, action.projectId, action.id, true) });
  const next = await loadActionRow(tx, action.projectId, action.id);
  await appendRuntimeLedger(tx, next, "approved", null, null, { status, safeErrorCode: safeCode });
  return Object.freeze({ kind: "terminal", action: await loadAction(tx, action.projectId, action.id, true) });
}

async function reserveDispatch(
  projectId: string,
  actionId: string,
  input: z.infer<typeof dispatchSchema>,
  actor: Actor,
  db: PrismaClient,
): Promise<Reservation | Replay | Terminalized> {
  const actorId = parseActor(actor);
  return withSerializableRetry(db, async (tx) => {
    await lockAdmission(tx, projectId, [actorId]);
    await ownerAdmission(tx, projectId, actorId, false);
    const seed = await tx.projectMcpAction.findFirst({ where: { projectId, id: actionId }, select: { id: true, grantId: true, delegationId: true, attestationId: true, connectionId: true, toolDefinitionId: true } });
    if (seed === null) throw new ProjectMcpActionServiceError("PROJECT_MCP_ACTION_NOT_FOUND");
    await lockAdmission(tx, projectId, [actorId], seed.connectionId, seed.toolDefinitionId, seed.grantId, seed.delegationId, seed.attestationId, undefined, seed.id);
    const { membership } = await ownerAdmission(tx, projectId, actorId, false);
    const action = await loadActionRow(tx, projectId, actionId);
    if (["dispatchReserved", "succeeded", "failed", "unknown", "expired", "invalidated"].includes(action.status)) {
      return Object.freeze({ kind: "replay", action: await loadAction(tx, projectId, actionId, true) });
    }
    if (action.status !== "approved" || action.stateVersion !== input.expectedStateVersion || actionRevisionFromFingerprint(action.actionFingerprint) !== input.expectedActionRevision) {
      return fail("PROJECT_MCP_ACTION_DISPATCH_CONFLICT");
    }
    const now = await databaseNow(tx);
    if (action.approvalExpiresAt === null || action.approvalExpiresAt.getTime() <= now.getTime()) {
      return terminalizeApprovedWithoutAttempt(tx, action, "expired", actorId, membership, "MCP_DISPATCH_APPROVAL_EXPIRED");
    }
    let grant: GrantRow;
    try {
      grant = await validateGrantTuple(tx, projectId, action.grantId, membership, 1);
    } catch (error) {
      if (error instanceof ProjectMcpActionServiceError && error.code === "PROJECT_MCP_ACTION_STALE") {
        return terminalizeApprovedWithoutAttempt(tx, action, "invalidated", actorId, membership, "MCP_DISPATCH_SOURCE_DRIFT");
      }
      throw error;
    }
    if (!sourceSnapshotMatchesAction(action, grant) || !await persistedActionHashesValid(tx, action)) {
      return terminalizeApprovedWithoutAttempt(tx, action, "invalidated", actorId, membership, "MCP_DISPATCH_SOURCE_DRIFT");
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = reservationTokenHash(token);
    const rpcRequestId = randomUUID();
    const updated = await tx.projectMcpAction.updateMany({
      where: { id: action.id, projectId, status: "approved", stateVersion: input.expectedStateVersion, actionFingerprint: action.actionFingerprint },
      data: {
        status: "dispatchReserved",
        stateVersion: { increment: 1 },
        lastActorId: actorId,
        lastActorProjectMembershipId: membership.id,
        lastActorMembershipCreatedAt: membership.createdAt,
      },
    });
    if (updated.count !== 1) return fail("PROJECT_MCP_ACTION_DISPATCH_CONFLICT");
    const reserved = await loadActionRow(tx, projectId, actionId);
    const attempt = await tx.projectMcpActionDispatchAttempt.create({
      data: {
        id: randomUUID(),
        projectId,
        actionId,
        actorKind: "owner",
        actorId: reserved.lastActorId,
        actorProjectMembershipId: reserved.lastActorProjectMembershipId,
        actorMembershipCreatedAt: reserved.lastActorMembershipCreatedAt,
        rpcRequestId,
        reservationTokenHash: tokenHash,
        status: "reserved",
        actionFingerprint: reserved.actionFingerprint,
        definitionFingerprint: reserved.definitionFingerprint,
        networkFingerprint: reserved.networkFingerprint,
        credentialFingerprint: reserved.credentialFingerprint,
        connectionConfigurationRevision: reserved.connectionConfigurationRevision,
        reservationTransactionId: BigInt(0),
        reservationExpiresAt: new Date(now.getTime() + DISPATCH_RESERVATION_MS),
        reservedAt: new Date(0),
        boundaryReachedAt: null,
        completedAt: null,
        safeErrorCode: null,
        httpStatus: null,
        resultFingerprint: null,
        resultBytes: null,
        resultNodes: null,
        resultDepth: null,
        createdAt: new Date(0),
      },
      select: { id: true, rpcRequestId: true },
    });
    await appendRuntimeLedger(tx, reserved, "approved", attempt.id, attempt.rpcRequestId, { status: "dispatch_reserved" });
    return Object.freeze({ kind: "reserved", actionId, projectId, attemptId: attempt.id, rpcRequestId: attempt.rpcRequestId, token, tokenHash });
  });
}

async function terminalizeReserved(
  projectId: string,
  actionId: string,
  tokenHash: string,
  status: ProjectMcpActionDispatchOutcome,
  result: Readonly<{
    safeErrorCode?: string | null;
    httpStatus?: number | null;
    payload?: unknown | null;
    resultFingerprint?: string | null;
    resultBytes?: number | null;
    resultNodes?: number | null;
    resultDepth?: number | null;
  }>,
  db: PrismaClient,
): Promise<Readonly<Record<string, unknown>>> {
  return withSerializableRetry(db, async (tx) => {
    const seed = await tx.projectMcpAction.findFirst({ where: { projectId, id: actionId }, select: { id: true, grantId: true, delegationId: true, attestationId: true, connectionId: true, toolDefinitionId: true } });
    if (seed === null) throw new ProjectMcpActionServiceError("PROJECT_MCP_ACTION_NOT_FOUND");
    await lockAdmission(tx, projectId, [], seed.connectionId, seed.toolDefinitionId, seed.grantId, seed.delegationId, seed.attestationId, undefined, actionId);
    const action = await loadActionRow(tx, projectId, actionId);
    const attempt = await loadAttempt(tx, projectId, actionId);
    if (attempt === null || attempt.reservationTokenHash !== tokenHash || attempt.status !== "reserved" || action.status !== "dispatchReserved" || action.stateVersion !== 3) {
      return loadAction(tx, projectId, actionId, true);
    }
    const updated = await tx.projectMcpAction.updateMany({
      where: { id: actionId, projectId, status: "dispatchReserved", stateVersion: 3, actionFingerprint: action.actionFingerprint },
      data: { status, stateVersion: { increment: 1 } },
    });
    if (updated.count !== 1) return loadAction(tx, projectId, actionId, true);
    const terminal = await loadActionRow(tx, projectId, actionId);
    await tx.projectMcpActionDispatchAttempt.update({
      where: { id: attempt.id },
      data: {
        status,
        safeErrorCode: result.safeErrorCode ?? null,
        httpStatus: result.httpStatus ?? null,
        resultFingerprint: status === "succeeded" ? null : result.resultFingerprint ?? null,
        resultBytes: status === "succeeded" ? null : result.resultBytes ?? null,
        resultNodes: status === "succeeded" ? null : result.resultNodes ?? null,
        resultDepth: status === "succeeded" ? null : result.resultDepth ?? null,
        completedAt: new Date(0),
      },
    });
    let persistedResult: { resultFingerprint: string; resultBytes: number; resultNodes: number; resultDepth: number } | null = null;
    if (status === "succeeded" && result.payload !== null && result.payload !== undefined) {
      await tx.projectMcpActionDispatchResult.create({
        data: {
          id: randomUUID(),
          projectId,
          actionId,
          sanitizedPayload: stableMcpJson(result.payload) as Prisma.InputJsonValue,
          // The database trigger derives these values from the JSONB payload.
          resultFingerprint: "0".repeat(64),
          resultBytes: 0,
          resultNodes: 1,
          resultDepth: 0,
          omittedContentCount: typeof result.payload === "object" && result.payload !== null && "omittedContentCount" in result.payload && typeof (result.payload as { omittedContentCount?: unknown }).omittedContentCount === "number" ? (result.payload as { omittedContentCount: number }).omittedContentCount : 0,
          createdAt: new Date(0),
        },
      });
      persistedResult = await tx.projectMcpActionDispatchResult.findUniqueOrThrow({
        where: { actionId },
        select: { resultFingerprint: true, resultBytes: true, resultNodes: true, resultDepth: true },
      });
    }
    await appendRuntimeLedger(tx, terminal, "dispatchReserved", attempt.id, attempt.rpcRequestId, {
      status,
      safeErrorCode: result.safeErrorCode ?? null,
      resultFingerprint: persistedResult?.resultFingerprint ?? null,
      resultBytes: persistedResult?.resultBytes ?? null,
      resultNodes: persistedResult?.resultNodes ?? null,
      resultDepth: persistedResult?.resultDepth ?? null,
    });
    return loadAction(tx, projectId, actionId, true);
  });
}

async function revalidateReservation(
  reservation: Reservation,
  actor: Actor,
  db: PrismaClient,
): Promise<ReadyDispatch | Replay | TerminalRequest> {
  const actorId = parseActor(actor);
  return withSerializableRetry(db, async (tx) => {
    const seed = await tx.projectMcpAction.findFirst({ where: { projectId: reservation.projectId, id: reservation.actionId }, select: { id: true, grantId: true, delegationId: true, attestationId: true, connectionId: true, toolDefinitionId: true } });
    if (seed === null) throw new ProjectMcpActionServiceError("PROJECT_MCP_ACTION_NOT_FOUND");
    await lockAdmission(tx, reservation.projectId, [actorId], seed.connectionId, seed.toolDefinitionId, seed.grantId, seed.delegationId, seed.attestationId, undefined, seed.id);
    const action = await loadActionRow(tx, reservation.projectId, reservation.actionId);
    const attempt = await loadAttempt(tx, reservation.projectId, reservation.actionId);
    if (attempt === null || attempt.id !== reservation.attemptId || attempt.reservationTokenHash !== reservation.tokenHash || attempt.status !== "reserved" || action.status !== "dispatchReserved" || action.stateVersion !== 3) {
      return Object.freeze({ kind: "replay", action: await loadAction(tx, reservation.projectId, reservation.actionId, true) });
    }
    let membership: { id: string; userId: string; createdAt: Date };
    try {
      membership = (await ownerAdmission(tx, reservation.projectId, actorId, false)).membership;
    } catch (error) {
      if (error instanceof Error && /PROJECT_MCP_ACTION_(PROJECT_OWNER_REQUIRED|ACCOUNT_DISABLED|PROJECT_ARCHIVED|FORBIDDEN)/u.test(error.message)) {
        return Object.freeze({ kind: "terminalize", status: "invalidated", safeErrorCode: "MCP_DISPATCH_OWNER_DRIFT" });
      }
      throw error;
    }
    if (action.lastActorId !== actorId || action.lastActorProjectMembershipId !== membership.id || action.lastActorMembershipCreatedAt.getTime() !== membership.createdAt.getTime()) {
      return Object.freeze({ kind: "terminalize", status: "invalidated", safeErrorCode: "MCP_DISPATCH_OWNER_EPOCH_DRIFT" });
    }
    const now = await databaseNow(tx);
    if (attempt.reservationExpiresAt.getTime() <= now.getTime()) {
      return Object.freeze({ kind: "terminalize", status: "unknown", safeErrorCode: "MCP_DISPATCH_RESERVATION_STALE" });
    }
    let grant: GrantRow;
    try {
      grant = await validateGrantTuple(tx, reservation.projectId, action.grantId, membership, 1);
    } catch (error) {
      if (error instanceof ProjectMcpActionServiceError && error.code === "PROJECT_MCP_ACTION_STALE") {
        return Object.freeze({ kind: "terminalize", status: "invalidated", safeErrorCode: "MCP_DISPATCH_SOURCE_DRIFT" });
      }
      throw error;
    }
    if (!sourceSnapshotMatchesAction(action, grant) || !await persistedActionHashesValid(tx, action)) {
      return Object.freeze({ kind: "terminalize", status: "invalidated", safeErrorCode: "MCP_DISPATCH_SOURCE_DRIFT" });
    }
    if (action.approvalExpiresAt === null || action.approvalExpiresAt.getTime() <= now.getTime()) {
      return Object.freeze({ kind: "terminalize", status: "expired", safeErrorCode: "MCP_DISPATCH_APPROVAL_EXPIRED" });
    }
    const [connection, definition] = await Promise.all([
      tx.mcpConnection.findUnique({
        where: { id: action.connectionId },
        select: { endpointUrl: true, allowPrivateNetwork: true, credentialId: true, authKind: true },
      }),
      tx.mcpToolDefinition.findFirst({
        where: { id: action.toolDefinitionId, connectionId: action.connectionId, name: action.toolName },
        select: { inputSchema: true, outputSchema: true, name: true },
      }),
    ]);
    if (connection === null || definition === null) {
      return Object.freeze({ kind: "terminalize", status: "invalidated", safeErrorCode: "MCP_DISPATCH_SOURCE_DRIFT" });
    }
    return Object.freeze({
      kind: "ready",
      action,
      attempt,
      endpointUrl: connection.endpointUrl,
      allowPrivateNetwork: connection.allowPrivateNetwork,
      credentialId: connection.credentialId,
      authKind: connection.authKind,
      toolName: definition.name,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      networkFingerprint: grant.networkFingerprint!,
      credentialFingerprint: grant.credentialFingerprint!,
      arguments: action.canonicalArguments,
    });
  });
}

async function loadBoundaryLockSeed(tx: Tx, reservation: Reservation, actorId: string): Promise<BoundaryLockSeed | null> {
  const action = await tx.projectMcpAction.findFirst({
    where: { id: reservation.actionId, projectId: reservation.projectId },
    select: {
      id: true,
      grantId: true,
      delegationId: true,
      attestationId: true,
      connectionId: true,
      toolDefinitionId: true,
      proposerProjectMembershipId: true,
      lastActorProjectMembershipId: true,
      lastActorId: true,
      connectionOwnerId: true,
    },
  });
  if (action === null) return null;
  const [grant, delegation, attestation] = await Promise.all([
    tx.projectMcpToolGrant.findFirst({
      where: { id: action.grantId, projectId: reservation.projectId, controlPlaneVersion: 2 },
      select: { managedById: true, grantorProjectMembershipId: true },
    }),
    tx.projectMcpConnectionDelegation.findFirst({
      where: { id: action.delegationId, projectId: reservation.projectId },
      select: {
        connectionOwnerId: true,
        projectConfirmedById: true,
        ownerProjectMembershipId: true,
        projectConfirmedProjectMembershipId: true,
      },
    }),
    tx.mcpToolAttestation.findUnique({ where: { id: action.attestationId }, select: { verifiedById: true } }),
  ]);
  if (grant === null || delegation === null || attestation === null || grant.grantorProjectMembershipId === null) return null;
  const membershipIds = [...new Set([
    action.proposerProjectMembershipId,
    action.lastActorProjectMembershipId,
    grant.grantorProjectMembershipId,
    delegation.ownerProjectMembershipId,
    delegation.projectConfirmedProjectMembershipId,
  ].filter((id): id is string => id !== null))].sort();
  const memberships = await tx.projectMembership.findMany({
    where: { id: { in: membershipIds } },
    select: { id: true, userId: true },
  });
  if (memberships.length !== membershipIds.length) return null;
  const actorIds = [...new Set([
    actorId,
    action.lastActorId,
    action.connectionOwnerId,
    grant.managedById,
    delegation.connectionOwnerId,
    delegation.projectConfirmedById,
    attestation.verifiedById,
    ...memberships.map((membership) => membership.userId),
  ].filter((id): id is string => id !== null))].sort();
  return Object.freeze({ action, actorIds, membershipIds });
}

async function lockBoundaryIdentityRows(tx: Tx, projectId: string, seed: BoundaryLockSeed): Promise<boolean> {
  const userRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "AppUser"
    WHERE "id" IN (${Prisma.join(seed.actorIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY "id"
    FOR UPDATE
  `);
  if (userRows.length !== seed.actorIds.length) return false;
  const membershipRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "ProjectMembership"
    WHERE "id" IN (${Prisma.join(seed.membershipIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY "id"
    FOR UPDATE
  `);
  if (membershipRows.length !== seed.membershipIds.length) return false;
  const projectRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Project" WHERE "id" = ${projectId}::uuid FOR UPDATE
  `);
  return projectRows.length === 1;
}

async function markDispatchBoundary(reservation: Reservation, ready: ReadyDispatch, actor: Actor, db: PrismaClient): Promise<boolean> {
  try {
    const actorId = parseActor(actor);
    const updated = await withSerializableRetry(db, async (tx) => {
      const seed = await loadBoundaryLockSeed(tx, reservation, actorId);
      if (seed === null) return [];
      // Acquire the same actor -> workspace -> project fence used by access,
      // grant, delegation, and lifecycle mutations before taking source rows.
      // Explicit row locks also fence direct account/membership mutations that
      // do not participate in the advisory-lock protocol.
      await lockAdmission(tx, reservation.projectId, seed.actorIds);
      if (!await lockBoundaryIdentityRows(tx, reservation.projectId, seed)) return [];
      await lockAdmission(
        tx,
        reservation.projectId,
        seed.actorIds,
        seed.action.connectionId,
        seed.action.toolDefinitionId,
        seed.action.grantId,
        seed.action.delegationId,
        seed.action.attestationId,
        undefined,
        seed.action.id,
      );
      const connection = await tx.mcpConnection.findUnique({
        where: { id: seed.action.connectionId },
        select: { credentialId: true },
      });
      if (connection === null) return [];
      if (connection.credentialId !== null) {
        const credentials = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "ExternalCredential" WHERE "id" = ${connection.credentialId}::uuid FOR UPDATE
        `);
        if (credentials.length !== 1) return [];
      }

      const action = await loadActionRow(tx, reservation.projectId, reservation.actionId);
      const attempt = await loadAttempt(tx, reservation.projectId, reservation.actionId);
      if (attempt === null
        || attempt.id !== reservation.attemptId
        || attempt.reservationTokenHash !== reservation.tokenHash
        || attempt.status !== "reserved"
        || attempt.boundaryReachedAt !== null
        || action.status !== "dispatchReserved"
        || action.stateVersion !== 3
        || action.lastActorId !== actorId
        || action.actionFingerprint !== ready.action.actionFingerprint) return [];
      let membership: { id: string; userId: string; createdAt: Date };
      try {
        membership = (await ownerAdmission(tx, reservation.projectId, actorId, false)).membership;
      } catch {
        return [];
      }
      if (action.lastActorProjectMembershipId !== membership.id
        || action.lastActorMembershipCreatedAt.getTime() !== membership.createdAt.getTime()) return [];
      let grant: GrantRow;
      try {
        grant = await validateGrantTuple(tx, reservation.projectId, action.grantId, membership, 1);
      } catch {
        return [];
      }
      if (!sourceSnapshotMatchesAction(action, grant) || !await persistedActionHashesValid(tx, action)) return [];

      return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "ProjectMcpActionDispatchAttempt" AS attempt
        SET "boundaryReachedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
        FROM "ProjectMcpAction" AS action
        JOIN "Project" AS project ON project."id" = action."projectId"
        WHERE attempt."id" = ${reservation.attemptId}::uuid
          AND attempt."projectId" = ${reservation.projectId}::uuid
          AND attempt."actionId" = ${reservation.actionId}::uuid
          AND attempt."reservationTokenHash" = ${reservation.tokenHash}
          AND attempt."status" = 'reserved'::"ProjectMcpActionDispatchAttemptStatus"
          AND attempt."boundaryReachedAt" IS NULL
          AND attempt."reservationExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
          AND action."id" = attempt."actionId"
          AND action."projectId" = attempt."projectId"
          AND action."status" = 'dispatch_reserved'::"ProjectMcpActionStatus"
          AND action."stateVersion" = 3
          AND action."actionFingerprint" = ${ready.action.actionFingerprint}
          AND action."approvalExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
          AND "project_mcp_action_source_tuple_valid"(action)
          AND "project_mcp_action_actor_valid"(
            action."projectId",
            action."lastActorId",
            action."lastActorProjectMembershipId",
            action."lastActorMembershipCreatedAt"
          )
          AND project."id" = attempt."projectId"
          AND project."archivedAt" IS NULL
        RETURNING attempt."id"
      `);
    });
    return updated.length === 1;
  } catch {
    // A failed DB-owned boundary check is fail-closed. No request object is
    // created, and the caller terminalizes the consumed reservation unknown.
    return false;
  }
}

async function dispatchReserved(reservation: Reservation, ready: ReadyDispatch, actor: Actor, db: PrismaClient): Promise<Readonly<Record<string, unknown>>> {
  let bearerToken: string | null = null;
  try {
    if (ready.authKind === "bearer") {
      if (ready.credentialId === null) throw new CredentialVaultError("CREDENTIAL_NOT_FOUND");
      bearerToken = await readCredentialSecret(ready.credentialId, "mcp", db, { expectedSecretFingerprint: ready.credentialFingerprint });
    }
  } catch (error) {
    return terminalizeReserved(ready.action.projectId, ready.action.id, reservation.tokenHash, "failed", { safeErrorCode: safeErrorCode(error, "MCP_CREDENTIAL_UNAVAILABLE") }, db);
  }

  let result: McpDetailedToolCallResult;
  try {
    result = await callMcpToolDetailed({
      endpointUrl: ready.endpointUrl,
      allowPrivateNetwork: ready.allowPrivateNetwork,
      expectedAddressFingerprint: ready.networkFingerprint,
      bearerToken,
      rpcRequestId: reservation.rpcRequestId,
      toolName: ready.toolName,
      inputSchema: ready.inputSchema,
      outputSchema: ready.outputSchema,
      arguments: ready.arguments,
      onDispatchBoundary: () => markDispatchBoundary(reservation, ready, actor, db),
    });
  } catch (error) {
    result = Object.freeze({ outcome: "unknown", requestId: reservation.rpcRequestId, safeErrorCode: safeErrorCode(error, "MCP_DISPATCH_UNKNOWN"), httpStatus: null });
  }
  const projected = projectDispatchResult(result);
  return terminalizeReserved(ready.action.projectId, ready.action.id, reservation.tokenHash, projected.status, projected, db);
}

export async function dispatchProjectMcpAction(
  projectIdInput: unknown,
  actionIdInput: unknown,
  input: unknown,
  actor: Actor,
  db: PrismaClient = getDb(),
): Promise<Readonly<Record<string, unknown>>> {
  const projectId = parseUuid(projectIdInput);
  const actionId = parseUuid(actionIdInput);
  const parsed = dispatchSchema.safeParse(input);
  if (!parsed.success) return fail("PROJECT_MCP_ACTION_DISPATCH_INVALID_INPUT");
  const reservation = await reserveDispatch(projectId, actionId, parsed.data, actor, db);
  if ("kind" in reservation && reservation.kind === "replay") return reservation.action;
  if ("kind" in reservation && reservation.kind === "terminal") return reservation.action;
  if (!("kind" in reservation) || reservation.kind !== "reserved") return fail("PROJECT_MCP_ACTION_DISPATCH_CONFLICT");
  const revalidated = await revalidateReservation(reservation, actor, db);
  if (revalidated.kind === "replay") return revalidated.action;
  if (revalidated.kind === "terminalize") {
    return terminalizeReserved(reservation.projectId, reservation.actionId, reservation.tokenHash, revalidated.status, { safeErrorCode: revalidated.safeErrorCode }, db);
  }
  if (revalidated.kind !== "ready") return fail("PROJECT_MCP_ACTION_DISPATCH_CONFLICT");
  return dispatchReserved(reservation, revalidated, actor, db);
}

/** Worker-safe reconciler: stale reservations become unknown, with no source
 * reads, credential decryption, MCP client call, or new attempt. */
export async function reconcileStaleProjectMcpActionDispatchReservations(
  db: PrismaClient = getDb(),
  maximum = 50,
): Promise<number> {
  let reconciled = 0;
  while (reconciled < maximum) {
    const done = await withSerializableRetry(db, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ projectId: string; actionId: string }>>(Prisma.sql`
        SELECT "projectId", "actionId"
        FROM "ProjectMcpActionDispatchAttempt"
        WHERE "status" = 'reserved'::"ProjectMcpActionDispatchAttemptStatus"
          AND "reservationExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
        ORDER BY "reservationExpiresAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const row = rows[0];
      if (row === undefined) return false;
      const action = await loadActionRow(tx, row.projectId, row.actionId);
      const attempt = await loadAttempt(tx, row.projectId, row.actionId);
      if (attempt === null || attempt.status !== "reserved" || action.status !== "dispatchReserved" || action.stateVersion !== 3) return true;
      await tx.projectMcpAction.updateMany({ where: { id: action.id, projectId: action.projectId, status: "dispatchReserved", stateVersion: 3, actionFingerprint: action.actionFingerprint }, data: { status: "unknown", stateVersion: { increment: 1 } } });
      const terminal = await loadActionRow(tx, action.projectId, action.id);
      await tx.projectMcpActionDispatchAttempt.update({ where: { id: attempt.id }, data: { status: "unknown", safeErrorCode: "MCP_DISPATCH_RESERVATION_STALE", completedAt: new Date(0) } });
      await appendRuntimeLedger(tx, terminal, "dispatchReserved", attempt.id, attempt.rpcRequestId, { status: "unknown", safeErrorCode: "MCP_DISPATCH_RESERVATION_STALE" });
      return true;
    });
    if (!done) break;
    reconciled += 1;
  }
  return reconciled;
}
