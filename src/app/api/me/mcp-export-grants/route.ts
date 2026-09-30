import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createMcpExportGrant, isMcpExportEnabled, listMcpExportGrants } from "@/lib/mcp-export-grants";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  if (!isMcpExportEnabled()) return new Response(null, { status: 404, headers: noStore });
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json({ grants: await listMcpExportGrants(actor) }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  if (!isMcpExportEnabled()) return new Response(null, { status: 404, headers: noStore });
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const issued = await createMcpExportGrant(actor, await readJsonBody(request));
    return NextResponse.json(issued, { status: 201, headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
