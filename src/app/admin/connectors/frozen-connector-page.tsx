import { AppHeader } from "@/components/app-header";
import { AdminShell, type AdminSection } from "@/components/admin-shell";

export function FrozenConnectorPage({
  username,
  active,
  title,
  description,
}: Readonly<{
  username: string;
  active: Extract<AdminSection, "git" | "mcp">;
  title: string;
  description: string;
}>) {
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="connections" isSystemAdmin />
      <AdminShell active={active} />
      <div className="mx-auto max-w-5xl px-6 py-12 sm:px-10 lg:px-12">
        <section className="rounded-[2rem] border border-amber-200 bg-white p-8 shadow-sm sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Migration boundary</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">{title}</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">{description}</p>
          <div className="mt-7 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900" role="status">
            旧版管理员连接配置已冻结。本页不会读取、展示或提交任何凭据；请等待个人连接配置和项目授权页面上线后再继续操作。
          </div>
        </section>
      </div>
    </main>
  );
}
