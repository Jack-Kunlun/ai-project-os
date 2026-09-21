import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { PersonalWorkspaceNav } from "@/components/personal-workspace-nav";
import { requirePageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Show the account-owned resource library without creating a personal default
 * routing API. Projects still decide which available source is effective.
 */
export default async function PersonalConfigurationPage(): Promise<React.JSX.Element> {
  const user = await requirePageSession();

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={user.username} active="personalKnowledge" isSystemAdmin={user.role === "admin"} />
      <PersonalWorkspaceNav active="configuration" />
      <div className="mx-auto max-w-6xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
        <section className="rounded-[2rem] bg-slate-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-11">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Personal configuration</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">个人工作区配置</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">这里管理你拥有的模型、Git 和 MCP 连接。项目配置会展示该项目当前的资源来源，并按项目自己的委托与选择使用；保存个人资源不会自动成为任何项目的默认配置。</p>
        </section>

        <section className="mt-7 grid gap-5 md:grid-cols-3">
          <ResourceCard href="/personal/models" eyebrow="AI resources" title="我的模型" description="维护个人模型连接、会员能力和连接状态。" />
          <ResourceCard href="/personal/connections/git" eyebrow="Repository access" title="我的 Git 连接" description="维护个人 Git 凭据；项目使用前仍需完成项目内委托确认。" />
          <ResourceCard href="/personal/connections/mcp" eyebrow="Tool access" title="我的 MCP 连接" description="维护个人 MCP 连接与安全状态；项目授权仍在项目侧处理。" />
        </section>

        <section className="mt-7 rounded-3xl border border-indigo-100 bg-indigo-50/60 p-6 text-sm leading-7 text-indigo-950 shadow-sm sm:p-7">
          <h2 className="text-lg font-semibold">个人资源与项目使用</h2>
          <p className="mt-2">个人工作区负责资源所有权和维护，项目配置负责读取当前有效来源并完成项目范围内的委托或选择。两者职责不同，项目状态变化不会删除你的个人连接。</p>
          <Link href="/projects" className="mt-4 inline-flex font-semibold text-indigo-700 underline decoration-indigo-200 underline-offset-4">查看项目并进入项目配置 →</Link>
        </section>
      </div>
    </main>
  );
}

/** Describe one resource owner surface without duplicating its form or state logic. */
function ResourceCard({ href, eyebrow, title, description }: Readonly<{ href: string; eyebrow: string; title: string; description: string }>): React.JSX.Element {
  return (
    <Link href={href} className="group rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{eyebrow}</p>
      <h2 className="mt-3 text-xl font-semibold text-slate-900">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
      <span className="mt-5 inline-flex text-sm font-semibold text-indigo-700 group-hover:underline">进入管理 →</span>
    </Link>
  );
}
