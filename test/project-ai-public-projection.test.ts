import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAiModelProjection,
  projectAiProviderProjection,
} from "../src/lib/project-ai-public-projection";

const ownerId = "00000000-0000-4000-8000-000000000001";
const viewerId = "00000000-0000-4000-8000-000000000002";
const personalProvider = {
  scope: "user",
  workspaceId: null,
  ownerUserId: ownerId,
  ownershipState: "confirmed",
  name: "私有连接名称",
  kind: "openai",
  status: "verified",
} as const;
const platformProvider = {
  scope: "platform",
  workspaceId: null,
  ownerUserId: null,
  ownershipState: "confirmed",
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
  const unknown = { ...personalProvider, scope: "workspace", workspaceId: "workspace-id" };
  const projection = projectAiProviderProjection(unknown, { actorId: ownerId, projectOwner: true });
  assert.equal(projection, null);
  assert.equal(projectAiModelProjection("gpt-4.1-mini", unknown, { actorId: ownerId, projectOwner: true }), null);
});
