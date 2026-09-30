import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { confirmMcpExportApproval, isMcpExportEnabled } from "@/lib/mcp-export-grants";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ grantId: string }> }) {
  if (!isMcpExportEnabled()) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { grantId } = await context.params;
    const approval = await confirmMcpExportApproval(actor, grantId, await readJsonBody(request));
    return NextResponse.json({ approval }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
