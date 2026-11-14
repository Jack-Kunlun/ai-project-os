import { AdminHeader } from "@/components/admin-header";
import { AdminPageFrame, type AdminSection } from "@/components/admin-shell";
import { AdminPageHeader } from "@/components/admin-page-header";

export function FrozenConnectorPage({
  username,
  active,
  title,
  description,
}: Readonly<{
  username: string;
  active: Extract<AdminSection, "mcp">;
  title: string;
  description: string;
}>) {
  return (
    <main className="min-h-screen bg-app-surface text-app-text">
      <AdminHeader username={username} />
      <AdminPageFrame active={active}>
        <section className="rounded-panel border app-panel-warning bg-app-surface p-6 app-panel">
          <AdminPageHeader title={title} description={description} />
          <div className="mt-7 rounded-field border border-app-warning-border bg-app-warning-soft px-5 py-4 text-sm leading-6 text-app-warning-ink app-feedback-warning" role="status">
            管理员连接配置已冻结。本页不会读取、展示或提交任何凭据，也不提供用户凭据池。个人 MCP 连接由用户在个人中心配置；管理员只查看必要的安全状态，不代替用户持有或管理私人凭据。
          </div>
        </section>
      </AdminPageFrame>
    </main>
  );
}
