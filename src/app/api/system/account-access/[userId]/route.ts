import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { executeAccountAccess, type AccountAccessAction } from "@/lib/account-access-service";

export const dynamic = "force-dynamic";

const executeSchema = z.object({
  action: z.enum(["disable", "restore"]),
  reason: z.string().max(500),
  expectedVersion: z.number().int().min(1),
  expectedImpactFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  requestKey: z.string().trim().min(8).max(180),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  previewId: z.string().uuid(),
  previewIssuedAt: z.string().datetime({ offset: true }),
  previewExpiresAt: z.string().datetime({ offset: true }),
  confirmation: z.literal(true),
  confirmationUsername: z.string().max(64),
}).strict();

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = await requireApiSession(request);
    const params = await context.params;
    const parsed = executeSchema.parse(await readJsonBody(request));
    const result = await executeAccountAccess({
      adminUserId: admin.id,
      adminAccountAccessVersion: admin.accountAccessVersion,
      userId: z.string().uuid().parse(params.userId),
      action: parsed.action as AccountAccessAction,
      reason: parsed.reason,
      expectedVersion: parsed.expectedVersion,
      expectedImpactFingerprint: parsed.expectedImpactFingerprint,
      requestKey: parsed.requestKey,
      requestFingerprint: parsed.requestFingerprint,
      previewId: parsed.previewId,
      previewIssuedAt: parsed.previewIssuedAt,
      previewExpiresAt: parsed.previewExpiresAt,
      confirmation: true,
      confirmationUsername: parsed.confirmationUsername,
    });
    return NextResponse.json({ result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(
      { error: { code: "ACCOUNT_ACCESS_METHOD_NOT_ALLOWED", message: "账号状态变更必须先预览，再通过用户详情 PATCH 确认" } },
      { status: 405, headers: { allow: "PATCH" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(
      { error: { code: "ACCOUNT_ACCESS_METHOD_NOT_ALLOWED", message: "账号状态不能删除，只能通过预览后 PATCH 停用或恢复" } },
      { status: 405, headers: { allow: "PATCH" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
