import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { beginGitHubOAuth, githubOAuthStateCookie } from "@/lib/github-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const intent = requestUrl.searchParams.get("intent") === "link" ? "link" : "login";
    const user = intent === "link" ? await requireApiSession(request) : null;
    const result = await beginGitHubOAuth({
      returnTo: intent === "link" ? "/profile" : requestUrl.searchParams.get("returnTo") ?? undefined,
      intent,
      linkUserId: user?.id,
      remember: requestUrl.searchParams.get("remember") !== "false",
    });
    const response = NextResponse.redirect(result.authorizationUrl, 302);
    response.headers.append("set-cookie", githubOAuthStateCookie(result.state, result.expiresAt));
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
