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
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AdminHeader username={username} />
      <AdminPageFrame active={active}>
        <section className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
          <AdminPageHeader title={title} description={description} />
          <div className="mt-7 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900" role="status">
            管理员连接配置已冻结。本页不会读取、展示或提交任何凭据，也不提供用户凭据池。个人 MCP 连接由用户在个人中心配置；管理员只查看必要的安全状态，不代替用户持有或管理私人凭据。
          </div>
        </section>
      </AdminPageFrame>
    </main>
  );
}
