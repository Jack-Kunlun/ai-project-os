import { NextResponse } from "next/server";
import { handleSystemAuditDetailGet } from "./handler";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ source: string; auditId: string }> },
): Promise<NextResponse> {
  return handleSystemAuditDetailGet(request, context);
}
