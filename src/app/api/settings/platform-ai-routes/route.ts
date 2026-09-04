import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  createPlatformDefaultAiRoute,
  listPlatformDefaultAiRoutes,
} from "@/lib/platform-default-ai-routes";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json(await listPlatformDefaultAiRoutes(actor));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const route = await createPlatformDefaultAiRoute(await readJsonBody(request), actor);
    return NextResponse.json({ route }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
