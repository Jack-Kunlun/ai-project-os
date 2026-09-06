import { projectMcpActionApiUnavailable } from "@/lib/project-mcp-action-api-gate";

export const dynamic = "force-dynamic";

export function POST() {
  return projectMcpActionApiUnavailable();
}
