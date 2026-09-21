import { NextResponse } from "next/server";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import {
  deletePersonalKnowledgeDocument,
  readPersonalKnowledgeDocument,
  revisePersonalKnowledgeDocument,
} from "@/lib/personal-knowledge-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Prevent owner scoped knowledge payloads from entering shared HTTP caches. */
function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** Resolve the dynamic segment without weakening service level UUID validation. */
async function documentId(params: Promise<{ documentId: string }>): Promise<string> {
  return (await params).documentId;
}

/** Read the current revision of an active personal document. */
/** Return the current immutable revision for an owner scoped active document. */
export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const document = await readPersonalKnowledgeDocument(await documentId(context.params), actor);
    return noStore(NextResponse.json({ document }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

/** Append a revision after the service enforces the expectedVersion CAS. */
/** Append a revision using the caller supplied compare-and-swap version. */
export async function PATCH(request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const document = await revisePersonalKnowledgeDocument(
      await documentId(context.params),
      await readJsonBody(request),
      actor,
    );
    return noStore(NextResponse.json({ document }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

/** Soft-delete an active document after the service enforces the version CAS. */
/** Soft-delete a document only when its expected version is still current. */
export async function DELETE(request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const deleted = await deletePersonalKnowledgeDocument(
      await documentId(context.params),
      await readJsonBody(request),
      actor,
    );
    return noStore(NextResponse.json({ deleted }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
