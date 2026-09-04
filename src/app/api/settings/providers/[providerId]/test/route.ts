import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { assertPlatformProviderAdminHint, testPlatformProviderConnection } from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    const providerId = idSchema.parse((await context.params).providerId);
    return NextResponse.json(await testPlatformProviderConnection(providerId, actor));
  } catch (error) {
    return handleApiError(error);
  }
}
