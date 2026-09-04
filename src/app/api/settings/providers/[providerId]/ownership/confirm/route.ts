import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { confirmPlatformProviderOwnership } from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const providerId = idSchema.parse((await context.params).providerId);
    const provider = await confirmPlatformProviderOwnership(providerId, await readJsonBody(request), actor);
    return NextResponse.json({ provider });
  } catch (error) {
    return handleApiError(error);
  }
}
