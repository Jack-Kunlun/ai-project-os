import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertLocalRegistrationOrigin } from "@/lib/local-registration-config";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { handleApiError } from "@/lib/api-response";
import { issueGraphicCaptcha } from "@/lib/graphic-captcha-service";
import { readCaptchaBrowserToken, newCaptchaBrowserToken, captchaBrowserCookie } from "@/lib/graphic-captcha-cookie";
const schema=z.object({phone:z.string().max(14),purpose:z.enum(["register","login","close","test","recover","bind","change-old","change-new"])}).strict();
export async function POST(request:Request){
 try{
  assertSameOrigin(request);assertLocalRegistrationOrigin(request);
  const input=schema.parse(await readSmsJsonBody(request));
  const actor=["close","test","bind","change-old","change-new"].includes(input.purpose)?await requireApiSession(request):undefined;
  const browserToken=readCaptchaBrowserToken(request)??newCaptchaBrowserToken();
  const result=await issueGraphicCaptcha({...input,actor,browserToken});
  return NextResponse.json(result,{headers:{"cache-control":"no-store","set-cookie":captchaBrowserCookie(browserToken)}});
 }catch(error){const response=handleApiError(error);response.headers.set("cache-control","no-store");return response;}
}
