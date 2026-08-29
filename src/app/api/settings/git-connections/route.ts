import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createGitConnection, gitConnectionCatalog, listGitConnections } from "@/lib/git";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireApiSession(request);
    return NextResponse.json({ connections: await listGitConnections(), catalog: gitConnectionCatalog() });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const connection = await createGitConnection(await readJsonBody(request), user);
    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
