import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { previewMembership } from "@/lib/membership-service";

export const dynamic = "force-dynamic";

const previewSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(["grant", "extend", "revoke"]),
  days: z.number().int().min(1).max(3650).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  expectedVersion: z.number().int().min(0).optional(),
  applicationId: z.string().uuid().nullable().optional(),
}).strict();

async function respond(input: unknown, request: Request): Promise<NextResponse> {
  assertSameOrigin(request);
  const admin = await requireApiSession(request);
  const parsed = previewSchema.parse(input);
  const preview = await previewMembership({ ...parsed, adminUserId: admin.id, days: parsed.days ?? undefined, applicationId: parsed.applicationId ?? undefined }, undefined);
  return NextResponse.json({ preview }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    return await respond(await readJsonBody(request), request);
  } catch (error) {
    return handleApiError(error);
  }
}
