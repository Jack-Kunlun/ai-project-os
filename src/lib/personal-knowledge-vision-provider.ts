import { createHash } from "node:crypto";
import type { AiProviderConnectionStatus, AiProviderKind, AiProviderProtocol, Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { getProviderDefinition, isSafeModelId } from "@/lib/ai-providers/registry";
import { getDb } from "@/lib/db";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = Readonly<{ id: string; role: "admin" | "user"; accountAccessVersion?: number }>;
export const PERSONAL_VISION_MAX_OUTPUT_TOKENS = 2_048;

export type PersonalVisionBillingRoute = Readonly<{
  source: "platform_default";
  routeId: string;
  routeVersion: number;
  routeUpdatedAt: Date;
  providerConfigurationVersion: number;
  quotaMultiplierBps: number;
  maxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  routeFenceFingerprint: string;
}>;

export type PersonalVisionProvider = Readonly<{
  id: string;
  name: string;
  kind: AiProviderKind;
  scope: "platform" | "user";
  ownerUserId: string | null;
  protocol: AiProviderProtocol;
  baseUrl: string;
  credentialId: string;
  configurationVersion: number;
  ownerAccountAccessVersion: number | null;
  status: AiProviderConnectionStatus;
  disabledAt: Date | null;
  defaultVisionModelId: string | null;
  credential: Readonly<{ kind: string; secretFingerprint: string }>;
  billingRoute?: PersonalVisionBillingRoute;
}>;

export const personalVisionProviderSelect = {
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
  defaultVisionModelId: true,
  credential: { select: { kind: true, secretFingerprint: true } },
} as const;

function stableJson(value: Readonly<Record<string, string | number | Date>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, item instanceof Date ? item.toISOString() : item,
  ] as const).sort(([left], [right]) => left.localeCompare(right))));
}

export function personalVisionProviderVerified(provider: PersonalVisionProvider): boolean {
  let definition;
  try { definition = getProviderDefinition(provider.kind); }
  catch { return false; }
  const modelId = provider.defaultVisionModelId;
  return provider.protocol === "chatCompletions"
    && provider.baseUrl === definition.baseUrl
    && provider.status === "verified"
    && provider.disabledAt === null
    && definition.supportsVision
    && modelId !== null
    && isSafeModelId(modelId)
    // DeepSeek vision is a model-specific transport capability. Other model
    // IDs are admitted only after the provider's configured model was tested.
    && (provider.kind !== "deepseek" || modelId === "deepseek-flash" || modelId === "deepseek-v4-flash-vision-exp")
    && Number.isSafeInteger(provider.configurationVersion)
    && provider.configurationVersion > 0
    && provider.credential.kind === "aiProvider"
    && /^[0-9a-f]{64}$/u.test(provider.credential.secretFingerprint);
}

/** Join the same operation fence used by platform vision-route writes. */
export async function lockPersonalVisionRoute(db: Db): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('visionExtract', 40904004))`;
}

/** Return only the currently validated platform default vision route. */
export async function readPersonalVisionPlatformProvider(db: Db): Promise<PersonalVisionProvider | null> {
  const route = await db.platformDefaultAiRoute.findFirst({
    where: { operation: "visionExtract", status: "active" },
    orderBy: [{ version: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    include: { providerConnection: { select: personalVisionProviderSelect } },
  });
  if (route === null) return null;
  const provider = route.providerConnection as PersonalVisionProvider;
  if (provider.scope !== "platform" || provider.ownerUserId !== null
    || !personalVisionProviderVerified(provider)
    || route.validatedAt === null
    || route.validatedProviderConfigurationVersion !== provider.configurationVersion
    || route.modelId !== provider.defaultVisionModelId
    || route.embeddingDimensions !== null
    || !Number.isSafeInteger(route.maxOutputTokens)
    || route.maxOutputTokens === null || route.maxOutputTokens < 1 || route.maxOutputTokens > 4_096
    || !Number.isSafeInteger(route.quotaMultiplierBps)
    || route.quotaMultiplierBps < 1 || route.quotaMultiplierBps > 100_000) return null;
  const material = {
    operation: "personalKnowledgeVision",
    routeId: route.id,
    version: route.version,
    updatedAt: route.updatedAt,
    providerId: provider.id,
    providerConfigurationVersion: provider.configurationVersion,
    modelId: route.modelId,
    credentialSecretFingerprint: provider.credential.secretFingerprint,
    quotaMultiplierBps: route.quotaMultiplierBps,
    maxOutputTokens: route.maxOutputTokens,
    effectiveMaxOutputTokens: Math.min(route.maxOutputTokens, PERSONAL_VISION_MAX_OUTPUT_TOKENS),
  };
  const routeFenceFingerprint = createHash("sha256").update(stableJson(material)).digest("hex");
  return Object.freeze({ ...provider, billingRoute: Object.freeze({
    source: "platform_default" as const,
    routeId: route.id,
    routeVersion: route.version,
    routeUpdatedAt: route.updatedAt,
    providerConfigurationVersion: provider.configurationVersion,
    quotaMultiplierBps: route.quotaMultiplierBps,
    maxOutputTokens: route.maxOutputTokens,
    effectiveMaxOutputTokens: Math.min(route.maxOutputTokens, PERSONAL_VISION_MAX_OUTPUT_TOKENS),
    routeFenceFingerprint,
  }) });
}

export function personalVisionBillingMatches(left: PersonalVisionProvider, right: PersonalVisionProvider): boolean {
  const a = left.billingRoute;
  const b = right.billingRoute;
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return a !== undefined && b !== undefined
    && a.routeId === b.routeId
    && a.routeVersion === b.routeVersion
    && a.routeUpdatedAt.getTime() === b.routeUpdatedAt.getTime()
    && a.providerConfigurationVersion === b.providerConfigurationVersion
    && a.quotaMultiplierBps === b.quotaMultiplierBps
    && a.maxOutputTokens === b.maxOutputTokens
    && a.effectiveMaxOutputTokens === b.effectiveMaxOutputTokens
    && a.routeFenceFingerprint === b.routeFenceFingerprint;
}

export type PersonalKnowledgeVisionProviderOption = Readonly<{
  id: string;
  name: string;
  modelId: string;
  billingMode: "platform" | "byok";
  quotaMultiplierBps: number | null;
  isDefault: boolean;
}>;

/** Safe, owner-scoped provider projection for the import confirmation UI. */
export async function listPersonalKnowledgeVisionProviders(
  actor: Actor,
  db: PrismaClient = getDb(),
): Promise<Readonly<{ providers: readonly PersonalKnowledgeVisionProviderOption[]; platformRouteAvailable: boolean }>> {
  if (actor.role !== "user") throw new ApiError(403, "PERSONAL_VISION_FORBIDDEN", "当前账号不能使用个人视觉识别");
  const access = await assertAccountAccessForActor(db, actor);
  const [platformProvider, personalProviders] = await Promise.all([
    readPersonalVisionPlatformProvider(db),
    db.aiProviderConnection.findMany({
      where: { scope: "user", ownerUserId: actor.id, ownerAccountAccessVersion: access.accountAccessVersion },
      select: personalVisionProviderSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);
  const platformOption = platformProvider !== null && personalVisionProviderVerified(platformProvider)
    ? [{
        id: platformProvider.id,
        name: platformProvider.name,
        modelId: platformProvider.defaultVisionModelId!,
        billingMode: "platform" as const,
        quotaMultiplierBps: platformProvider.billingRoute!.quotaMultiplierBps,
        isDefault: true,
      }]
    : [];
  const byokOptions = personalProviders
    .filter((provider) => provider.scope === "user" && provider.ownerUserId === actor.id
      && provider.ownerAccountAccessVersion === access.accountAccessVersion
      && personalVisionProviderVerified(provider as PersonalVisionProvider))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      modelId: provider.defaultVisionModelId!,
      billingMode: "byok" as const,
      quotaMultiplierBps: null,
      isDefault: false,
    }));
  const defaultByokId = byokOptions[0]?.id ?? null;
  const providers = [
    ...platformOption,
    ...byokOptions.map((provider) => ({ ...provider, isDefault: platformOption.length === 0 && provider.id === defaultByokId })),
  ];
  return Object.freeze({ providers: Object.freeze(providers), platformRouteAvailable: platformOption.length > 0 });
}
