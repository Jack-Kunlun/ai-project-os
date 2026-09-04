import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { runPlatformDefaultAiRouteLifecycle } from "@/lib/platform-default-ai-routes";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ routeId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { routeId } = await context.params;
    const route = await runPlatformDefaultAiRouteLifecycle(routeId, await readJsonBody(request), actor);
    return NextResponse.json({ route });
  } catch (error) {
    return handleApiError(error);
  }
}
