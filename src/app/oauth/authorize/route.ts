import {
  createMcpExportOAuthAuthorizationRequest,
  fetchMcpExportOAuthClientMetadata,
  McpExportOAuthError,
  parseMcpExportOAuthAuthorizationParameters,
} from "@/lib/mcp-export-oauth";
import {
  getMcpExportOAuthCsrfCookieName,
  getMcpExportPublicOrigin,
  hasMcpExportOAuthCsrfCookieCapacity,
  isMcpExportOAuthEnabled,
  isMcpExportRequestHostAllowed,
} from "@/lib/mcp-export-oauth-config";

export const dynamic = "force-dynamic";

function oauthError(status: number, error: string, retryAfterSeconds?: number) {
  return Response.json({ error }, { status, headers: {
    "cache-control": "no-store", "pragma": "no-cache", "referrer-policy": "no-referrer",
    ...(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }),
  } });
}

export async function GET(request: Request) {
  if (!isMcpExportOAuthEnabled()) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const origin = getMcpExportPublicOrigin();
  if (origin === null) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  if (!isMcpExportRequestHostAllowed(request)) return oauthError(403, "invalid_request");
  if (!hasMcpExportOAuthCsrfCookieCapacity(request.headers.get("cookie"))) return oauthError(429, "temporarily_unavailable", 60);
  try {
    const parameters = parseMcpExportOAuthAuthorizationParameters(new URL(request.url).searchParams);
    const metadata = await fetchMcpExportOAuthClientMetadata(parameters.clientId);
    const authorization = await createMcpExportOAuthAuthorizationRequest(parameters, metadata);
    const consentUrl = new URL("/mcp/authorize", origin);
    consentUrl.searchParams.set("requestId", authorization.requestId);
    const cookieName = getMcpExportOAuthCsrfCookieName(authorization.requestId);
    return new Response(null, { status: 303, headers: {
      location: consentUrl.toString(),
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "set-cookie": `${cookieName}=${authorization.csrfToken}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    } });
  } catch (error) {
    if (error instanceof McpExportOAuthError) {
      if (error.code === "MCP_EXPORT_OAUTH_INVALID_CLIENT") return oauthError(400, "invalid_client");
      if (error.code === "MCP_EXPORT_OAUTH_INVALID_REQUEST") return oauthError(400, "invalid_request");
      if (error.code === "MCP_EXPORT_OAUTH_RATE_LIMITED") return oauthError(429, "temporarily_unavailable", 60);
      return oauthError(503, "temporarily_unavailable");
    }
    return oauthError(503, "temporarily_unavailable");
  }
}
