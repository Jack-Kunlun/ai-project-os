import { NextResponse } from "next/server";
import { expiredOidcStateCookie, OIDC_STATE_COOKIE_NAME, completeOidcLogin } from "@/lib/oidc";
import { sessionCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.has("error")) throw new Error("OIDC_PROVIDER_REJECTED");
    const result = await completeOidcLogin({ code: url.searchParams.get("code"), state: url.searchParams.get("state"), cookieState: cookieValue(request.headers.get("cookie"), OIDC_STATE_COOKIE_NAME) });
    const response = NextResponse.redirect(new URL(result.returnTo, url.origin), 303);
    response.headers.append("set-cookie", sessionCookie(result.session.token, result.session.expiresAt));
    response.headers.append("set-cookie", expiredOidcStateCookie());
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    const url = new URL(request.url);
    const response = NextResponse.redirect(new URL("/login?oidc=failed", url.origin), 303);
    response.headers.append("set-cookie", expiredOidcStateCookie());
    return response;
  }
}
