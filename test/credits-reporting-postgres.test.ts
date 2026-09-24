import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getDb } from "../src/lib/db";
import { getCreditReportInTransaction, parseCreditReportQuery, resolveCreditReportQuery } from "../src/lib/credit-reporting";
import { grantWorkspaceMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.CREDITS_REPORTING_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_credits_reporting_test";
const gateUser = "ai_project_os_gate";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("CREDITS_REPORTING_POSTGRES_DATABASE_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("CREDITS_REPORTING_POSTGRES_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== gateUser
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("CREDITS_REPORTING_POSTGRES_DATABASE_URL_NOT_ISOLATED");
}

type GrantSeed = Readonly<{
  userId: string;
  actorId: string;
  amount: number;
  remainingTokens: number;
  expiresAt: Date;
  issuedAt: Date;
  suffix: string;
}>;

async function createManualGrant(db: Prisma.TransactionClient, input: GrantSeed): Promise<string> {
  const grantId = randomUUID();
  const previewId = randomUUID();
  const auditId = randomUUID();
  const ledgerId = randomUUID();
  const requestKey = `credits-reporting-grant-${input.suffix}`;
  const requestFingerprint = createHash("sha256").update(`${requestKey}:request`, "utf8").digest("hex");
  const impactFingerprint = createHash("sha256").update(`${requestKey}:impact`, "utf8").digest("hex");
  const ledgerKey = `grant:manual:${createHash("sha256").update(`${input.actorId}:${requestKey}`, "utf8").digest("hex")}`;
  const reason = "P04 PostgreSQL reporting fixture";

  await db.platformTokenGrantMutationPreview.create({
    data: {
      id: previewId,
      actorId: input.actorId,
      userId: input.userId,
      action: "grant",
      amount: input.amount,
      expiresAt: input.expiresAt,
      reclaimableTokens: 0,
      expectedVersion: 0,
      expectedRemainingTokens: null,
      requestKey,
      reason,
      impactFingerprint,
      requestFingerprint,
      issuedAt: input.issuedAt,
      previewExpiresAt: new Date(input.issuedAt.getTime() + 5 * 60 * 1_000),
      consumedAt: input.issuedAt,
      createdAt: input.issuedAt,
    },
  });
  await db.platformTokenGrant.create({
    data: {
      id: grantId,
      userId: input.userId,
      kind: "manual",
      amount: input.amount,
      remainingTokens: input.remainingTokens,
      offerVersion: `credits-reporting-${input.suffix}`,
      issuedById: input.actorId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      version: 1,
      createdAt: input.issuedAt,
      updatedAt: input.issuedAt,
    },
  });
  await db.platformTokenLedgerEntry.create({
    data: {
      id: ledgerId,
      userId: input.userId,
      grantId,
      entryKind: "grant",
      amount: input.amount,
      usageTokens: null,
      reasonCode: "AI_MANUAL_GRANT",
      callKey: null,
      metadata: { governance: "platform-credit-v1" },
      createdAt: input.issuedAt,
      idempotencyKey: ledgerKey,
    },
  });
  await db.platformTokenGrantAudit.create({
    data: {
      id: auditId,
      grantId,
      userId: input.userId,
      actorId: input.actorId,
      event: "grant",
      versionBefore: 0,
      versionAfter: 1,
      statusBefore: "absent",
      statusAfter: "active",
      amount: input.amount,
      remainingBefore: 0,
      remainingAfter: input.remainingTokens,
      previewId,
      reason,
      requestKey,
      requestFingerprint,
      impactFingerprint,
      transitionAt: input.issuedAt,
      createdAt: input.issuedAt,
    },
  });
  return grantId;
}

type ReservationSeed = Readonly<{
  userId: string;
  grantId: string;
  projectId: string | null;
  callKey: string;
  operation: "generateWithContext";
  modelId: string;
  status: "settled" | "held";
  createdAt: Date;
  settledAt: Date | null;
  rawEstimatedTokens?: number;
  rawSettledTokens?: number;
  allocations: readonly Readonly<{ grantId: string; reservedTokens: number; settledTokens: number; releasedTokens: number }>[];
  safeErrorCode?: string | null;
  runtime?: RuntimeReservationEvidence;
}>;

type RuntimeReservationEvidence = Readonly<{
  webAiGrantId: string;
  jobId: string;
  providerConnectionId: string;
  routeId: string;
  routeVersion: number;
  routeUpdatedAt: Date;
  providerConfigurationVersion: number;
  quotaMultiplierBps: number;
  routeFenceFingerprint: string;
}>;

async function createReservation(db: Prisma.TransactionClient, input: ReservationSeed): Promise<string> {
  const reservationId = randomUUID();
  const reservedTokens = input.allocations.reduce((sum, allocation) => sum + allocation.reservedTokens, 0);
  const settledTokens = input.status === "settled"
    ? input.allocations.reduce((sum, allocation) => sum + allocation.settledTokens, 0)
    : null;
  await db.platformTokenReservation.create({
    data: {
      id: reservationId,
      userId: input.userId,
      grantId: input.grantId,
      webAiGrantId: input.runtime?.webAiGrantId ?? null,
      webAiGrantReferenceId: input.runtime?.webAiGrantId ?? null,
      webAiGrantProjectId: input.projectId,
      jobId: input.runtime?.jobId ?? null,
      providerConnectionId: input.runtime?.providerConnectionId ?? null,
      callKey: input.callKey,
      operation: input.operation,
      modelId: input.modelId,
      status: input.status,
      reservedTokens,
      rawEstimatedTokens: input.rawEstimatedTokens ?? reservedTokens,
      quotaMultiplierBps: input.runtime?.quotaMultiplierBps ?? 10_000,
      routeSource: input.runtime === undefined ? null : "platform_default",
      routeId: input.runtime?.routeId ?? null,
      routeVersion: input.runtime?.routeVersion ?? null,
      routeUpdatedAt: input.runtime?.routeUpdatedAt ?? null,
      providerConfigurationVersion: input.runtime?.providerConfigurationVersion ?? null,
      routeFenceFingerprint: input.runtime?.routeFenceFingerprint ?? null,
      rawSettledTokens: input.rawSettledTokens ?? settledTokens,
      settledTokens,
      reconciliationRequired: input.status === "held",
      safeErrorCode: input.safeErrorCode ?? null,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      createdAt: input.createdAt,
      settledAt: input.settledAt,
    },
  });
  for (const [index, allocation] of input.allocations.entries()) {
    await db.platformTokenReservationAllocation.create({
      data: {
        id: randomUUID(),
        reservationId,
        grantId: allocation.grantId,
        ordinal: index + 1,
        reservedTokens: allocation.reservedTokens,
        settledTokens: allocation.settledTokens,
        releasedTokens: allocation.releasedTokens,
        createdAt: input.createdAt,
      },
    });
  }
  for (const [index, allocation] of input.allocations.entries()) {
    const ordinal = index + 1;
    const settledKey = `settle:${input.userId}:${input.callKey}${ordinal === 1 ? "" : `:allocation:${ordinal}`}`;
    const holdKey = `hold:${input.userId}:${input.callKey}${ordinal === 1 ? "" : `:allocation:${ordinal}`}`;
    const releaseKey = `release:${input.userId}:${input.callKey}${ordinal === 1 ? "" : `:allocation:${ordinal}`}`;
    if (input.status === "held") {
      await db.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: input.userId, grantId: allocation.grantId, reservationId,
          entryKind: "hold", amount: 0, usageTokens: null,
          reasonCode: input.safeErrorCode ?? "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED", callKey: input.callKey,
          metadata: { allocationOrdinal: ordinal }, createdAt: input.createdAt, idempotencyKey: holdKey,
        },
      });
      continue;
    }
    await db.platformTokenLedgerEntry.create({
      data: {
        id: randomUUID(), userId: input.userId, grantId: allocation.grantId, reservationId,
        entryKind: "settle", amount: 0, usageTokens: ordinal === 1 ? input.rawSettledTokens ?? settledTokens : null,
        reasonCode: "AI_PLATFORM_TOKEN_SETTLED", callKey: input.callKey,
        metadata: { allocationOrdinal: ordinal }, createdAt: input.settledAt ?? input.createdAt, idempotencyKey: settledKey,
      },
    });
    const releaseAmount = allocation.releasedTokens;
    if (releaseAmount > 0) {
      await db.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(), userId: input.userId, grantId: allocation.grantId, reservationId,
          entryKind: "release", amount: releaseAmount, usageTokens: null,
          reasonCode: "AI_PLATFORM_TOKEN_SETTLE_RELEASE", callKey: input.callKey,
          metadata: { allocationOrdinal: ordinal }, createdAt: input.settledAt ?? input.createdAt, idempotencyKey: releaseKey,
        },
      });
    }
  }
  return reservationId;
}

test("P04 credit reporting reads settled allocations with scope and owner isolation on PostgreSQL", {
  skip: !shouldRun ? "CREDITS_REPORTING_POSTGRES_GATE=1 is required" : false,
}, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const reportNow = new Date("2026-09-12T00:00:00.000Z");
  const issuedAt = new Date("2026-09-01T00:00:00.000Z");
  const expiresAt = new Date("2026-10-01T00:00:00.000Z");
  const hiddenProjectId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const adminId = randomUUID();
  const rollback = new Error("CREDITS_REPORTING_FIXTURE_ROLLBACK");

  try {
    await db.$transaction(async (tx) => {
      await tx.appUser.createMany({
        data: [
          { id: adminId, username: `credits_admin_${suffix}`, role: "admin" },
          { id: userId, username: `credits_user_${suffix}`, role: "user" },
          { id: otherUserId, username: `credits_other_${suffix}`, role: "user" },
        ],
      });
      await tx.workspace.create({ data: { id: workspaceId, name: `Credits workspace ${suffix}`, slug: `credits-workspace-${suffix}`, createdById: adminId } });
      await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "P04 PostgreSQL reporting fixture" });
      // Deliberately keep the project inaccessible to the reporting user so
      // the same ledger rows verify the redacted-name projection.
      await tx.project.create({ data: { id: hiddenProjectId, workspaceId, name: `Hidden project ${suffix}`, slug: `hidden-project-${suffix}` } });

      const credentialId = randomUUID();
      const providerConnectionId = randomUUID();
      const jobId = randomUUID();
      const webAiGrantId = randomUUID();
      const routeId = randomUUID();
      const credentialSecretFingerprint = "a".repeat(64);
      const routeFenceFingerprint = "b".repeat(64);
      await tx.externalCredential.create({
        data: {
          id: credentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([0x01]),
          nonce: Buffer.from([0x02]),
          authTag: Buffer.from([0x03]),
          keyVersion: 1,
          maskedSuffix: "fixture",
          secretFingerprint: credentialSecretFingerprint,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        },
      });
      await tx.aiProviderConnection.create({
        data: {
          id: providerConnectionId,
          name: `credits-provider-${suffix}`,
          kind: "openai",
          scope: "platform",
          ownerUserId: null,
          protocol: "chatCompletions",
          baseUrl: "https://api.openai.com/v1",
          credentialId,
          defaultGenerationModelId: "gpt-p04",
          defaultEmbeddingModelId: null,
          defaultVisionModelId: null,
          embeddingDimensions: null,
          configurationVersion: 1,
          status: "verified",
          lastTestedAt: issuedAt,
          lastErrorCode: null,
          disabledAt: null,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        },
      });
      await tx.backgroundJob.create({
        data: {
          id: jobId,
          projectId: hiddenProjectId,
          kind: "projectAgent",
          requestedById: userId,
          webAiGrantId: null,
          idempotencyKey: createHash("sha256").update(`credits-job-${suffix}`, "utf8").digest("hex"),
          payload: {},
          createdAt: issuedAt,
        },
      });
      await tx.webAiGrant.create({
        data: {
          id: webAiGrantId,
          projectId: hiddenProjectId,
          operation: "generateWithContext",
          scopeKind: "query",
          scopeIds: {},
          manifestFingerprint: "c".repeat(64),
          providerConnectionId,
          modelId: "gpt-p04",
          consentVersion: "p04-postgres-fixture-v1",
          issuedById: userId,
          billingMode: "platform",
          billingUserId: userId,
          callKey: `credits-job-grant-${suffix}`,
          boundJobId: jobId,
          routeSource: "platform_default",
          routeId,
          routeVersion: 1,
          routeUpdatedAt: issuedAt,
          providerConfigurationVersion: 1,
          quotaMultiplierBps: 20_000,
          routeFenceFingerprint,
          payerKind: "platformCaller",
          payerProviderConnectionId: providerConnectionId,
          credentialSecretFingerprint,
          embeddingDimensions: null,
          maxOutputTokens: 128,
          issuedAt,
          expiresAt,
        },
      });
      await tx.backgroundJob.update({ where: { id: jobId }, data: { webAiGrantId } });
      const runtime: RuntimeReservationEvidence = {
        webAiGrantId,
        jobId,
        providerConnectionId,
        routeId,
        routeVersion: 1,
        routeUpdatedAt: issuedAt,
        providerConfigurationVersion: 1,
        quotaMultiplierBps: 20_000,
        routeFenceFingerprint,
      };

      const multiGrantA = await createManualGrant(tx, { userId, actorId: adminId, amount: 40, remainingTokens: 0, expiresAt, issuedAt, suffix: `${suffix}-a` });
      const multiGrantB = await createManualGrant(tx, { userId, actorId: adminId, amount: 60, remainingTokens: 40, expiresAt, issuedAt, suffix: `${suffix}-b` });
      const personalGrant = await createManualGrant(tx, { userId, actorId: adminId, amount: 10, remainingTokens: 0, expiresAt, issuedAt, suffix: `${suffix}-c` });
      const heldGrant = await createManualGrant(tx, { userId, actorId: adminId, amount: 20, remainingTokens: 12, expiresAt, issuedAt, suffix: `${suffix}-d` });
      const otherGrant = await createManualGrant(tx, { userId: otherUserId, actorId: adminId, amount: 25, remainingTokens: 0, expiresAt, issuedAt, suffix: `${suffix}-other` });

      await createReservation(tx, {
        userId,
        grantId: multiGrantA,
        projectId: hiddenProjectId,
        callKey: `credits-hidden-${suffix}`,
        operation: "generateWithContext",
        modelId: "gpt-p04",
        status: "settled",
        createdAt: new Date("2026-09-10T23:00:00.000Z"),
        settledAt: new Date("2026-09-10T23:30:00.000Z"),
        rawEstimatedTokens: 50,
        rawSettledTokens: 30,
        allocations: [
          { grantId: multiGrantA, reservedTokens: 40, settledTokens: 40, releasedTokens: 0 },
          { grantId: multiGrantB, reservedTokens: 60, settledTokens: 20, releasedTokens: 40 },
        ],
        runtime,
      });
      await createReservation(tx, {
        userId,
        grantId: personalGrant,
        projectId: null,
        callKey: `credits-personal-${suffix}`,
        operation: "generateWithContext",
        modelId: "gpt-p04",
        status: "settled",
        createdAt: new Date("2026-09-10T15:00:00.000Z"),
        settledAt: new Date("2026-09-10T15:30:00.000Z"),
        allocations: [{ grantId: personalGrant, reservedTokens: 10, settledTokens: 10, releasedTokens: 0 }],
      });
      await createReservation(tx, {
        userId,
        grantId: heldGrant,
        projectId: null,
        callKey: `credits-held-${suffix}`,
        operation: "generateWithContext",
        modelId: "gpt-p04",
        status: "held",
        createdAt: new Date("2026-09-11T01:00:00.000Z"),
        settledAt: null,
        safeErrorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED",
        allocations: [{ grantId: heldGrant, reservedTokens: 8, settledTokens: 0, releasedTokens: 0 }],
      });
      await createReservation(tx, {
        userId: otherUserId,
        grantId: otherGrant,
        projectId: null,
        callKey: `credits-other-${suffix}`,
        operation: "generateWithContext",
        modelId: "gpt-p04",
        status: "settled",
        createdAt: new Date("2026-09-10T15:00:00.000Z"),
        settledAt: new Date("2026-09-10T15:30:00.000Z"),
        allocations: [{ grantId: otherGrant, reservedTokens: 25, settledTokens: 25, releasedTokens: 0 }],
      });

      await tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const input = parseCreditReportQuery(new URLSearchParams("range=custom&from=2026-09-10&to=2026-09-11&timezone=Asia%2FShanghai"));
      const query = resolveCreditReportQuery(input, reportNow);
      const report = await getCreditReportInTransaction(userId, tx, query, reportNow);
      assert.deepEqual(report.usage.daily, [
        { date: "2026-09-10", settledCredits: 10, settledRawTokens: 10, rawTokenCoverageComplete: true, pendingCredits: 0 },
        { date: "2026-09-11", settledCredits: 60, settledRawTokens: 30, rawTokenCoverageComplete: true, pendingCredits: 8 },
      ]);
      assert.deepEqual({ total: report.summary.totalCredits, available: report.summary.availableCredits, used: report.summary.usedCredits, held: report.summary.heldCredits }, { total: 130, available: 52, used: 70, held: 8 });
      assert.equal(report.ledger.entries.filter((entry) => entry.kind === "settle").reduce((sum, entry) => sum + entry.settledCredits, 0), 70);
      assert.ok(report.ledger.entries.filter((entry) => entry.kind === "settle").every((entry) => entry.balanceDelta === 0));
      assert.equal(report.ledger.entries.filter((entry) => entry.projectName === "项目已不可见").length, 3);
      assert.equal(report.ledger.entries.filter((entry) => entry.projectName === "未关联项目").length, 2);
      assert.equal(report.ledger.entries.length, 5);

      const personalQuery = resolveCreditReportQuery(parseCreditReportQuery(new URLSearchParams("range=custom&from=2026-09-10&to=2026-09-11&timezone=Asia%2FShanghai&scope=personal")), reportNow);
      const personalReport = await getCreditReportInTransaction(userId, tx, personalQuery, reportNow);
      assert.equal(personalReport.usage.settledCredits, 10);
      assert.equal(personalReport.usage.daily[0]?.settledRawTokens, 10);
      assert.equal(personalReport.usage.pendingCredits, 8);
      assert.equal(personalReport.ledger.entries.length, 2);
      assert.ok(personalReport.ledger.entries.every((entry) => entry.projectName === "未关联项目"));

      const projectQuery = resolveCreditReportQuery(parseCreditReportQuery(new URLSearchParams(`range=custom&from=2026-09-10&to=2026-09-11&timezone=Asia%2FShanghai&scope=project&projectId=${hiddenProjectId}`)), reportNow);
      const projectReport = await getCreditReportInTransaction(userId, tx, projectQuery, reportNow);
      assert.equal(projectReport.usage.settledCredits, 60);
      assert.equal(projectReport.usage.daily[1]?.settledRawTokens, 30);
      assert.equal(projectReport.usage.pendingCredits, 0);
      assert.equal(projectReport.ledger.entries.length, 3);
      assert.ok(projectReport.ledger.entries.every((entry) => entry.projectName === "项目已不可见"));

      throw rollback;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});
