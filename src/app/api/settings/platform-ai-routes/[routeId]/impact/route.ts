import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getPlatformDefaultAiRouteImpact } from "@/lib/platform-default-ai-routes";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ routeId: string }> },
) {
  try {
    const actor = await requireApiSession(request);
    const { routeId } = await context.params;
    return NextResponse.json(await getPlatformDefaultAiRouteImpact(routeId, actor));
  } catch (error) {
    return handleApiError(error);
  }
}
