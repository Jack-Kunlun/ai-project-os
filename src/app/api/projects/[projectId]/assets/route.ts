import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { acquireUploadAdmission, countActiveUploadAdmissions, releaseUploadAdmission } from "@/lib/project-assets/admission";
import { getProjectAssetUploadUsage, publicProjectAssetUploadUsage } from "@/lib/project-assets/quota";
import { getUploadPolicy, publicUploadPolicy } from "@/lib/project-assets/policy";
import { listProjectAssetsPage, uploadProjectAsset } from "@/lib/project-assets/service";
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from "@/lib/list-pagination";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const projectIdSchema = z.string().uuid();
const listAssetsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
  search: z.string().trim().max(120).default(""),
  kind: z.enum(["all", "text", "document", "spreadsheet", "presentation", "image"]).default("all"),
  status: z.enum(["all", "uploaded", "parsing", "waitingVision", "awaitingReview", "ready", "failed"]).default("all"),
}).strict();

async function projectId(params: Promise<{ projectId: string }>): Promise<string> {
  return projectIdSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    const policy = getUploadPolicy();
    const searchParams = new URL(request.url).searchParams;
    for (const key of new Set(searchParams.keys())) {
      if (searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
    const query = listAssetsQuerySchema.parse(Object.fromEntries(searchParams));
    const page = await listProjectAssetsPage(id, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      ...(query.kind === "all" ? {} : { kind: query.kind }),
      ...(query.status === "all" ? {} : { status: query.status }),
    });
    const usage = await getProjectAssetUploadUsage(id);
    return NextResponse.json({
      assets: page.items,
      pagination: page.pagination,
      policy: publicUploadPolicy(policy),
      usage: {
        ...publicProjectAssetUploadUsage(usage),
        activeUploads: await countActiveUploadAdmissions(user.id),
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    const policy = getUploadPolicy();
    const admissionId = await acquireUploadAdmission({ projectId: id, userId: user.id });
    let response: NextResponse | undefined;
    try {
      // Admit before the remaining request validation so malformed, archived,
      // oversized and quota-rejected upload attempts all consume the rate
      // window. The lease is released in finally below.
      await assertProjectActive(id);
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
        throw new ApiError(415, "ASSET_UPLOAD_CONTENT_TYPE_INVALID", "Upload must use multipart/form-data");
      }
      const body = await readRequestBody(request, policy.maxRequestBytes, () =>
        new ApiError(413, "ASSET_UPLOAD_REQUEST_TOO_LARGE", "Upload request is too large"),
        {
          milliseconds: policy.bodyReadTimeoutMs,
          error: () => new ApiError(408, "ASSET_UPLOAD_TIMEOUT", "Upload request timed out"),
        },
      );
      let form: FormData;
      try {
        form = await new Request(request.url, {
          method: request.method,
          headers: new Headers(request.headers),
          body: new Blob([body]),
        }).formData();
      } catch {
        throw new ApiError(400, "ASSET_UPLOAD_INVALID", "Upload form is invalid");
      }
      const values = form.getAll("file");
      if (values.length === 0 || values.some((value) => !(value instanceof File))) {
        throw new ApiError(400, "ASSET_FILE_REQUIRED", "A file is required");
      }
      if (values.length > policy.maxFiles) {
        throw new ApiError(413, "ASSET_UPLOAD_TOO_MANY_FILES", "Too many files in one upload request");
      }
      if (values.length !== 1) {
        throw new ApiError(400, "ASSET_UPLOAD_ONE_FILE_ONLY", "Each upload request must contain exactly one file");
      }
      const file = values[0] as File;
      const asset = await uploadProjectAsset({
        projectId: id,
        requestedBy: user,
        fileName: file.name,
        buffer: Buffer.from(await file.arrayBuffer()),
      });
      response = NextResponse.json({ assets: [asset], asset }, { status: 201 });
    } finally {
      try {
        await releaseUploadAdmission(admissionId);
      } catch {
        // Preserve the business result if the database is unavailable after
        // the upload. The durable lease expiry is the recovery boundary; a
        // retry must not turn a successful write into a misleading duplicate.
        console.error("Upload admission release failed; lease expiry will recover it");
      }
    }
    if (response === undefined) throw new Error("ASSET_UPLOAD_RESPONSE_MISSING");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
