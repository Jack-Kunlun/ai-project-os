import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertLocalRegistrationOrigin, requireLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { readCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
import { handleApiError } from "@/lib/api-response";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { emailGraphicCaptchaProofSchema, type EmailAuthPurpose } from "@/lib/email-graphic-captcha-service";
import { issueEmailChallenge } from "@/lib/email-auth-service";

export const dynamic = "force-dynamic";
const schema = z.object({
  purpose: z.enum(["register", "verify", "password"]),
  email: z.string().max(320).optional(),
  captcha: emailGraphicCaptchaProofSchema,
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await readSmsJsonBody(request));
    let actor;
    if (input.purpose === "register") {
      assertLocalRegistrationOrigin(request);
      requireLocalRegistrationEnabled();
    } else {
      actor = await requireApiSession(request);
    }
    const result = await issueEmailChallenge({
      purpose: input.purpose as EmailAuthPurpose,
      email: input.email,
      captcha: input.captcha,
      actor,
      browserToken: readCaptchaBrowserToken(request) ?? "",
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store", "retry-after": String(result.retryAfterSeconds) },
    });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    if (response.status === 429) response.headers.set("retry-after", "60");
    return response;
  }
}
