import { AdminShell } from "@/components/admin-shell";
import { AppHeader } from "@/components/app-header";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminGuidePage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AppHeader username={user.username} active="admin" isSystemAdmin /><AdminShell active="guide" /><div className="mx-auto max-w-6xl px-5 pb-16 pt-8 sm:px-8 lg:px-10"><section className="rounded-[2rem] bg-slate-950 px-7 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-10"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">Administrator guide</p><h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">管理员操作指南</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">管理工作台仅供系统管理员使用。平台配置、外部连接、会员资格和备份运维均有独立权限边界，不能由工作区 Owner/Admin 代替。</p></section><div className="mt-8 grid gap-5 md:grid-cols-2"><GuideCard title="平台模型" text="在平台模型页配置并验证当前支持的 provider kind 与自定义模型 ID。管理员配置并验证后，可作为平台默认路由建议/供项目选择；普通用户免费模型策略和自定义免费模型供给仍是 planned / 后续能力。API Key 只进入服务端加密存储。" /><GuideCard title="Git / MCP 连接" text="Git 连接只读验证仓库来源；MCP 连接只允许远程 Streamable HTTP 与经过认证的非破坏性工具。项目首次 Git 仓库接入由系统管理员完成，项目 Owner 仍需在项目内逐项授权并审批 MCP 调用。" /><GuideCard title="用户与会员" text="会员页面只负责发放、延期和撤销会员资格，不改变 AppUser 角色或工作区成员角色。工作区管理员不能通过成员操作全局停用账户。" /><GuideCard title="备份与服务状态" text="备份状态仅初始超级管理员可读。总览中的应用、数据库和 Worker 状态来自当前真实检查；不把页面描述成主机资源或 Docker 监控。" /><GuideCard title="工作区边界" text="系统 admin 是平台范围；workspace Owner/Admin 仅管理所属工作区成员、邀请和项目权限。不要把工作区管理权限当作平台管理员权限。" /><GuideCard title="凭据安全" text="不在日志、文档、项目资料或 URL 中记录 API Key、Token、私钥或数据库连接信息。平台表单不会返回明文凭据，页面只显示受限状态。" /></div></div></main>;
}

function GuideCard({ title, text }: { title: string; text: string }) {
  return <article className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold text-slate-900">{title}</h2><p className="mt-3 text-sm leading-7 text-slate-600">{text}</p></article>;
}
