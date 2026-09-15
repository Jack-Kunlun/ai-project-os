import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createDefaultPersonalModelDraft,
  createPersonalModelConfigurationPatch,
  createPersonalModelEditDraft,
  createPersonalModelKeyPatch,
  hasPersonalModelCapability,
} from "../src/app/profile/models/personal-models-state";

const catalog = [
  {
    kind: "openai" as const,
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyLabel: "OpenAI API Key",
    generationModelSuggestions: ["gpt-4.1-mini"],
    embeddingModelSuggestions: [{ id: "text-embedding-3-small", dimensions: 1536 }],
    visionModelSuggestions: ["gpt-4.1-mini"],
    supportsEmbeddings: true,
    supportsVision: true,
  },
] as const;

test("personal models page keeps authentication and membership evaluation on the server", async () => {
  const page = await readFile("src/app/profile/models/page.tsx", "utf8");

  assert.match(page, /requirePageSession\(\)/u);
  assert.match(page, /getMembershipStatus\(user\.id\)/u);
  assert.match(page, /active="profile"/u);
  assert.match(page, /startsAt: membership\.startsAt\?\.toISOString/u);
  assert.match(page, /expiresAt: membership\.expiresAt\?\.toISOString/u);
  assert.match(page, /<PersonalModelsClient/u);
});

test("personal models experience uses only the personal provider contract and never the admin provider API", async () => {
  const [client, profile] = await Promise.all([
    readFile("src/app/profile/models/personal-models-client.tsx", "utf8"),
    readFile("src/app/profile/profile-client.tsx", "utf8"),
  ]);

  assert.match(client, /fetch\("\/api\/me\/ai-providers"/u);
  assert.match(client, /fetch\(`\/api\/me\/ai-providers\/\$\{provider\.id\}`/u);
  assert.match(client, /\/api\/me\/ai-providers\/\$\{provider\.id\}\/test/u);
  assert.doesNotMatch(client, /\/api\/settings\/providers/u);
  assert.doesNotMatch(client, /window\.(confirm|prompt)/u);
  assert.match(client, /useAppConfirmDialog/u);
  assert.match(client, /requiredValue: current\.name/u);
  assert.match(client, /expectedUpdatedAt/u);
  assert.match(client, /draft\.expectedUpdatedAt/u);
  assert.match(client, /expectedUpdatedAt: current\.updatedAt/u);
  assert.match(client, /type="password"/gu);
  assert.match(client, /autoComplete="new-password"/gu);
  assert.match(client, /apiKey: ""/u);
  assert.match(client, /不含用户或项目内容的探针/u);
  assert.match(client, /await onReload\(\)/u);
  assert.match(client, /AI_PROVIDER_IN_USE/u);
  assert.match(client, /状态已刷新，请重新打开编辑/u);
  assert.match(client, /await onReload\(\)[\s\S]*setEditing\(null\)[\s\S]*setDraft\(null\)/u);
  assert.match(profile, /href="\/profile\/models"/u);
  assert.match(profile, /可在上方提交会员申请/u);
  assert.doesNotMatch(profile, /联系管理员开通会员/u);
  assert.match(profile, /不能测试、启用或调用/u);
});

test("membership states are reflected as capability gates in the personal models page", async () => {
  const client = await readFile("src/app/profile/models/personal-models-client.tsx", "utf8");

  assert.match(client, /const canConfigure = membership\.status === "active"/u);
  assert.match(client, /activeMembership \? <button/u);
  assert.match(client, /当前资格不能重新启用/u);
  assert.match(client, /只允许安全维护/u);
  assert.match(client, /会员已到期/u);
  assert.match(client, /会员资格已撤销/u);
  assert.match(client, /普通用户只能使用平台赠送的免费额度/u);
  assert.match(client, /固定官方端点不可修改/u);
  assert.ok((client.match(/生成模型或向量模型至少配置一项。/gu) ?? []).length >= 2);
  assert.equal((client.match(/type="number" min=\{8\} max=\{8192\} step=\{1\}/gu) ?? []).length, 2);
  assert.match(client, /正在加载可用模型目录/u);
  assert.match(client, /暂时无法加载模型目录/u);
  assert.match(client, /重新加载/u);
});

test("provider deletion is a disabled, exact-name confirmed operation", async () => {
  const client = await readFile("src/app/profile/models/personal-models-client.tsx", "utf8");

  assert.match(client, /if \(current\.status !== "disabled" \|\| current\.disabledAt === null\)/u);
  assert.match(client, /patch\(\{ enabled: false \}/u);
  assert.match(client, /confirmationName: result\.value/u);
  assert.match(client, /method: "DELETE"/u);
  assert.match(client, /删除前已停用连接/u);
});

test("first catalog defaults include a valid generation or embedding capability", () => {
  const draft = createDefaultPersonalModelDraft(catalog);
  assert.ok(draft);
  assert.equal(draft.kind, "openai");
  assert.equal(draft.generationModelId, "gpt-4.1-mini");
  assert.equal(draft.embeddingModelId, "text-embedding-3-small");
  assert.equal(draft.embeddingDimensions, "1536");
  assert.equal(draft.apiKey, "");
  assert.equal(hasPersonalModelCapability(draft), true);
});

test("personal model defaults fail closed for an empty or capability-free catalog", () => {
  assert.equal(createDefaultPersonalModelDraft([]), null);
  const draft = createDefaultPersonalModelDraft([
    {
      ...catalog[0],
      generationModelSuggestions: [],
      embeddingModelSuggestions: [],
      visionModelSuggestions: [],
    },
  ]);
  assert.ok(draft);
  assert.equal(draft.generationModelId, "");
  assert.equal(draft.embeddingModelId, "");
  assert.equal(draft.embeddingDimensions, "");
  assert.equal(draft.visionModelId, "");
  assert.equal(hasPersonalModelCapability(draft), false);
  assert.equal(hasPersonalModelCapability({ generationModelId: "", embeddingModelId: "  " }), false);
  assert.equal(hasPersonalModelCapability({ generationModelId: "gpt-test", embeddingModelId: "" }), true);
});

test("editing snapshot binds fields and expectedUpdatedAt to the same provider version", () => {
  const provider = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "我的 OpenAI",
    kind: "openai" as const,
    protocol: "chatCompletions",
    baseUrl: "https://api.openai.com/v1",
    defaultGenerationModelId: "gpt-4.1-mini",
    defaultEmbeddingModelId: "text-embedding-3-small",
    defaultVisionModelId: null,
    embeddingDimensions: 1536,
    configurationVersion: 1,
    status: "verified",
    lastTestedAt: null,
    lastErrorCode: null,
    disabledAt: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:01.000Z",
    credential: { maskedSuffix: "1234", rotatedAt: null, updatedAt: "2026-09-05T00:00:00.000Z" },
  };
  const draft = createPersonalModelEditDraft(provider);
  assert.equal(draft.expectedUpdatedAt, provider.updatedAt);
  assert.equal(draft.name, provider.name);
  assert.equal(draft.generationModelId, provider.defaultGenerationModelId);
  assert.deepEqual(createPersonalModelConfigurationPatch({ ...draft, name: "新名称" }), {
    name: "新名称",
    generationModelId: "gpt-4.1-mini",
    visionModelId: null,
    embeddingModelId: "text-embedding-3-small",
    embeddingDimensions: 1536,
  });
  assert.deepEqual(createPersonalModelKeyPatch({ ...draft, apiKey: "new-secret" }), { apiKey: "new-secret" });
  const configuration = createPersonalModelConfigurationPatch(draft);
  assert.equal("apiKey" in configuration, false);
  assert.equal("expectedUpdatedAt" in configuration, false);
});

test("personal model patches preserve explicit nulls when optional capability fields are empty", () => {
  const provider = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "无默认模型",
    kind: "openai" as const,
    protocol: "chatCompletions",
    baseUrl: "https://api.openai.com/v1",
    defaultGenerationModelId: null,
    defaultEmbeddingModelId: null,
    defaultVisionModelId: "vision-model",
    embeddingDimensions: null,
    configurationVersion: 1,
    status: "disabled",
    lastTestedAt: null,
    lastErrorCode: null,
    disabledAt: "2026-09-05T00:00:00.000Z",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:01.000Z",
    credential: { maskedSuffix: "5678", rotatedAt: null, updatedAt: "2026-09-05T00:00:00.000Z" },
  };
  const draft = createPersonalModelEditDraft(provider);
  assert.deepEqual(draft, {
    name: "无默认模型",
    kind: "openai",
    apiKey: "",
    generationModelId: "",
    visionModelId: "vision-model",
    embeddingModelId: "",
    embeddingDimensions: "",
    expectedUpdatedAt: provider.updatedAt,
  });
  assert.deepEqual(createPersonalModelConfigurationPatch(draft), {
    name: "无默认模型",
    generationModelId: null,
    visionModelId: "vision-model",
    embeddingModelId: null,
    embeddingDimensions: null,
  });
  assert.deepEqual(
    createPersonalModelConfigurationPatch({ ...draft, embeddingModelId: "embedding-model", embeddingDimensions: "" }),
    {
      name: "无默认模型",
      generationModelId: null,
      visionModelId: "vision-model",
      embeddingModelId: "embedding-model",
      embeddingDimensions: null,
    },
  );
});
