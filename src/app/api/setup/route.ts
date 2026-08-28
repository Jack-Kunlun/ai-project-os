import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertSameOrigin,
  initializeAdmin,
  sessionCookie,
} from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";

const setupSchema = z.object({
  username: z.string(),
  password: z.string(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = setupSchema.parse(await readJsonBody(request));
    const session = await initializeAdmin(input);
    return NextResponse.json(
      { user: session.user },
      {
        status: 201,
        headers: {
          "cache-control": "no-store",
          "set-cookie": sessionCookie(session.token, session.expiresAt),
        },
      },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
