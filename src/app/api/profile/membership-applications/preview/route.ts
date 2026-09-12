import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { previewMembershipApplication } from "@/lib/membership-application-service";

export const dynamic = "force-dynamic";

const schema = z.object({ requestKey: z.string().min(8).max(180), reason: z.string().max(500) }).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = schema.parse(await readJsonBody(request));
    const result = await previewMembershipApplication({ actorId: actor.id, requestKey: input.requestKey, reason: input.reason });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
