import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { listProjectAssets, uploadProjectAsset } from "@/lib/project-assets/service";
import { MAX_ASSET_FILE_BYTES, MAX_UPLOAD_REQUEST_BYTES } from "@/lib/project-assets/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const projectIdSchema = z.string().uuid();

async function projectId(params: Promise<{ projectId: string }>): Promise<string> {
  return projectIdSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    await requireApiSession(request);
    const id = await projectId(context.params);
    return NextResponse.json({ assets: await listProjectAssets(id) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    await assertProjectActive(id);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      throw new ApiError(415, "ASSET_UPLOAD_CONTENT_TYPE_INVALID", "Upload must use multipart/form-data");
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_REQUEST_BYTES) {
      throw new ApiError(413, "ASSET_FILE_TOO_LARGE", "Upload request is too large");
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "ASSET_UPLOAD_INVALID", "Upload form is invalid");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "ASSET_FILE_REQUIRED", "A file is required");
    if (file.size <= 0 || file.size > MAX_ASSET_FILE_BYTES) {
      throw new ApiError(413, "ASSET_FILE_TOO_LARGE", "File exceeds the allowed size");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const asset = await uploadProjectAsset({
      projectId: id,
      requestedBy: user,
      fileName: file.name,
      buffer,
    });
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
