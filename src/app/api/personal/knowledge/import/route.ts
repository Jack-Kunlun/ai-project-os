import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { ProjectAssetArchiveError } from "@/lib/project-assets/archive";
import { parseAssetBuffer, ProjectAssetParserError } from "@/lib/project-assets/parser";
import { PERSONAL_KNOWLEDGE_CONTENT_MAX_LENGTH } from "@/lib/personal-knowledge-service";
import { extractPersonalKnowledgeVision, preparePersonalKnowledgeVision } from "@/lib/personal-knowledge-vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_IMPORTS = 2;
let activeImports = 0;
const mimeByExtension: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", json: "application/json",
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function POST(request: Request) {
  const executionDeadlineAt = new Date(Date.now() + 150_000);
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    if (actor.role === "admin") throw new ApiError(403, "PERSONAL_KNOWLEDGE_FORBIDDEN", "当前账号不能使用个人知识库");
    if (activeImports >= MAX_CONCURRENT_IMPORTS) throw new ApiError(429, "PERSONAL_KNOWLEDGE_IMPORT_BUSY", "文件处理繁忙，请稍后重试");
    activeImports += 1;
    try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError(415, "PERSONAL_KNOWLEDGE_IMPORT_INVALID_TYPE", "请上传文件");
    const body = await readRequestBody(request, MAX_FILE_BYTES + 64_000, () => new ApiError(413, "PERSONAL_KNOWLEDGE_IMPORT_TOO_LARGE", "文件超过 2 MB 限制"), { milliseconds: 30_000, error: () => new ApiError(408, "PERSONAL_KNOWLEDGE_IMPORT_TIMEOUT", "文件上传超时") });
    let data: FormData;
    try {
      data = await new Request(request.url, { method: "POST", headers: new Headers(request.headers), body: new Blob([body]) }).formData();
    } catch {
      throw new ApiError(400, "PERSONAL_KNOWLEDGE_IMPORT_INVALID", "文件上传格式无效");
    }
    const entries = [...data.entries()];
    const keys = entries.map(([key]) => key).sort().join(",");
    if (!(keys === "file" || keys === "file,forceVision" || keys === "action,file,providerId"
      || keys === "action,file,forceVision,providerId" || keys === "action,attemptId,file"
      || keys === "action,attemptId,file,forceVision")
      || !(data.get("file") instanceof File)) {
      throw new ApiError(400, "PERSONAL_KNOWLEDGE_IMPORT_INVALID", "请选择一个文件");
    }
    const file = data.get("file") as File;
    if (file.size === 0 || file.size > MAX_FILE_BYTES) throw new ApiError(413, "PERSONAL_KNOWLEDGE_IMPORT_TOO_LARGE", "文件超过 2 MB 限制");
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = mimeByExtension[extension];
    if (!mimeType) throw new ApiError(415, "PERSONAL_KNOWLEDGE_IMPORT_UNSUPPORTED", "当前支持 TXT、Markdown、JSON、PDF、DOCX、PNG、JPEG 和 WebP");
    const forceVision = data.get("forceVision");
    if (forceVision !== null && (forceVision !== "true" || mimeType !== "application/pdf")) {
      throw new ApiError(400, "PERSONAL_KNOWLEDGE_IMPORT_INVALID", "视觉识别选项仅适用于 PDF");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    if ((mimeType === "application/pdf" && buffer.subarray(0, 5).toString("ascii") !== "%PDF-")
      || (mimeType === "image/png" && !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
      || (mimeType === "image/jpeg" && !buffer.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")))
      || (mimeType === "image/webp" && !(buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP"))) {
      throw new ApiError(422, "PERSONAL_KNOWLEDGE_IMPORT_PARSE_FAILED", "文件格式与扩展名不符");
    }
    let segments;
    try {
      const parsed = await parseAssetBuffer({ buffer, mimeType, fileName: file.name, archiveLimits: { maxEntries: 200, maxExpandedBytes: 4 * 1024 * 1024, maxSelectedEntryBytes: 2 * 1024 * 1024 }, maxPdfPages: 50 });
      segments = forceVision === "true" ? parsed.map((segment) => ({ ...segment, requiresVision: true })) : parsed;
    } catch (error) {
      if (error instanceof ProjectAssetParserError || error instanceof ProjectAssetArchiveError) throw new ApiError(422, "PERSONAL_KNOWLEDGE_IMPORT_PARSE_FAILED", "文件内容无法提取");
      throw error;
    }
    const visionNeeded = segments.some((segment) => segment.requiresVision);
    const providerId = data.get("providerId");
    const action = data.get("action");
    const attemptId = data.get("attemptId");
    if (visionNeeded && action === "prepare" && typeof providerId === "string") {
      const prepared = await preparePersonalKnowledgeVision({ actor, providerId, buffer, mimeType, segments });
      return noStore(NextResponse.json({ confirmation: prepared }));
    }
    if (visionNeeded && (action !== "execute" || typeof attemptId !== "string")) {
      throw new ApiError(422, "PERSONAL_KNOWLEDGE_IMPORT_VISION_REQUIRED", "图片或扫描页需要先选择视觉模型并确认发送");
    }
    if (!visionNeeded && action !== null) throw new ApiError(400, "PERSONAL_KNOWLEDGE_IMPORT_INVALID", "文件导入操作无效");
    const visionContent = visionNeeded ? await extractPersonalKnowledgeVision({ actor, attemptId: attemptId as string, buffer, mimeType, segments, executionDeadlineAt }) : [];
    const content = [...segments.map((segment) => segment.contentText).filter(Boolean), ...visionContent].join("\n\n");
    if (!content.trim() || content.length > PERSONAL_KNOWLEDGE_CONTENT_MAX_LENGTH) {
      throw new ApiError(422, "PERSONAL_KNOWLEDGE_IMPORT_INVALID_CONTENT", "提取内容为空或超过 100,000 字符");
    }
    const title = file.name.replace(/\.[^.]+$/u, "").trim().slice(0, 240);
    return noStore(NextResponse.json({ preview: { title, content } }));
    } finally {
      activeImports -= 1;
    }
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
