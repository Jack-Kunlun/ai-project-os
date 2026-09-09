import type { BackgroundJobKind, PrismaClient } from "@prisma/client";
import { getDb } from "../src/lib/db";
import {
  confirmationRouteSnapshot,
  prepareWebAiConfirmation,
  type WebAiConfirmationAction,
} from "../src/lib/web-ai-confirmation";
import { createGrantedWebAiJob } from "../src/lib/web-ai-governance";

type CreateGrantedWebAiJobInput = Parameters<typeof createGrantedWebAiJob>[0];

/**
 * The Web AI gate deliberately exercises the same browser confirmation
 * boundary as production. Keep this mapping explicit so a newly added job
 * kind cannot silently fall back to an unrelated confirmation action.
 */
const confirmationActionByJobKind: Readonly<Partial<Record<BackgroundJobKind, WebAiConfirmationAction>>> = Object.freeze({
  autoExtract: "memoryExtract",
  memoryIndex: "memoryIndex",
  semanticSearch: "memorySearch",
  ragAnswer: "memoryAnswer",
  assetExtract: "assetRecognize",
  projectBrief: "intelligenceBrief",
  projectAgent: "intelligenceAgent",
});

function confirmationActionForJobKind(kind: BackgroundJobKind): WebAiConfirmationAction {
  const action = confirmationActionByJobKind[kind];
  if (action === undefined) throw new Error(`WEB_AI_GATE_CONFIRMATION_ACTION_UNMAPPED:${kind}`);
  return action;
}

function safeScopeItemCount(scopeIds: unknown): number {
  if (Array.isArray(scopeIds)) return scopeIds.length;
  if (typeof scopeIds === "object" && scopeIds !== null) return Object.keys(scopeIds).length;
  return 0;
}

export type ConfirmedWebAiJobInput = Omit<CreateGrantedWebAiJobInput, "confirmation" | "refreshConfirmation">;

/**
 * Create a test job through the real prepare -> execute confirmation protocol.
 * The returned browser view is intentionally not trusted for execution: the
 * exact material used during preparation is passed to createGrantedWebAiJob.
 */
export async function createConfirmedWebAiJobForPostgresGate(
  input: ConfirmedWebAiJobInput,
  db: PrismaClient = getDb(),
): ReturnType<typeof createGrantedWebAiJob> {
  const targetAction = confirmationActionForJobKind(input.kind);
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
      safeSummary: Object.freeze({
        action: targetAction,
        scopeKind: input.scopeKind,
        scopeItemCount: safeScopeItemCount(input.scopeIds),
      }),
    }),
  });
  return createGrantedWebAiJob({
    ...input,
    confirmation: {
      challengeId: prepared.challengeId,
      clientKey: input.clientKey,
      targetAction,
      ...confirmationMaterial,
    },
  }, db);
}
