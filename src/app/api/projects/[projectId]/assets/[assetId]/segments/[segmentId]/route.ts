import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { reviewProjectAssetSegment } from "@/lib/project-assets/service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  projectId: z.string().uuid(),
  assetId: z.string().uuid(),
  segmentId: z.string().uuid(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; assetId: string; segmentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const parsed = paramsSchema.parse(await context.params);
    await assertProjectActive(parsed.projectId);
    const asset = await reviewProjectAssetSegment({
      projectId: parsed.projectId,
      assetId: parsed.assetId,
      segmentId: parsed.segmentId,
      requestedBy: user,
      review: await readJsonBody(request),
    });
    return NextResponse.json({ asset });
  } catch (error) {
    return handleApiError(error);
  }
}
