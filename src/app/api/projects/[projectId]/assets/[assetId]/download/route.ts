import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
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
    const inline = file.mimeType.startsWith("image/") || file.mimeType === "application/pdf" || file.mimeType.startsWith("text/");
    const fallback = file.fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "project-asset";
    const encodedFileName = encodeURIComponent(file.fileName).replace(/[!'()*]/g, (character) =>
      `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
    );
    return new Response(new Uint8Array(file.buffer), {
      headers: {
        "content-type": file.mimeType,
        "content-length": String(file.sizeBytes),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodedFileName}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
