import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { decideBrowserWebSourceReview, getBrowserWebSourceReview } from "@/lib/browser-web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

type Params = Promise<{ projectId: string; webSourceId: string; revisionId: string }>;

export async function GET(request: Request, context: { params: Params }) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const review = await getBrowserWebSourceReview(idSchema.parse(params.projectId), idSchema.parse(params.webSourceId), idSchema.parse(params.revisionId), actor);
    return NextResponse.json({ review });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Params }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const review = await decideBrowserWebSourceReview(idSchema.parse(params.projectId), idSchema.parse(params.webSourceId), idSchema.parse(params.revisionId), await readJsonBody(request), actor);
    return NextResponse.json({ review });
  } catch (error) {
    return handleApiError(error);
  }
}
