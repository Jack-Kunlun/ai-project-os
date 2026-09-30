import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { isMcpExportEnabled, revokeMcpExportGrant } from "@/lib/mcp-export-grants";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ grantId: string }> }) {
  if (!isMcpExportEnabled()) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { grantId } = await context.params;
    const revoked = await revokeMcpExportGrant(actor, grantId);
    return NextResponse.json({ revoked }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
