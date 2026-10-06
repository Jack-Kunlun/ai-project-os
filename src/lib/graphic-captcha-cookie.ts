import { randomBytes } from "node:crypto";
export const GRAPHIC_CAPTCHA_COOKIE = "ap_os_graphic_captcha";
export function validCaptchaBrowserToken(value: unknown): value is string { return typeof value==="string" && /^[A-Za-z0-9_-]{43}$/u.test(value); }
export function readCaptchaBrowserToken(request: Request): string | undefined {
 const values=(request.headers.get("cookie")??"").split(";").map(part=>part.trim()).filter(part=>part.startsWith(`${GRAPHIC_CAPTCHA_COOKIE}=`));
 if(values.length!==1)return undefined;
 const value=values[0].slice(GRAPHIC_CAPTCHA_COOKIE.length+1);return validCaptchaBrowserToken(value)?value:undefined;
}
export function newCaptchaBrowserToken():string{return randomBytes(32).toString("base64url");}
export function captchaBrowserCookie(token:string):string {
 if(!validCaptchaBrowserToken(token))throw new Error("CAPTCHA_COOKIE_INVALID");
 return `${GRAPHIC_CAPTCHA_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${process.env.AI_PROJECT_OS_SECURE_COOKIES==="true"?"; Secure":""}`;
}
