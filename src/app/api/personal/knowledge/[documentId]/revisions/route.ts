import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import {
  listPersonalKnowledgeRevisions,
  PERSONAL_KNOWLEDGE_PAGE_DEFAULT_SIZE,
  PERSONAL_KNOWLEDGE_PAGE_MAX_SIZE,
} from "@/lib/personal-knowledge-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Prevent owner scoped revision metadata from entering shared HTTP caches. */
function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

const revisionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PERSONAL_KNOWLEDGE_PAGE_MAX_SIZE).default(PERSONAL_KNOWLEDGE_PAGE_DEFAULT_SIZE),
  cursor: z.string().trim().min(1).max(128).optional(),
}).strict();

/** Reject duplicate pagination keys so a cursor has one unambiguous meaning. */
function assertUniqueQueryKeys(url: URL): void {
  for (const key of new Set(url.searchParams.keys())) {
    if (url.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
  }
}

/** List immutable revisions for an active owner-scoped document. */
/** List bounded revision metadata for an authenticated owner's active document. */
export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const url = new URL(request.url);
    assertUniqueQueryKeys(url);
    const query = revisionQuerySchema.parse(Object.fromEntries(url.searchParams));
    const result = await listPersonalKnowledgeRevisions((await context.params).documentId, actor, query);
    return noStore(NextResponse.json(result));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
