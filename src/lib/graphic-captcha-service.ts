import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { type Prisma, type PrismaClient, type GraphicCaptchaChallenge } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { lockActorAccess } from "@/lib/access-linearization";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { phoneAuthSecret, isPhoneAuthEnabled } from "@/lib/phone-auth-config";
import { requireLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { normalizeMainlandPhone, phoneFingerprint, equalSmsDigest } from "@/lib/phone-auth-identity";
import { smsDatabaseClock } from "@/lib/phone-auth-budget";
import { newCaptchaAnswer, renderGraphicCaptcha } from "@/lib/graphic-captcha-image";
import { validCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
export const graphicCaptchaProofSchema=z.object({challengeId:z.string().uuid(),answer:z.string().regex(/^[A-Za-z0-9]{6}$/u)}).strict();
export type GraphicCaptchaProof=z.infer<typeof graphicCaptchaProofSchema>;
export type GraphicCaptchaPurpose="register"|"login"|"close"|"test"|"recover"|"bind"|"change-old"|"change-new";
type Actor={id:string;role:string;accountAccessVersion?:number;securityRevision?:number};
type Input={phone:unknown;purpose:GraphicCaptchaPurpose;browserToken:string;actor?:Actor};
type Tx=Prisma.TransactionClient;
const WINDOW=600_000,TTL=180_000;
const ACTOR_BOUND_PURPOSES=new Set<GraphicCaptchaPurpose>(["close","test","bind","change-old","change-new"]);
function invalid():ApiError{return new ApiError(400,"GRAPHIC_CAPTCHA_INVALID","图形验证码错误或已失效，请换一张后重试");}
function hash(domain:string,value:string):string{return createHmac("sha256",phoneAuthSecret()).update(`graphic-captcha-v1:${domain}:`).update(value).digest("hex");}
function binding(input:Input){
 if(!validCaptchaBrowserToken(input.browserToken)||!["register","login","close","test","recover","bind","change-old","change-new"].includes(input.purpose))throw invalid();
 const phone=normalizeMainlandPhone(input.phone),actor=ACTOR_BOUND_PURPOSES.has(input.purpose)?input.actor:undefined;
 if(ACTOR_BOUND_PURPOSES.has(input.purpose)&&(!actor||!z.string().uuid().safeParse(actor.id).success||!Number.isSafeInteger(actor.accountAccessVersion)||(actor.accountAccessVersion??0)<1))throw invalid();
 if(["bind","change-old","change-new"].includes(input.purpose)&&(!Number.isSafeInteger(actor?.securityRevision)||(actor?.securityRevision??0)<1))throw invalid();
 return {phone,phoneFingerprint:phoneFingerprint(phone,phoneAuthSecret()),browserFingerprint:hash("browser",input.browserToken),actorId:actor?.id??null,actorAccountAccessVersion:actor?.accountAccessVersion??null,actorSecurityRevision:actor?.securityRevision??null};
}
function digest(id:string,b:ReturnType<typeof binding>,purpose:string,answer:string):string{return hash("answer",JSON.stringify([id,b.phoneFingerprint,b.browserFingerprint,purpose,b.actorId,b.actorAccountAccessVersion,b.actorSecurityRevision,answer.toUpperCase()]));}
async function writer(tx:Tx,db:PrismaClient){if(isEntitlementDatabase(db))await assertEntitlementWriterSession(tx);}
async function actorAllowed(tx:Tx,input:Input,phone:string):Promise<boolean>{
 if(!ACTOR_BOUND_PURPOSES.has(input.purpose))return true;
 if(!input.actor)return false;
 await lockActorAccess(tx,input.actor.id);
 try{await assertAccountAccessForActor(tx,input.actor);}catch{return false;}
 const user=await tx.appUser.findUnique({where:{id:input.actor.id},select:{role:true,phoneE164:true,closedAt:true,securityRevision:true}});
 if(!user||user.closedAt||(input.actor.securityRevision!==undefined&&user.securityRevision!==input.actor.securityRevision))return false;
 if(input.purpose==="test")return user.role==="admin"&&input.actor.role==="admin";
 if(input.purpose==="close"||input.purpose==="change-old")return user.phoneE164===phone;
 return true;
}
async function budget(tx:Tx,scope:string,keyFingerprint:string,limit:number,now:Date){
 const where={scope_keyFingerprint:{scope,keyFingerprint}},old=await tx.graphicCaptchaBudget.findUnique({where});
 if(old&&old.windowStartedAt.getTime()+WINDOW>now.getTime()&&old.attemptCount>=limit)throw new ApiError(429,"GRAPHIC_CAPTCHA_RATE_LIMITED","获取图形验证码过于频繁，请稍后再试");
 const reset=!old||old.windowStartedAt.getTime()+WINDOW<=now.getTime();
 await tx.graphicCaptchaBudget.upsert({where,create:{scope,keyFingerprint,windowStartedAt:now,attemptCount:1,updatedAt:now},update:reset?{windowStartedAt:now,attemptCount:1,updatedAt:now}:{attemptCount:{increment:1},updatedAt:now}});
}
export async function issueGraphicCaptcha(input:Input,db=getEntitlementDb(),renderer: (answer:string)=>Promise<Buffer>=renderGraphicCaptcha){
 if(input.purpose==="register")requireLocalRegistrationEnabled();
 if(input.purpose!=="test"&&!isPhoneAuthEnabled())throw new ApiError(503,"PHONE_AUTH_UNAVAILABLE","短信验证暂不可用");
 const b=binding(input),id=randomUUID(),answer=newCaptchaAnswer();
 await db.$transaction(async tx=>{
  await writer(tx,db);
  if(!await actorAllowed(tx,input,b.phone))throw new ApiError(403,"GRAPHIC_CAPTCHA_FORBIDDEN","当前账号不能执行此操作");
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('graphic-captcha-admission-v1',0))`;
  const now=await smsDatabaseClock(tx);
  await tx.graphicCaptchaChallenge.deleteMany({where:{expiresAt:{lt:now}}});
  await tx.graphicCaptchaBudget.deleteMany({where:{updatedAt:{lt:new Date(now.getTime()-WINDOW)}}});
  await budget(tx,"issue_browser",b.browserFingerprint,40,now);await budget(tx,"issue_phone",b.phoneFingerprint,20,now);await budget(tx,"issue_global","0".repeat(64),1000,now);
  await tx.graphicCaptchaChallenge.create({data:{id,phoneFingerprint:b.phoneFingerprint,browserFingerprint:b.browserFingerprint,purpose:input.purpose,actorId:b.actorId,actorAccountAccessVersion:b.actorAccountAccessVersion,actorSecurityRevision:b.actorSecurityRevision,answerDigest:digest(id,b,input.purpose,answer),createdAt:now,expiresAt:new Date(now.getTime()+TTL)}});
 });
 try{return {challengeId:id,image:`data:image/png;base64,${(await renderer(answer)).toString("base64")}`,expiresInSeconds:180 as const};}
 catch{await db.graphicCaptchaChallenge.deleteMany({where:{id}}).catch(()=>undefined);throw new ApiError(503,"GRAPHIC_CAPTCHA_UNAVAILABLE","图形验证码暂不可用，请稍后再试");}
}
/** A single attempt is committed even for a wrong answer/binding; never roll it back with SMS admission. */
export async function consumeGraphicCaptcha(input:Input&{captcha:unknown},db=getEntitlementDb()):Promise<void>{
 const parsed=graphicCaptchaProofSchema.safeParse(input.captcha);if(!parsed.success)throw invalid();
 const b=binding(input),proof=parsed.data;
 const passed=await db.$transaction(async tx=>{
  await writer(tx,db);
  // Actor locks precede row locks consistently with issuance and account closure.
  const allowed=await actorAllowed(tx,input,b.phone);
  const [row]=await tx.$queryRaw<GraphicCaptchaChallenge[]>`SELECT * FROM "GraphicCaptchaChallenge" WHERE "id"=${proof.challengeId}::uuid FOR UPDATE`;
  const now=await smsDatabaseClock(tx);
  if(!row||row.consumedAt)return false;
  await tx.graphicCaptchaChallenge.update({where:{id:row.id},data:{consumedAt:now}});
  return allowed&&row.expiresAt>now&&row.phoneFingerprint===b.phoneFingerprint&&row.browserFingerprint===b.browserFingerprint&&row.purpose===input.purpose&&row.actorId===b.actorId&&row.actorAccountAccessVersion===b.actorAccountAccessVersion&&row.actorSecurityRevision===b.actorSecurityRevision&&equalSmsDigest(row.answerDigest,digest(row.id,b,input.purpose,proof.answer));
 });
 if(!passed)throw invalid();
}
