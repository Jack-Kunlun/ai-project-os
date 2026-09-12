import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { executeMembershipApplication } from "@/lib/membership-application-service";

export const dynamic = "force-dynamic";

const schema = z.object({
  requestKey: z.string().min(8).max(180),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  impactFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  previewId: z.string().uuid(),
  previewIssuedAt: z.union([z.string(), z.date()]),
  previewExpiresAt: z.union([z.string(), z.date()]),
  confirmation: z.literal(true),
  confirmationUsername: z.string().max(64).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = schema.parse(await readJsonBody(request));
    const application = await executeMembershipApplication({ ...input, actorId: actor.id });
    return NextResponse.json({ application }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
