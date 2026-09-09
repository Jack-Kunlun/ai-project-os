import { NextResponse } from "next/server";
import { handleSystemAuditGet } from "./handler";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handleSystemAuditGet(request);
}
