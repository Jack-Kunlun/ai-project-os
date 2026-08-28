import { NextResponse } from "next/server";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";

export async function GET() {
  try {
    const [initialized, session] = await Promise.all([
      isApplicationInitialized(),
      getPageSession(),
    ]);
    return NextResponse.json(
      { initialized, authenticated: session !== null },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
