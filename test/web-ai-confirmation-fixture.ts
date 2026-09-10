import type { BackgroundJobKind, PrismaClient } from "@prisma/client";
import { getDb } from "../src/lib/db";
import {
  confirmationActionForBackgroundJobKind,
  confirmationRouteSnapshot,
  confirmationRouteDisplay,
  parseWebAiConfirmationSafeSummary,
  prepareWebAiConfirmation,
  type WebAiConfirmationAction,
} from "../src/lib/web-ai-confirmation";
import { createGrantedWebAiJob } from "../src/lib/web-ai-governance";

type CreateGrantedWebAiJobInput = Parameters<typeof createGrantedWebAiJob>[0];

function confirmationActionForJobKind(kind: BackgroundJobKind): WebAiConfirmationAction {
  const action = confirmationActionForBackgroundJobKind(kind);
  if (action === null) throw new Error(`WEB_AI_GATE_CONFIRMATION_ACTION_UNMAPPED:${kind}`);
  return action;
}

function safeScopeItemCount(scopeIds: unknown): number {
  if (Array.isArray(scopeIds)) return scopeIds.length;
  if (typeof scopeIds === "object" && scopeIds !== null) return Object.keys(scopeIds).length;
  return 0;
}

type ConfirmationRouteContext = Readonly<{
  embedding?: CreateGrantedWebAiJobInput["route"];
  generation?: CreateGrantedWebAiJobInput["route"];
}>;

function confirmationRouteDisplayFor(
  route: CreateGrantedWebAiJobInput["route"],
  actorId: string,
) {
  return confirmationRouteDisplay(route, { actorId, projectOwner: false });
}

function safeSummaryForAction(
  input: ConfirmedWebAiJobInput,
  targetAction: WebAiConfirmationAction,
) {
  const route = confirmationRouteDisplayFor(input.route, input.requestedBy.id);
  const embeddingRoute = input.confirmationRoutes?.embedding === undefined
    ? route
    : confirmationRouteDisplayFor(input.confirmationRoutes.embedding, input.requestedBy.id);
  const generationRoute = input.confirmationRoutes?.generation === undefined
    ? route
    : confirmationRouteDisplayFor(input.confirmationRoutes.generation, input.requestedBy.id);
  const count = Math.max(1, Math.min(10, safeScopeItemCount(input.scopeIds)));
  const summary = targetAction === "memoryExtract"
    ? { action: targetAction, route, scope: { sourceCount: count } }
    : targetAction === "memoryIndex"
      ? { action: targetAction, route, scope: { mode: "full" as const, inputCount: count, generateCount: count, reuseCount: 0, deleteCount: 0, estimatedProviderCalls: count } }
      : targetAction === "memorySearch"
        ? { action: targetAction, route: { embedding: embeddingRoute }, scope: { indexGenerationId: input.projectId } }
        : targetAction === "memoryAnswer"
          ? { action: targetAction, route: { embedding: embeddingRoute, generation: generationRoute }, scope: { indexGenerationId: input.projectId } }
          : targetAction === "assetRecognize"
            ? { action: targetAction, route, scope: { segmentCount: count, mimeType: "application/octet-stream" } }
            : targetAction === "intelligenceBrief"
              ? { action: targetAction, route: { embedding: embeddingRoute, generation: generationRoute }, scope: { indexGenerationId: input.projectId } }
              : { action: targetAction, route: { embedding: embeddingRoute, generation: generationRoute }, scope: { indexGenerationId: input.projectId, questionProvided: true as const } };
  return parseWebAiConfirmationSafeSummary(summary, targetAction);
}

export type ConfirmedWebAiJobInput = Omit<CreateGrantedWebAiJobInput, "confirmation" | "refreshConfirmation"> & Readonly<{
  /** Test-only route context for actions that dispatch both embedding and generation. */
  confirmationRoutes?: ConfirmationRouteContext;
}>;

export async function prepareConfirmedWebAiJobForPostgresGate(
  input: ConfirmedWebAiJobInput,
  db: PrismaClient = getDb(),
) {
  const targetAction = confirmationActionForJobKind(input.kind);
  const { confirmationRoutes, ...productionInput } = input;
  const confirmationMaterial = Object.freeze({
    contentVersion: `postgres-gate:web-ai:${targetAction}:${input.manifestFingerprint}`,
    inputFingerprintPayload: Object.freeze({
      kind: input.kind,
      scopeKind: input.scopeKind,
      scopeIds: input.scopeIds,
      manifestFingerprint: input.manifestFingerprint,
    }),
    routeSnapshot: confirmationRouteSnapshot(input.route),
  });
  const prepared = await prepareWebAiConfirmation({
    projectId: input.projectId,
    actor: input.requestedBy,
    targetAction,
    clientKey: input.clientKey,
    db,
    resolve: async () => ({
      ...confirmationMaterial,
      safeSummary: safeSummaryForAction({ ...productionInput, confirmationRoutes }, targetAction),
    }),
  });
  return Object.freeze({
    input: productionInput,
    confirmation: Object.freeze({
      challengeId: prepared.challengeId,
      clientKey: input.clientKey,
      targetAction,
      ...confirmationMaterial,
    }),
    targetAction,
  });
}

/**
 * Create a test job through the real prepare -> execute confirmation protocol.
 * The returned browser view is intentionally not trusted for execution: the
 * exact material used during preparation is passed to createGrantedWebAiJob.
 */
export async function createConfirmedWebAiJobForPostgresGate(
  input: ConfirmedWebAiJobInput,
  db: PrismaClient = getDb(),
): ReturnType<typeof createGrantedWebAiJob> {
  const prepared = await prepareConfirmedWebAiJobForPostgresGate(input, db);
  return createGrantedWebAiJob({ ...prepared.input, confirmation: prepared.confirmation }, db);
}
