import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { retryProjectAssetLocalExtraction } from "@/lib/project-assets/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z.object({
  projectId: z.string().uuid(),
  assetId: z.string().uuid(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; assetId: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const { projectId, assetId } = paramsSchema.parse(await context.params);
    await assertProjectActive(projectId);
    const asset = await retryProjectAssetLocalExtraction(projectId, assetId);
    return NextResponse.json({ asset }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
