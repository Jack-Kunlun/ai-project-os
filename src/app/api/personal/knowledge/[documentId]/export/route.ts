import { NextResponse } from "next/server";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { exportPersonalKnowledgeDocument } from "@/lib/personal-knowledge-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Prevent exported owner data from being cached by shared intermediaries. */
function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** Export an active revision and record a body-free audit event transactionally. */
/** Audit and return one exact document revision in an allowlisted text format. */
export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const result = await exportPersonalKnowledgeDocument(
      (await context.params).documentId,
      await readJsonBody(request),
      actor,
    );
    const response = new NextResponse(result.body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-type": result.contentType,
        "content-disposition": `attachment; filename="${result.filename}"`,
        "x-content-type-options": "nosniff",
        "x-personal-knowledge-content-hash": result.contentHash,
        "x-personal-knowledge-version": String(result.version),
      },
    });
    return response;
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
