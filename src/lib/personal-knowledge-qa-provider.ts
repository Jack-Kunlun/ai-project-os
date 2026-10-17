import { createHash } from "node:crypto";
import type { AiProviderConnectionStatus, Prisma, PrismaClient } from "@prisma/client";
import { getProviderDefinition, isSafeModelId } from "@/lib/ai-providers/registry";
import { canonicalPersonalKnowledgeQaJson } from "@/lib/personal-knowledge-qa-contract";

type QaProviderDb = PrismaClient | Prisma.TransactionClient;

export type PersonalKnowledgeQaBillingRoute = Readonly<{
  source: "platform_default";
  routeId: string;
  routeVersion: number;
  routeUpdatedAt: Date;
  providerConfigurationVersion: number;
  quotaMultiplierBps: number;
  maxOutputTokens: number;
  routeFenceFingerprint: string;
}>;

export type PersonalKnowledgeQaProvider = Readonly<{
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
  defaultGenerationModelId: string | null;
  credential: Readonly<{ kind: string; secretFingerprint: string }>;
  billingRoute?: PersonalKnowledgeQaBillingRoute;
}>;

export const personalKnowledgeQaProviderSelect = {
  id: true,
  name: true,
  kind: true,
  scope: true,
  ownerUserId: true,
  protocol: true,
  baseUrl: true,
  credentialId: true,
  configurationVersion: true,
  ownerAccountAccessVersion: true,
  status: true,
  disabledAt: true,
  defaultGenerationModelId: true,
  credential: { select: { kind: true, secretFingerprint: true } },
} as const;

const ROUTE_OPERATION = "generateWithContext" as const;
const PLATFORM_QUOTA_BPS_MIN = 1;
const PLATFORM_QUOTA_BPS_MAX = 100_000;
const PLATFORM_MAX_OUTPUT_TOKENS = 4_096;

function canonicalRouteJson(value: Readonly<Record<string, string | number | Date>>): string {
  return canonicalPersonalKnowledgeQaJson(value);
}

export function personalKnowledgeQaProviderVerified(provider: PersonalKnowledgeQaProvider): boolean {
  let definition;
  try {
    definition = getProviderDefinition(provider.kind);
  } catch {
    return false;
  }
  return provider.protocol === "chatCompletions"
    && provider.baseUrl === definition.baseUrl
    && provider.status === "verified"
    && provider.disabledAt === null
    && provider.defaultGenerationModelId !== null
    && isSafeModelId(provider.defaultGenerationModelId)
    && Number.isSafeInteger(provider.configurationVersion)
    && provider.configurationVersion > 0
    && provider.credential.kind === "aiProvider"
    && /^[0-9a-f]{64}$/u.test(provider.credential.secretFingerprint);
}

/** Join the same advisory fence used by writes to this platform operation. */
export async function lockPersonalKnowledgeQaRoute(db: QaProviderDb): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('generateWithContext', 40904004))`;
}

/** Return only the active, validated platform default route for page Q&A. */
export async function readPersonalKnowledgeQaPlatformProvider(db: QaProviderDb): Promise<PersonalKnowledgeQaProvider | null> {
  const route = await db.platformDefaultAiRoute.findFirst({
    where: { operation: ROUTE_OPERATION, status: "active" },
    orderBy: [{ version: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    include: { providerConnection: { select: personalKnowledgeQaProviderSelect } },
  });
  if (route === null) return null;
  const provider = route.providerConnection as PersonalKnowledgeQaProvider;
  if (provider.scope !== "platform" || provider.ownerUserId !== null
    || !personalKnowledgeQaProviderVerified(provider)
    || route.validatedAt === null
    || route.validatedProviderConfigurationVersion !== provider.configurationVersion
    || route.modelId !== provider.defaultGenerationModelId
    || route.embeddingDimensions !== null
    || !Number.isSafeInteger(route.maxOutputTokens)
    || route.maxOutputTokens === null || route.maxOutputTokens < 1 || route.maxOutputTokens > PLATFORM_MAX_OUTPUT_TOKENS
    || !Number.isSafeInteger(route.quotaMultiplierBps)
    || route.quotaMultiplierBps < PLATFORM_QUOTA_BPS_MIN || route.quotaMultiplierBps > PLATFORM_QUOTA_BPS_MAX) return null;

  const material = {
    operation: ROUTE_OPERATION,
    routeId: route.id,
    version: route.version,
    updatedAt: route.updatedAt,
    providerId: provider.id,
    providerConfigurationVersion: provider.configurationVersion,
    modelId: route.modelId,
    credentialSecretFingerprint: provider.credential.secretFingerprint,
    quotaMultiplierBps: route.quotaMultiplierBps,
    maxOutputTokens: route.maxOutputTokens,
  };
  const routeFenceFingerprint = createHash("sha256").update(canonicalRouteJson(material)).digest("hex");
  return Object.freeze({ ...provider, billingRoute: Object.freeze({
    source: "platform_default" as const,
    routeId: route.id,
    routeVersion: route.version,
    routeUpdatedAt: route.updatedAt,
    providerConfigurationVersion: provider.configurationVersion,
    quotaMultiplierBps: route.quotaMultiplierBps,
    maxOutputTokens: route.maxOutputTokens,
    routeFenceFingerprint,
  }) });
}

export function personalKnowledgeQaBillingMatches(left: PersonalKnowledgeQaProvider, right: PersonalKnowledgeQaProvider): boolean {
  const a = left.billingRoute;
  const b = right.billingRoute;
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return a.routeId === b.routeId
    && a.routeVersion === b.routeVersion
    && a.routeUpdatedAt.getTime() === b.routeUpdatedAt.getTime()
    && a.providerConfigurationVersion === b.providerConfigurationVersion
    && a.quotaMultiplierBps === b.quotaMultiplierBps
    && a.maxOutputTokens === b.maxOutputTokens
    && a.routeFenceFingerprint === b.routeFenceFingerprint;
}
