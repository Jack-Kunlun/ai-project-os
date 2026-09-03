import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { grantOrExtendMembership, revokeMembership } from "@/lib/membership-service";

export const dynamic = "force-dynamic";

const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant"), days: z.number().int().min(1).max(3650), note: z.string().max(500).nullable().optional(), expectedVersion: z.number().int().positive().nullable().optional() }).strict(),
  z.object({ action: z.literal("revoke"), expectedVersion: z.number().int().positive().nullable().optional() }).strict(),
]);

async function userId(params: Promise<{ userId: string }>): Promise<string> {
  return z.string().uuid().parse((await params).userId);
}

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = await requireApiSession(request);
    const targetId = await userId(context.params);
    const input = updateSchema.parse(await readJsonBody(request));
    const subscription = input.action === "revoke"
      ? await revokeMembership({ adminUserId: admin.id, userId: targetId, expectedVersion: input.expectedVersion ?? undefined })
      : await grantOrExtendMembership({ adminUserId: admin.id, userId: targetId, days: input.days, note: input.note, expectedVersion: input.expectedVersion ?? undefined });
    return NextResponse.json({ subscription }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = await requireApiSession(request);
    const targetId = await userId(context.params);
    const body = await readJsonBody(request);
    const expectedVersion = z.object({ expectedVersion: z.number().int().positive().nullable().optional() }).strict().parse(body).expectedVersion ?? undefined;
    const subscription = await revokeMembership({ adminUserId: admin.id, userId: targetId, expectedVersion });
    return NextResponse.json({ subscription }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
