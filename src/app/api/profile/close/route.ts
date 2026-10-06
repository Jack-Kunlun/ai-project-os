import { NextResponse } from "next/server";
import { assertSameOrigin, expiredSessionCookie, requireApiSession } from "@/lib/auth";
import { assertLocalRegistrationOrigin } from "@/lib/local-registration-config";
import { handleApiError } from "@/lib/api-response";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { closeOwnAccount } from "@/lib/account-closure-service";
export const dynamic="force-dynamic";
export async function POST(request:Request){
 try{
  assertSameOrigin(request);assertLocalRegistrationOrigin(request);
  const actor=await requireApiSession(request);
  const result=await closeOwnAccount(await readSmsJsonBody(request),actor);
  return NextResponse.json(result,{headers:{"cache-control":"no-store","set-cookie":expiredSessionCookie()}});
 }catch(error){const response=handleApiError(error);response.headers.set("cache-control","no-store");return response;}
}
