import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { newCaptchaAnswer, CAPTCHA_ALPHABET, renderGraphicCaptcha } from "@/lib/graphic-captcha-image";
import { newCaptchaBrowserToken, readCaptchaBrowserToken, captchaBrowserCookie, GRAPHIC_CAPTCHA_COOKIE } from "@/lib/graphic-captcha-cookie";
import { graphicCaptchaProofSchema, consumeGraphicCaptcha } from "@/lib/graphic-captcha-service";
import { POST } from "@/app/api/auth/sms/captcha/route";

test("CAPTCHA raster contains no text or answer metadata and needs no fonts",async()=>{
 assert.equal(new Set(CAPTCHA_ALPHABET).size,32);
 for(let n=0;n<20;n++)assert.match(newCaptchaAnswer(),/^[A-HJ-NP-Z2-9]{6}$/u);
 const image=await renderGraphicCaptcha("ABCD23");assert.equal(image.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
 assert.equal(image.readUInt32BE(16),216);assert.equal(image.readUInt32BE(20),72);
 const chunks:string[]=[];for(let offset=8;offset<image.length;){const length=image.readUInt32BE(offset);chunks.push(image.toString("ascii",offset+4,offset+8));offset+=length+12;}
 assert.ok(chunks.includes("IDAT"));assert.ok(!chunks.some(x=>["tEXt","iTXt","zTXt"].includes(x)));
 await assert.rejects(renderGraphicCaptcha("<script>"));
});
test("opaque CAPTCHA cookie is strict, HttpOnly and rejects duplicate/malformed binding",()=>{
 const token=newCaptchaBrowserToken();assert.match(token,/^[A-Za-z0-9_-]{43}$/u);
 const request=(cookie:string)=>new Request("https://example.com",{headers:{cookie}});
 assert.equal(readCaptchaBrowserToken(request(`${GRAPHIC_CAPTCHA_COOKIE}=${token}`)),token);
 assert.equal(readCaptchaBrowserToken(request(`${GRAPHIC_CAPTCHA_COOKIE}=${token}; ${GRAPHIC_CAPTCHA_COOKIE}=${token}`)),undefined);
 assert.equal(readCaptchaBrowserToken(request(`${GRAPHIC_CAPTCHA_COOKIE}=invalid`)),undefined);
 const before=process.env.AI_PROJECT_OS_SECURE_COOKIES;process.env.AI_PROJECT_OS_SECURE_COOKIES="true";
 try{assert.match(captchaBrowserCookie(token),/HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/u);}finally{if(before===undefined)delete process.env.AI_PROJECT_OS_SECURE_COOKIES;else process.env.AI_PROJECT_OS_SECURE_COOKIES=before;}
});
test("proof schema rejects missing, oversized or unknown fields before DB access",async()=>{
 assert.ok(graphicCaptchaProofSchema.safeParse({challengeId:randomUUID(),answer:"abcd23"}).success);
 for(const captcha of [undefined,{}, {challengeId:randomUUID(),answer:"AAAAAAA"},{challengeId:randomUUID(),answer:"ABCD23",passed:true}]){
  assert.equal(graphicCaptchaProofSchema.safeParse(captcha).success,false);
  await assert.rejects(consumeGraphicCaptcha({phone:"13800000000",purpose:"login",browserToken:newCaptchaBrowserToken(),captcha},{} as never),{code:"GRAPHIC_CAPTCHA_INVALID"});
 }
});
test("CAPTCHA API rejects foreign origin with no-store response before DB/provider work",async()=>{
 const response=await POST(new Request("https://example.com/api/auth/sms/captcha",{method:"POST",headers:{origin:"https://attacker.invalid","content-type":"application/json"},body:JSON.stringify({phone:"13800000000",purpose:"login"})}));
 assert.equal(response.status,403);assert.equal(response.headers.get("cache-control"),"no-store");
});
