import { seedVerifiedSmsConfigFixture } from "./sms-provider-config-fixture";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { issueSmsChallenge, loginWithSms, registerPhoneAccount, type SmsTransport } from "@/lib/phone-auth-service";
import { loginAdmin } from "@/lib/auth";
import { sealSmsConfig } from "@/lib/phone-auth-config";
import { issueGraphicCaptchaFixture } from "./graphic-captcha-fixture";
const enabled=process.env.PHONE_AUTH_POSTGRES_GATE==="1";
function url(name:string):string {
 const value=process.env[name];if(!value)throw new Error("PHONE_AUTH_ISOLATED_URL_REQUIRED");
 const u=new URL(value);if(!["postgresql:","postgres:"].includes(u.protocol)||u.hostname!=="127.0.0.1"||u.port!=="56329"||u.pathname!=="/ai_project_os_phone_auth_test"||u.search||u.hash)throw new Error("PHONE_AUTH_ISOLATED_URL_INVALID");return value;
}
const config={accessKeyId:"test-key",accessKeySecret:"test-only-secret",signName:"测试专用",templateCode:"100001",schemePrefix:"gate"};
const code="123456", password="PhoneAuthentication_2026";
test("phone authentication migration, one-use proof, durable limits and account identity",{skip:!enabled},async(t)=>{
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:url("PHONE_AUTH_TEST_DATABASE_URL")})});
 const owner=new PrismaClient({adapter:new PrismaPg({connectionString:url("PHONE_AUTH_TEST_OWNER_URL")})});
 let sends=0,checks=0;
 const sms:SmsTransport={send:async()=>{sends++;},check:async input=>{checks++;return input.code===code;}};
 const id=randomUUID();
 await owner.appUser.create({data:{id,username:`phone_gate_admin_${id.slice(0,8)}`,role:"admin"}});
 const sealed=await sealSmsConfig(config,"active");
 await owner.$transaction(async tx=>{await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;await tx.smsProviderConfig.deleteMany();await seedVerifiedSmsConfigFixture(tx,{id:"active",provider:"aliyun-pnvs",enabled:true,version:1,verifiedAt:new Date(),updatedById:id,...sealed});});
 async function advanceConfig(){await owner.$transaction(async tx=>{await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;await tx.smsProviderConfig.update({where:{id:"active"},data:{version:{increment:1}}});});}

 async function challenge(phone:string,purpose:"register"|"login"="login"){
  const captcha=await issueGraphicCaptchaFixture({phone,purpose},db);
  return issueSmsChallenge({phone,purpose,...captcha},db,sms);
 }
 try{
  await t.test("concurrent sends commit one reservation and failures still consume cooldown",async()=>{
   const previousGlobal=(await db.phoneAuthBudget.findUnique({where:{scope_keyFingerprint:{scope:"send_global_hour",keyFingerprint:"0".repeat(64)}}}))?.attemptCount??0;
   const results=await Promise.allSettled(Array.from({length:8},()=>challenge("13800000001")));
   assert.equal(results.filter(x=>x.status==="fulfilled").length,1);assert.equal(sends,1);
   assert.equal((await db.phoneAuthBudget.findUniqueOrThrow({where:{scope_keyFingerprint:{scope:"send_global_hour",keyFingerprint:"0".repeat(64)}}})).attemptCount,previousGlobal+1);
   const failedSendCaptcha=await issueGraphicCaptchaFixture({phone:"13800000002",purpose:"login"},db);
   await assert.rejects(issueSmsChallenge({phone:"13800000002",purpose:"login",...failedSendCaptcha},db,{...sms,send:async()=>{throw new Error("provider secret trace");}}),ApiError);
   await assert.rejects(challenge("13800000002"),(e:unknown)=>e instanceof ApiError&&e.status===429);
   assert.equal((await db.phoneAuthBudget.findUniqueOrThrow({where:{scope_keyFingerprint:{scope:"send_global_hour",keyFingerprint:"0".repeat(64)}}})).attemptCount,previousGlobal+2);
  });
  await t.test("wrong codes count durably up to five with no account created",async()=>{
   const c=await challenge("13800000003");const before=checks;
   for(let i=0;i<6;i++)await assert.rejects(loginWithSms({phone:"13800000003",challengeId:c.challengeId,code:"999999"},db,sms),(e:unknown)=>e instanceof ApiError&&e.code==="PHONE_AUTH_CODE_INVALID");
   assert.equal((await db.smsAuthChallenge.findUniqueOrThrow({where:{id:c.challengeId}})).attemptCount,5);assert.equal(checks-before,5);
   assert.equal(await db.appUser.findUnique({where:{phoneE164:"+8613800000003"}}),null);
  });
  await t.test("SMS login creates exactly one ordinary account and personal Owner workspace; same code cannot replay",async()=>{
   const c=await challenge("13800000004");const results=await Promise.allSettled([loginWithSms({phone:"13800000004",challengeId:c.challengeId,code},db,sms),loginWithSms({phone:"13800000004",challengeId:c.challengeId,code},db,sms)]);
   const pass=results.find(x=>x.status==="fulfilled");assert.ok(pass&&pass.status==="fulfilled");assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
   assert.equal(pass.value.registered,true);const user=await db.appUser.findUniqueOrThrow({where:{phoneE164:"+8613800000004"}});
   assert.equal(user.role,"user");assert.equal(user.passwordHash,null);assert.equal(user.emailVerifiedAt,null);
   const memberships=await db.workspaceMembership.findMany({where:{userId:user.id,accessState:"confirmed"}});assert.equal(memberships.length,1);assert.equal(memberships[0].role,"owner");
   await assert.rejects(loginWithSms({phone:"13800000004",challengeId:c.challengeId,code},db,sms),ApiError);
  });
  await t.test("explicit signup requires registration proof; password also accepts local and +86 phone aliases",async()=>{
   const login=await challenge("13800000005","login");await assert.rejects(registerPhoneAccount({username:"phone_purpose_bad",password,phone:"13800000005",challengeId:login.challengeId,code},db,sms),ApiError);
   const c=await challenge("13800000006","register");const session=await registerPhoneAccount({username:"phone_password_owner",password,phone:"13800000006",challengeId:c.challengeId,code},db,sms);
   assert.equal((await loginAdmin({username:"13800000006",password},db)).user.id,session.user.id);
   assert.equal((await loginAdmin({username:"+8613800000006",password},db)).user.id,session.user.id);
   assert.equal((await loginAdmin({username:"phone_password_owner",password},db)).user.id,session.user.id);
   process.env.PHONE_AUTH_ENABLED="false";
   try { assert.equal((await loginAdmin({username:"13800000006",password},db)).user.id,session.user.id); }
   finally { process.env.PHONE_AUTH_ENABLED="true"; }
   await assert.rejects(loginAdmin({username:"13800000006",password:"WrongPassword2026"},db));
  });
  await t.test("verified proof cannot create an account when signup disabled; existing SMS login remains available",async()=>{
   const c=await challenge("13800000007");process.env.LOCAL_REGISTRATION_ENABLED="false";
   try{await assert.rejects(loginWithSms({phone:"13800000007",challengeId:c.challengeId,code},db,sms),(e:unknown)=>e instanceof ApiError&&e.code==="LOCAL_REGISTRATION_DISABLED");
   await owner.$executeRaw`UPDATE "SmsAuthChallenge" SET "createdAt"="createdAt"-interval '61 seconds',"expiresAt"="expiresAt"-interval '61 seconds' WHERE "phoneE164"='+8613800000006'`;
   const existing=await challenge("13800000006");assert.equal((await loginWithSms({phone:"13800000006",challengeId:existing.challengeId,code},db,sms)).registered,false);
   }finally{process.env.LOCAL_REGISTRATION_ENABLED="true";}
  });
  await t.test("expired, superseded and configuration-stale proofs are rejected",async()=>{
   const c=await challenge("13800000008");await db.smsAuthChallenge.update({where:{id:c.challengeId},data:{status:"superseded"}});await assert.rejects(loginWithSms({phone:"13800000008",challengeId:c.challengeId,code},db,sms),ApiError);
   const e=await challenge("13800000009");await owner.$executeRaw`UPDATE "SmsAuthChallenge" SET "createdAt"=clock_timestamp()-interval '6 minutes',"expiresAt"=clock_timestamp()-interval '1 minute' WHERE "id"=${e.challengeId}::uuid`;await assert.rejects(loginWithSms({phone:"13800000009",challengeId:e.challengeId,code},db,sms),ApiError);
   const v=await challenge("13800000010");await advanceConfig();await assert.rejects(loginWithSms({phone:"13800000010",challengeId:v.challengeId,code},db,sms),ApiError);
  });
  await t.test("switch during an in-flight check prevents session or account creation",async()=>{
   const c=await challenge("13800000011");const switching:SmsTransport={...sms,check:async()=>{await advanceConfig();return true;}};
   await assert.rejects(loginWithSms({phone:"13800000011",challengeId:c.challengeId,code},db,switching),ApiError);assert.equal(await db.appUser.findUnique({where:{phoneE164:"+8613800000011"}}),null);
  });
  await t.test("global send quota is shared even across different phone numbers",async()=>{
   await db.phoneAuthBudget.update({where:{scope_keyFingerprint:{scope:"send_global_hour",keyFingerprint:"0".repeat(64)}},data:{attemptCount:49}});
   const results=await Promise.allSettled([challenge("13800000012"),challenge("13800000013")]);assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
   assert.equal((await db.phoneAuthBudget.findUniqueOrThrow({where:{scope_keyFingerprint:{scope:"send_global_hour",keyFingerprint:"0".repeat(64)}}})).attemptCount,50);
   await db.phoneAuthBudget.deleteMany();
  });
 }finally{await db.$disconnect();await owner.$disconnect();}
});
