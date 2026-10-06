import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "@/app/api/profile/close/route";
test("account closure rejects missing or foreign origins before touching authentication or storage",async()=>{
 const previous=process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;process.env.AI_PROJECT_OS_PUBLIC_ORIGIN="https://closure.example.com";
 try{for(const origin of [undefined,"https://evil.example.com","http://closure.example.com"]){const headers:Record<string,string>={"content-type":"application/json"};if(origin)headers.origin=origin;const r=await POST(new Request("https://closure.example.com/api/profile/close",{method:"POST",headers,body:"{}"}));assert.equal(r.status,403);assert.equal(r.headers.get("cache-control"),"no-store");}}finally{if(previous===undefined)delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN=previous;}
});
