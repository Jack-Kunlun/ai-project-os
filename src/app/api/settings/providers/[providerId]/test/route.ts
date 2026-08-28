import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { testProviderConnection } from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const providerId = idSchema.parse((await context.params).providerId);
    return NextResponse.json(await testProviderConnection(providerId));
  } catch (error) {
    return handleApiError(error);
  }
}

