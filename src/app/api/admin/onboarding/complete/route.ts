import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, initializeFirstOwner, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const completionSchema = z.object({
  username: z.string(),
  password: z.string(),
}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = completionSchema.parse(await readJsonBody(request));
    const completion = await initializeFirstOwner(actor, input);
    return NextResponse.json(
      {
        onboarding: {
          status: "completed",
          completedAt: completion.createdAt.toISOString(),
          owner: completion.user,
        },
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
