import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { verifyPasswordRecord, type SafeSessionUser } from "@/lib/auth";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess, lockWorkspaceAccess, lockProjectAccess } from "@/lib/access-linearization";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { lockSmsConfiguration } from "@/lib/phone-auth-config";
import { smsDatabaseClock } from "@/lib/phone-auth-budget";
import { consumePhoneChallenge, verifyPhoneChallenge, type PhoneAuthProof, type SmsTransport } from "@/lib/phone-auth-service";
const schema=z.discriminatedUnion("method",[
 z.object({method:z.literal("password"),password:z.string().min(1).max(128),confirmation:z.literal("注销账号")}).strict(),
 z.object({method:z.literal("sms"),challengeId:z.string().uuid(),code:z.string().regex(/^[0-9]{6}$/u),confirmation:z.literal("注销账号")}).strict(),
]);
const WINDOW=15*60_000;
async function writer(tx:Prisma.TransactionClient,db:PrismaClient){if(isEntitlementDatabase(db))await assertEntitlementWriterSession(tx);}
function forbidden():ApiError{return new ApiError(403,"ACCOUNT_CLOSURE_AUTH_REQUIRED","身份验证失败，请重新登录后再试");}
export async function closeOwnAccount(input:unknown,actor:SafeSessionUser,db:PrismaClient=getEntitlementDb(),sms?:SmsTransport):Promise<{closed:true}> {
 const parsed=schema.parse(input);
 // Commit the per-account guessing limit before any expensive password/SMS check.
 const admitted=await db.$transaction(async tx=>{
  await writer(tx,db);await lockActorAccess(tx,actor.id);await assertAccountAccessForActor(tx,actor);
  const user=await tx.appUser.findUniqueOrThrow({where:{id:actor.id}});if(user.closedAt)throw forbidden();
  const now=await smsDatabaseClock(tx),old=await tx.accountClosureBudget.findUnique({where:{userId:actor.id}});
  if(old&&old.windowStartedAt.getTime()+WINDOW>now.getTime()&&old.attemptCount>=5)throw new ApiError(429,"ACCOUNT_CLOSURE_RATE_LIMITED","验证次数过多，请 15 分钟后重试");
  await tx.accountClosureBudget.upsert({where:{userId:actor.id},create:{userId:actor.id,attemptCount:1,windowStartedAt:now,updatedAt:now},update:old&&old.windowStartedAt.getTime()+WINDOW>now.getTime()?{attemptCount:{increment:1},updatedAt:now}:{attemptCount:1,windowStartedAt:now,updatedAt:now}});
  return user;
 });
 let proof:PhoneAuthProof|undefined;
 if(parsed.method==="password"){
  if(!await verifyPasswordRecord(parsed.password,admitted))throw forbidden();
 }else{
  if(!admitted.phoneE164||!admitted.phoneVerifiedAt)throw forbidden();
  proof=await verifyPhoneChallenge({phone:admitted.phoneE164,challengeId:parsed.challengeId,code:parsed.code},"close",db,sms);
 }
 return db.$transaction(async tx=>{
  await writer(tx,db);await lockSmsConfiguration(tx);await lockActorAccess(tx,actor.id);await assertAccountAccessForActor(tx,actor);
  const current=await tx.appUser.findUniqueOrThrow({where:{id:actor.id}});
  if(current.closedAt||current.passwordHash!==admitted.passwordHash||current.passwordSalt!==admitted.passwordSalt||current.passwordVersion!==admitted.passwordVersion||current.phoneE164!==admitted.phoneE164)throw forbidden();
  if(current.role==="admin"){
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(29082031)`;
   if(await tx.appUser.count({where:{role:"admin",disabledAt:null}})<=1)throw new ApiError(409,"ACCOUNT_CLOSURE_LAST_ADMIN","请先由另一位管理员接管系统，再注销账号");
  }
  const memberships=await tx.workspaceMembership.findMany({where:{userId:actor.id,role:"owner",accessState:"confirmed"},select:{workspaceId:true}});
  const workspaceIds=[...new Set(memberships.map(x=>x.workspaceId))].sort();
  for(const id of workspaceIds)await lockWorkspaceAccess(tx,id);
  const projects=await tx.project.findMany({where:{workspaceId:{in:workspaceIds}},select:{id:true},orderBy:{id:"asc"}});
  for(const project of projects)await lockProjectAccess(tx,project.id);
  const archive:string[]=[];
  for(const id of workspaceIds){
   const others=await tx.workspaceMembership.count({where:{workspaceId:id,userId:{not:actor.id},role:"owner",accessState:"confirmed",user:{disabledAt:null}}});
   if(others>0)continue;
   const workspace=await tx.workspace.findUniqueOrThrow({where:{id}});
   const collaborators=await tx.workspaceMembership.count({where:{workspaceId:id,userId:{not:actor.id},accessState:{not:"revoked"}}});
   const projectCollaborators=await tx.projectMembership.count({where:{project:{workspaceId:id},userId:{not:actor.id},accessState:{not:"revoked"}}});
   if(workspace.createdById!==actor.id||workspace.slug!==`user-${actor.id}`||collaborators>0||projectCollaborators>0)throw new ApiError(409,"ACCOUNT_CLOSURE_OWNER_TRANSFER_REQUIRED","你仍是共享工作区的唯一 Owner，请先转交所有权，再注销账号");
   if(!workspace.closedAt)archive.push(id);
  }
  const now=await smsDatabaseClock(tx);
  if(proof)await consumePhoneChallenge(tx,proof,actor.id,now);
  await tx.$executeRaw`SELECT set_config('app.account_closure_user_id',${actor.id},true)`;
  await tx.accountClosureReceipt.create({data:{id:randomUUID(),userId:actor.id,versionBefore:current.accountAccessVersion,versionAfter:current.accountAccessVersion+1,method:parsed.method,archivedWorkspaceIds:archive,createdAt:now}});
  for(const id of archive)await tx.workspace.update({where:{id},data:{closedAt:now,name:"已注销用户的工作区"}});
  await tx.appSession.updateMany({where:{userId:actor.id,revokedAt:null},data:{revokedAt:now}});
  if(current.phoneE164)await tx.smsAuthChallenge.updateMany({where:{phoneE164:current.phoneE164,consumedAt:null,status:{in:["pending","sent"]}},data:{status:"superseded"}});
  await tx.appUser.update({where:{id:actor.id},data:{closedAt:now,disabledAt:now,disabledReason:"account_closed",disabledById:actor.id,accountAccessVersion:{increment:1},username:`closed_${actor.id.replaceAll("-","")}`,displayName:null,email:null,emailVerifiedAt:null,phoneE164:null,phoneVerifiedAt:null,passwordHash:null,passwordSalt:null}});
  return {closed:true as const};
 },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,timeout:20_000});
}
