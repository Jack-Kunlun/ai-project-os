import { createHash } from "node:crypto";
import type { AiProviderConnectionStatus, Prisma, PrismaClient } from "@prisma/client";
import { getProviderDefinition, isSafeModelId } from "@/lib/ai-providers/registry";
import { canonicalPersonalKnowledgeSemanticJson } from "@/lib/personal-knowledge-semantic-contract";

type Db = PrismaClient | Prisma.TransactionClient;
export type SemanticBillingRoute = Readonly<{
  source: "platform_default";
  routeId: string;
  routeVersion: number;
  routeUpdatedAt: Date;
  providerConfigurationVersion: number;
  quotaMultiplierBps: number;
  routeFenceFingerprint: string;
}>;

export type SemanticProvider = Readonly<{
  id: string;
  name: string;
  kind: "openai" | "deepseek" | "qwen" | "glm";
  scope: "platform" | "user";
  ownerUserId: string | null;
  protocol: "chatCompletions";
  baseUrl: string;
  credentialId: string;
  configurationVersion: number;
  ownerAccountAccessVersion: number | null;
  status: AiProviderConnectionStatus;
  disabledAt: Date | null;
  defaultEmbeddingModelId: string | null;
  embeddingDimensions: number | null;
  credential: { kind: "aiProvider"; secretFingerprint: string };
  billingRoute?: SemanticBillingRoute;
}>;

export const semanticProviderSelect = {
  id: true, name: true, kind: true, scope: true, ownerUserId: true,
  protocol: true, baseUrl: true, credentialId: true, configurationVersion: true,
  ownerAccountAccessVersion: true, status: true, disabledAt: true,
  defaultEmbeddingModelId: true, embeddingDimensions: true,
  credential: { select: { kind: true, secretFingerprint: true } },
} as const;

export function semanticProviderVerified(provider: SemanticProvider): boolean {
  const definition = getProviderDefinition(provider.kind);
  return provider.protocol === "chatCompletions"
    && provider.baseUrl === definition.baseUrl
    && provider.status === "verified" && provider.disabledAt === null
    && provider.defaultEmbeddingModelId !== null && isSafeModelId(provider.defaultEmbeddingModelId)
    && Number.isSafeInteger(provider.embeddingDimensions)
    && provider.embeddingDimensions! >= 8 && provider.embeddingDimensions! <= 8_192
    && Number.isSafeInteger(provider.configurationVersion) && provider.configurationVersion > 0
    && provider.credential.kind === "aiProvider"
    && /^[0-9a-f]{64}$/u.test(provider.credential.secretFingerprint)
    && definition.supportsEmbeddings;
}

/** Join the same operation fence used by platform route configuration writes. */
export async function lockPersonalSemanticRoute(db: Db): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('embedding', 40904004))`;
}

/** Only the tested, active embedding route is eligible for ordinary users. */
export async function readPersonalSemanticPlatformProvider(db: Db): Promise<SemanticProvider | null> {
  const route = await db.platformDefaultAiRoute.findFirst({
    where: { operation: "embedding", status: "active" },
    orderBy: [{ version: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    include: { providerConnection: { select: semanticProviderSelect } },
  });
  if (route === null) return null;
  const provider = route.providerConnection as SemanticProvider;
  if (provider.scope !== "platform" || provider.ownerUserId !== null
    || !semanticProviderVerified(provider) || route.validatedAt === null
    || route.validatedProviderConfigurationVersion !== provider.configurationVersion
    || route.modelId !== provider.defaultEmbeddingModelId || route.embeddingDimensions !== provider.embeddingDimensions
    || !Number.isSafeInteger(route.quotaMultiplierBps) || route.quotaMultiplierBps < 1 || route.quotaMultiplierBps > 100_000) return null;
  const material = {
    operation: "personalKnowledgeEmbedding", routeId: route.id, version: route.version,
    updatedAt: route.updatedAt, providerId: provider.id, configurationVersion: provider.configurationVersion,
    model: route.modelId, dimensions: route.embeddingDimensions, quotaMultiplierBps: route.quotaMultiplierBps,
    credentialSecretFingerprint: provider.credential.secretFingerprint,
  };
  return Object.freeze({ ...provider, billingRoute: Object.freeze({
    source: "platform_default" as const, routeId: route.id, routeVersion: route.version,
    routeUpdatedAt: route.updatedAt, providerConfigurationVersion: provider.configurationVersion,
    quotaMultiplierBps: route.quotaMultiplierBps,
    routeFenceFingerprint: createHash("sha256").update(canonicalPersonalKnowledgeSemanticJson(material)).digest("hex"),
  }) });
}

export function semanticProviderOwnerMatches(provider: SemanticProvider, accountAccessVersion: number): boolean {
  return provider.scope === "platform"
    ? provider.ownerUserId === null && provider.billingRoute !== undefined
    : provider.ownerAccountAccessVersion === accountAccessVersion;
}

export function semanticBillingMatches(left: SemanticProvider, right: SemanticProvider): boolean {
  return (left.billingRoute?.routeFenceFingerprint ?? null) === (right.billingRoute?.routeFenceFingerprint ?? null);
}
