import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { decideAuthenticatedWebSourceReview, getAuthenticatedWebSourceReview } from "@/lib/authenticated-web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function ids(params: Promise<{ projectId: string; webSourceId: string; revisionId: string }>) {
  const value = await params;
  return {
    projectId: idSchema.parse(value.projectId),
    webSourceId: idSchema.parse(value.webSourceId),
    revisionId: idSchema.parse(value.revisionId),
  };
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string; webSourceId: string; revisionId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const { projectId, webSourceId, revisionId } = await ids(context.params);
    const review = await getAuthenticatedWebSourceReview(projectId, webSourceId, revisionId, user);
    return NextResponse.json({ review });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string; webSourceId: string; revisionId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const { projectId, webSourceId, revisionId } = await ids(context.params);
    const result = await decideAuthenticatedWebSourceReview(projectId, webSourceId, revisionId, await readJsonBody(request), user);
    return NextResponse.json({ result });
  } catch (error) {
    return handleApiError(error);
  }
}
