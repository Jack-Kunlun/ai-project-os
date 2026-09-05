"use client";

import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { ProjectManagementParentLink } from "@/components/project-parent-link";

type ProjectToolsClientProps = { username: string; projectId: string };

export function ProjectToolsClient({ username, projectId }: ProjectToolsClientProps) {
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="tools" />
      <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
        <div className="mb-5"><ProjectManagementParentLink projectId={projectId} /></div>
        <section className="grid gap-7 rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 sm:px-9 sm:py-10 lg:grid-cols-[1.2fr_.8fr] lg:px-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Project capability grants</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">项目工具权限</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">
              项目级 MCP 授权与动作调用当前未开放。个人 MCP 连接可以在个人中心管理，但当前连接还不能用于项目或自动化。
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/profile/connections/mcp" className="flex min-h-11 items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-violet-50">
                管理个人 MCP 连接
              </Link>
              <Link href={`/projects/${projectId}/governance`} className="flex min-h-11 items-center justify-center rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10">
                查看项目治理
              </Link>
            </div>
          </div>
          <div role="status" className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm leading-6 text-slate-300">
            <p className="font-semibold text-white">当前状态</p>
            <p className="mt-2">项目 MCP 能力未开放</p>
            <p className="mt-3 text-xs text-slate-400">此页面不会发现工具、授权项目或创建远端调用动作。</p>
          </div>
        </section>

        <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Capability status</p>
          <h2 className="mt-2 text-2xl font-semibold">项目 MCP 尚未开放</h2>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <StatusCard label="个人连接" value="可在个人中心配置" />
            <StatusCard label="项目授权" value="尚未开放" />
            <StatusCard label="动作调用" value="尚未开放" />
          </div>
          <p className="mt-6 text-sm leading-7 text-slate-600">
            项目授权和远端动作能力将在后续完成安全审核与项目委托设计后开放；当前不会因为管理员配置或个人连接存在而暗示项目已可使用。
          </p>
        </section>
      </div>
    </main>
  );
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
