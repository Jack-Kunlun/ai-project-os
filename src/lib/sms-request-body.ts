import { ApiError } from "@/lib/api-errors";
import { readRequestBody } from "@/lib/api-response";
export async function readSmsJsonBody(request: Request, limit = 2048): Promise<unknown> {
  const bytes = await readRequestBody(request, limit, () => new ApiError(413, "PHONE_AUTH_BODY_TOO_LARGE", "请求内容过大"), { milliseconds: 10_000, error: () => new ApiError(408, "PHONE_AUTH_BODY_TIMEOUT", "请求超时") });
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ApiError(400, "PHONE_AUTH_INVALID_INPUT", "请求内容无效"); }
}
