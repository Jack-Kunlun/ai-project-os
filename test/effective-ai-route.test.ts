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
}>) {
  let defaultLookups = 0;
  let lockCalls = 0;
  const db = {
    project: {
      findUnique: async () => ({ id: PROJECT_ID, workspaceId: WORKSPACE_ID }),
    },
    projectAiRoute: {
      findUnique: async () => input.route ?? null,
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
  assert.equal(fixture.lockCalls, 1);
  assert.deepEqual(effectiveAiRouteSnapshot(route), {
    routeSource: "platform_default",
    routeId: DEFAULT_ROUTE_ID,
    routeVersion: 7,
    routeUpdatedAt: NOW,
    providerConfigurationVersion: 3,
    quotaMultiplierBps: 12_500,
    routeFenceFingerprint: route.routeFenceFingerprint,
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
