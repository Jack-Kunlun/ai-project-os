import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  EffectiveAiRouteError,
  effectiveAiRouteSnapshot,
  resolveEffectiveAiRoute,
  routeSnapshotsEqual,
} from "../src/lib/effective-ai-route";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_ROUTE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-05T00:00:00.000Z");

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER_ID,
    name: "Runtime provider",
    kind: "openai",
    scope: "platform",
    workspaceId: null,
    ownerUserId: null,
    ownershipState: "confirmed",
    protocol: "chatCompletions",
    baseUrl: "https://api.openai.com/v1",
    credentialId: randomUUID(),
    credential: { kind: "aiProvider", secretFingerprint: "d".repeat(64) },
    defaultGenerationModelId: "gpt-4.1-mini",
    defaultEmbeddingModelId: "text-embedding-3-small",
    defaultVisionModelId: "gpt-4o-mini",
    embeddingDimensions: 1536,
    configurationVersion: 3,
    status: "verified",
    lastTestedAt: NOW,
    lastErrorCode: null,
    disabledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function projectRoute(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    operation: "autoExtract",
    providerConnectionId: PROVIDER_ID,
    modelId: "gpt-4.1-mini",
    embeddingDimensions: null,
    maxOutputTokens: 512,
    createdAt: NOW,
    updatedAt: NOW,
    providerConnection: provider(),
    ...overrides,
  };
}

function defaultRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: DEFAULT_ROUTE_ID,
    operation: "embedding",
    version: 7,
    status: "active",
    providerConnectionId: PROVIDER_ID,
    modelId: "text-embedding-3-small",
    embeddingDimensions: 1536,
    maxOutputTokens: null,
    quotaMultiplierBps: 12_500,
    validatedProviderConfigurationVersion: 3,
    validatedAt: NOW,
    createdById: "55555555-5555-4555-8555-555555555555",
    updatedById: "66666666-6666-4666-8666-666666666666",
    createdAt: NOW,
    updatedAt: NOW,
    providerConnection: provider(),
    ...overrides,
  };
}

function fakeDb(input: Readonly<{
  route?: unknown;
  defaultRoute?: unknown;
  providerOverride?: Record<string, unknown>;
  selection?: unknown;
  delegation?: unknown;
  projectArchivedAt?: Date | null;
  lockBusy?: boolean;
}>) {
  let defaultLookups = 0;
  let lockCalls = 0;
  const db = {
    project: {
      findUnique: async () => ({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, archivedAt: input.projectArchivedAt ?? null }),
    },
    projectAiRoute: {
      findUnique: async () => input.route ?? null,
    },
    projectAiEffectiveRouteSelection: {
      findUnique: async () => input.selection ?? null,
    },
    projectAiProviderDelegation: {
      findUnique: async () => input.delegation ?? null,
      findFirst: async () => input.delegation ?? null,
    },
    platformDefaultAiRoute: {
      findFirst: async () => {
        defaultLookups += 1;
        return input.defaultRoute === undefined
          ? null
          : { ...input.defaultRoute as Record<string, unknown>, providerConnection: provider(input.providerOverride ?? {}) };
      },
    },
    $executeRaw: async () => {
      lockCalls += 1;
      return 1;
    },
    $queryRaw: async () => { lockCalls += 1; return [{ locked: input.lockBusy !== true }]; },
  } as unknown as PrismaClient;
  return {
    db,
    get defaultLookups() { return defaultLookups; },
    get lockCalls() { return lockCalls; },
  };
}

function routeError(code: string) {
  return (error: unknown) => error instanceof EffectiveAiRouteError && error.code === code;
}

test("a legacy project route blocks fallback and fails closed", async () => {
  const fixture = fakeDb({ route: projectRoute(), defaultRoute: defaultRoute({ operation: "autoExtract" }) });
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", fixture.db),
    routeError("PROJECT_ROUTE_INVALID"),
  );
  assert.equal(fixture.defaultLookups, 0);
});

test("an invalid explicit override fails closed without consulting the default", async () => {
  const fixture = fakeDb({
    route: projectRoute({ providerConnection: provider({ status: "disabled" }) }),
    defaultRoute: defaultRoute({ operation: "autoExtract" }),
  });
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", fixture.db),
    routeError("PROJECT_ROUTE_INVALID"),
  );
  assert.equal(fixture.defaultLookups, 0);
});

test("an active default returns its versioned route fence and quota snapshot", async () => {
  const fixture = fakeDb({ defaultRoute: defaultRoute() });
  const route = await resolveEffectiveAiRoute(PROJECT_ID, "embedding", fixture.db, { lock: true });
  assert.equal(route.source, "platform_default");
  assert.equal(route.routeId, DEFAULT_ROUTE_ID);
  assert.equal(route.routeVersion, 7);
  assert.equal(route.maxOutputTokens, 128);
  assert.equal(route.quotaMultiplierBps, 12_500);
  assert.equal(route.providerConfigurationVersion, 3);
  assert.equal(route.routeFenceFingerprint, "451dc6dd19190bd3faf1fd9740f1e49c0844c1aeaf1296f5681b037c40d6b159");
  assert.equal(fixture.lockCalls, 2);
  assert.deepEqual(effectiveAiRouteSnapshot(route), {
    routeSource: "platform_default",
    routeId: DEFAULT_ROUTE_ID,
    routeVersion: 7,
    routeUpdatedAt: NOW,
    providerConfigurationVersion: 3,
    quotaMultiplierBps: 12_500,
    routeFenceFingerprint: route.routeFenceFingerprint,
    credentialSecretFingerprint: "d".repeat(64),
  });
});

test("projects without a legacy route inherit the active platform default", async () => {
  const fixture = fakeDb({ defaultRoute: defaultRoute({ operation: "autoExtract", modelId: "gpt-4.1-mini", embeddingDimensions: null }) });
  const route = await resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", fixture.db);
  assert.equal(route.source, "platform_default");
  assert.equal(route.routeId, DEFAULT_ROUTE_ID);
  assert.equal(route.routeVersion, 7);
  assert.equal(route.modelId, "gpt-4.1-mini");
  assert.equal(fixture.defaultLookups, 1);
});

test("a malformed explicit platform selection cannot fall back to the default", async () => {
  const fixture = fakeDb({
    selection: { source: "platformDefault", delegationId: randomUUID() },
    defaultRoute: defaultRoute({ operation: "autoExtract", modelId: "gpt-4.1-mini", embeddingDimensions: null }),
  });
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", fixture.db),
    routeError("PLATFORM_ROUTE_UNAVAILABLE"),
  );
  assert.equal(fixture.defaultLookups, 0);
});

test("archived projects cannot resolve a platform runtime route", async () => {
  const fixture = fakeDb({
    projectArchivedAt: NOW,
    defaultRoute: defaultRoute({ operation: "autoExtract", modelId: "gpt-4.1-mini", embeddingDimensions: null }),
  });
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", fixture.db),
    routeError("PLATFORM_ROUTE_UNAVAILABLE"),
  );
  assert.equal(fixture.defaultLookups, 0);
});

test("route lock contention fails closed before route reads", async () => {
  const fixture = fakeDb({ lockBusy: true, defaultRoute: defaultRoute({ operation: "autoExtract", modelId: "gpt-4.1-mini", embeddingDimensions: null }) });
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", fixture.db, { lock: true }),
    routeError("AI_ROUTE_LOCK_BUSY"),
  );
  assert.equal(fixture.defaultLookups, 0);
});

test("an active personal selection resolves a complete internal route without platform fallback", async () => {
  const ownerId = "77777777-7777-4777-8777-777777777777";
  const ownerMembershipId = "88888888-8888-4888-8888-888888888888";
  const projectOwnerMembershipId = "99999999-9999-4999-8999-999999999999";
  const subscriptionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const delegationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const selectionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const providerConnection = {
    ...provider({
      scope: "user",
      ownerUserId: ownerId,
      workspaceId: null,
      ownershipState: "confirmed",
      status: "verified",
      baseUrl: "https://api.openai.com/v1",
    }),
    credential: { kind: "aiProvider", secretFingerprint: "a".repeat(64) },
  };
  const selection = {
    id: selectionId,
    projectId: PROJECT_ID,
    operation: "autoExtract",
    source: "personalDelegation",
    delegationId,
    selectedById: ownerId,
    selectedByProjectMembershipId: projectOwnerMembershipId,
    selectedByMembershipCreatedAt: NOW,
    version: 2,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
  const delegation = {
    id: delegationId,
    projectId: PROJECT_ID,
    operation: "autoExtract",
    version: 3,
    status: "active",
    providerConnectionId: PROVIDER_ID,
    connectionOwnerId: ownerId,
    ownerProjectMembershipId: ownerMembershipId,
    ownerMembershipCreatedAt: NOW,
    projectConfirmedProjectMembershipId: projectOwnerMembershipId,
    projectConfirmedMembershipCreatedAt: NOW,
    projectConfirmedById: ownerId,
    connectionOwnerSubscriptionId: subscriptionId,
    connectionOwnerSubscriptionVersion: 4,
    connectionOwnerSubscriptionStartsAt: new Date("2026-08-01T00:00:00.000Z"),
    connectionOwnerSubscriptionExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
    modelId: "gpt-4.1-mini",
    embeddingDimensions: null,
    maxOutputTokens: 2048,
    providerConfigurationVersion: 3,
    credentialFingerprint: "a".repeat(64),
    delegationFingerprint: "b".repeat(64),
    expiresAt: new Date("2026-09-20T00:00:00.000Z"),
    providerConnection,
  } as const;
  let defaultLookups = 0;
  const db = {
    project: { findUnique: async () => ({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, archivedAt: null }) },
    projectAiRoute: { findUnique: async () => null },
    projectAiEffectiveRouteSelection: { findUnique: async () => selection },
    projectAiProviderDelegation: { findUnique: async () => ({ providerConnectionId: PROVIDER_ID }), findFirst: async () => delegation },
    appUser: { findUnique: async () => ({ disabledAt: null }) },
    projectMembership: { findUnique: async () => ({ projectId: PROJECT_ID, userId: ownerId, role: "owner", accessState: "confirmed", createdAt: NOW }) },
    membershipSubscription: { findUnique: async () => ({ userId: ownerId, status: "active", version: 4, startsAt: new Date("2026-08-01T00:00:00.000Z"), expiresAt: new Date("2026-10-01T00:00:00.000Z") }) },
    platformDefaultAiRoute: { findFirst: async () => { defaultLookups += 1; return defaultRoute({ operation: "autoExtract" }); } },
    $queryRaw: async () => [{ now: NOW }],
  } as unknown as PrismaClient;
  const route = await resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", db);
  assert.equal(route.source, "personal_delegation");
  assert.equal(route.routeId, selectionId);
  assert.equal(route.routeVersion, 2);
  assert.equal(route.maxOutputTokens, 2048);
  assert.equal(route.quotaMultiplierBps, 10_000);
  assert.equal(route.personalEvidence?.personalDelegationId, delegationId);
  assert.equal(route.personalEvidence?.payerKind, "personal_connection_owner");
  assert.equal(route.personalEvidence?.billingUserId, ownerId);
  assert.equal(defaultLookups, 0);

  const revokedDb = {
    ...db,
    projectAiProviderDelegation: {
      findUnique: async () => ({ providerConnectionId: PROVIDER_ID }),
      findFirst: async () => ({ ...delegation, status: "revoked" }),
    },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", revokedDb),
    routeError("PERSONAL_ROUTE_UNAVAILABLE"),
  );

  const archivedDb = {
    ...db,
    project: { findUnique: async () => ({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, archivedAt: NOW }) },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "autoExtract", archivedDb),
    routeError("PERSONAL_ROUTE_UNAVAILABLE"),
  );
});

test("missing, unverified, and configuration-drifted defaults are unavailable", async () => {
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "embedding", fakeDb({}).db),
    routeError("PLATFORM_ROUTE_UNAVAILABLE"),
  );
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "embedding", fakeDb({ defaultRoute: defaultRoute(), providerOverride: { status: "configured" } }).db),
    routeError("PLATFORM_ROUTE_UNAVAILABLE"),
  );
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "embedding", fakeDb({ defaultRoute: defaultRoute(), providerOverride: { configurationVersion: 4 } }).db),
    routeError("AI_PROVIDER_CONFIGURATION_DRIFT"),
  );
  await assert.rejects(
    () => resolveEffectiveAiRoute(PROJECT_ID, "embedding", fakeDb({ defaultRoute: defaultRoute({ validatedAt: null }) }).db),
    routeError("PLATFORM_ROUTE_UNAVAILABLE"),
  );
});

test("route snapshots include quota multiplier in drift detection", async () => {
  const fixture = fakeDb({ defaultRoute: defaultRoute() });
  const route = await resolveEffectiveAiRoute(PROJECT_ID, "embedding", fixture.db);
  assert.equal(routeSnapshotsEqual(route, route), true);
  assert.equal(routeSnapshotsEqual(route, { ...route, quotaMultiplierBps: 12_499 }), false);
  assert.equal(routeSnapshotsEqual(route, { ...route, routeFenceFingerprint: "f".repeat(64) }), false);
});
