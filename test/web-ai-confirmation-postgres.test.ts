import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import test from "node:test";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import type { AiOperation, PrismaClient } from "@prisma/client";
import { issueVerifiedSignupGrant } from "../src/lib/ai-entitlements";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { getDb } from "../src/lib/db";
import { resolveEffectiveAiRoute } from "../src/lib/effective-ai-route";
import { cancelMemoryIndexJob } from "../src/lib/web-memory-index";
import {
  consumeWebAiConfirmation,
  confirmationActionForBackgroundJobKind,
  confirmationRouteDisplay,
  parseWebAiConfirmationSafeSummary,
  prepareWebAiConfirmation,
  toPublicWebAiConfirmationView,
  validateWebAiConfirmation,
  WEB_AI_CONFIRMATION_ACTION_BY_JOB_KIND,
  WebAiConfirmationError,
} from "../src/lib/web-ai-confirmation";
import {
  createGrantedWebAiJob,
} from "../src/lib/web-ai-governance";
import { withWebAiProjectAccessTransaction } from "../src/lib/access-linearization";
import {
  createConfirmedWebAiJobForPostgresGate,
  prepareConfirmedWebAiJobForPostgresGate,
  type ConfirmedWebAiJobInput,
} from "./web-ai-confirmation-fixture";
import { createSignupOfferFixture } from "./platform-grant-offer-policy-fixture";

const databaseUrl = process.env.DATABASE_URL;
const shouldRun = process.env.WEB_AI_CONFIRMATION_POSTGRES_GATE === "1"
  && typeof databaseUrl === "string"
  && databaseUrl.length > 0;

type ConfirmationFixture = Readonly<{
  workspaceId: string;
  actorId: string;
  projectId: string;
  providerId: string;
  credentialId: string;
  challengeId: string;
  driftChallengeId: string;
  jobId: string;
  grantId: string;
  inputFingerprint: string;
  clientKeyHash: string;
}>;

type FixtureOptions = Readonly<{ ttlMs?: number }>;

type WebAiServiceFixture = Readonly<{
  db: PrismaClient;
  actor: Readonly<{ id: string; role: "user"; accountAccessVersion: 1 }>;
  projectId: string;
  embeddingRoute: NonNullable<Awaited<ReturnType<typeof resolveEffectiveAiRoute>>>;
  generationRoute: NonNullable<Awaited<ReturnType<typeof resolveEffectiveAiRoute>>>;
}>;

async function createActiveGateRoute(
  db: PrismaClient,
  adminId: string,
  providerId: string,
  operation: AiOperation,
  modelId: string,
  options: Readonly<{ embeddingDimensions: number | null; maxOutputTokens: number | null }>,
) {
  const activeRoute = await db.platformDefaultAiRoute.findFirst({
    where: { operation, status: "active" },
    orderBy: [{ version: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (activeRoute !== null) {
    await db.platformDefaultAiRoute.update({
      where: { id: activeRoute.id },
      data: { status: "retired", updatedById: adminId },
    });
  }
  const latest = await db.platformDefaultAiRoute.findFirst({
    where: { operation },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return db.platformDefaultAiRoute.create({
    data: {
      operation,
      version: (latest?.version ?? 0) + 1,
      status: "active",
      providerConnectionId: providerId,
      modelId,
      embeddingDimensions: options.embeddingDimensions,
      maxOutputTokens: options.maxOutputTokens,
      quotaMultiplierBps: 10_000,
      validatedProviderConfigurationVersion: 1,
      validatedAt: new Date(),
      createdById: adminId,
      updatedById: adminId,
    },
  });
}

async function createWebAiServiceFixture(): Promise<WebAiServiceFixture> {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const actorId = randomUUID();
  const adminId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const providerId = randomUUID();
  const credentialId = randomUUID();
  const now = new Date();

  await db.appUser.createMany({
    data: [
      { id: actorId, username: `web_ai_service_actor_${suffix}`, role: "user" },
      { id: adminId, username: `web_ai_service_admin_${suffix}`, role: "admin" },
    ],
  });
  await createSignupOfferFixture(db, adminId);
  await db.workspace.create({
    data: { id: workspaceId, name: `Web AI service ${suffix}`, slug: `web-ai-service-${suffix}`, createdById: actorId },
  });
  await db.project.create({
    data: { id: projectId, workspaceId, name: `Web AI service project ${suffix}`, slug: `web-ai-service-project-${suffix}` },
  });
  await db.$transaction(async (tx) => {
    await grantWorkspaceMembership(tx, { workspaceId, userId: actorId, role: "owner", actorId, reason: "web_ai_confirmation_service_fixture" });
    await grantProjectMembership(tx, { projectId, workspaceId, userId: actorId, role: "owner", actorId, reason: "web_ai_confirmation_service_fixture" });
  });
  await issueVerifiedSignupGrant(actorId, { eligibilitySource: "verifiedGithub", issuedById: adminId, now }, db);
  await db.externalCredential.create({
    data: {
      id: credentialId,
      kind: "aiProvider",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.from([2]),
      authTag: Buffer.from([3]),
      maskedSuffix: "gate",
      secretFingerprint: "9".repeat(64),
    },
  });
  await db.aiProviderConnection.create({
    data: {
      id: providerId,
      name: `Web AI service provider ${suffix}`,
      kind: "glm",
      scope: "platform",
      ownerUserId: null,
      protocol: "chatCompletions",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      credentialId,
      defaultGenerationModelId: "glm-4-flash",
      defaultEmbeddingModelId: "embedding-3",
      embeddingDimensions: 1024,
      status: "verified",
      lastTestedAt: now,
    },
  });
  await createActiveGateRoute(db, adminId, providerId, "embedding", "embedding-3", { embeddingDimensions: 1024, maxOutputTokens: null });
  await createActiveGateRoute(db, adminId, providerId, "projectAnalysis", "glm-4-flash", { embeddingDimensions: null, maxOutputTokens: 128 });
  const embeddingRoute = await resolveEffectiveAiRoute(projectId, "embedding", db);
  const generationRoute = await resolveEffectiveAiRoute(projectId, "projectAnalysis", db);
  assert.ok(embeddingRoute);
  assert.ok(generationRoute);
  return Object.freeze({
    db,
    actor: { id: actorId, role: "user" as const, accountAccessVersion: 1 as const },
    projectId,
    embeddingRoute,
    generationRoute,
  });
}

test("R-11 safe summaries are strict, action-discriminated, and mapped once", () => {
  const generationRoute = { source: "platform_default", provider: { name: "Platform", kind: "glm" }, model: "platform-model" } as const;
  const embeddingRoute = { ...generationRoute, dimensions: 1536 } as const;
  const summaries = [
    { action: "memoryExtract", route: generationRoute, scope: { sourceCount: 1 } },
    { action: "memoryIndex", route: embeddingRoute, scope: { mode: "full", inputCount: 1, generateCount: 1, reuseCount: 0, deleteCount: 0, estimatedProviderCalls: 1 } },
    { action: "memorySearch", route: { embedding: embeddingRoute }, scope: { indexGenerationId: "generation-1" } },
    { action: "memoryAnswer", route: { embedding: embeddingRoute, generation: generationRoute }, scope: { indexGenerationId: "generation-1" } },
    { action: "assetRecognize", route: generationRoute, scope: { segmentCount: 1, mimeType: "image/png" } },
    { action: "intelligenceBrief", route: { embedding: embeddingRoute, generation: generationRoute }, scope: { indexGenerationId: "generation-1" } },
    { action: "intelligenceAgent", route: { embedding: embeddingRoute, generation: generationRoute }, scope: { indexGenerationId: "generation-1", questionProvided: true } },
  ] as const;
  for (const summary of summaries) {
    assert.equal(parseWebAiConfirmationSafeSummary(summary, summary.action).action, summary.action);
  }
  const extract = summaries[0];
  assert.throws(
    () => parseWebAiConfirmationSafeSummary({ ...extract, question: "不应进入摘要" }, "memoryExtract"),
    (error: unknown) => error instanceof WebAiConfirmationError && error.code === "WEB_AI_CONFIRMATION_STALE",
  );
  assert.throws(
    () => parseWebAiConfirmationSafeSummary({ ...extract, action: "memoryIndex" }, "memoryIndex"),
    (error: unknown) => error instanceof WebAiConfirmationError && error.code === "WEB_AI_CONFIRMATION_STALE",
  );
  assert.throws(
    () => parseWebAiConfirmationSafeSummary({ ...summaries[1], route: generationRoute }, "memoryIndex"),
    (error: unknown) => error instanceof WebAiConfirmationError && error.code === "WEB_AI_CONFIRMATION_STALE",
  );
  assert.throws(
    () => parseWebAiConfirmationSafeSummary({ ...extract, route: embeddingRoute }, "memoryExtract"),
    (error: unknown) => error instanceof WebAiConfirmationError && error.code === "WEB_AI_CONFIRMATION_STALE",
  );
  assert.throws(
    () => parseWebAiConfirmationSafeSummary({ ...extract, route: { ...generationRoute, modelId: "enumeration-leak" } }, "memoryExtract"),
    (error: unknown) => error instanceof WebAiConfirmationError && error.code === "WEB_AI_CONFIRMATION_STALE",
  );
  assert.deepEqual(WEB_AI_CONFIRMATION_ACTION_BY_JOB_KIND, {
    autoExtract: "memoryExtract",
    memoryIndex: "memoryIndex",
    semanticSearch: "memorySearch",
    ragAnswer: "memoryAnswer",
    assetExtract: "assetRecognize",
    projectBrief: "intelligenceBrief",
    projectAgent: "intelligenceAgent",
  });
  assert.equal(confirmationActionForBackgroundJobKind("githubScan"), null);
});

test(
  "R-11 production execute is exactly once and queued memory-index jobs require cancel then reprepare",
  { skip: !shouldRun ? "WEB_AI_CONFIRMATION_POSTGRES_GATE=1 and DATABASE_URL are required" : false },
  async () => {
    const fixture = await createWebAiServiceFixture();
    const { db, actor, projectId, embeddingRoute } = fixture;
    const reservationCountBefore = await db.platformTokenReservation.count();
    const ledgerCountBefore = await db.platformTokenLedgerEntry.count();
    let afterCreateCount = 0;
    const productionInput: ConfirmedWebAiJobInput = {
      projectId,
      kind: "memoryIndex" as const,
      route: embeddingRoute,
      requestedBy: actor,
      clientKey: `service-concurrent-${randomUUID()}`,
      scopeKind: "projectMemory" as const,
      scopeIds: { projectId, sourceCount: 1 },
      manifestFingerprint: "a".repeat(64),
      payload: { operation: "memory-index" },
      afterCreate: async (tx, jobId, grantId) => {
        afterCreateCount += 1;
        const grant = await tx.webAiGrant.findUniqueOrThrow({
          where: { id: grantId },
          select: { manifestFingerprint: true },
        });
        await tx.memoryIndexGeneration.create({
          data: {
            projectId,
            jobId,
            providerConnectionId: embeddingRoute.providerConnectionId,
            modelId: embeddingRoute.modelId,
            dimensions: embeddingRoute.embeddingDimensions!,
            status: "staging",
            buildMode: "full",
            inputManifestFingerprint: grant.manifestFingerprint,
            expectedInputCount: 1,
            expectedEmbeddingRouteUpdatedAt: embeddingRoute.routeUpdatedAt,
            expectedEmbeddingRouteSource: embeddingRoute.source,
            expectedEmbeddingRouteId: embeddingRoute.routeId,
            expectedEmbeddingRouteVersion: embeddingRoute.routeVersion,
            expectedEmbeddingProviderConfigurationVersion: embeddingRoute.providerConfigurationVersion,
            expectedEmbeddingConnectionOwnerAccountAccessVersion: embeddingRoute.source === "personal_delegation"
              ? embeddingRoute.personalEvidence?.connectionOwnerAccountAccessVersion ?? null
              : null,
            expectedEmbeddingRouteFenceFingerprint: embeddingRoute.routeFenceFingerprint,
            embeddingWebAiGrantId: embeddingRoute.source === "personal_delegation" ? grantId : null,
          },
        });
      },
    };
    const prepared = await prepareConfirmedWebAiJobForPostgresGate(productionInput, db);
    const execute = () => createGrantedWebAiJob({ ...prepared.input, confirmation: prepared.confirmation }, db);
    const outcomes = await Promise.all([execute(), execute()]);
    assert.deepEqual(outcomes.map((outcome) => outcome.created).sort(), [false, true]);
    assert.equal(outcomes[0]?.jobId, outcomes[1]?.jobId);
    assert.equal(outcomes[0]?.grantId, outcomes[1]?.grantId);
    assert.equal(afterCreateCount, 1);
    const jobId = outcomes[0]!.jobId;
    const grantId = outcomes[0]!.grantId;
    assert.equal(await db.backgroundJob.count({ where: { projectId, id: jobId, kind: "memoryIndex" } }), 1);
    assert.equal(await db.webAiGrant.count({ where: { projectId, boundJobId: jobId } }), 1);
    assert.equal(await db.backgroundJobAttempt.count({ where: { jobId } }), 0);
    assert.equal(await db.providerCallAudit.count({ where: { jobId } }), 0);
    const consumedChallenge = await db.webAiConfirmationChallenge.findUniqueOrThrow({ where: { id: prepared.confirmation.challengeId } });
    assert.equal(consumedChallenge.consumedJobId, jobId);
    assert.equal(consumedChallenge.consumedClientKeyHash?.length, 64);

    const cancelled = await cancelMemoryIndexJob(projectId, jobId, actor, db);
    assert.equal(cancelled.status, "cancelled");
    const cancelledGeneration = await db.memoryIndexGeneration.findUniqueOrThrow({ where: { projectId_jobId: { projectId, jobId } } });
    assert.equal(cancelledGeneration.status, "failed");
    assert.equal(cancelledGeneration.failureCode, "MEMORY_INDEX_CANCELLED");
    assert.equal(await db.backgroundJobAttempt.count({ where: { jobId } }), 0, "cancelled queued work was never claimed");
    const cancelledReplay = await execute();
    assert.deepEqual(cancelledReplay, { jobId, grantId, created: false });
    assert.equal(await db.backgroundJobAttempt.count({ where: { jobId } }), 0, "replaying a consumed challenge cannot claim cancelled work");
    assert.equal(await db.providerCallAudit.count({ where: { jobId } }), 0, "replaying a consumed challenge cannot dispatch a provider call");

    const reprepared = await createConfirmedWebAiJobForPostgresGate({
      ...productionInput,
      clientKey: `service-reprepare-${randomUUID()}`,
      scopeIds: { projectId, sourceCount: 1, reprepare: true },
      manifestFingerprint: "b".repeat(64),
    }, db);
    assert.equal(reprepared.created, true);
    assert.notEqual(reprepared.jobId, jobId);
    assert.equal(await db.backgroundJob.count({ where: { projectId, kind: "memoryIndex" } }), 2);
    const reprepareChallenge = await db.webAiConfirmationChallenge.findFirstOrThrow({ where: { consumedJobId: reprepared.jobId } });
    assert.notEqual(reprepareChallenge.id, prepared.confirmation.challengeId);
    assert.equal(await db.backgroundJobAttempt.count({ where: { jobId: reprepared.jobId } }), 0);
    assert.equal(await db.providerCallAudit.count({ where: { jobId: reprepared.jobId } }), 0);
    assert.equal(await db.platformTokenReservation.count(), reservationCountBefore);
    assert.equal(await db.platformTokenLedgerEntry.count(), ledgerCountBefore);
    assert.equal(grantId.length, 36);
  },
);

test(
  "R-11 job, supplemental grant, staging resource, ledger, and challenge roll back together on afterCreate failure",
  { skip: !shouldRun ? "WEB_AI_CONFIRMATION_POSTGRES_GATE=1 and DATABASE_URL are required" : false },
  async () => {
    const fixture = await createWebAiServiceFixture();
    const { db, actor, projectId, embeddingRoute, generationRoute } = fixture;
    const reservationCountBefore = await db.platformTokenReservation.count();
    const ledgerCountBefore = await db.platformTokenLedgerEntry.count();
    const manifestFingerprint = "c".repeat(64);
    const prepared = await prepareConfirmedWebAiJobForPostgresGate({
      projectId,
      kind: "memoryIndex",
      route: embeddingRoute,
      requestedBy: actor,
      clientKey: `service-after-create-failure-${randomUUID()}`,
      scopeKind: "projectMemory",
      scopeIds: { projectId, rollback: true },
      manifestFingerprint,
      payload: { operation: "memory-index-rollback" },
      supplemental: {
        route: generationRoute,
        scopeKind: "projectIntelligence",
        scopeIds: { projectId, supplemental: true },
        manifestFingerprint: "d".repeat(64),
      },
      afterCreate: async (tx, jobId, grantId) => {
        await tx.memoryIndexGeneration.create({
          data: {
            projectId,
            jobId,
            providerConnectionId: embeddingRoute.providerConnectionId,
            modelId: embeddingRoute.modelId,
            dimensions: embeddingRoute.embeddingDimensions!,
            status: "staging",
            buildMode: "full",
            inputManifestFingerprint: manifestFingerprint,
            expectedInputCount: 1,
            expectedEmbeddingRouteUpdatedAt: embeddingRoute.routeUpdatedAt,
            expectedEmbeddingRouteSource: embeddingRoute.source,
            expectedEmbeddingRouteId: embeddingRoute.routeId,
            expectedEmbeddingRouteVersion: embeddingRoute.routeVersion,
            expectedEmbeddingProviderConfigurationVersion: embeddingRoute.providerConfigurationVersion,
            expectedEmbeddingConnectionOwnerAccountAccessVersion: embeddingRoute.source === "personal_delegation"
              ? embeddingRoute.personalEvidence?.connectionOwnerAccountAccessVersion ?? null
              : null,
            expectedEmbeddingRouteFenceFingerprint: embeddingRoute.routeFenceFingerprint,
            embeddingWebAiGrantId: embeddingRoute.source === "personal_delegation" ? grantId : null,
          },
        });
        throw new Error("R11_AFTER_CREATE_ROLLBACK");
      },
    }, db);

    await assert.rejects(
      () => createGrantedWebAiJob({ ...prepared.input, confirmation: prepared.confirmation }, db),
      /R11_AFTER_CREATE_ROLLBACK/u,
    );
    assert.equal(await db.backgroundJob.count({ where: { projectId } }), 0);
    assert.equal(await db.webAiGrant.count({ where: { projectId } }), 0);
    assert.equal(await db.memoryIndexGeneration.count({ where: { projectId } }), 0);
    const challenge = await db.webAiConfirmationChallenge.findUniqueOrThrow({ where: { id: prepared.confirmation.challengeId } });
    assert.equal(challenge.consumedAt, null);
    assert.equal(challenge.consumedJobId, null);
    assert.equal(challenge.consumedClientKeyHash, null);
    assert.equal(await db.platformTokenReservation.count(), reservationCountBefore);
    assert.equal(await db.platformTokenLedgerEntry.count(), ledgerCountBefore);
  },
);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function query<T extends QueryResultRow = QueryResultRow>(
  client: Client,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return client.query(text, values);
}

type ChallengeState = Readonly<{
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

async function readChallengeState(client: Client, challengeId: string): Promise<ChallengeState> {
  const result = await query<ChallengeState>(client, `
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
    WHERE "id" = $1::uuid
  `, [challengeId]);
  const row = result.rows[0];
  assert.ok(row, `challenge ${challengeId} should exist`);
  return row;
}

async function createFixture(client: Client, options: FixtureOptions = {}): Promise<ConfirmationFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const actorId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const providerId = randomUUID();
  const routeId = randomUUID();
  const credentialId = randomUUID();
  const challengeId = randomUUID();
  const driftChallengeId = randomUUID();
  const jobId = randomUUID();
  const grantId = randomUUID();
  const inputFingerprint = "a".repeat(64);
  const clientKeyHash = "b".repeat(64);
  const ttlMs = options.ttlMs ?? 10 * 60 * 1_000;

  await query(client, `
    INSERT INTO "AppUser" ("id", "username", "role", "updatedAt")
    VALUES ($1::uuid, $2, 'user', CURRENT_TIMESTAMP)
  `, [actorId, `web_ai_confirmation_${suffix}`]);
  await query(client, `
    INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt")
    VALUES ($1::uuid, $2, $3, $4::uuid, CURRENT_TIMESTAMP)
  `, [workspaceId, `Web AI confirmation ${suffix}`, `web-ai-confirmation-${suffix}`, actorId]);
  await query(client, `
    INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt")
    VALUES ($1::uuid, $2::uuid, $3, $4, CURRENT_TIMESTAMP)
  `, [projectId, workspaceId, `Web AI confirmation project ${suffix}`, `web-ai-confirmation-${suffix}`]);
  await query(client, `
    INSERT INTO "ExternalCredential"
      ("id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "updatedAt")
    VALUES ($1::uuid, 'ai_provider', decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'), 'confirm', $2, CURRENT_TIMESTAMP)
  `, [credentialId, "c".repeat(64)]);
  await query(client, `
    INSERT INTO "AiProviderConnection"
      ("id", "name", "kind", "scope", "ownerUserId", "baseUrl", "credentialId", "defaultGenerationModelId", "status", "updatedAt")
    VALUES ($1::uuid, $2, 'glm', 'platform', NULL, 'https://open.bigmodel.cn/api/paas/v4', $3::uuid, 'glm-4-flash', 'verified', CURRENT_TIMESTAMP)
  `, [providerId, `Confirmation provider ${suffix}`, credentialId]);
  await query(client, `
    INSERT INTO "WebAiConfirmationChallenge"
      ("id", "projectId", "actorId", "actorAccountAccessVersion", "actorAccessFingerprint", "targetAction", "contentVersion", "inputFingerprint", "routeSnapshot", "safeSummary", "preparedClientKeyHash", "issuedAt", "expiresAt")
    VALUES
      ($1::uuid, $2::uuid, $3::uuid, 1, $4, 'memory_extract', 'content-v1', $5, '{"routeVersion":1,"modelId":"glm-4-flash"}'::jsonb, '{"action":"memoryExtract","route":{"source":"platform_default","provider":{"name":"Confirmation provider","kind":"glm"},"model":"glm-4-flash"},"scope":{"sourceCount":1}}'::jsonb, $8, clock_timestamp(), clock_timestamp() + ($9::double precision * INTERVAL '1 millisecond')),
      ($6::uuid, $2::uuid, $3::uuid, 1, $4, 'memory_extract', 'content-v1', $7, '{"routeVersion":1,"modelId":"glm-4-flash"}'::jsonb, '{"action":"memoryExtract","route":{"source":"platform_default","provider":{"name":"Confirmation provider","kind":"glm"},"model":"glm-4-flash"},"scope":{"sourceCount":1}}'::jsonb, $8, clock_timestamp(), clock_timestamp() + ($9::double precision * INTERVAL '1 millisecond'))
    `, [challengeId, projectId, actorId, "d".repeat(64), inputFingerprint, driftChallengeId, "e".repeat(64), clientKeyHash, ttlMs]);
  await query(client, `
    INSERT INTO "BackgroundJob"
      ("id", "projectId", "kind", "payload", "idempotencyKey", "requestedById")
    VALUES ($1::uuid, $2::uuid, 'auto_extract', '{}'::jsonb, $3, $4::uuid)
  `, [jobId, projectId, `confirmation-${suffix}`, actorId]);
  await query(client, `
    INSERT INTO "WebAiGrant"
      ("id", "projectId", "operation", "scopeKind", "scopeIds", "manifestFingerprint", "providerConnectionId", "modelId", "consentVersion", "issuedById", "billingMode", "billingUserId", "boundJobId", "confirmationChallengeId", "routeSource", "routeId", "routeVersion", "routeUpdatedAt", "providerConfigurationVersion", "quotaMultiplierBps", "routeFenceFingerprint", "credentialSecretFingerprint", "payerKind", "payerProviderConnectionId", "maxOutputTokens", "expiresAt")
    VALUES ($1::uuid, $2::uuid, 'autoExtract', 'project_sources', '{}'::jsonb, $3, $4::uuid, 'glm-4-flash', 'web-ai-transfer-consent:v1', $5::uuid, 'platform', $5::uuid, $6::uuid, $7::uuid, 'platform_default', $8::uuid, 1, CURRENT_TIMESTAMP, 1, 10000, $9, $10, 'platform_caller', $11::uuid, 128, CURRENT_TIMESTAMP + INTERVAL '1 day')
  `, [grantId, projectId, "f".repeat(64), providerId, actorId, jobId, challengeId, routeId, "7".repeat(64), "c".repeat(64), providerId]);
  await query(client, `UPDATE "BackgroundJob" SET "webAiGrantId" = $2::uuid WHERE "id" = $1::uuid`, [jobId, grantId]);

  return Object.freeze({
    workspaceId,
    actorId,
    projectId,
    providerId,
    credentialId,
    challengeId,
    driftChallengeId,
    jobId,
    grantId,
    inputFingerprint,
    clientKeyHash,
  });
}

async function consumeOnce(
  fixture: ConfirmationFixture,
  options: Readonly<{ clientKeyHash?: string; jobId?: string; challengeId?: string }> = {},
): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await query(client, "BEGIN");
    await query(client, "SELECT set_config('app.web_ai_confirmation_consume', '1', true)");
    await query(client, "SELECT set_config('app.web_ai_confirmation_challenge_id', $1, true)", [fixture.challengeId]);
    await query(client, "SELECT set_config('app.web_ai_confirmation_consume_actor_id', $1, true)", [fixture.actorId]);
    const result = await query(client, `
      UPDATE "WebAiConfirmationChallenge"
         SET "consumedAt" = clock_timestamp(),
             "consumedJobId" = $1::uuid,
             "consumedClientKeyHash" = $2
       WHERE "id" = $3::uuid
         AND "consumedAt" IS NULL
         AND "projectId" = $4::uuid
         AND "actorId" = $5::uuid
         AND "inputFingerprint" = $6
         AND "preparedClientKeyHash" = $2
         AND "expiresAt" > clock_timestamp()
       RETURNING "id"
    `, [options.jobId ?? fixture.jobId, options.clientKeyHash ?? fixture.clientKeyHash, options.challengeId ?? fixture.challengeId, fixture.projectId, fixture.actorId, fixture.inputFingerprint]);
    await query(client, "COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await query(client, "ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

test(
  "R-11 consumes a challenge exactly once and concurrent executes recover the same job",
  { skip: !shouldRun ? "WEB_AI_CONFIRMATION_POSTGRES_GATE=1 and DATABASE_URL are required" : false },
  async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    let fixture: ConfirmationFixture;
    try {
      fixture = await createFixture(client);
    } finally {
      await client.end();
    }

    const wrongKey = await consumeOnce(fixture, { clientKeyHash: "a".repeat(64) });
    assert.equal(wrongKey, false, "a different prepared client key must not consume the challenge");

    const outcomes = await Promise.all([consumeOnce(fixture), consumeOnce(fixture)]);
    assert.deepEqual(outcomes.sort(), [false, true]);

    const state = new Client({ connectionString: databaseUrl });
    await state.connect();
    try {
      const consumed = await query<{ consumedJobId: string | null; consumedClientKeyHash: string | null }>(state, `
        SELECT "consumedJobId"::text AS "consumedJobId", "consumedClientKeyHash"
          FROM "WebAiConfirmationChallenge"
         WHERE "id" = $1::uuid
      `, [fixture.challengeId]);
      assert.equal(consumed.rows[0]?.consumedJobId, fixture.jobId);
      assert.equal(consumed.rows[0]?.consumedClientKeyHash, fixture.clientKeyHash);

      const replay = await query<{ jobId: string }>(state, `
        SELECT c."consumedJobId"::text AS "jobId"
          FROM "WebAiConfirmationChallenge" c
         WHERE c."id" = $1::uuid
           AND c."consumedClientKeyHash" = $2
      `, [fixture.challengeId, fixture.clientKeyHash]);
      assert.deepEqual(replay.rows, [{ jobId: fixture.jobId }]);

      const attemptedOtherJob = await consumeOnce(fixture, {
        clientKeyHash: fixture.clientKeyHash,
        jobId: randomUUID(),
      });
      assert.equal(attemptedOtherJob, false, "the prepared key can only recover the original consumed job");
      const unchanged = await query<{ consumedJobId: string | null }>(state, `
        SELECT "consumedJobId"::text AS "consumedJobId"
          FROM "WebAiConfirmationChallenge"
         WHERE "id" = $1::uuid
      `, [fixture.challengeId]);
      assert.equal(unchanged.rows[0]?.consumedJobId, fixture.jobId);

      const drift = await query<{ id: string }>(state, `
        UPDATE "WebAiConfirmationChallenge"
           SET "consumedAt" = clock_timestamp(),
               "consumedJobId" = $1::uuid,
               "consumedClientKeyHash" = $2
         WHERE "id" = $3::uuid
           AND "consumedAt" IS NULL
           AND "projectId" = $4::uuid
           AND "actorId" = $5::uuid
           AND "inputFingerprint" = $6
           AND "expiresAt" > clock_timestamp()
         RETURNING "id"
      `, [fixture.jobId, fixture.clientKeyHash, fixture.driftChallengeId, fixture.projectId, fixture.actorId, "0".repeat(64)]);
      assert.equal(drift.rowCount, 0, "a changed input fingerprint must not consume a challenge");
    } finally {
      await state.end();
    }
  },
);

test(
  "R-11 challenge issuance and consumption fields are protected by database triggers",
  { skip: !shouldRun ? "WEB_AI_CONFIRMATION_POSTGRES_GATE=1 and DATABASE_URL are required" : false },
  async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    let fixture: ConfirmationFixture;
    try {
      fixture = await createFixture(client);
    } finally {
      await client.end();
    }

    const state = new Client({ connectionString: databaseUrl });
    await state.connect();
    try {
      await assert.rejects(
        () => query(state, `UPDATE "WebAiConfirmationChallenge" SET "inputFingerprint" = $2 WHERE "id" = $1::uuid`, [fixture.challengeId, "0".repeat(64)]),
        /issuance fields are immutable/u,
      );
      await assert.rejects(
        () => query(state, `DELETE FROM "WebAiConfirmationChallenge" WHERE "id" = $1::uuid`, [fixture.challengeId]),
        /append-only/u,
      );
      await assert.rejects(
        () => query(state, `
          UPDATE "WebAiConfirmationChallenge"
             SET "consumedAt" = clock_timestamp(),
                 "consumedJobId" = $2::uuid,
                 "consumedClientKeyHash" = $3
           WHERE "id" = $1::uuid
        `, [fixture.driftChallengeId, fixture.jobId, fixture.clientKeyHash]),
        /must be consumed by the admission service/u,
      );
    } finally {
      await state.end();
    }
  },
);

test(
  "R-11 rechecks expiry with clock_timestamp after a challenge lock wait",
  { skip: !shouldRun ? "WEB_AI_CONFIRMATION_POSTGRES_GATE=1 and DATABASE_URL are required" : false },
  async () => {
    const fixtureClient = new Client({ connectionString: databaseUrl });
    await fixtureClient.connect();
    let fixture: ConfirmationFixture;
    try {
      // Leave enough setup budget for the real PostgreSQL fixture before the
      // lock-wait transaction starts; the hold duration below is derived from
      // the database clock so release remains after expiry.
      fixture = await createFixture(fixtureClient, { ttlMs: 2_000 });
    } finally {
      await fixtureClient.end();
    }

    const holder = new Client({ connectionString: databaseUrl });
    const state = new Client({ connectionString: databaseUrl });
    await holder.connect();
    await state.connect();
    try {
      const challenge = await readChallengeState(state, fixture.challengeId);
      const databaseBeforeWait = await query<{ active: boolean; remainingMs: number }>(state, `
        SELECT
          "expiresAt" > clock_timestamp() AS active,
          (EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp())) * 1000)::double precision AS "remainingMs"
        FROM "WebAiConfirmationChallenge"
        WHERE "id" = $1::uuid
      `, [fixture.challengeId]);
      const expiryState = databaseBeforeWait.rows[0];
      assert.equal(expiryState?.active, true, "the lock wait must begin before challenge expiry");
      const remainingUntilExpiryMs = expiryState?.remainingMs ?? 0;
      assert.ok(remainingUntilExpiryMs > 500, "the lock wait must have setup-time margin before challenge expiry");
      const beforeCounts = await query<{ jobs: string; grants: string }>(state, `
        SELECT
          (SELECT COUNT(*)::text FROM "BackgroundJob" WHERE "projectId" = $1::uuid) AS jobs,
          (SELECT COUNT(*)::text FROM "WebAiGrant" WHERE "projectId" = $1::uuid) AS grants
      `, [fixture.projectId]);

      await query(holder, "BEGIN");
      await query(holder, `SELECT "id" FROM "WebAiConfirmationChallenge" WHERE "id" = $1::uuid FOR UPDATE`, [fixture.challengeId]);

      const validated = {
        row: {
          id: challenge.id,
          projectId: challenge.projectId,
          actorId: challenge.actorId,
          actorAccountAccessVersion: challenge.actorAccountAccessVersion,
          actorAccessFingerprint: challenge.actorAccessFingerprint,
          targetAction: "memoryExtract" as const,
          contentVersion: challenge.contentVersion,
          inputFingerprint: challenge.inputFingerprint,
          routeSnapshot: challenge.routeSnapshot,
          preparedClientKeyHash: challenge.preparedClientKeyHash,
          issuedAt: challenge.issuedAt,
          expiresAt: challenge.expiresAt,
          consumedAt: challenge.consumedAt,
          consumedJobId: challenge.consumedJobId,
          consumedClientKeyHash: challenge.consumedClientKeyHash,
        },
        clientKeyHash: challenge.preparedClientKeyHash,
        targetAction: "memoryExtract" as const,
        contentVersion: challenge.contentVersion,
        actorAccountAccessVersion: challenge.actorAccountAccessVersion,
        actorAccessFingerprint: challenge.actorAccessFingerprint,
        routeSnapshot: challenge.routeSnapshot,
        inputFingerprint: challenge.inputFingerprint,
      };
      const db = getDb();
      let waiterStarted = false;
      let waiterStartedWhileActive = false;
      let markWaiterStarted: (() => void) | undefined;
      const waiterStartedPromise = new Promise<void>((resolve) => { markWaiterStarted = resolve; });
      const waiting = db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ active: boolean }>>`
          SELECT "expiresAt" > clock_timestamp() AS active
          FROM "WebAiConfirmationChallenge"
          WHERE "id" = ${fixture.challengeId}::uuid
        `;
        waiterStartedWhileActive = rows[0]?.active === true;
        waiterStarted = true;
        markWaiterStarted?.();
        return consumeWebAiConfirmation(tx, validated, fixture.jobId, fixture.actorId);
      });
      await waiterStartedPromise;
      assert.equal(waiterStarted, true);
      assert.equal(waiterStartedWhileActive, true, "the waiting transaction must start before challenge expiry");

      await delay(Math.ceil(remainingUntilExpiryMs) + 500);
      await query(holder, "COMMIT");
      await assert.rejects(
        () => waiting,
        (error: unknown) => error instanceof WebAiConfirmationError && error.code === "WEB_AI_CONFIRMATION_EXPIRED",
      );

      const afterCounts = await query<{ jobs: string; grants: string }>(state, `
        SELECT
          (SELECT COUNT(*)::text FROM "BackgroundJob" WHERE "projectId" = $1::uuid) AS jobs,
          (SELECT COUNT(*)::text FROM "WebAiGrant" WHERE "projectId" = $1::uuid) AS grants
      `, [fixture.projectId]);
      assert.deepEqual(afterCounts.rows, beforeCounts.rows, "expiry after the lock wait must not create a job or grant");
      const unchanged = await readChallengeState(state, fixture.challengeId);
      assert.equal(unchanged.consumedAt, null);
      assert.equal(unchanged.consumedJobId, null);
      assert.equal(unchanged.consumedClientKeyHash, null);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await state.end();
    }
  },
);

test(
  "R-11 public confirmation serialization and personal route visibility are deny-by-default",
  { skip: !shouldRun ? "WEB_AI_CONFIRMATION_POSTGRES_GATE=1 and DATABASE_URL are required" : false },
  () => {
    const ownerId = "00000000-0000-4000-8000-000000000001";
    const editorId = "00000000-0000-4000-8000-000000000002";
    const route = {
      source: "personal_delegation",
      operation: "projectAnalysis",
      providerConnection: {
        scope: "user",
        ownerUserId: ownerId,
        name: "个人私有连接",
        kind: "openai",
        status: "verified",
      },
      providerConnectionId: "33333333-3333-4333-8333-333333333333",
      modelId: "private-model",
      embeddingDimensions: null,
    } as never;

    assert.deepEqual(confirmationRouteDisplay(route, { actorId: ownerId, projectOwner: false }), {
      source: "personal_delegation",
      provider: { name: "个人私有连接", kind: "openai" },
      model: "private-model",
    });
    for (const visibility of [
      { actorId: editorId, projectOwner: false },
      { actorId: editorId, projectOwner: true },
    ]) {
      const projection = confirmationRouteDisplay(route, visibility);
      assert.deepEqual(projection, { source: "personal_delegation", provider: { kind: "openai" } });
      assert.doesNotMatch(JSON.stringify(projection), /个人私有连接|private-model|33333333|"id"/u);
    }

    const view = toPublicWebAiConfirmationView({
      id: "44444444-4444-4444-8444-444444444444",
      targetAction: "memoryExtract",
      issuedAt: new Date("2026-09-09T00:00:00.000Z"),
      expiresAt: new Date("2026-09-09T00:10:00.000Z"),
      safeSummary: {
        action: "memoryExtract",
        route: confirmationRouteDisplay(route, { actorId: editorId, projectOwner: false }),
        scope: { sourceCount: 1 },
      },
      contentVersion: "auto-extract:v1:private",
      question: "用户问题不应出现在摘要",
      inputFingerprint: "a".repeat(64),
      routeSnapshot: { modelId: "private-model" },
      manifest: "b".repeat(64),
      sha: "c".repeat(64),
    } as never);
    assert.equal("contentVersion" in view, false);
    assert.equal("question" in view, false);
    assert.equal("inputFingerprint" in view, false);
    assert.doesNotMatch(JSON.stringify(view), /contentVersion|用户问题|private-model|manifest|sha|fingerprint/iu);
  },
);

test(
  "R-11 prepareWebAiConfirmation persists the prepared key hash and returns only the browser view",
  { skip: !shouldRun ? "WEB_AI_CONFIRMATION_POSTGRES_GATE=1 and DATABASE_URL are required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const actorId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const clientKey = `prepare-${suffix}-client-key`;
    const masterKeyPath = `/tmp/ai-project-os-web-ai-confirmation-${process.pid}.key`;
    const previousMasterKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;
    await unlink(masterKeyPath).catch(() => undefined);

    try {
      await db.appUser.create({ data: { id: actorId, username: `web_ai_confirmation_service_${suffix}`, role: "user" } });
      await db.workspace.create({ data: { id: workspaceId, name: `Confirmation service ${suffix}`, slug: `confirmation-service-${suffix}`, createdById: actorId } });
      await db.project.create({ data: { id: projectId, workspaceId, name: `Confirmation service project ${suffix}`, slug: `confirmation-service-project-${suffix}` } });
      await db.$transaction(async (tx) => {
        await grantWorkspaceMembership(tx, { workspaceId, userId: actorId, role: "owner", actorId, reason: "web_ai_confirmation_service_fixture" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: actorId, role: "owner", actorId, reason: "web_ai_confirmation_service_fixture" });
      });

      const actor = { id: actorId, role: "user" as const, accountAccessVersion: 1 };
      const sourceId = randomUUID();
      const confirmation = await prepareWebAiConfirmation({
        projectId,
        actor,
        targetAction: "memoryExtract",
        clientKey,
        db,
        resolve: async () => ({
          contentVersion: "memory-extract:v1:service-fixture",
          inputFingerprintPayload: { sourceIds: [sourceId] },
          routeSnapshot: { source: "platform_default", model: "platform-model" },
          safeSummary: { action: "memoryExtract", route: { source: "platform_default", provider: { name: "Platform", kind: "glm" }, model: "platform-model" }, scope: { sourceCount: 1 } },
        }),
      });
      assert.equal(confirmation.targetAction, "memoryExtract");
      assert.equal("contentVersion" in confirmation, false);
      assert.equal("inputFingerprint" in confirmation, false);
      assert.equal("preparedClientKeyHash" in confirmation, false);

      const challenge = await db.webAiConfirmationChallenge.findUniqueOrThrow({
        where: { id: confirmation.challengeId },
        select: { targetAction: true, preparedClientKeyHash: true },
      });
      assert.equal(challenge.targetAction, "memoryExtract");
      assert.match(challenge.preparedClientKeyHash, /^[0-9a-f]{64}$/u);

      const validated = await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "edit" }, (tx, admission) => validateWebAiConfirmation(tx, admission, {
        challengeId: confirmation.challengeId,
        clientKey,
        targetAction: "memoryExtract",
        contentVersion: "memory-extract:v1:service-fixture",
        inputFingerprintPayload: { sourceIds: [sourceId] },
        routeSnapshot: { source: "platform_default", model: "platform-model" },
      }));
      assert.equal(validated.row.targetAction, "memoryExtract");
      assert.equal(validated.row.consumedAt, null);
    } finally {
      if (previousMasterKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousMasterKeyPath;
      await unlink(masterKeyPath).catch(() => undefined);
    }
  },
);
