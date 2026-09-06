export const PROJECT_MCP_ACTION_API_UNAVAILABLE = "PROJECT_MCP_ACTION_API_UNAVAILABLE";

export function projectMcpActionApiUnavailable(): Response {
  return Response.json(
    {
      error: {
        code: PROJECT_MCP_ACTION_API_UNAVAILABLE,
        message: "项目 MCP 调用尚未开放",
      },
    },
    {
      status: 404,
      headers: { "cache-control": "no-store" },
    },
  );
}
