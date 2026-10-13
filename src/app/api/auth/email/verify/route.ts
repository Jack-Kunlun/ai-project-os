import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession, verifyAccountEmail } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { readCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
import { verifyEmailChallenge } from "@/lib/email-auth-service";
import { getEntitlementDb } from "@/lib/db";
import { ApiError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";
const schema = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^[0-9]{6}$/u) }).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = schema.parse(await readSmsJsonBody(request));
    const browserToken = readCaptchaBrowserToken(request);
    if (!browserToken) throw new ApiError(400, "EMAIL_AUTH_CODE_INVALID", "邮箱验证码无效或已过期，请重新获取");
    const proof = await verifyEmailChallenge({ ...input, purpose: "verify", actor, browserToken }, getEntitlementDb());
    const user = await verifyAccountEmail(actor, proof, browserToken, getEntitlementDb());
    return NextResponse.json({ user }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
