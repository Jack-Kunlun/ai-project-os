import { NextResponse } from "next/server";
import { ApiError, mapApiError } from "@/lib/api-errors";

export function handleApiError(error: unknown): NextResponse {
  const mapped = mapApiError(error);

  if (mapped.status >= 500) {
    console.error("API request failed");
  }

  return NextResponse.json(mapped.body, { status: mapped.status });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}
