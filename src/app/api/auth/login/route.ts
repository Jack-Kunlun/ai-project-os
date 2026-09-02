import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, loginAdmin, sessionCookie } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
  remember: z.boolean().default(true),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = loginSchema.parse(await readJsonBody(request));
    const session = await loginAdmin(input);
    return NextResponse.json(
      { user: session.user },
      {
        headers: {
          "cache-control": "no-store",
          "set-cookie": sessionCookie(session.token, session.expiresAt, input.remember),
        },
      },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
