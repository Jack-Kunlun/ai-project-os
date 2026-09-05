import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listConnectionOwnerProjectMcpConnectionDelegations } from "@/lib/project-mcp-connection-delegation-service";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;

function noStoreResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const delegations = await listConnectionOwnerProjectMcpConnectionDelegations(actor);
    return NextResponse.json({ delegations }, { headers: noStore });
  } catch (error) {
    return noStoreResponse(handleApiError(error));
  }
}
