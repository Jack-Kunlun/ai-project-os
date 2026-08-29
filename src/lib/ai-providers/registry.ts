import type { AiProviderKind } from "@prisma/client";

export type ProviderDefinition = Readonly<{
  kind: AiProviderKind;
  displayName: string;
  baseUrl: string;
  apiKeyLabel: string;
  generationModelSuggestions: readonly string[];
  embeddingModelSuggestions: readonly Readonly<{ id: string; dimensions: number }>[];
  visionModelSuggestions: readonly string[];
  supportsEmbeddings: boolean;
  supportsVision: boolean;
}>;

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = Object.freeze([
  Object.freeze({
    kind: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyLabel: "OpenAI API Key",
    generationModelSuggestions: Object.freeze(["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"]),
    embeddingModelSuggestions: Object.freeze([
      Object.freeze({ id: "text-embedding-3-small", dimensions: 1536 }),
      Object.freeze({ id: "text-embedding-3-large", dimensions: 3072 }),
    ]),
    visionModelSuggestions: Object.freeze(["gpt-4.1-mini", "gpt-4o-mini"]),
    supportsEmbeddings: true,
    supportsVision: true,
  }),
  Object.freeze({
    kind: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyLabel: "DeepSeek API Key",
    generationModelSuggestions: Object.freeze(["deepseek-chat", "deepseek-reasoner"]),
    embeddingModelSuggestions: Object.freeze([]),
    visionModelSuggestions: Object.freeze(["deepseek-v4-flash-vision-exp"]),
    supportsEmbeddings: false,
    supportsVision: true,
  }),
  Object.freeze({
    kind: "qwen",
    displayName: "Qwen（阿里云百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyLabel: "DashScope API Key",
    generationModelSuggestions: Object.freeze(["qwen-plus", "qwen-max", "qwen-turbo"]),
    embeddingModelSuggestions: Object.freeze([
      Object.freeze({ id: "text-embedding-v4", dimensions: 1024 }),
      Object.freeze({ id: "text-embedding-v3", dimensions: 1024 }),
    ]),
    visionModelSuggestions: Object.freeze(["qwen3-vl-plus", "qwen-vl-max"]),
    supportsEmbeddings: true,
    supportsVision: true,
  }),
  Object.freeze({
    kind: "glm",
    displayName: "GLM（智谱开放平台）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyLabel: "智谱 API Key",
    generationModelSuggestions: Object.freeze(["glm-4-flash", "glm-4-plus", "glm-4-air"]),
    embeddingModelSuggestions: Object.freeze([
      Object.freeze({ id: "embedding-3", dimensions: 2048 }),
      Object.freeze({ id: "embedding-2", dimensions: 1024 }),
    ]),
    visionModelSuggestions: Object.freeze(["glm-5v-turbo", "glm-4.5v"]),
    supportsEmbeddings: true,
    supportsVision: true,
  }),
]);

const definitionByKind = new Map(PROVIDER_DEFINITIONS.map((definition) => [definition.kind, definition]));
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function getProviderDefinition(kind: AiProviderKind): ProviderDefinition {
  const definition = definitionByKind.get(kind);
  if (definition === undefined) throw new Error("AI_PROVIDER_KIND_UNSUPPORTED");
  return definition;
}

export function canonicalProviderBaseUrl(kind: AiProviderKind): string {
  return getProviderDefinition(kind).baseUrl;
}

export function isSafeModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value) && !value.includes("://") && !value.includes("..");
}
