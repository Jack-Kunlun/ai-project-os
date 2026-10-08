import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, expiredSessionCookie } from "@/lib/auth";
import { assertLocalRegistrationOrigin } from "@/lib/local-registration-config";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { handleApiError } from "@/lib/api-response";
import { recoverAccountPassword } from "@/lib/account-security-service";

const schema = z.object({
  phone: z.string().max(14), challengeId: z.string().uuid(),
  code: z.string().regex(/^[0-9]{6}$/u), newPassword: z.string().min(12).max(128),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertLocalRegistrationOrigin(request);
    const result = await recoverAccountPassword(schema.parse(await readSmsJsonBody(request)));
    return NextResponse.json({ ...result, passwordChanged: true }, {
      headers: { "cache-control": "no-store", "set-cookie": expiredSessionCookie() },
    });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
