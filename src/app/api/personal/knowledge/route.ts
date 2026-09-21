import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import {
  createPersonalKnowledgeDocument,
  listPersonalKnowledgeDocuments,
  searchPersonalKnowledgeDocuments,
  PERSONAL_KNOWLEDGE_PAGE_DEFAULT_SIZE,
  PERSONAL_KNOWLEDGE_PAGE_MAX_SIZE,
} from "@/lib/personal-knowledge-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const listQuerySchema = z.object({
  query: z.string().trim().max(240).optional(),
  limit: z.coerce.number().int().min(1).max(PERSONAL_KNOWLEDGE_PAGE_MAX_SIZE).default(PERSONAL_KNOWLEDGE_PAGE_DEFAULT_SIZE),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

/** Prevent owner scoped knowledge payloads from entering shared HTTP caches. */
function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** Reject duplicate pagination/search keys instead of accepting an ambiguous value. */
function assertUniqueQueryKeys(url: URL): void {
  for (const key of new Set(url.searchParams.keys())) {
    if (url.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
  }
}

/** List or search the signed-in user's active personal text documents. */
/** List or search only the authenticated user's active personal documents. */
export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const url = new URL(request.url);
    assertUniqueQueryKeys(url);
    const query = listQuerySchema.parse(Object.fromEntries(url.searchParams));
    const result = query.query === undefined
      ? await listPersonalKnowledgeDocuments(actor, { limit: query.limit, cursor: query.cursor })
      : await searchPersonalKnowledgeDocuments(actor, { query: query.query, limit: query.limit, cursor: query.cursor });
    return noStore(NextResponse.json(result));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

/** Create the first immutable revision of an owner-scoped personal document. */
/** Create the first immutable revision of an owner scoped document. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const document = await createPersonalKnowledgeDocument(await readJsonBody(request), actor);
    return noStore(NextResponse.json({ document }, { status: 201 }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
