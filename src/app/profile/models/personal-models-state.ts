export type PersonalProviderKind = "openai" | "deepseek" | "qwen" | "glm";

export type PersonalProviderCatalogEntry = Readonly<{
  kind: PersonalProviderKind;
  displayName: string;
  baseUrl: string;
  apiKeyLabel: string;
  generationModelSuggestions: readonly string[];
  embeddingModelSuggestions: readonly Readonly<{ id: string; dimensions: number }>[];
  visionModelSuggestions: readonly string[];
  supportsEmbeddings: boolean;
  supportsVision: boolean;
}>;

export type PersonalProviderRecord = Readonly<{
  id: string;
  name: string;
  kind: PersonalProviderKind;
  protocol: string;
  baseUrl: string;
  defaultGenerationModelId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  embeddingDimensions: number | null;
  configurationVersion: number;
  status: string;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  credential: { maskedSuffix: string; rotatedAt: string | null; updatedAt: string };
}>;

export type PersonalModelDraft = Readonly<{
  name: string;
  kind: PersonalProviderKind;
  apiKey: string;
  generationModelId: string;
  visionModelId: string;
  embeddingModelId: string;
  embeddingDimensions: string;
  expectedUpdatedAt?: string;
}>;

export function createDefaultPersonalModelDraft(
  catalog: readonly PersonalProviderCatalogEntry[],
  name = "",
): PersonalModelDraft | null {
  const definition = catalog[0];
  if (definition === undefined) return null;
  const embedding = definition.embeddingModelSuggestions[0];
  return Object.freeze({
    name,
    kind: definition.kind,
    apiKey: "",
    generationModelId: definition.generationModelSuggestions[0] ?? "",
    visionModelId: definition.visionModelSuggestions[0] ?? "",
    embeddingModelId: embedding?.id ?? "",
    embeddingDimensions: embedding === undefined ? "" : String(embedding.dimensions),
  });
}

export function createPersonalModelEditDraft(provider: PersonalProviderRecord): PersonalModelDraft {
  return Object.freeze({
    name: provider.name,
    kind: provider.kind,
    apiKey: "",
    generationModelId: provider.defaultGenerationModelId ?? "",
    visionModelId: provider.defaultVisionModelId ?? "",
    embeddingModelId: provider.defaultEmbeddingModelId ?? "",
    embeddingDimensions: provider.embeddingDimensions === null ? "" : String(provider.embeddingDimensions),
    expectedUpdatedAt: provider.updatedAt,
  });
}

export function hasPersonalModelCapability(draft: Pick<PersonalModelDraft, "generationModelId" | "embeddingModelId">): boolean {
  return draft.generationModelId.trim().length > 0 || draft.embeddingModelId.trim().length > 0;
}

export function createPersonalModelConfigurationPatch(
  draft: Pick<PersonalModelDraft, "name" | "generationModelId" | "visionModelId" | "embeddingModelId" | "embeddingDimensions">,
) {
  return {
    name: draft.name,
    generationModelId: draft.generationModelId || null,
    visionModelId: draft.visionModelId || null,
    embeddingModelId: draft.embeddingModelId || null,
    embeddingDimensions: draft.embeddingModelId && draft.embeddingDimensions ? Number(draft.embeddingDimensions) : null,
  } as const;
}

export function createPersonalModelKeyPatch(draft: Pick<PersonalModelDraft, "apiKey">) {
  return { apiKey: draft.apiKey } as const;
}
