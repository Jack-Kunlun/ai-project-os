import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { refreshBrowserWebSourceProfile } from "@/lib/browser-web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; webSourceId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const source = await refreshBrowserWebSourceProfile(idSchema.parse(params.projectId), idSchema.parse(params.webSourceId), actor);
    return NextResponse.json({ source });
  } catch (error) {
    return handleApiError(error);
  }
}
