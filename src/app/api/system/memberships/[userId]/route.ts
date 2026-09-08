import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { executeMembership, type MembershipLifecycleAction } from "@/lib/membership-service";

export const dynamic = "force-dynamic";

const baseSchema = z.object({
  action: z.enum(["grant", "extend", "revoke"]),
  days: z.number().int().min(1).max(3650).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  expectedVersion: z.number().int().min(0),
  expectedImpactFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  requestKey: z.string().trim().min(8).max(180),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  previewId: z.string().uuid(),
  previewIssuedAt: z.string().datetime({ offset: true }),
  previewExpiresAt: z.string().datetime({ offset: true }),
  confirmation: z.literal(true),
  confirmationUsername: z.string().max(64).optional(),
}).strict();

async function targetId(params: Promise<{ userId: string }>): Promise<string> {
  return z.string().uuid().parse((await params).userId);
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { error: { code: "MEMBERSHIP_METHOD_NOT_ALLOWED", message: "会员变更必须先预览，再通过用户详情 PATCH 确认" } },
    { status: 405, headers: { allow: "PATCH" } },
  );
}

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = await requireApiSession(request);
    const input = baseSchema.parse(await readJsonBody(request));
    const action = input.action as MembershipLifecycleAction;
    const subscription = await executeMembership({
      adminUserId: admin.id,
      userId: await targetId(context.params),
      action,
      days: action === "revoke" ? undefined : input.days ?? undefined,
      note: input.note,
      reason: input.reason,
      expectedVersion: input.expectedVersion,
      expectedImpactFingerprint: input.expectedImpactFingerprint,
      requestKey: input.requestKey,
      requestFingerprint: input.requestFingerprint,
      previewId: input.previewId,
      previewIssuedAt: input.previewIssuedAt,
      previewExpiresAt: input.previewExpiresAt,
      confirmation: true,
      confirmationUsername: input.confirmationUsername,
    });
    return NextResponse.json({ subscription }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    return methodNotAllowed();
  } catch (error) {
    return handleApiError(error);
  }
}
