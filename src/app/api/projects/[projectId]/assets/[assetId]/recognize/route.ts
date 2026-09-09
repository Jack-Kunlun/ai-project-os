import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { prepareProjectAssetVisionConfirmation, runProjectAssetVisionExtraction } from "@/lib/project-assets/vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

const paramsSchema = z.object({ projectId: z.string().uuid(), assetId: z.string().uuid() });
const bodySchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("prepare"), clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u) }).strict(),
  z.object({ phase: z.literal("execute"), challengeId: z.string().uuid(), clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u) }).strict(),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; assetId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await readJsonBody(request));
    if (body.phase === "prepare") {
      const confirmation = await prepareProjectAssetVisionConfirmation({ projectId: params.projectId, assetId: params.assetId, requestedBy: user, clientKey: body.clientKey });
      return NextResponse.json({ confirmation }, { headers: { "cache-control": "no-store" } });
    }
    const job = await runProjectAssetVisionExtraction({
      projectId: params.projectId,
      assetId: params.assetId,
      requestedBy: user,
      clientKey: body.clientKey,
      challengeId: body.challengeId,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return handleApiError(error);
  }
}
