import Link from "next/link";

export type AdminSection = "overview" | "models" | "git" | "mcp" | "memberships" | "operations" | "guide";

const items: Array<{ key: AdminSection; label: string; href: string; description: string }> = [
  { key: "overview", label: "总览", href: "/admin", description: "服务与安全计数" },
  { key: "models", label: "平台模型", href: "/admin/models", description: "当前模型能力" },
  { key: "git", label: "Git 连接", href: "/admin/connectors/git", description: "代码来源" },
  { key: "mcp", label: "MCP 连接", href: "/admin/connectors/mcp", description: "只读工具" },
  { key: "memberships", label: "用户与会员", href: "/admin/users/memberships", description: "会员资格" },
  { key: "operations", label: "备份 / 运维", href: "/admin/operations/backups", description: "只读状态" },
  { key: "guide", label: "管理员指南", href: "/admin/guide", description: "操作边界" },
];

export function AdminShell({ active }: { active: AdminSection }) {
  return (
    <section className="mx-auto max-w-7xl px-5 pt-5 sm:px-8 lg:px-10">
      <div className="rounded-3xl border border-indigo-100 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-3 pb-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-600">Admin workspace</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">管理工作台</h2>
          </div>
          <Link href="/dashboard" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-indigo-200 hover:text-indigo-700">返回用户工作台</Link>
        </div>
        <nav aria-label="管理工作台导航" className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {items.map((item) => (
            <Link key={item.key} href={item.href} aria-current={item.key === active ? "page" : undefined} className={`rounded-2xl px-3 py-3 transition ${item.key === active ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"}`}>
              <span className="block text-xs font-semibold">{item.label}</span>
              <span className={`mt-1 block text-[10px] ${item.key === active ? "text-slate-300" : "text-slate-400"}`}>{item.description}</span>
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}
