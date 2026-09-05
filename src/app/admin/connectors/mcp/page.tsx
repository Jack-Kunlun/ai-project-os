import { FrozenConnectorPage } from "@/app/admin/connectors/frozen-connector-page";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminMcpConnectionsPage() {
  const user = await requireSystemAdminPage();
  return <FrozenConnectorPage active="mcp" username={user.username} title="MCP 连接配置已冻结" description="MCP 凭据属于连接所有者。管理员只负责后续安全证据审查与工具认证，不直接提交、轮换或读取用户的 Bearer Token。" />;
}
