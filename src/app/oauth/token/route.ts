import {
  exchangeMcpExportOAuthAuthorizationCode,
  McpExportOAuthError,
  parseMcpExportOAuthTokenRequest,
} from "@/lib/mcp-export-oauth";
import { isMcpExportOAuthEnabled, isMcpExportRequestHostAllowed } from "@/lib/mcp-export-oauth-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readSmallBody(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("body_too_large");
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function tokenError(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });
}

export async function POST(request: Request) {
  if (!isMcpExportOAuthEnabled()) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  if (!isMcpExportRequestHostAllowed(request)) return tokenError(403, "invalid_request");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return tokenError(415, "invalid_request");
  try {
    const form = new URLSearchParams(await readSmallBody(request, 8 * 1024));
    const tokenRequest = parseMcpExportOAuthTokenRequest(form);
    const token = await exchangeMcpExportOAuthAuthorizationCode(tokenRequest);
    return Response.json({
      access_token: token.accessToken,
      token_type: token.tokenType,
      expires_in: token.expiresIn,
      scope: token.scope,
    }, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  } catch (error) {
    if (error instanceof McpExportOAuthError) {
      if (error.code === "MCP_EXPORT_OAUTH_UNAUTHORIZED") return tokenError(503, "temporarily_unavailable");
      if (error.code === "MCP_EXPORT_OAUTH_INVALID_CLIENT") return tokenError(400, "invalid_client");
      return tokenError(400, "invalid_grant");
    }
    if (error instanceof Error && error.message === "body_too_large") return tokenError(413, "invalid_request");
    return tokenError(503, "temporarily_unavailable");
  }
}
