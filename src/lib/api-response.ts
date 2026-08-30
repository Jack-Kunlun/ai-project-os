import { NextResponse } from "next/server";
import { ApiError, mapApiError } from "@/lib/api-errors";

export function handleApiError(error: unknown): NextResponse {
  const mapped = mapApiError(error);

  if (mapped.status >= 500) {
    console.error("API request failed");
  }

  return NextResponse.json(mapped.body, { status: mapped.status });
}

export const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

function requestBodyTooLarge(): ApiError {
  return new ApiError(413, "REQUEST_BODY_TOO_LARGE", "Request body is too large");
}

function invalidContentLength(): ApiError {
  return new ApiError(400, "REQUEST_CONTENT_LENGTH_INVALID", "Request Content-Length is invalid");
}

export async function readRequestBody(
  request: Request,
  maxBytes: number,
  tooLarge: () => ApiError = requestBodyTooLarge,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("readRequestBody requires a positive safe integer limit");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/u.test(normalized)) throw invalidContentLength();
    try {
      if (BigInt(normalized) > BigInt(maxBytes)) throw tooLarge();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw invalidContentLength();
    }
  }

  if (request.body === null) return new Uint8Array() as Uint8Array<ArrayBuffer>;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Request body chunk is invalid");
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("REQUEST_BODY_TOO_LARGE").catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total) as Uint8Array<ArrayBuffer>;
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readRequestBody(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}
