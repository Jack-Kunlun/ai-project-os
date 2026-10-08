import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, expiredSessionCookie, requireApiSession } from "@/lib/auth";
import { assertLocalRegistrationOrigin } from "@/lib/local-registration-config";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { handleApiError } from "@/lib/api-response";
import { bindAccountPhone, changeAccountPhone } from "@/lib/account-security-service";

const proof = { phone: z.string().max(14), challengeId: z.string().uuid(), code: z.string().regex(/^[0-9]{6}$/u) };
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("bind"), ...proof, currentPassword: z.string().max(128) }).strict(),
  z.object({ action: z.literal("change"), ...proof, oldPhone: z.string().max(14), oldChallengeId: z.string().uuid(), oldCode: z.string().regex(/^[0-9]{6}$/u) }).strict(),
]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertLocalRegistrationOrigin(request);
    const actor = await requireApiSession(request);
    const input = schema.parse(await readSmsJsonBody(request));
    if (input.action === "bind") await bindAccountPhone(actor, input);
    else await changeAccountPhone(actor, input);
    return NextResponse.json({ phoneChanged: true }, {
      headers: { "cache-control": "no-store", "set-cookie": expiredSessionCookie() },
    });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
