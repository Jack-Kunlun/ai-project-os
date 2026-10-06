import { createHash, createHmac } from "node:crypto";
/** Pure ACS3 signing; transport endpoints are fixed by the provider adapter. */
export function signAliyunAcs3(input: { method: string; query: string; headers: Readonly<Record<string,string>>; payloadHash: string; accessKeyId: string; accessKeySecret: string }): string {
  const entries=Object.entries(input.headers).map(([name,value])=>[name.toLowerCase(),value.trim()] as const).filter(([name])=>name==="host"||name==="content-type"||name.startsWith("x-acs-")).sort(([a],[b])=>a<b?-1:a>b?1:0);
  const signedHeaders=entries.map(([name])=>name).join(";");
  const canonicalHeaders=entries.map(([name,value])=>`${name}:${value}\n`).join("");
  const request=[input.method,"/",input.query,canonicalHeaders,signedHeaders,input.payloadHash].join("\n");
  const stringToSign=`ACS3-HMAC-SHA256\n${createHash("sha256").update(request,"utf8").digest("hex")}`;
  const signature=createHmac("sha256",input.accessKeySecret).update(stringToSign,"utf8").digest("hex");
  return `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
}
