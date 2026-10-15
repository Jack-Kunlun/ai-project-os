import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { listPersonalKnowledgeVisionProviders } from "@/lib/personal-knowledge-vision-provider";

export const dynamic = "force-dynamic";

/** Return the current user's safe platform/BYOK vision choices without caching. */
export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const result = await listPersonalKnowledgeVisionProviders(actor);
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
