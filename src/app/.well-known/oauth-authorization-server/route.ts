import { getMcpExportOAuthConfiguration, isMcpExportOAuthEnabled, isMcpExportRequestHostAllowed } from "@/lib/mcp-export-oauth-config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const configuration = getMcpExportOAuthConfiguration();
  if (!isMcpExportOAuthEnabled() || configuration === null) {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (!isMcpExportRequestHostAllowed(request)) {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
  return Response.json({
    issuer: configuration.issuer,
    authorization_endpoint: configuration.authorizationEndpoint,
    token_endpoint: configuration.tokenEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["project:read"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }, { headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } });
}
