import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listPersonalKnowledgeSemanticProviders } from "@/lib/personal-knowledge-semantic-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json(await listPersonalKnowledgeSemanticProviders(actor), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
