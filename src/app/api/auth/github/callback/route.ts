import { NextResponse } from "next/server";
import { readSessionToken, SESSION_COOKIE_NAME, sessionCookie } from "@/lib/auth";
import {
  completeGitHubOAuth,
  expiredGitHubOAuthStateCookie,
  GITHUB_OAUTH_STATE_COOKIE_NAME,
  GitHubOAuthError,
  githubOAuthFailurePath,
  githubOAuthProviderRejected,
  githubOAuthPublicUrl,
} from "@/lib/github-oauth";
import { canonicalInternalReturnPath } from "@/lib/redirects";

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
  const state = url.searchParams.get("state");
  try {
    if (url.searchParams.has("error")) githubOAuthProviderRejected();
    const requestCookies = request.headers.get("cookie");
    const sessionUser = await readSessionToken(cookieValue(requestCookies, SESSION_COOKIE_NAME));
    const result = await completeGitHubOAuth({
      code: url.searchParams.get("code"),
      state,
      cookieState: cookieValue(requestCookies, GITHUB_OAUTH_STATE_COOKIE_NAME),
      sessionUserId: sessionUser?.id,
    });
    const response = NextResponse.redirect(githubOAuthPublicUrl(canonicalInternalReturnPath(result.returnTo)), 303);
    if (result.session !== null) {
      response.headers.append("set-cookie", sessionCookie(result.session.token, result.session.expiresAt, result.remember));
    }
    response.headers.append("set-cookie", expiredGitHubOAuthStateCookie());
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch (error) {
    const failurePath = await githubOAuthFailurePath(state).catch(() => "/login");
    const failureUrl = githubOAuthPublicUrl(failurePath);
    failureUrl.searchParams.set("github", error instanceof GitHubOAuthError ? error.code : "failed");
    const response = NextResponse.redirect(failureUrl, 303);
    response.headers.append("set-cookie", expiredGitHubOAuthStateCookie());
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
}
