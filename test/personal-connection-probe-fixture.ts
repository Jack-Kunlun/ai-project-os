import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Client } from "pg";
import {
  consumePersonalConnectionProbe,
  runPersonalConnectionProbe,
  type PersonalConnectionProbeActor,
} from "../src/lib/personal-connection-probe-service";

const FIXTURE_FINGERPRINT = "a".repeat(64);

type FixtureDb = PrismaClient;
type FixtureTx = Prisma.TransactionClient;

function fixtureActor(ownerUserId: string, ownerAccountAccessVersion: number | null | undefined): PersonalConnectionProbeActor {
  return { id: ownerUserId, accountAccessVersion: ownerAccountAccessVersion ?? 1 };
}

function hashFixture(value: string): string {
  return createHash("sha256").update(`personal-connection-probe-fixture:${value}`, "utf8").digest("hex");
}

function requireConnectionIdentity(data: { id?: string; ownerUserId?: string | null; createdById?: string; ownerAccountAccessVersion?: number | null }): { id: string; ownerUserId: string; createdById: string; ownerAccountAccessVersion: number } {
  if (data.id === undefined || data.ownerUserId === null || data.ownerUserId === undefined || data.createdById === undefined) {
    throw new Error("PERSONAL_CONNECTION_PROBE_FIXTURE_OWNER_REQUIRED");
  }
  return {
    id: data.id,
    ownerUserId: data.ownerUserId,
    createdById: data.createdById,
    ownerAccountAccessVersion: data.ownerAccountAccessVersion ?? 1,
  };
}

async function createFixtureProbe(
  kind: "git" | "mcp",
  identity: ReturnType<typeof requireConnectionIdentity>,
  db: FixtureDb,
): Promise<{ actor: PersonalConnectionProbeActor; probeId: string; requestKey: string }> {
  const actor = fixtureActor(identity.ownerUserId, identity.ownerAccountAccessVersion);
  const requestKey = randomUUID();
  const probe = await runPersonalConnectionProbe({
    kind,
    action: "create",
    connectionId: null,
    clientRequestKey: requestKey,
    configuration: {
      fixture: "postgres-gate",
      kind,
      connectionId: identity.id,
    },
    secret: null,
  }, actor, async () => kind === "git"
    ? { addressFingerprint: FIXTURE_FINGERPRINT, commitSha: "b".repeat(40), resultSnapshot: {} }
    : { addressFingerprint: FIXTURE_FINGERPRINT, protocolVersion: "2025-06-18", catalogFingerprint: "c".repeat(64), resultCount: 0, resultSnapshot: [] }, db);
  if (probe.draftProbeId === null) throw new Error("PERSONAL_CONNECTION_PROBE_FIXTURE_PROBE_NOT_SETTLED");
  return { actor, probeId: probe.draftProbeId, requestKey };
}

export async function createGitConnectionFixture(
  data: Prisma.GitConnectionUncheckedCreateInput,
  db: FixtureDb,
): Promise<Prisma.GitConnectionGetPayload<object>> {
  const identity = requireConnectionIdentity(data);
  const { actor, probeId, requestKey } = await createFixtureProbe("git", identity, db);
  return db.$transaction(async (tx) => {
    await consumePersonalConnectionProbe({
      kind: "git",
      action: "create",
      connectionId: null,
      clientRequestKey: requestKey,
      configuration: { fixture: "postgres-gate", kind: "git", connectionId: identity.id },
      secret: null,
    }, actor, identity.id, tx, probeId);
    return tx.gitConnection.create({ data });
  });
}

export async function createMcpConnectionFixture(
  data: Prisma.McpConnectionUncheckedCreateInput,
  db: FixtureDb,
): Promise<Prisma.McpConnectionGetPayload<object>> {
  const identity = requireConnectionIdentity(data);
  const { actor, probeId, requestKey } = await createFixtureProbe("mcp", identity, db);
  return db.$transaction(async (tx) => {
    await consumePersonalConnectionProbe({
      kind: "mcp",
      action: "create",
      connectionId: null,
      clientRequestKey: requestKey,
      configuration: { fixture: "postgres-gate", kind: "mcp", connectionId: identity.id },
      secret: null,
    }, actor, identity.id, tx, probeId);
    return tx.mcpConnection.create({ data });
  });
}

export async function seedPersonalConnectionProbeCreateContext(
  tx: FixtureTx,
  input: Readonly<{
    kind: "git" | "mcp";
    actorId: string;
    actorAccountAccessVersion?: number;
    connectionId: string;
    expiresAt?: Date;
  }>,
): Promise<string> {
  const now = new Date();
  const proofId = randomUUID();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + 60_000);
  const table = input.kind === "git" ? "GitConnection" : "McpConnection";
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_mutation_context', 'service-v1', true)`;
  await tx.personalConnectionProbeAttempt.create({
    data: {
      id: proofId,
      kind: input.kind,
      action: "create",
      connectionId: null,
      actorId: input.actorId,
      actorAccountAccessVersion: input.actorAccountAccessVersion ?? 1,
      clientRequestKeyHash: hashFixture(`${proofId}:request`),
      requestFingerprint: hashFixture(`${proofId}:request-fingerprint`),
      configurationDigest: hashFixture(`${proofId}:configuration`),
      credentialSecretFingerprint: null,
      targetRepositoryPath: null,
      targetTrackedRef: null,
      resolvedAddressFingerprint: FIXTURE_FINGERPRINT,
      resultCommitSha: input.kind === "git" ? "b".repeat(40) : null,
      protocolVersion: input.kind === "mcp" ? "2025-06-18" : null,
      catalogFingerprint: input.kind === "mcp" ? "c".repeat(64) : null,
      resultCount: input.kind === "mcp" ? 0 : null,
      resultSnapshot: input.kind === "git" ? {} : [],
      status: "settled",
      safeErrorCode: null,
      evidenceExpiresAt: expiresAt,
      consumedAt: now,
      consumedConnectionId: input.connectionId,
      terminalAt: now,
    },
  });
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_id', ${proofId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_actor_id', ${input.actorId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_connection_id', ${input.connectionId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_kind', ${input.kind}, true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_action', 'create', true)`;
  await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_table', ${table}, true)`;
  return proofId;
}

export async function seedPersonalConnectionProbeCreateContextPg(
  client: Client,
  input: Readonly<{
    kind: "git" | "mcp";
    actorId: string;
    actorAccountAccessVersion?: number;
    connectionId: string;
  }>,
): Promise<string> {
  const proofId = randomUUID();
  const table = input.kind === "git" ? "GitConnection" : "McpConnection";
  await client.query("SELECT set_config('app.personal_connection_probe_mutation_context', 'service-v1', true)");
  await client.query(
    `INSERT INTO "PersonalConnectionProbeAttempt" (
       "id", "kind", "action", "connectionId", "actorId", "actorAccountAccessVersion",
       "clientRequestKeyHash", "requestFingerprint", "configurationDigest", "resolvedAddressFingerprint",
       "resultCommitSha", "protocolVersion", "catalogFingerprint", "resultCount", "resultSnapshot",
       "status", "evidenceExpiresAt", "consumedAt", "consumedConnectionId", "terminalAt"
     ) VALUES ($1::uuid, $2::"PersonalConnectionProbeKind", 'create', NULL, $3::uuid, $4,
       $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
       'settled'::"PersonalConnectionProbeStatus", CURRENT_TIMESTAMP + interval '60 seconds', CURRENT_TIMESTAMP, $14::uuid, CURRENT_TIMESTAMP)`,
    [
      proofId,
      input.kind,
      input.actorId,
      input.actorAccountAccessVersion ?? 1,
      hashFixture(`${proofId}:request`),
      hashFixture(`${proofId}:request-fingerprint`),
      hashFixture(`${proofId}:configuration`),
      FIXTURE_FINGERPRINT,
      input.kind === "git" ? "b".repeat(40) : null,
      input.kind === "mcp" ? "2025-06-18" : null,
      input.kind === "mcp" ? "c".repeat(64) : null,
      input.kind === "mcp" ? 0 : null,
      input.kind === "git" ? "{}" : "[]",
      input.connectionId,
    ],
  );
  await client.query("SELECT set_config('app.personal_connection_probe_id', $1, true)", [proofId]);
  await client.query("SELECT set_config('app.personal_connection_probe_actor_id', $1, true)", [input.actorId]);
  await client.query("SELECT set_config('app.personal_connection_probe_connection_id', $1, true)", [input.connectionId]);
  await client.query("SELECT set_config('app.personal_connection_probe_kind', $1, true)", [input.kind]);
  await client.query("SELECT set_config('app.personal_connection_probe_action', 'create', true)");
  await client.query("SELECT set_config('app.personal_connection_probe_table', $1, true)", [table]);
  return proofId;
}
