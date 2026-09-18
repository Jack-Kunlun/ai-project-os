import { AdminPageFrame } from "@/components/admin-shell";
import { AdminHeader } from "@/components/admin-header";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminGuidePage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AdminHeader username={user.username} /><AdminPageFrame active="guide"><div className="mx-auto max-w-6xl px-5 pb-16 pt-8 sm:px-8 lg:px-10"><section className="rounded-[2rem] bg-slate-950 px-7 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-10"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">Administrator guide</p><h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">管理员操作指南</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">管理工作台仅供平台管理员使用。平台配置、用户运营、安全审查和备份运维均有独立边界，不能由工作区 Owner/Admin 代替；这里也不展示项目、团队或个人连接。</p></section><div className="mt-8 grid gap-5 md:grid-cols-2"><GuideCard title="平台模型" text="/admin/models 只配置和验证平台供应商与模型连接；API Key 只进入服务端加密存储。" /><GuideCard title="默认路由" text="/admin/models/routes 独立维护平台默认能力的模型、维度、倍率和生命周期。" /><GuideCard title="平台额度" text="/admin/credits 处理新注册赠送策略、额度记录和人工额度治理；每次变更都保留确认与审计边界。" /><GuideCard title="探测预算" text="/admin/operations/probes 配置连接测试预算、告警阈值和有效期，未知外发不会自动重试。" /><GuideCard title="MCP 安全" text="个人 MCP 连接归创建它的用户所有。管理员只审核精确工具的安全边界，不读取个人凭据。" /><GuideCard title="用户运营" text="/admin/users 统一查看账号、会员和用户额度摘要；账号停用、恢复及相关记录在用户详情页处理。" /><GuideCard title="备份与服务状态" text="备份状态仅初始超级管理员可读。总览展示当前可验证的应用、数据库和 Worker 状态。" /><GuideCard title="角色边界" text="平台管理员只负责平台运营，不进入项目、团队和用户工作区；工作区 Owner/Admin 也不具备平台管理权限。" /><GuideCard title="凭据安全" text="不在日志、文档、项目资料或 URL 中记录 API Key、Token、私钥或数据库连接信息。" /></div></div></AdminPageFrame></main>;
}

function GuideCard({ title, text }: { title: string; text: string }) {
  return <article className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold text-slate-900">{title}</h2><p className="mt-3 text-sm leading-7 text-slate-600">{text}</p></article>;
}
