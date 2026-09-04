import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { auditedProviderCall } from "../src/lib/web-ai-governance";
import { WebAiAccessError } from "../src/lib/web-ai-access";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const PROVIDER_ID = "55555555-5555-4555-8555-555555555555";

function governanceFixture() {
  let actorLookups = 0;
  let reservationStatus: "reserved" | "released" = "reserved";
  let reservationCreated = false;
  let reservationCreates = 0;
  let reservationReleases = 0;
  let dispatchMarks = 0;
  let auditCreates = 0;
  let networkCalls = 0;

  const db = {
    appUser: {
      findUnique: async () => {
        actorLookups += 1;
        return {
          id: ACTOR_ID,
          role: "member" as const,
          disabledAt: actorLookups >= 3 ? new Date("2026-09-04T00:00:00.000Z") : null,
        };
      },
    },
    project: {
      findUnique: async (query: { select?: { id?: boolean; workspaceId?: boolean; archivedAt?: boolean; membershipInheritanceMode?: boolean; workspace?: unknown; memberships?: unknown } }) => {
        if (query.select?.membershipInheritanceMode === true && query.select.workspace === undefined && query.select.memberships === undefined) return { id: PROJECT_ID, workspaceId: "66666666-6666-4666-8666-666666666666", archivedAt: null, membershipInheritanceMode: "projectOnly" };
        if (query.select?.workspaceId === true) return { id: PROJECT_ID, workspaceId: "66666666-6666-4666-8666-666666666666" };
        if (query.select?.archivedAt === true) return { archivedAt: null };
        return { workspace: { memberships: [] }, memberships: [{ role: "editor" as const }] };
      },
    },
    workspaceMembership: {
      findUnique: async () => ({ role: "member" as const, accessState: "confirmed" as const }),
      findMany: async () => [{ role: "member" as const, accessState: "confirmed" as const }],
    },
    projectMembership: {
      findUnique: async () => ({ role: "editor" as const, accessState: "confirmed" as const }),
      findMany: async () => [{ role: "editor" as const, accessState: "confirmed" as const }],
    },
    backgroundJob: {
      findUnique: async () => ({ projectId: PROJECT_ID, requestedById: ACTOR_ID }),
    },
    platformTokenReservation: {
      findMany: async () => [],
      findUnique: async () => reservationCreated
        ? {
            id: "77777777-7777-4777-8777-777777777777",
            status: reservationStatus,
            reservedTokens: 128,
            settledTokens: null,
            grantId: "88888888-8888-4888-8888-888888888888",
            expiresAt: new Date(Date.now() + 60_000),
            grant: { id: "88888888-8888-4888-8888-888888888888", remainingTokens: 999_872 },
          }
        : null,
      create: async () => {
        reservationCreates += 1;
        reservationCreated = true;
        reservationStatus = "reserved";
        return {
          id: "77777777-7777-4777-8777-777777777777",
          status: "reserved" as const,
          reservedTokens: 128,
          settledTokens: null,
        };
      },
      update: async () => {
        reservationStatus = "released";
        reservationReleases += 1;
        return {
          id: "77777777-7777-4777-8777-777777777777",
          status: "released" as const,
          reservedTokens: 128,
          settledTokens: null,
        };
      },
    },
    platformTokenGrant: {
      findMany: async () => [{ id: "88888888-8888-4888-8888-888888888888", remainingTokens: 100_000, expiresAt: new Date(Date.now() + 60_000) }],
      count: async () => 1,
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
    platformTokenLedgerEntry: {
      create: async () => ({}),
      createMany: async () => ({ count: 1 }),
    },
    backgroundJobAttempt: {
      updateMany: async () => {
        dispatchMarks += 1;
        throw new Error("DISPATCH_MUST_NOT_RUN");
      },
      findFirst: async () => null,
    },
    providerCallAudit: {
      create: async () => {
        auditCreates += 1;
        throw new Error("AUDIT_MUST_NOT_RUN");
      },
    },
    $executeRaw: async () => 0,
    $transaction: async (callback: (tx: PrismaClient) => Promise<unknown>) => callback(db),
  } as unknown as PrismaClient;

  const call = async () => {
    networkCalls += 1;
    throw new Error("NETWORK_MUST_NOT_RUN");
  };

  return {
    db,
    call,
    get actorLookups() { return actorLookups; },
    get reservationStatus() { return reservationStatus; },
    get reservationCreates() { return reservationCreates; },
    get reservationReleases() { return reservationReleases; },
    get dispatchMarks() { return dispatchMarks; },
    get auditCreates() { return auditCreates; },
    get networkCalls() { return networkCalls; },
  };
}

test("auditedProviderCall releases a reservation when the actor is revoked before dispatch", async () => {
  const fixture = governanceFixture();
  const route = {
    projectId: PROJECT_ID,
    providerConnectionId: PROVIDER_ID,
    modelId: "deepseek-v4-flash",
    operation: "generation",
    maxOutputTokens: 64,
    embeddingDimensions: null,
    providerConnection: {
      status: "verified",
      disabledAt: null,
      scope: "platform",
      kind: "deepseek",
      defaultGenerationModelId: "deepseek-v4-flash",
    },
  };

  await assert.rejects(
    () => auditedProviderCall({
      jobId: JOB_ID,
      attempt: { attemptId: ATTEMPT_ID, claimToken: "claim-token" },
      actor: { id: ACTOR_ID, role: "member" },
      route: route as never,
      callKey: "ai-governance-revoke-test",
      requestPayload: { prompt: "hello" },
      call: fixture.call,
    }, fixture.db),
    (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCOUNT_DISABLED",
  );
  assert.equal(fixture.actorLookups, 3);
  assert.equal(fixture.reservationCreates, 1);
  assert.equal(fixture.reservationReleases, 1);
  assert.equal(fixture.reservationStatus, "released");
  assert.equal(fixture.dispatchMarks, 0);
  assert.equal(fixture.auditCreates, 0);
  assert.equal(fixture.networkCalls, 0);
});
