import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { parsePlatformAiOperationProbeInput, probePlatformAiOperation } from "../src/lib/platform-ai-operation-service";

test("platform operation probes require a strict request shape", () => {
  const parsed = parsePlatformAiOperationProbeInput({
    clientRequestKey: "11111111-1111-4111-8111-111111111111",
    providerConnectionId: "22222222-2222-4222-8222-222222222222",
    operation: "projectAnalysis",
    modelId: "gpt-4.1-mini",
    maxOutputTokens: 256,
    quotaMultiplierBps: 10_000,
  });
  assert.equal(parsed.operation, "projectAnalysis");
  assert.throws(() => parsePlatformAiOperationProbeInput({
    clientRequestKey: "11111111-1111-4111-8111-111111111111",
    providerConnectionId: "22222222-2222-4222-8222-222222222222",
    operation: "projectAnalysis",
    modelId: "gpt-4.1-mini",
    apiKey: "must-not-be-accepted",
  }));
});

test("operation probes read the saved credential and retire before replacing an active route", async () => {
  const source = await readFile("src/lib/platform-ai-operation-service.ts", "utf8");
  assert.match(source, /credentialId: true/u);
  assert.match(source, /credentialId: admission\.provider\.credentialId/u);
  const retireIndex = source.indexOf('data: { status: "retired", updatedById: currentActor.id }');
  const createIndex = source.indexOf('platformDefaultAiRoute.create({ data: { operation: input.operation');
  assert.notEqual(retireIndex, -1);
  assert.notEqual(createIndex, -1);
  assert.ok(retireIndex < createIndex, "the partial active-route unique index requires retirement first");
});

test("operation probes reject a demoted admin before reading provider rows", async () => {
  const actorId = "11111111-1111-4111-8111-111111111111";
  let providerReads = 0;
  const db = {
    appUser: {
      findUnique: async () => ({ id: actorId, role: "user", disabledAt: null, accountAccessVersion: 1 }),
    },
    get aiProviderConnection() {
      providerReads += 1;
      throw new Error("provider rows must not be read for a non-admin actor");
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    () => probePlatformAiOperation({
      clientRequestKey: "22222222-2222-4222-8222-222222222222",
      providerConnectionId: "33333333-3333-4333-8333-333333333333",
      operation: "projectAnalysis",
      modelId: "gpt-4.1-mini",
      maxOutputTokens: 256,
      quotaMultiplierBps: 10_000,
    }, { id: actorId, role: "admin", accountAccessVersion: 1 }, db),
    (error: unknown) => (error as { code?: string }).code === "AI_PROVIDER_ADMIN_REQUIRED",
  );
  assert.equal(providerReads, 0);
});
