import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { completeFirstAdminOnboarding } from "@/lib/first-admin-onboarding-service";

export const dynamic = "force-dynamic";

// The endpoint accepts an explicit empty acknowledgement only.  Identity,
// timestamp, returnTo and redirect targets are all derived server-side.
const completionSchema = z.object({}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    completionSchema.parse(await readJsonBody(request));
    const completion = await completeFirstAdminOnboarding(actor);
    return NextResponse.json(
      { onboarding: { status: "completed", completedAt: completion.completedAt.toISOString() } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
