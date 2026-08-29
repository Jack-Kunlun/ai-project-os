import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { runProjectAssetVisionExtraction } from "@/lib/project-assets/vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

const paramsSchema = z.object({ projectId: z.string().uuid(), assetId: z.string().uuid() });
const bodySchema = z.object({
  clientKey: z.string().min(8).max(200),
  consent: z.object({ acknowledged: z.literal(true), version: z.string() }).strict(),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; assetId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = paramsSchema.parse(await context.params);
    await assertProjectActive(params.projectId);
    const body = bodySchema.parse(await readJsonBody(request));
    const job = await runProjectAssetVisionExtraction({
      projectId: params.projectId,
      assetId: params.assetId,
      requestedBy: user,
      clientKey: body.clientKey,
      consent: body.consent,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return handleApiError(error);
  }
}
