import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-response";
import { beginOidcLogin, oidcStateCookie } from "@/lib/oidc";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ providerId: string }> }) {
  try {
    const requestUrl = new URL(request.url);
    const result = await beginOidcLogin({ providerId: idSchema.parse((await context.params).providerId), redirectUri: `${requestUrl.origin}/api/auth/oidc/callback`, returnTo: requestUrl.searchParams.get("returnTo") ?? undefined });
    const response = NextResponse.redirect(result.authorizationUrl, 302);
    response.headers.append("set-cookie", oidcStateCookie(result.state, result.expiresAt));
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) { return handleApiError(error); }
}
