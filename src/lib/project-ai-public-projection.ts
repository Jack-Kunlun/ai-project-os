/**
 * Public projection for project AI provider metadata.
 *
 * Provider connection identifiers are never part of this projection. Personal
 * connection metadata is deny-by-default: only the connection owner may see
 * its name, while a confirmed project owner may see the minimum model/kind
 * needed to understand the selected operation.
 */
export type ProjectAiPublicVisibility = Readonly<{
  actorId: string;
  projectOwner: boolean;
}>;

export type ProjectAiProviderSnapshot = Readonly<{
  scope?: string | null;
  ownerUserId: string | null;
  name: string;
  kind: string;
  status?: string;
}>;

export type ProjectAiProviderProjection = Readonly<{
  name?: string;
  kind?: string;
  status?: string;
}>;

export function isProjectAiPlatformProvider(provider: ProjectAiProviderSnapshot): boolean {
  return provider.scope === "platform" && provider.ownerUserId === null;
}

export function isProjectAiPersonalProvider(provider: ProjectAiProviderSnapshot): boolean {
  return provider.scope === "user" && provider.ownerUserId !== null;
}

export function canSeeProjectAiPersonalModel(
  provider: ProjectAiProviderSnapshot,
  visibility: ProjectAiPublicVisibility,
): boolean {
  return isProjectAiPersonalProvider(provider) && (
    provider.ownerUserId === visibility.actorId || visibility.projectOwner
  );
}

export async function loadProjectAiPublicVisibility(
  db: ProjectAiProjectionDb,
  projectId: string,
  actorId: string,
): Promise<ProjectAiPublicVisibility> {
  const membership = await db.projectMembership.findFirst({
    where: { projectId, userId: actorId, accessState: "confirmed", role: "owner" },
    select: { id: true },
  });
  return Object.freeze({ actorId, projectOwner: membership !== null });
}

export function projectAiProviderProjection(
  provider: ProjectAiProviderSnapshot,
  visibility: ProjectAiPublicVisibility,
): ProjectAiProviderProjection | null {
  const isPlatform = isProjectAiPlatformProvider(provider);
  const isPersonal = isProjectAiPersonalProvider(provider);
  if (!isPlatform && !isPersonal) return null;
  if (isPlatform) {
    return Object.freeze({
      name: provider.name,
      kind: provider.kind,
      ...(provider.status === undefined ? {} : { status: provider.status }),
    });
  }
  if (provider.ownerUserId === visibility.actorId) {
    return Object.freeze({
      name: provider.name,
      kind: provider.kind,
      ...(provider.status === undefined ? {} : { status: provider.status }),
    });
  }
  if (visibility.projectOwner) {
    return Object.freeze({ kind: provider.kind });
  }
  return null;
}

export function projectAiModelProjection(
  modelId: string,
  provider: ProjectAiProviderSnapshot,
  visibility: ProjectAiPublicVisibility,
): string | null {
  const isPlatform = isProjectAiPlatformProvider(provider);
  const isPersonal = isProjectAiPersonalProvider(provider);
  if (isPlatform) return modelId;
  if (isPersonal && (visibility.projectOwner || provider.ownerUserId === visibility.actorId)) return modelId;
  return null;
}

import type { Prisma, PrismaClient } from "@prisma/client";

type ProjectAiProjectionDb = PrismaClient | Prisma.TransactionClient;
