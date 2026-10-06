import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { readRequestBody } from "@/lib/api-response";

export function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function readSmsAdminBody(request: Request): Promise<unknown> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readRequestBody(request, 4 * 1024, () => new ApiError(413, "SMS_PROVIDER_ADMIN_BODY_TOO_LARGE", "短信服务请求内容过大"));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "SMS_PROVIDER_ADMIN_INVALID_INPUT", "短信服务请求无效");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ApiError(400, "SMS_PROVIDER_ADMIN_INVALID_INPUT", "短信服务请求无效");
  }
}
