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
    resource: configuration.resource,
    authorization_servers: [configuration.issuer],
    scopes_supported: ["project:read"],
    bearer_methods_supported: ["header"],
  }, { headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } });
}
