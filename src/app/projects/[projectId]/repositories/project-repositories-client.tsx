"use client";

import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";

export function ProjectRepositoriesClient({ username, projectId }: { username: string; projectId: string }) {
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="repositories" />
      <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
        <div className="mb-5"><ProjectMaterialsParentLink projectId={projectId} /></div>
        <section className="grid gap-7 rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 sm:px-9 sm:py-10 lg:grid-cols-[1.2fr_.8fr] lg:px-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Repository access</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">项目代码仓库</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">
              项目 Git 委托与仓库同步当前未开放。个人 Git 连接可以在个人中心管理，但当前连接还不能用于项目或自动化。
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/profile/connections/git" className="flex min-h-11 items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-indigo-50">
                管理个人 Git 连接
              </Link>
              <Link href={`/projects/${projectId}/materials`} className="flex min-h-11 items-center justify-center rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10">
                查看项目资料
              </Link>
            </div>
          </div>
          <div role="status" className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm leading-6 text-slate-300">
            <p className="font-semibold text-white">当前状态</p>
            <p className="mt-2">项目仓库能力未开放</p>
            <p className="mt-3 text-xs text-slate-400">此页面不会读取项目仓库列表，也不会发起同步、停用或其他远端操作。</p>
          </div>
        </section>

        <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Project materials</p>
          <h2 className="mt-2 text-2xl font-semibold">已导入资料仍可查看</h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
            历史已导入的项目资料仍可在项目资料中查看和整理。项目仓库列表、首次关联和同步能力将在项目委托开放后再接入。
          </p>
          <Link href={`/projects/${projectId}/materials`} className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">
            打开项目资料
          </Link>
        </section>
      </div>
    </main>
  );
}
