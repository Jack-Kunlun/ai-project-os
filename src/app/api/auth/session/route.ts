import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    return NextResponse.json(
      { user },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
