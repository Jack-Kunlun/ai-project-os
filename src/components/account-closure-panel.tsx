"use client";
import { UiErrorText } from "@/components/ui-error-text";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { SmsCodeInput } from "@/components/sms-code-input";
import { UiText } from "@/components/appearance-provider";
import { DialogActions, DialogForm, DialogSubmit } from "@/components/dialog-actions";
type Props={hasLocalPassword:boolean;phoneE164:string|null;phoneAuthStatus:"disabled"|"unavailable"|"available";embedded?:boolean};
export function AccountClosurePanel({hasLocalPassword,phoneE164,phoneAuthStatus,embedded=false}:Props){
 const router=useRouter(),[open,setOpen]=useState(embedded),[method,setMethod]=useState<"password"|"sms">(hasLocalPassword?"password":"sms"),[password,setPassword]=useState(""),[code,setCode]=useState(""),[challengeId,setChallengeId]=useState<string|null>(null),[confirmation,setConfirmation]=useState(""),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const smsAvailable=phoneE164!==null&&phoneAuthStatus==="available";
 const available=method==="password"?hasLocalPassword:smsAvailable;
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(pending||!available||confirmation!=="注销账号"||(method==="sms"&&!challengeId))return;
  setPending(true);setError(null);
  try{
   const response=await fetch("/api/profile/close",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(method==="password"?{method,password,confirmation}:{method,challengeId,code,confirmation})});
   const payload=await response.json().catch(()=>null) as {closed?:boolean;error?:{message?:string}}|null;
   if(!response.ok||payload?.closed!==true)throw new Error(payload?.error?.message??"注销未完成，请稍后重试");
   setPassword("");setCode("");router.replace("/login?account=closed");router.refresh();
  }catch(cause){setError(cause instanceof Error?cause.message:"注销未完成，请稍后重试");setPending(false);}
 }
 return <section className={embedded?"space-y-4":"mt-6 app-panel app-panel-danger p-6 sm:p-7"}>
  {!embedded?<h2 className="text-lg font-semibold text-app-text"><UiText text="注销账号" /></h2>:null}
  <p className="mt-2 text-sm leading-6 text-app-muted"><UiText text="注销后无法恢复账号，所有登录会话立即失效。手机号可以重新注册，全新账号不会关联旧工作区。" /></p>
  <p className="mt-1 text-sm leading-6 text-app-muted"><UiText text="独占的个人工作区将封存，历史资料和审计记录保留。共享团队的协作资料继续保留；若你是唯一 Owner，请先转交所有权。" /></p>
  {!open?<button type="button" onClick={()=>setOpen(true)} className="app-button-danger mt-4"><UiText text="申请注销账号" /></button>:<DialogForm onSubmit={submit} className="mt-4 max-w-lg space-y-4">
   {hasLocalPassword&&smsAvailable?<fieldset disabled={pending} className="flex gap-4 text-sm"><legend className="mb-2 font-semibold"><UiText text="再次验证身份" /></legend><label><input type="radio" name="closure-method" checked={method==="password"} onChange={()=>{setMethod("password");setError(null);}}/> <UiText text="账号密码" /></label><label><input type="radio" name="closure-method" checked={method==="sms"} onChange={()=>{setMethod("sms");setError(null);}}/> <UiText text="手机验证码" /></label></fieldset>:null}
   {method==="password"&&hasLocalPassword?<label className="block text-sm font-semibold" htmlFor="closure-password"><UiText text="当前账号密码" /><input id="closure-password" type="password" value={password} onChange={e=>setPassword(e.target.value)} maxLength={128} autoComplete="current-password" required disabled={pending} className="app-field mt-2 w-full font-normal"/></label>:phoneE164?<><p className="text-sm text-app-muted"><UiText text="验证已绑定手机号：" />+86 {phoneE164.slice(3,6)}****{phoneE164.slice(-4)}</p><fieldset disabled={pending}><SmsCodeInput id="account-closure-code" phoneE164={phoneE164} purpose="close" availability={smsAvailable?"available":"unavailable"} code={code} onCodeChange={setCode} onChallengeIdChange={setChallengeId}/></fieldset></>:<p className="text-sm text-app-warning-ink"><UiText text="请先在上方「账号密码」设置密码并重新登录，再验证注销。" /></p>}
   {!available&&phoneE164?<p className="text-sm text-app-warning-ink"><UiText text="短信验证暂不可用。已有账号密码可通过密码验证注销；仅短信登录的账号可先设置账号密码。" /></p>:null}
   <label className="block text-sm font-semibold" htmlFor="closure-confirmation"><UiText text="输入「注销账号」以确认" /><input id="closure-confirmation" value={confirmation} onChange={e=>setConfirmation(e.target.value)} required maxLength={4} autoComplete="off" disabled={pending} className="app-field mt-2 w-full font-normal"/></label>
   {error?<p role="alert" className="app-feedback-error text-sm"><UiErrorText text={error} /></p>:null}
   <DialogActions><DialogSubmit disabled={pending||!available||confirmation!=="注销账号"||(method==="sms"&&!challengeId)} className="app-button-danger"><UiText text={pending?"正在注销…":"确认注销"} /></DialogSubmit>{!embedded?<button type="button" disabled={pending} onClick={()=>{setOpen(false);setPassword("");setCode("");setConfirmation("");setError(null);}} className="app-button-secondary"><UiText text="取消" /></button>:null}</DialogActions>
  </DialogForm>}
 </section>;
}
