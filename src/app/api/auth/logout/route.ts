import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  expiredSessionCookie,
  revokeRequestSession,
} from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await revokeRequestSession(request);
    return NextResponse.json(
      { ok: true },
      {
        headers: {
          "cache-control": "no-store",
          "set-cookie": expiredSessionCookie(),
        },
      },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
