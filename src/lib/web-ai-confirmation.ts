import { createHash, createHmac, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { effectiveAiRouteSnapshot, type EffectiveAiRoute } from "@/lib/effective-ai-route";
import { getDb } from "@/lib/db";
import {
  isProjectAiPlatformProvider,
  projectAiProviderProjection,
  type ProjectAiPublicVisibility,
} from "@/lib/project-ai-public-projection";
import {
  withWebAiProjectAccessTransaction,
  type ProjectAccessAdmission,
  type WebAiActor,
} from "@/lib/access-linearization";

/**
 * The public action names are intentionally independent from Prisma's enum
 * spelling.  They are part of the API contract and must not be inferred from
 * a client supplied operation or route.
 */
export const WEB_AI_CONFIRMATION_ACTIONS = {
  memoryExtract: "memoryExtract",
  memoryIndex: "memoryIndex",
  memorySearch: "memorySearch",
  memoryAnswer: "memoryAnswer",
  assetRecognize: "assetRecognize",
  intelligenceBrief: "intelligenceBrief",
  intelligenceAgent: "intelligenceAgent",
} as const;

export type WebAiConfirmationAction = typeof WEB_AI_CONFIRMATION_ACTIONS[keyof typeof WEB_AI_CONFIRMATION_ACTIONS];

/** Prisma maps these public action names to snake_case PostgreSQL enum values. */
const actionDatabaseValues: Readonly<Record<WebAiConfirmationAction, string>> = Object.freeze({
  memoryExtract: "memory_extract",
  memoryIndex: "memory_index",
  memorySearch: "memory_search",
  memoryAnswer: "memory_answer",
  assetRecognize: "asset_recognize",
  intelligenceBrief: "intelligence_brief",
  intelligenceAgent: "intelligence_agent",
});
const actionPublicValues = new Set<string>(Object.values(WEB_AI_CONFIRMATION_ACTIONS));
const actionDatabaseToPublic = new Map<string, WebAiConfirmationAction>(
  Object.entries(actionDatabaseValues).map(([publicValue, databaseValue]) => [databaseValue, publicValue as WebAiConfirmationAction]),
);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hashPattern = /^[0-9a-f]{64}$/u;
const clientKeyPattern = /^[A-Za-z0-9._:-]{8,200}$/u;
const sensitiveKeyPattern = /(?:^|_)(?:body|content|prompt|secret|credential|token|password|sourceText|assetBody)(?:$|_)/iu;
const confirmationTtlMs = 10 * 60 * 1_000;
const HMAC_CONTEXT = "ai-project-os:web-ai-confirmation:v1";

export type WebAiConfirmationPreparation = Readonly<{
  contentVersion: string;
  inputFingerprintPayload: unknown;
  /** A normalized route snapshot. It is never returned to the browser. */
  routeSnapshot: unknown;
  /** Only action, route display, scope/count and expiry may be exposed. */
  safeSummary: Readonly<Record<string, unknown>>;
}>;

export type WebAiConfirmationView = Readonly<{
  challengeId: string;
  targetAction: WebAiConfirmationAction;
  issuedAt: string;
  expiresAt: string;
  safeSummary: Readonly<Record<string, unknown>>;
}>;

export type WebAiConfirmationExecuteInput = Readonly<{
  challengeId: unknown;
  clientKey: unknown;
  targetAction: WebAiConfirmationAction;
  contentVersion: string;
  inputFingerprintPayload: unknown;
  routeSnapshot: unknown;
}>;

export type WebAiConfirmationConsumeResult = Readonly<{
  challengeId: string;
  clientKeyHash: string;
  recoveredJobId: string | null;
}>;

export type WebAiConfirmationErrorCode =
  | "WEB_AI_CONFIRMATION_REQUIRED"
  | "WEB_AI_CONFIRMATION_EXPIRED"
  | "WEB_AI_CONFIRMATION_STALE"
  | "WEB_AI_CONFIRMATION_CONSUMED";

export class WebAiConfirmationError extends Error {
  constructor(readonly code: WebAiConfirmationErrorCode) {
    super(code);
    this.name = "WebAiConfirmationError";
  }
}

/**
 * Route data used in a challenge is an internal, non-secret fence.  It is
 * never returned by the API; credentialSecretFingerprint is a one-way
 * configuration fence, not a credential.
 */
export function confirmationRouteSnapshot(route: EffectiveAiRoute): Readonly<Record<string, unknown>> {
  return Object.freeze({
    operation: route.operation,
    providerConnectionId: route.providerConnectionId,
    modelId: route.modelId,
    embeddingDimensions: route.embeddingDimensions,
    maxOutputTokens: route.maxOutputTokens,
    route: effectiveAiRouteSnapshot(route),
  });
}

export function confirmationRouteDisplay(
  route: EffectiveAiRoute,
  visibility: ProjectAiPublicVisibility,
): Readonly<Record<string, unknown>> {
  const provider = route.providerConnection;
  const platform = isProjectAiPlatformProvider(provider);
  const connectionOwner = provider.scope === "user" && provider.ownerUserId === visibility.actorId;
  const projectedProvider = projectAiProviderProjection(provider, visibility);
  const routeDisplay = {
    source: route.source,
    ...(route.operation === "embedding" ? { dimensions: route.embeddingDimensions } : {}),
  };
  if (platform || connectionOwner) {
    return Object.freeze({
      ...routeDisplay,
      provider: {
        name: projectedProvider?.name ?? provider.name,
        kind: projectedProvider?.kind ?? provider.kind,
      },
      model: route.modelId,
    });
  }
  // Non-owners may see only the safe provider category/source, never the
  // personal connection name, model identifier, or connection ID.
  return Object.freeze({
    ...routeDisplay,
    provider: { kind: provider.kind },
  });
}

function fail(code: WebAiConfirmationErrorCode): never {
  throw new WebAiConfirmationError(code);
}

function assertAction(value: unknown): asserts value is WebAiConfirmationAction {
  if (typeof value !== "string" || !actionPublicValues.has(value)) return fail("WEB_AI_CONFIRMATION_REQUIRED");
}

function databaseActionValue(value: WebAiConfirmationAction): string {
  return actionDatabaseValues[value];
}

function publicActionValue(value: unknown): WebAiConfirmationAction {
  const action = actionDatabaseToPublic.get(typeof value === "string" ? value : "");
  if (action === undefined) return fail("WEB_AI_CONFIRMATION_REQUIRED");
  return action;
}

function assertUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) return fail("WEB_AI_CONFIRMATION_REQUIRED");
  return value.toLowerCase();
}

export function normalizeWebAiConfirmationId(value: unknown): string {
  return assertUuid(value);
}

function assertClientKey(value: unknown): string {
  if (typeof value !== "string" || !clientKeyPattern.test(value)) return fail("WEB_AI_CONFIRMATION_REQUIRED");
  return value;
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !hashPattern.test(value)) return fail("WEB_AI_CONFIRMATION_STALE");
}

/** Deterministic JSON encoding used by all confirmation and access fences. */
export function canonicalConfirmationValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(canonicalConfirmationValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalConfirmationValue(entry)]));
  }
  return String(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalConfirmationValue(value));
}

function assertNoSensitiveKeys(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveKeys(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) {
      throw new Error(`unsafe web AI confirmation material: ${path}.${key}`);
    }
    assertNoSensitiveKeys(entry, `${path}.${key}`);
  }
}

function validatePreparation(material: WebAiConfirmationPreparation): void {
  if (
    typeof material.contentVersion !== "string"
    || material.contentVersion.length < 1
    || material.contentVersion.length > 128
    || /[\u0000-\u001f\u007f]/u.test(material.contentVersion)
  ) return fail("WEB_AI_CONFIRMATION_STALE");
  if (typeof material.safeSummary !== "object" || material.safeSummary === null || Array.isArray(material.safeSummary)) {
    return fail("WEB_AI_CONFIRMATION_STALE");
  }
  assertNoSensitiveKeys(material.safeSummary);
  assertNoSensitiveKeys(material.inputFingerprintPayload);
  assertNoSensitiveKeys(material.routeSnapshot);
}

async function hmacFingerprint(value: unknown): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key).update(HMAC_CONTEXT, "utf8").update("\0", "utf8").update(canonicalJson(value), "utf8").digest("hex");
}

function actorAccessFingerprint(admission: ProjectAccessAdmission): string {
  return createHash("sha256")
    .update(canonicalJson({
      actorId: admission.actor.id,
      actorRole: admission.actor.role,
      actorAccountAccessVersion: admission.actor.accountAccessVersion,
      projectId: admission.project.id,
      workspaceId: admission.project.workspaceId,
      permission: admission.permission,
    }), "utf8")
    .digest("hex");
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return new Date();
  return now;
}

export function toPublicWebAiConfirmationView(row: Readonly<{
  id: string;
  targetAction: string;
  issuedAt: Date;
  expiresAt: Date;
  safeSummary: unknown;
}>): WebAiConfirmationView {
  assertAction(row.targetAction);
  const safeSummary = row.safeSummary as Readonly<Record<string, unknown>>;
  return Object.freeze({
    challengeId: row.id,
    targetAction: row.targetAction,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    safeSummary,
  });
}

export async function prepareWebAiConfirmation(input: Readonly<{
  projectId: string;
  actor: WebAiActor;
  targetAction: WebAiConfirmationAction;
  clientKey: unknown;
  resolve: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<WebAiConfirmationPreparation>;
  db?: PrismaClient;
}>): Promise<WebAiConfirmationView> {
  assertAction(input.targetAction);
  const clientKey = assertClientKey(input.clientKey);
  const preparedClientKeyHash = await clientKeyHash(clientKey);
  return withWebAiProjectAccessTransaction(input.db ?? getDb(), {
    actor: input.actor,
    projectId: input.projectId,
    required: "edit",
  }, async (tx, admission) => {
    const material = await input.resolve(tx, admission);
    validatePreparation(material);
    const routeSnapshot = canonicalConfirmationValue(material.routeSnapshot);
    const inputFingerprint = await hmacFingerprint({
      projectId: admission.project.id,
      targetAction: input.targetAction,
      contentVersion: material.contentVersion,
      input: material.inputFingerprintPayload,
      routeSnapshot,
    });
    const now = await databaseNow(tx);
    const challenge = await tx.webAiConfirmationChallenge.create({
      data: {
        id: randomUUID(),
        projectId: admission.project.id,
        actorId: admission.actor.id,
        actorAccountAccessVersion: admission.actor.accountAccessVersion,
        actorAccessFingerprint: actorAccessFingerprint(admission),
        targetAction: input.targetAction,
        contentVersion: material.contentVersion,
        inputFingerprint,
        routeSnapshot: routeSnapshot as Prisma.InputJsonValue,
        safeSummary: canonicalConfirmationValue(material.safeSummary) as Prisma.InputJsonValue,
        preparedClientKeyHash,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + confirmationTtlMs),
      },
      select: { id: true, targetAction: true, issuedAt: true, expiresAt: true, safeSummary: true },
    });
    return toPublicWebAiConfirmationView(challenge);
  });
}

type ChallengeRow = Readonly<{
  id: string;
  projectId: string;
  actorId: string;
  actorAccountAccessVersion: number;
  actorAccessFingerprint: string;
  targetAction: string;
  contentVersion: string;
  inputFingerprint: string;
  routeSnapshot: unknown;
  preparedClientKeyHash: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedJobId: string | null;
  consumedClientKeyHash: string | null;
}>;

async function lockChallenge(tx: Prisma.TransactionClient, challengeId: string): Promise<ChallengeRow | null> {
  const rows = await tx.$queryRaw<ChallengeRow[]>(Prisma.sql`
    SELECT
      "id"::text AS "id",
      "projectId"::text AS "projectId",
      "actorId"::text AS "actorId",
      "actorAccountAccessVersion" AS "actorAccountAccessVersion",
      "actorAccessFingerprint" AS "actorAccessFingerprint",
      "targetAction"::text AS "targetAction",
      "contentVersion" AS "contentVersion",
      "inputFingerprint" AS "inputFingerprint",
      "routeSnapshot" AS "routeSnapshot",
      "preparedClientKeyHash" AS "preparedClientKeyHash",
      "issuedAt" AS "issuedAt",
      "expiresAt" AS "expiresAt",
      "consumedAt" AS "consumedAt",
      "consumedJobId"::text AS "consumedJobId",
      "consumedClientKeyHash" AS "consumedClientKeyHash"
    FROM "WebAiConfirmationChallenge"
    WHERE "id" = ${challengeId}::uuid
    FOR UPDATE
  `);
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({ ...row, targetAction: publicActionValue(row.targetAction) });
}

function routeSnapshotMatches(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function clientKeyHash(clientKey: string): Promise<string> {
  return hmacFingerprint({ clientKey });
}

export async function validateWebAiConfirmation(
  tx: Prisma.TransactionClient,
  admission: ProjectAccessAdmission,
  input: WebAiConfirmationExecuteInput,
): Promise<Readonly<{
  row: ChallengeRow;
  clientKey: string;
  clientKeyHash: string;
  inputFingerprint: string;
  targetAction: WebAiConfirmationAction;
  contentVersion: string;
  actorAccountAccessVersion: number;
  actorAccessFingerprint: string;
  routeSnapshot: unknown;
}>> {
  assertAction(input.targetAction);
  const challengeId = assertUuid(input.challengeId);
  const clientKey = assertClientKey(input.clientKey);
  const row = await lockChallenge(tx, challengeId);
  if (row === null) return fail("WEB_AI_CONFIRMATION_REQUIRED");
  const expectedAccessFingerprint = actorAccessFingerprint(admission);
  const currentRouteSnapshot = canonicalConfirmationValue(input.routeSnapshot);
  const inputFingerprint = await hmacFingerprint({
    projectId: admission.project.id,
    targetAction: input.targetAction,
    contentVersion: input.contentVersion,
    input: input.inputFingerprintPayload,
    routeSnapshot: currentRouteSnapshot,
  });
  assertHash(row.inputFingerprint);
  assertHash(row.preparedClientKeyHash);
  const keyHash = await clientKeyHash(clientKey);

  if (
    row.projectId !== admission.project.id
    || row.actorId !== admission.actor.id
    || row.actorAccountAccessVersion !== admission.actor.accountAccessVersion
    || row.actorAccessFingerprint !== expectedAccessFingerprint
  ) return fail("WEB_AI_CONFIRMATION_REQUIRED");

  // Keep challenge existence and client-key ownership indistinguishable from
  // a missing challenge.  Only an authorized actor with the prepared key can
  // receive the more actionable drift/expiry/replay states below.
  if (row.preparedClientKeyHash !== keyHash) return fail("WEB_AI_CONFIRMATION_REQUIRED");

  if (
    row.targetAction !== input.targetAction
    || row.contentVersion !== input.contentVersion
    || row.inputFingerprint !== inputFingerprint
    || !routeSnapshotMatches(row.routeSnapshot, currentRouteSnapshot)
  ) return fail("WEB_AI_CONFIRMATION_STALE");

  if (row.consumedAt !== null) {
    if (row.consumedClientKeyHash === keyHash && row.consumedJobId !== null) {
      return Object.freeze({
        row,
        clientKey,
        clientKeyHash: keyHash,
        inputFingerprint,
        targetAction: input.targetAction,
        contentVersion: input.contentVersion,
        actorAccountAccessVersion: admission.actor.accountAccessVersion,
        actorAccessFingerprint: expectedAccessFingerprint,
        routeSnapshot: currentRouteSnapshot,
      });
    }
    return fail("WEB_AI_CONFIRMATION_CONSUMED");
  }
  const now = await databaseNow(tx);
  if (row.expiresAt.getTime() <= now.getTime()) return fail("WEB_AI_CONFIRMATION_EXPIRED");
  return Object.freeze({
    row,
    clientKey,
    clientKeyHash: keyHash,
    inputFingerprint,
    targetAction: input.targetAction,
    contentVersion: input.contentVersion,
    actorAccountAccessVersion: admission.actor.accountAccessVersion,
    actorAccessFingerprint: expectedAccessFingerprint,
    routeSnapshot: currentRouteSnapshot,
  });
}

/**
 * The challenge row is updated only after the primary job and grant have been
 * created in the same transaction. The database trigger checks that binding
 * before allowing this update, so a challenge can never become a bearer job
 * token or be consumed twice.
 */
export async function consumeWebAiConfirmation(
  tx: Prisma.TransactionClient,
  validated: Readonly<{
    row: ChallengeRow;
    clientKeyHash: string;
    targetAction: WebAiConfirmationAction;
    contentVersion: string;
    actorAccountAccessVersion: number;
    actorAccessFingerprint: string;
    routeSnapshot: unknown;
    inputFingerprint: string;
  }>,
  jobId: string,
  actorId: string,
): Promise<WebAiConfirmationConsumeResult> {
  const challengeId = assertUuid(validated.row.id);
  const parsedJobId = assertUuid(jobId);
  const parsedActorId = assertUuid(actorId);
  assertHash(validated.clientKeyHash);
  const current = await lockChallenge(tx, challengeId);
  if (current === null) return fail("WEB_AI_CONFIRMATION_REQUIRED");

  const matchesValidatedBindings = (
    row: ChallengeRow,
  ): boolean => row.projectId === validated.row.projectId
    && row.actorId === validated.row.actorId
    && row.actorId === parsedActorId
    && row.actorAccountAccessVersion === validated.actorAccountAccessVersion
    && row.actorAccessFingerprint === validated.actorAccessFingerprint
    && row.targetAction === validated.targetAction
    && row.contentVersion === validated.contentVersion
    && row.inputFingerprint === validated.inputFingerprint
    && routeSnapshotMatches(row.routeSnapshot, validated.routeSnapshot)
    && row.preparedClientKeyHash === validated.clientKeyHash;

  if (!matchesValidatedBindings(current)) return fail("WEB_AI_CONFIRMATION_REQUIRED");
  if (current.consumedAt !== null) {
    if (current.consumedClientKeyHash === validated.clientKeyHash && current.consumedJobId !== null) {
      return Object.freeze({ challengeId, clientKeyHash: validated.clientKeyHash, recoveredJobId: current.consumedJobId });
    }
    return fail("WEB_AI_CONFIRMATION_CONSUMED");
  }
  const now = await databaseNow(tx);
  if (current.expiresAt.getTime() <= now.getTime()) return fail("WEB_AI_CONFIRMATION_EXPIRED");

  await tx.$executeRaw`SELECT set_config('app.web_ai_confirmation_consume', '1', true)`;
  await tx.$executeRaw`SELECT set_config('app.web_ai_confirmation_challenge_id', ${challengeId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.web_ai_confirmation_consume_actor_id', ${parsedActorId}, true)`;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "WebAiConfirmationChallenge"
       SET "consumedAt" = clock_timestamp(),
           "consumedJobId" = ${parsedJobId}::uuid,
           "consumedClientKeyHash" = ${validated.clientKeyHash}
     WHERE "id" = ${challengeId}::uuid
       AND "consumedAt" IS NULL
       AND "projectId" = ${validated.row.projectId}::uuid
       AND "actorId" = ${parsedActorId}::uuid
       AND "actorAccountAccessVersion" = ${validated.actorAccountAccessVersion}
       AND "actorAccessFingerprint" = ${validated.actorAccessFingerprint}
       AND "targetAction" = ${databaseActionValue(validated.targetAction)}::"WebAiConfirmationAction"
       AND "contentVersion" = ${validated.contentVersion}
       AND "inputFingerprint" = ${validated.inputFingerprint}
       AND "routeSnapshot" = ${JSON.stringify(canonicalConfirmationValue(validated.routeSnapshot))}::jsonb
       AND "preparedClientKeyHash" = ${validated.clientKeyHash}
       AND "expiresAt" > clock_timestamp()
     RETURNING "id"::text AS "id"
  `;
  if (rows.length !== 1) {
    const currentAfterCas = await lockChallenge(tx, challengeId);
    if (currentAfterCas === null) return fail("WEB_AI_CONFIRMATION_REQUIRED");
    if (!matchesValidatedBindings(currentAfterCas)) return fail("WEB_AI_CONFIRMATION_REQUIRED");
    if (currentAfterCas.consumedAt !== null) {
      if (currentAfterCas.consumedClientKeyHash === validated.clientKeyHash && currentAfterCas.consumedJobId !== null) {
        return Object.freeze({ challengeId, clientKeyHash: validated.clientKeyHash, recoveredJobId: currentAfterCas.consumedJobId });
      }
      return fail("WEB_AI_CONFIRMATION_CONSUMED");
    }
    const nowAfterCas = await databaseNow(tx);
    return fail(currentAfterCas.expiresAt.getTime() <= nowAfterCas.getTime()
      ? "WEB_AI_CONFIRMATION_EXPIRED"
      : "WEB_AI_CONFIRMATION_CONSUMED");
  }
  return Object.freeze({ challengeId, clientKeyHash: validated.clientKeyHash, recoveredJobId: null });
}

export function confirmationActionForOperation(action: WebAiConfirmationAction): WebAiConfirmationAction {
  assertAction(action);
  return action;
}
