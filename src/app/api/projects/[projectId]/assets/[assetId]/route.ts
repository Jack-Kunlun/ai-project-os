import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { deleteProjectAsset, getProjectAsset } from "@/lib/project-assets/service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ projectId: z.string().uuid(), assetId: z.string().uuid() });

async function params(value: Promise<{ projectId: string; assetId: string }>) {
  return paramsSchema.parse(await value);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string; assetId: string }> }) {
  try {
    await requireApiSession(request);
    const parsed = await params(context.params);
    return NextResponse.json({ asset: await getProjectAsset(parsed.projectId, parsed.assetId) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string; assetId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const parsed = await params(context.params);
    await assertProjectActive(parsed.projectId);
    await deleteProjectAsset(parsed.projectId, parsed.assetId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
