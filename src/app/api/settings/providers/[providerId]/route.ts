import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertPlatformProviderAdminHint, deleteProviderConnection, updateProviderConnection } from "@/lib/ai-providers";

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
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    const provider = await updateProviderConnection(
      await providerId(context.params),
      await readJsonBody(request),
      actor,
    );
    return NextResponse.json({ provider }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    const deleted = await deleteProviderConnection(
      await providerId(context.params),
      await readJsonBody(request),
      actor,
    );
    return NextResponse.json({ deleted });
  } catch (error) {
    return handleApiError(error);
  }
}
