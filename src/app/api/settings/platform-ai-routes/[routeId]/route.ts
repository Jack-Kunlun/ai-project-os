import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { updatePlatformDefaultAiRoute } from "@/lib/platform-default-ai-routes";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ routeId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { routeId } = await context.params;
    const route = await updatePlatformDefaultAiRoute(routeId, await readJsonBody(request), actor);
    return NextResponse.json({ route });
  } catch (error) {
    return handleApiError(error);
  }
}
