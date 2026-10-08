import { createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { phoneAuthSecret } from "@/lib/phone-auth-config";
import { normalizeMainlandPhone, phoneFingerprint } from "@/lib/phone-auth-identity";
const MINUTE=60_000, HOUR=60*MINUTE, DAY=24*HOUR, ZERO="0".repeat(64);
type Tx=Prisma.TransactionClient;
function limited(): ApiError { return new ApiError(429,"PHONE_AUTH_RATE_LIMITED","操作过于频繁，请稍后再试"); }
export async function smsDatabaseClock(tx: Tx): Promise<Date> {
  const [row]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS "now"`;
  if (!(row?.now instanceof Date)) throw new ApiError(503,"PHONE_AUTH_UNAVAILABLE","短信验证暂不可用");
  return row.now;
}
async function budget(tx:Tx,scope:string,key:string,duration:number,limit:number,now:Date):Promise<void> {
  const where={scope_keyFingerprint:{scope,keyFingerprint:key}};
  const old=await tx.phoneAuthBudget.findUnique({where});
  if (!old || old.windowStartedAt.getTime()+duration<=now.getTime()) {
    await tx.phoneAuthBudget.upsert({where,create:{scope,keyFingerprint:key,attemptCount:1,windowStartedAt:now,updatedAt:now},update:{attemptCount:1,windowStartedAt:now,updatedAt:now}});
  } else {
    if(old.attemptCount>=limit) throw limited();
    await tx.phoneAuthBudget.update({where,data:{attemptCount:{increment:1},updatedAt:now}});
  }
}
async function admission(tx:Tx):Promise<void> { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('phone-auth-admission-v1',0))`; }
export async function reserveSmsSendBudget(tx:Tx,phoneInput:string):Promise<{now:Date;fingerprint:string}> {
  const phone=normalizeMainlandPhone(phoneInput), fingerprint=phoneFingerprint(phone,phoneAuthSecret());
  await admission(tx); const now=await smsDatabaseClock(tx);
  await tx.smsAuthChallenge.deleteMany({where:{expiresAt:{lt:new Date(now.getTime()-DAY)}}});
  await tx.smsProviderProbe.deleteMany({where:{expiresAt:{lt:new Date(now.getTime()-DAY)}}});
  await tx.phoneAuthBudget.deleteMany({where:{updatedAt:{lt:new Date(now.getTime()-DAY)}}});
  const recent={phoneFingerprint:fingerprint,createdAt:{gt:new Date(now.getTime()-MINUTE)}};
  if(await tx.smsAuthChallenge.findFirst({where:recent,select:{id:true}}) || await tx.smsProviderProbe.findFirst({where:recent,select:{id:true}})) throw limited();
  await budget(tx,"send_phone_hour",fingerprint,HOUR,5,now); await budget(tx,"send_phone_day",fingerprint,DAY,10,now);
  await budget(tx,"send_global_hour",ZERO,HOUR,50,now); await budget(tx,"send_global_day",ZERO,DAY,200,now);
  return {now,fingerprint};
}
export async function reserveSmsVerifyBudget(tx:Tx,phoneInput:string):Promise<{now:Date;fingerprint:string}> {
  const fingerprint=phoneFingerprint(normalizeMainlandPhone(phoneInput),phoneAuthSecret());
  await admission(tx);const now=await smsDatabaseClock(tx);
  await budget(tx,"verify_phone_hour",fingerprint,HOUR,30,now);await budget(tx,"verify_global_hour",ZERO,HOUR,500,now);
  return {now,fingerprint};
}
export async function reserveAccountPasswordVerifyBudget(tx:Tx,userId:string):Promise<{now:Date;fingerprint:string}> {
  const fingerprint=createHmac("sha256",phoneAuthSecret()).update("phone-auth:account-password:v1:").update(userId).digest("hex");
  await admission(tx);const now=await smsDatabaseClock(tx);
  await budget(tx,"verify_account_password_hour",fingerprint,HOUR,10,now);
  return {now,fingerprint};
}
