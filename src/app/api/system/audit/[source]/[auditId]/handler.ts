import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, mapApiError } from "@/lib/api-errors";
import { requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSystemAuditDetail, SYSTEM_AUDIT_SOURCES } from "@/lib/system-audit";

const noStore = { "cache-control": "private, no-store" } as const;
const sourceSchema = z.enum(SYSTEM_AUDIT_SOURCES);
const auditIdSchema = z.string().uuid();

function auditErrorResponse(error: unknown): NextResponse {
  const mapped = mapApiError(error);
  return NextResponse.json(
    { error: { code: mapped.body.error.code, message: mapped.body.error.message } },
    { status: mapped.status, headers: noStore },
  );
}

export async function handleSystemAuditDetailGet(
  request: Request,
  context: { params: Promise<{ source: string; auditId: string }> },
  dependencies: Readonly<{ db?: Parameters<typeof requireApiSession>[1] }> = {},
): Promise<NextResponse> {
  try {
    const user = await requireApiSession(request, dependencies.db ?? getDb());
    if (user.role !== "admin") throw new ApiError(403, "SYSTEM_AUDIT_ADMIN_REQUIRED", "需要系统管理员权限");
    const params = await context.params;
    const source = sourceSchema.parse(params.source);
    const auditId = auditIdSchema.parse(params.auditId);
    const event = await getSystemAuditDetail(source, auditId, dependencies.db ?? getDb());
    return NextResponse.json({ event }, { headers: noStore });
  } catch (error) {
    return auditErrorResponse(error);
  }
}
