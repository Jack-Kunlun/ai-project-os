import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createGitConnection, gitConnectionCatalog, listGitConnections } from "@/lib/git";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json(
      { connections: await listGitConnections(actor), catalog: gitConnectionCatalog() },
      { headers: noStore },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    return NextResponse.json(
      { connection: await createGitConnection(await readJsonBody(request), actor) },
      { status: 201, headers: noStore },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
