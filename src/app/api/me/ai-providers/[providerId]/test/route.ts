import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { testPersonalProviderConnection } from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const providerId = (await context.params).providerId;
    const result = await testPersonalProviderConnection(providerId, actor);
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
