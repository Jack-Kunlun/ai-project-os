import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { createProjectAssetDownloadResponse } from "@/lib/project-assets/download-response";
import { getProjectAssetBlob } from "@/lib/project-assets/service";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z.object({ projectId: z.string().uuid(), assetId: z.string().uuid() });

export async function GET(request: Request, context: { params: Promise<{ projectId: string; assetId: string }> }) {
  try {
    await requireApiSession(request);
    const parsed = paramsSchema.parse(await context.params);
    const file = await getProjectAssetBlob(parsed.projectId, parsed.assetId);
    return createProjectAssetDownloadResponse(file);
  } catch (error) {
    return handleApiError(error);
  }
}
