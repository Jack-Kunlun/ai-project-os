import { randomUUID } from "node:crypto";
import type { AiProviderKind, PrismaClient } from "@prisma/client";
import { createProviderConnection, type PlatformProviderActor } from "../src/lib/ai-providers/service";
import { runPlatformProviderDraftProbe } from "../src/lib/platform-provider-draft-probe-service";
import { createAndActivatePlatformProviderProbeBudget } from "../src/lib/platform-provider-probe-service";

type ProviderFixtureInput = Readonly<{
  name: string;
  kind: AiProviderKind;
  apiKey: string;
  generationModelId: string | null;
  visionModelId: string | null;
  embeddingModelId: string | null;
  embeddingDimensions: number | null;
}>;

function requestBody(init: RequestInit | undefined): Record<string, unknown> | null {
  if (typeof init?.body !== "string") return null;
  try {
    const value = JSON.parse(init.body) as unknown;
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isDraftProbeRequest(url: string, body: Record<string, unknown> | null): boolean {
  if (body === null) return false;
  if (url.endsWith("/embeddings")) {
    return Array.isArray(body.input) && body.input.length === 1 && body.input[0] === "AI Project OS platform connectivity check";
  }
  if (url.endsWith("/responses")) {
    const input = Array.isArray(body.input) ? body.input[0] as Record<string, unknown> | undefined : undefined;
    const content = Array.isArray(input?.content) ? input.content : [];
    return content.some((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).text === "Reply OK");
  }
  if (!url.endsWith("/chat/completions")) return false;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0] as Record<string, unknown> | undefined;
  if (first?.content === "Connectivity check. Reply OK.") return true;
  return Array.isArray(first?.content) && first.content.some((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).text === "Reply OK");
}

async function withDraftProbeFetch<T>(operation: () => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = requestBody(init);
    if (!isDraftProbeRequest(url, body)) return previousFetch(input, init);
    if (url.endsWith("/embeddings")) {
      const dimensions = typeof body?.dimensions === "number" ? body.dimensions : 8;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: dimensions }, () => 0) }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/responses")) {
      return new Response(JSON.stringify({ output_text: "OK" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

/** Create a provider through the same draft-proof contract used by the admin UI. */
export async function createVerifiedProviderFixture(
  input: ProviderFixtureInput,
  actor: PlatformProviderActor,
  db: PrismaClient,
) {
  const createRequestKey = randomUUID();
  const now = new Date();
  const activeBudget = await db.platformProviderProbeBudget.findFirst({ where: { status: "active", startsAt: { lte: now }, expiresAt: { gt: now } }, select: { id: true } });
  if (activeBudget === null) {
    await createAndActivatePlatformProviderProbeBudget({
      unitLimit: 100,
      alertThresholdUnits: 1,
      startsAt: new Date(now.getTime() - 1_000).toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    }, actor, db);
  }
  const draft = await withDraftProbeFetch(() => runPlatformProviderDraftProbe({ ...input, clientRequestKey: createRequestKey }, actor, db));
  if (draft.draftProbeId === null) throw new Error(`provider fixture draft probe failed: ${draft.attempt.safeErrorCode ?? "unknown"}`);
  return createProviderConnection({ ...input, draftProbeId: draft.draftProbeId, createRequestKey }, actor, db);
}
