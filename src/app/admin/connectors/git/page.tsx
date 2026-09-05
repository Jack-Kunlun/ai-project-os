import { FrozenConnectorPage } from "@/app/admin/connectors/frozen-connector-page";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminGitConnectionsPage() {
  const user = await requireSystemAdminPage();
  return <FrozenConnectorPage active="git" username={user.username} title="Git 连接配置已冻结" description="Git 凭据已迁移到用户私有连接边界。管理员不再代用户录入或管理个人 Git Token、密码、私钥、CA 或 known_hosts。" />;
}
