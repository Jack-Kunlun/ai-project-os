import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { McpExportGrantError, dispatchMcpExportProject, isMcpExportEnabled, readMcpExportProject, type McpExportOperation } from "@/lib/mcp-export-grants";
import { getMcpExportOAuthConfiguration, getMcpExportPublicOrigin, isMcpExportRequestHostAllowed } from "@/lib/mcp-export-oauth-config";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "ai-project-os", version: APP_VERSION });
  const noArguments = fromJsonSchema({ type: "object", properties: {}, additionalProperties: false });
  const registerReadTool = (operation: McpExportOperation, description: string) => {
    server.registerTool(operation, {
      description,
      inputSchema: noArguments,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (_args, context) => {
      const authorization = context.http?.req?.headers.get("authorization") ?? null;
      try {
        const { content } = await dispatchMcpExportProject(authorization, operation);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(content) }],
          structuredContent: content,
        };
      } catch (error) {
        if (!(error instanceof McpExportGrantError)) console.error("MCP export tool failed");
        return { content: [{ type: "text" as const, text: "MCP export unavailable or approval required" }], isError: true };
      }
    });
  };
  registerReadTool("project_summary", "Read the approved project name, description, archive state and update time.");
  registerReadTool("project_evidence", "Read up to ten recently updated confirmed project facts with source provenance, after Owner approval.");
  registerReadTool("project_plan", "Read up to ten recent objectives and work items, after Owner approval.");
  return server;
}, { maxSubscriptions: 0 });

async function serve(request: Request): Promise<Response> {
  if (!isMcpExportEnabled()) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const publicOrigin = getMcpExportPublicOrigin();
  if (publicOrigin === null) {
    console.error("MCP export public origin is not configured");
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!isMcpExportRequestHostAllowed(request)) {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      if (origin !== new URL(origin).origin || new URL(origin).origin !== publicOrigin) throw new Error("origin mismatch");
    } catch {
      return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
    }
  }
  try {
    // Authenticate before protocol discovery and repeat inside each tool call
    // so a revoked or downgraded grant cannot finish an in-flight read.
    await readMcpExportProject(request.headers.get("authorization"));
  } catch (error) {
    if (!(error instanceof McpExportGrantError)) {
      console.error("MCP request failed");
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    }
    const oauthConfiguration = getMcpExportOAuthConfiguration();
    return new Response(null, {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": oauthConfiguration === null
          ? 'Bearer realm="ai-project-os-mcp"'
          : `Bearer resource_metadata="${oauthConfiguration.protectedResourceMetadata}", scope="project:read"`,
      },
    });
  }
  const response = await handler.fetch(request);
  response.headers.set("cache-control", "no-store");
  return response;
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
