import { NextResponse } from "next/server";
import { ApiError, mapApiError } from "@/lib/api-errors";
import { requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listSystemAudit, parseSystemAuditQuery } from "@/lib/system-audit";

const noStore = { "cache-control": "private, no-store" } as const;

function auditErrorResponse(error: unknown): NextResponse {
  const mapped = mapApiError(error);
  return NextResponse.json(
    { error: { code: mapped.body.error.code, message: mapped.body.error.message } },
    { status: mapped.status, headers: noStore },
  );
}

export async function handleSystemAuditGet(
  request: Request,
  dependencies: Readonly<{ db?: Parameters<typeof requireApiSession>[1] }> = {},
): Promise<NextResponse> {
  try {
    const user = await requireApiSession(request, dependencies.db ?? getDb());
    if (user.role !== "admin") throw new ApiError(403, "SYSTEM_AUDIT_ADMIN_REQUIRED", "需要系统管理员权限");
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const query = parseSystemAuditQuery(params);
    return NextResponse.json(await listSystemAudit(query, dependencies.db ?? getDb()), { headers: noStore });
  } catch (error) {
    return auditErrorResponse(error);
  }
}
