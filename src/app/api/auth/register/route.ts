import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, sessionCookie } from "@/lib/auth";
import { getEntitlementDb } from "@/lib/db";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import { reserveLocalRegistrationAttempt } from "@/lib/local-registration-abuse-budget";
import { assertLocalRegistrationOrigin, requireLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { isPhoneAuthEnabled } from "@/lib/phone-auth-config";
import { registerPhoneAccount } from "@/lib/phone-auth-service";
import { registerLocalAccount } from "@/lib/local-registration-service";

export const dynamic = "force-dynamic";
const MAX_REGISTRATION_BODY_BYTES = 4 * 1024;

const registrationSchema = z.object({
  username: z.string().max(64),
  password: z.string().max(128),
  remember: z.boolean().default(true),
  phone: z.string().max(14).optional(),
  challengeId: z.string().uuid().optional(),
  code: z.string().regex(/^[0-9]{6}$/u).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertLocalRegistrationOrigin(request);
    requireLocalRegistrationEnabled();
    const body = await readRequestBody(request, MAX_REGISTRATION_BODY_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    } catch {
      throw new ApiError(400, "INVALID_JSON", "注册请求格式无效");
    }
    const input = registrationSchema.parse(payload);
    const db = getEntitlementDb();
    let session;
    if (isPhoneAuthEnabled()) {
      if (!input.phone || !input.challengeId || !input.code) throw new ApiError(400, "PHONE_AUTH_PROOF_REQUIRED", "请填写手机号并完成短信验证码验证");
      session = await registerPhoneAccount({ ...input, phone: input.phone, challengeId: input.challengeId, code: input.code }, db);
    } else {
      session = await registerLocalAccount(input, reserveLocalRegistrationAttempt, db);
    }
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
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
