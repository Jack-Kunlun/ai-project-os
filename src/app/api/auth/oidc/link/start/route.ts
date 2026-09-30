import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSessionContext } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { beginOidcIdentityLink, oidcIdentityLinkStateCookie } from "@/lib/oidc";

export const dynamic = "force-dynamic";

const inputSchema = z.object({ providerId: z.string().uuid() }).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireApiSessionContext(request);
    const input = inputSchema.parse(await readJsonBody(request));
    const requestUrl = new URL(request.url);
    const result = await beginOidcIdentityLink({
      providerId: input.providerId,
      redirectUri: `${requestUrl.origin}/api/auth/oidc/link/callback`,
      session,
    });
    const response = NextResponse.json({ authorizationUrl: result.authorizationUrl }, { headers: { "cache-control": "no-store" } });
    response.headers.append("set-cookie", oidcIdentityLinkStateCookie(result.state, result.expiresAt));
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
