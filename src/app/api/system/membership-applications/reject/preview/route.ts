import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { previewRejectMembershipApplication } from "@/lib/membership-application-service";

export const dynamic = "force-dynamic";
const schema = z.object({ applicationId: z.string().uuid(), requestKey: z.string().min(8).max(180), reason: z.string().min(1).max(500) }).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await requireApiSession(request);
    const input = schema.parse(await readJsonBody(request));
    const result = await previewRejectMembershipApplication({ ...input, actorId: admin.id });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
