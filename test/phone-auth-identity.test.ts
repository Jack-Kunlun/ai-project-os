import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMainlandPhone, phoneFingerprint, smsCodeDigest, equalSmsDigest } from "@/lib/phone-auth-identity";
import { ApiError } from "@/lib/api-errors";
import { readSmsJsonBody } from "@/lib/sms-request-body";
import { POST as sendPost } from "@/app/api/auth/sms/send/route";
import { POST as loginPost } from "@/app/api/auth/sms/login/route";

test("mainland identity accepts +86 and local numbers, rejects ambiguous or foreign input",()=>{
  assert.equal(normalizeMainlandPhone("13800138000"),"+8613800138000");
  assert.equal(normalizeMainlandPhone("+8613800138000"),"+8613800138000");
  for(const value of [null,13800138000,"+85213800138000","+8612800138000"," 13800138000","138 0013 8000","008613800138000","138001380000"]){
    assert.throws(()=>normalizeMainlandPhone(value),ApiError);
  }
});
test("OTP digests bind challenge, phone, purpose and secret without storing the code",()=>{
  const secret=Buffer.alloc(32,1),base={id:"62ea96d1-e37f-4e46-a6a0-ec6d19e5500d",phone:"+8613800138000",purpose:"register" as const,code:"012345"};
  const digest=smsCodeDigest(base,secret);
  for(const change of [{purpose:"login" as const},{id:"different"},{phone:"+8613900138000"},{code:"012346"}]) assert.notEqual(smsCodeDigest({...base,...change},secret),digest);
  assert.notEqual(smsCodeDigest(base,Buffer.alloc(32,2)),digest);
  assert.ok(equalSmsDigest(digest,digest));assert.equal(equalSmsDigest(digest,"012345"),false);
  assert.notEqual(phoneFingerprint(base.phone,secret),phoneFingerprint(base.phone,Buffer.alloc(32,2)));
});
test("SMS JSON body enforces 2KiB and strict UTF-8 before parsing",async()=>{
  const req=(body:string|Uint8Array)=>new Request("https://example.com/api/auth/sms/send",{method:"POST",body:body as BodyInit});
  await assert.rejects(readSmsJsonBody(req(" ".repeat(2049))), (e:unknown)=>e instanceof ApiError&&e.status===413);
  await assert.rejects(readSmsJsonBody(req(new Uint8Array([255]))),(e:unknown)=>e instanceof ApiError&&e.status===400);
  assert.deepEqual(await readSmsJsonBody(req('{"phone":"13800138000"}')),{phone:"13800138000"});
});
test("SMS send and login reject missing/foreign origins before database or provider access",async()=>{
  const original=process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  process.env.AI_PROJECT_OS_PUBLIC_ORIGIN="https://phone-auth.example.com";
  try{for(const route of [sendPost,loginPost])for(const origin of [undefined,"https://evil.example.com","http://phone-auth.example.com"]){
    const headers:Record<string,string>={"content-type":"application/json"};if(origin)headers.origin=origin;
    const response=await route(new Request("https://phone-auth.example.com/api/auth/sms/send",{method:"POST",headers,body:"{}"}));
    assert.equal(response.status,403);assert.equal((await response.json()).error.code,"AUTH_CSRF_REJECTED");
  }}finally{if(original===undefined)delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN=original;}
});
