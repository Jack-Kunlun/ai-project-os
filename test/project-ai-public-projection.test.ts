import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAiModelProjection,
  projectAiProviderProjection,
} from "../src/lib/project-ai-public-projection";
import {
  confirmationRouteDisplay,
  toPublicWebAiConfirmationView,
} from "../src/lib/web-ai-confirmation";

const ownerId = "00000000-0000-4000-8000-000000000001";
const viewerId = "00000000-0000-4000-8000-000000000002";
const personalProvider = {
  scope: "user",
  ownerUserId: ownerId,
  name: "私有连接名称",
  kind: "openai",
  status: "verified",
} as const;
const platformProvider = {
  scope: "platform",
  ownerUserId: null,
  name: "平台托管连接",
  kind: "openai",
  status: "verified",
} as const;

test("personal provider projection is deny-by-default and role scoped", () => {
  const viewer = { actorId: viewerId, projectOwner: false } as const;
  const projectOwner = { actorId: viewerId, projectOwner: true } as const;
  const connectionOwner = { actorId: ownerId, projectOwner: false } as const;

  assert.equal(projectAiProviderProjection(personalProvider, viewer), null);
  assert.deepEqual(projectAiProviderProjection(personalProvider, projectOwner), { kind: "openai" });
  assert.deepEqual(projectAiProviderProjection(personalProvider, connectionOwner), {
    name: "私有连接名称",
    kind: "openai",
    status: "verified",
  });
  assert.equal(projectAiModelProjection("gpt-4.1-mini", personalProvider, viewer), null);
  assert.equal(projectAiModelProjection("gpt-4.1-mini", personalProvider, projectOwner), "gpt-4.1-mini");
  assert.equal(projectAiModelProjection("gpt-4.1-mini", personalProvider, connectionOwner), "gpt-4.1-mini");
});

test("platform projection preserves product metadata without a connection identifier", () => {
  const projection = projectAiProviderProjection(platformProvider, { actorId: viewerId, projectOwner: false });
  assert.deepEqual(projection, { name: "平台托管连接", kind: "openai", status: "verified" });
  assert.equal(projectAiModelProjection("gpt-4.1-mini", platformProvider, { actorId: viewerId, projectOwner: false }), "gpt-4.1-mini");
  assert.equal("id" in (projection ?? {}), false);
});

test("unknown provider ownership fails closed", () => {
  const unknown = { ...personalProvider, scope: "legacy" };
  const projection = projectAiProviderProjection(unknown, { actorId: ownerId, projectOwner: true });
  assert.equal(projection, null);
  assert.equal(projectAiModelProjection("gpt-4.1-mini", unknown, { actorId: ownerId, projectOwner: true }), null);
});

test("confirmation route projection hides personal names and models from non-owners", () => {
  const route = {
    source: "personal_delegation",
    operation: "projectAnalysis",
    providerConnection: personalProvider,
    providerConnectionId: "33333333-3333-4333-8333-333333333333",
    modelId: "private-model",
    embeddingDimensions: null,
  } as never;
  const connectionOwner = confirmationRouteDisplay(route, { actorId: ownerId, projectOwner: false });
  assert.deepEqual(connectionOwner, {
    source: "personal_delegation",
    provider: { name: "私有连接名称", kind: "openai" },
    model: "private-model",
  });
  for (const visibility of [
    { actorId: viewerId, projectOwner: true },
    { actorId: viewerId, projectOwner: false },
  ]) {
    const projection = confirmationRouteDisplay(route, visibility);
    assert.deepEqual(projection, { source: "personal_delegation", provider: { kind: "openai" } });
    const serialized = JSON.stringify(projection);
    assert.doesNotMatch(serialized, /私有连接名称|private-model|33333333/u);
  }
});

test("confirmation serialization exposes only the safe browser view", () => {
  const view = toPublicWebAiConfirmationView({
    id: "44444444-4444-4444-8444-444444444444",
    targetAction: "memorySearch",
    issuedAt: new Date("2026-09-09T00:00:00.000Z"),
    expiresAt: new Date("2026-09-09T00:10:00.000Z"),
    // These are deliberately not part of the serializer input. The actual
    // challenge row keeps them internal, so this cast proves the whitelist
    // does not accidentally spread internal evidence into the response.
    safeSummary: {
      action: "memorySearch",
      route: { embedding: { source: "platform_default", provider: { name: "Platform", kind: "glm" }, model: "platform-model", dimensions: 1536 } },
      scope: { indexGenerationId: "generation-1" },
    },
    contentVersion: "semantic-search:v1:private",
    inputFingerprint: "a".repeat(64),
    routeSnapshot: { modelId: "private-model" },
    question: "用户问题不应出现在摘要",
  } as never);
  assert.deepEqual(view, {
    challengeId: "44444444-4444-4444-8444-444444444444",
    targetAction: "memorySearch",
    issuedAt: "2026-09-09T00:00:00.000Z",
    expiresAt: "2026-09-09T00:10:00.000Z",
    safeSummary: {
      action: "memorySearch",
      route: { embedding: { source: "platform_default", provider: { name: "Platform", kind: "glm" }, model: "platform-model", dimensions: 1536 } },
      scope: { indexGenerationId: "generation-1" },
    },
  });
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /contentVersion|inputFingerprint|routeSnapshot|private-model|用户问题/u);
});
