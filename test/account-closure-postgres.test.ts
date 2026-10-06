import { seedVerifiedSmsConfigFixture } from "./sms-provider-config-fixture";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { closeOwnAccount } from "@/lib/account-closure-service";
import { issueSmsChallenge, loginWithSms, registerPhoneAccount, type SmsTransport } from "@/lib/phone-auth-service";
import { createPasswordRecord, loginAdmin, readSessionToken } from "@/lib/auth";
import { sealSmsConfig } from "@/lib/phone-auth-config";
import { grantWorkspaceMembership } from "@/lib/membership-governance";
import { issueGraphicCaptchaFixture } from "./graphic-captcha-fixture";
const enabled=process.env.PHONE_AUTH_POSTGRES_GATE==="1";
function url(name:string):string{const value=process.env[name];if(!value)throw new Error("PHONE_AUTH_ISOLATED_URL_REQUIRED");const u=new URL(value);if(u.hostname!=="127.0.0.1"||u.port!=="56329"||u.pathname!=="/ai_project_os_phone_auth_test"||u.search||u.hash)throw new Error("PHONE_AUTH_ISOLATED_URL_INVALID");return value;}
const password="ClosureAcceptance_2026",code="123456",sms:SmsTransport={send:async()=>{},check:async input=>input.code===code};
test("irreversible closure releases phone identity, revokes access and safely seals personal workspaces",{skip:!enabled},async(t)=>{
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:url("PHONE_AUTH_TEST_DATABASE_URL")})}),owner=new PrismaClient({adapter:new PrismaPg({connectionString:url("PHONE_AUTH_TEST_OWNER_URL")})});
 const adminId=randomUUID(),adminUsername=`closure_admin_${adminId.slice(0,8)}`;await owner.appUser.create({data:{id:adminId,username:adminUsername,role:"admin",...await createPasswordRecord(password)}});
 const sealed=await sealSmsConfig({accessKeyId:"closure-key",accessKeySecret:"test-only-closure-secret",signName:"隔离测试",templateCode:"10001",schemePrefix:"closure"},"active");
 await owner.$transaction(async tx=>{await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;await tx.smsProviderConfig.deleteMany();await seedVerifiedSmsConfigFixture(tx,{id:"active",provider:"aliyun-pnvs",version:1,enabled:true,verifiedAt:new Date(),updatedById:adminId,...sealed});});
 async function resetCooldown(phone:string){await owner.$executeRaw`UPDATE "SmsAuthChallenge" SET "createdAt"="createdAt"-interval '61 seconds',"expiresAt"="expiresAt"-interval '61 seconds' WHERE "phoneE164"=${`+86${phone}`}`;}
 async function register(phone:string,username:string){const captcha=await issueGraphicCaptchaFixture({phone,purpose:"register"},db);const c=await issueSmsChallenge({phone,purpose:"register",...captcha},db,sms);return registerPhoneAccount({username,password,phone,challengeId:c.challengeId,code},db,sms);}
 try{
  await t.test("the last enabled platform administrator cannot close their account",async()=>{
   const session=await loginAdmin({username:adminUsername,password},db);
   await assert.rejects(closeOwnAccount({method:"password",password,confirmation:"注销账号"},session.user,db,sms),(error:unknown)=>error instanceof ApiError&&error.code==="ACCOUNT_CLOSURE_LAST_ADMIN");
   assert.equal((await db.appUser.findUniqueOrThrow({where:{id:adminId}})).closedAt,null);
   assert.equal(await db.accountClosureReceipt.count({where:{userId:adminId}}),0);
  });
  await t.test("wrong passwords consume a durable limit while leaving the account unchanged",async()=>{
   const s=await register("13800000201","closure_wrong_password");for(let i=0;i<5;i++)await assert.rejects(closeOwnAccount({method:"password",password:"WrongPassword_2026",confirmation:"注销账号"},s.user,db,sms),(e:unknown)=>e instanceof ApiError&&e.code==="ACCOUNT_CLOSURE_AUTH_REQUIRED");
   await assert.rejects(closeOwnAccount({method:"password",password,confirmation:"注销账号"},s.user,db,sms),(e:unknown)=>e instanceof ApiError&&e.status===429);
   assert.equal((await db.appUser.findUniqueOrThrow({where:{id:s.user.id}})).closedAt,null);assert.equal(await db.accountClosureReceipt.count({where:{userId:s.user.id}}),0);
  });
  await t.test("SMS closure needs its own purpose proof; sealed personal data never attaches to a reused phone",async()=>{
   const phone="13800000202",s=await register(phone,phone),oldId=s.user.id,workspace=await db.workspace.findUniqueOrThrow({where:{slug:`user-${oldId}`}});
   const project=await owner.project.create({data:{workspaceId:workspace.id,slug:`closure_project_${randomUUID().slice(0,8)}`,name:"isolated preserved project",description:"synthetic closure acceptance material"}});
   await resetCooldown(phone);const loginCaptcha=await issueGraphicCaptchaFixture({phone,purpose:"login"},db),loginProof=await issueSmsChallenge({phone,purpose:"login",...loginCaptcha},db,sms);
   await assert.rejects(closeOwnAccount({method:"sms",challengeId:loginProof.challengeId,code,confirmation:"注销账号"},s.user,db,sms),ApiError);assert.equal(await db.accountClosureReceipt.count({where:{userId:oldId}}),0);
   await resetCooldown(phone);const closeCaptcha=await issueGraphicCaptchaFixture({phone,purpose:"close",actor:s.user},db),closeProof=await issueSmsChallenge({phone,purpose:"close",actor:s.user,...closeCaptcha},db,sms);
   assert.deepEqual(await closeOwnAccount({method:"sms",challengeId:closeProof.challengeId,code,confirmation:"注销账号"},s.user,db,sms),{closed:true});
   const old=await db.appUser.findUniqueOrThrow({where:{id:oldId}});assert.ok(old.closedAt);assert.ok(old.disabledAt);assert.equal(old.accountAccessVersion,2);assert.equal(old.phoneE164,null);assert.equal(old.passwordHash,null);assert.match(old.username,/^closed_[a-f0-9]{32}$/u);
   assert.equal(await readSessionToken(s.token,db),null);assert.equal(await db.appSession.count({where:{userId:oldId,revokedAt:null}}),0);
   assert.ok((await db.workspace.findUniqueOrThrow({where:{id:workspace.id}})).closedAt);assert.equal((await db.project.findUniqueOrThrow({where:{id:project.id}})).description,"synthetic closure acceptance material");
   await assert.rejects(owner.project.create({data:{workspaceId:workspace.id,name:"must reject",slug:`closed_reject_${randomUUID().slice(0,8)}`}}));
   await assert.rejects(owner.workspace.update({where:{id:workspace.id},data:{closedAt:null}}));await assert.rejects(owner.appUser.update({where:{id:oldId},data:{disabledAt:null,closedAt:null}}));
   await assert.rejects(loginWithSms({phone,challengeId:loginProof.challengeId,code},db,sms),ApiError);
   const receipt=await db.accountClosureReceipt.findUniqueOrThrow({where:{userId:oldId}});assert.deepEqual(receipt.archivedWorkspaceIds,[workspace.id]);await assert.rejects(db.accountClosureReceipt.update({where:{id:receipt.id},data:{method:"password"}}));
   await resetCooldown(phone);const freshCaptcha=await issueGraphicCaptchaFixture({phone,purpose:"login"},db),freshProof=await issueSmsChallenge({phone,purpose:"login",...freshCaptcha},db,sms),fresh=await loginWithSms({phone,challengeId:freshProof.challengeId,code},db,sms);
   assert.equal(fresh.registered,true);assert.notEqual(fresh.session.user.id,oldId);const newWorkspace=await db.workspace.findUniqueOrThrow({where:{slug:`user-${fresh.session.user.id}`}});assert.notEqual(newWorkspace.id,workspace.id);assert.equal(await db.project.count({where:{workspaceId:newWorkspace.id}}),0);
   await assert.rejects(loginAdmin({username:phone,password},db));assert.equal(await readSessionToken(s.token,db),null);
  });
  await t.test("an exclusive personal account can close by password, but sole shared Owner must transfer",async()=>{
   const s=await register("13800000203","closure_shared_owner");
   const shared=await owner.$transaction(async tx=>{const w=await tx.workspace.create({data:{name:"isolated shared",slug:`shared_${randomUUID().slice(0,8)}`,createdById:s.user.id}});await grantWorkspaceMembership(tx,{workspaceId:w.id,userId:s.user.id,role:"owner",actorId:s.user.id,reason:"isolated_closure_owner_fixture"});return w;});
   await assert.rejects(closeOwnAccount({method:"password",password,confirmation:"注销账号"},s.user,db,sms),(e:unknown)=>e instanceof ApiError&&e.code==="ACCOUNT_CLOSURE_OWNER_TRANSFER_REQUIRED");
   assert.equal((await db.appUser.findUniqueOrThrow({where:{id:s.user.id}})).closedAt,null);assert.equal(await db.accountClosureReceipt.count({where:{userId:s.user.id}}),0);
   const successor=await register("13800000204","closure_successor");await owner.$transaction(tx=>grantWorkspaceMembership(tx,{workspaceId:shared.id,userId:successor.user.id,role:"owner",actorId:s.user.id,reason:"isolated_closure_successor_fixture"}));
   await closeOwnAccount({method:"password",password,confirmation:"注销账号"},s.user,db,sms);
   assert.equal((await db.workspace.findUniqueOrThrow({where:{id:shared.id}})).closedAt,null);assert.equal(await readSessionToken(s.token,db),null);
  });
  await t.test("stale actors cannot reserve or close after account epoch changes",async()=>{
   const s=await register("13800000205","closure_stale_actor");await assert.rejects(closeOwnAccount({method:"password",password,confirmation:"注销账号"},{...s.user,accountAccessVersion:s.user.accountAccessVersion+1},db,sms));assert.equal(await db.accountClosureReceipt.count({where:{userId:s.user.id}}),0);
  });
 }finally{await db.$disconnect();await owner.$disconnect();}
});
