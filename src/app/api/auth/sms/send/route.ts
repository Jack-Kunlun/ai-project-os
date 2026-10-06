import { graphicCaptchaProofSchema } from "@/lib/graphic-captcha-service";
import { readCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertLocalRegistrationOrigin } from "@/lib/local-registration-config";
import { handleApiError } from "@/lib/api-response";
import { issueSmsChallenge } from "@/lib/phone-auth-service";

const schema = z.object({ phone: z.string().max(14), purpose: z.enum(["register", "login", "close"]), captcha: graphicCaptchaProofSchema }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertLocalRegistrationOrigin(request);
    const input = schema.parse(await readSmsJsonBody(request));
    const actor = input.purpose === "close" ? await requireApiSession(request) : undefined;
    const result = await issueSmsChallenge({ ...input, actor, browserToken: readCaptchaBrowserToken(request) ?? "" });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) { const response = handleApiError(error); response.headers.set("cache-control", "no-store"); return response; }
}
