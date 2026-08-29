import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createMcpConnection, listMcpConnections } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireApiSession(request);
    return NextResponse.json({ connections: await listMcpConnections() });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    return NextResponse.json({ connection: await createMcpConnection(await readJsonBody(request), user) }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
