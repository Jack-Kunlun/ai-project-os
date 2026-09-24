import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { ProjectAssetArchiveError } from "@/lib/project-assets/archive";
import { parseAssetBuffer, ProjectAssetParserError } from "@/lib/project-assets/parser";
import { PERSONAL_KNOWLEDGE_CONTENT_MAX_LENGTH } from "@/lib/personal-knowledge-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_IMPORTS = 2;
let activeImports = 0;
const mimeByExtension: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", json: "application/json",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function POST(request: Request) {
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
    if (entries.length !== 1 || entries[0]?.[0] !== "file" || !(entries[0][1] instanceof File)) {
      throw new ApiError(400, "PERSONAL_KNOWLEDGE_IMPORT_INVALID", "请选择一个文件");
    }
    const file = entries[0][1];
    if (file.size === 0 || file.size > MAX_FILE_BYTES) throw new ApiError(413, "PERSONAL_KNOWLEDGE_IMPORT_TOO_LARGE", "文件超过 2 MB 限制");
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = mimeByExtension[extension];
    if (!mimeType) throw new ApiError(415, "PERSONAL_KNOWLEDGE_IMPORT_UNSUPPORTED", "当前支持 TXT、Markdown、JSON、PDF 和 DOCX");
    let segments;
    try {
      segments = await parseAssetBuffer({ buffer: Buffer.from(await file.arrayBuffer()), mimeType, fileName: file.name, archiveLimits: { maxEntries: 200, maxExpandedBytes: 4 * 1024 * 1024, maxSelectedEntryBytes: 2 * 1024 * 1024 }, maxPdfPages: 50 });
    } catch (error) {
      if (error instanceof ProjectAssetParserError || error instanceof ProjectAssetArchiveError) throw new ApiError(422, "PERSONAL_KNOWLEDGE_IMPORT_PARSE_FAILED", "文件内容无法提取");
      throw error;
    }
    if (segments.some((segment) => segment.requiresVision)) throw new ApiError(422, "PERSONAL_KNOWLEDGE_IMPORT_VISION_REQUIRED", "文件包含需要图片识别的页面");
    const content = segments.map((segment) => segment.contentText).filter(Boolean).join("\n\n");
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
