import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { previewAccountAccess } from "@/lib/account-access-service";

export const dynamic = "force-dynamic";

const previewSchema = z.object({
  action: z.enum(["disable", "restore"]),
  reason: z.string().max(500),
  expectedVersion: z.number().int().min(1).optional(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = await requireApiSession(request);
    const params = await context.params;
    const parsed = previewSchema.parse(await readJsonBody(request));
    const preview = await previewAccountAccess({
      adminUserId: admin.id,
      adminAccountAccessVersion: admin.accountAccessVersion,
      userId: z.string().uuid().parse(params.userId),
      action: parsed.action,
      reason: parsed.reason,
      expectedVersion: parsed.expectedVersion,
    });
    return NextResponse.json({ preview }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(
      { error: { code: "ACCOUNT_ACCESS_METHOD_NOT_ALLOWED", message: "账号状态变更必须通过 POST 预览" } },
      { status: 405, headers: { allow: "POST" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
