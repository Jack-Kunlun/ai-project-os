export const PROJECT_MCP_ACTION_API_UNAVAILABLE = "PROJECT_MCP_ACTION_API_UNAVAILABLE";

export function isProjectMcpActionApiEnabled(): boolean {
  return process.env.AI_PROJECT_OS_MCP_ACTIONS_ENABLED === "true";
}

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
