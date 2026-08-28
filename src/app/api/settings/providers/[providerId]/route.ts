import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { disableProviderConnection, updateProviderConnection } from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

async function providerId(params: Promise<{ providerId: string }>): Promise<string> {
  return idSchema.parse((await params).providerId);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const provider = await updateProviderConnection(
      await providerId(context.params),
      await readJsonBody(request),
    );
    return NextResponse.json({ provider });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const provider = await disableProviderConnection(await providerId(context.params));
    return NextResponse.json({ provider });
  } catch (error) {
    return handleApiError(error);
  }
}

