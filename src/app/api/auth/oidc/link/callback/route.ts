import { NextResponse } from "next/server";
import { readApiSessionContextReadOnly } from "@/lib/auth";
import {
  completeOidcIdentityLink,
  expiredOidcIdentityLinkStateCookie,
  OIDC_LINK_STATE_COOKIE_NAME,
  OidcError,
} from "@/lib/oidc";

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
  const url = new URL(request.url);
  try {
    if (url.searchParams.has("error")) throw new OidcError("OIDC_FLOW_INVALID");
    const session = await readApiSessionContextReadOnly(request);
    await completeOidcIdentityLink({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      cookieState: cookieValue(request.headers.get("cookie"), OIDC_LINK_STATE_COOKIE_NAME),
      session,
    });
    const response = NextResponse.redirect(new URL("/profile?oidc=linked", url.origin), 303);
    response.headers.append("set-cookie", expiredOidcIdentityLinkStateCookie());
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch {
    const response = NextResponse.redirect(new URL("/profile?oidc=failed", url.origin), 303);
    response.headers.append("set-cookie", expiredOidcIdentityLinkStateCookie());
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
}
