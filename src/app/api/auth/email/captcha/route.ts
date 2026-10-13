import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertLocalRegistrationOrigin, requireLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { readCaptchaBrowserToken, newCaptchaBrowserToken, captchaBrowserCookie } from "@/lib/graphic-captcha-cookie";
import { handleApiError } from "@/lib/api-response";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { issueEmailGraphicCaptcha } from "@/lib/email-graphic-captcha-service";

export const dynamic = "force-dynamic";
const schema = z.object({
  purpose: z.enum(["register", "verify", "password"]),
  email: z.string().max(320).optional(),
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
    const existingToken = readCaptchaBrowserToken(request);
    const browserToken = existingToken ?? newCaptchaBrowserToken();
    const result = await issueEmailGraphicCaptcha({ ...input, email: input.email, actor, browserToken });
    return NextResponse.json(result, {
      headers: {
        "cache-control": "no-store",
        "set-cookie": captchaBrowserCookie(browserToken),
      },
    });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
