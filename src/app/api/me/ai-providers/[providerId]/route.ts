import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  deletePersonalProviderConnection,
  getPersonalProviderConnection,
  updatePersonalProviderConnection,
} from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

async function providerId(params: Promise<{ providerId: string }>): Promise<string> {
  return (await params).providerId;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    const actor = await requireApiSession(request);
    const provider = await getPersonalProviderConnection(await providerId(context.params), actor);
    return NextResponse.json({ provider }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const provider = await updatePersonalProviderConnection(
      await providerId(context.params),
      await readJsonBody(request),
      actor,
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
    const actor = await requireApiSession(request);
    const deleted = await deletePersonalProviderConnection(
      await providerId(context.params),
      await readJsonBody(request),
      actor,
    );
    return NextResponse.json({ deleted });
  } catch (error) {
    return handleApiError(error);
  }
}
