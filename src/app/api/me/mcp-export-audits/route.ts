import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { isMcpExportEnabled, listMcpExportDispatchAudits } from "@/lib/mcp-export-grants";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  if (!isMcpExportEnabled()) return new Response(null, { status: 404, headers: noStore });
  try {
    const actor = await requireApiSession(request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    const audits = await listMcpExportDispatchAudits(actor, projectId);
    return NextResponse.json({ audits }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
