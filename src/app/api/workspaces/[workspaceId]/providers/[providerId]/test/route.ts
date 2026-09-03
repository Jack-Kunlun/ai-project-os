import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { testWorkspaceProviderConnection } from "@/lib/workspace-provider-service";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string; providerId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    return NextResponse.json(await testWorkspaceProviderConnection(idSchema.parse(params.workspaceId), idSchema.parse(params.providerId), actor));
  } catch (error) {
    return handleApiError(error);
  }
}
