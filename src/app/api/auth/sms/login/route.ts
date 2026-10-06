import { readSmsJsonBody } from "@/lib/sms-request-body";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, sessionCookie } from "@/lib/auth";
import { assertLocalRegistrationOrigin } from "@/lib/local-registration-config";
import { handleApiError } from "@/lib/api-response";
import { loginWithSms } from "@/lib/phone-auth-service";

const schema = z.object({ phone: z.string().max(14), challengeId: z.string().uuid(), code: z.string().regex(/^[0-9]{6}$/u), remember: z.boolean().default(true) }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertLocalRegistrationOrigin(request);
    const input = schema.parse(await readSmsJsonBody(request));
    const { session, registered } = await loginWithSms(input);
    return NextResponse.json({ user: session.user, registered, message: registered ? "该手机号尚未注册，已自动创建账号和个人工作区。" : "登录成功" }, { headers: { "cache-control": "no-store", "set-cookie": sessionCookie(session.token, session.expiresAt, input.remember) } });
  } catch (error) { const response = handleApiError(error); response.headers.set("cache-control", "no-store"); return response; }
}
