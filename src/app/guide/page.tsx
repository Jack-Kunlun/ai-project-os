import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "使用指南 · AI Project OS V2.2",
  description: "AI Project OS V2.2 从 Dashboard、首次配置到项目智能体的页面操作指南。",
};

const workflow = [
  { number: "01", title: "配置模型", detail: "添加并测试生成与向量供应商。", href: "#providers" },
  { number: "02", title: "准备项目", detail: "录入资料，或连接并扫描 GitHub 仓库。", href: "#project-data" },
  { number: "03", title: "建立记忆", detail: "审核 AI 候选，构建兼容的语义索引。", href: "#memory" },
  { number: "04", title: "运行智能体", detail: "生成状态简报，或开展一次只读调查。", href: "#agent" },
] as const;

const providerRows = [
  ["OpenAI", "生成 + 向量", "可由一个连接承担全部 AI 能力"],
  ["DeepSeek", "仅生成", "需要再配置 OpenAI、Qwen 或 GLM 作为向量供应商"],
  ["Qwen（阿里云百炼）", "生成 + 向量", "适合国内 API 接入的一体化配置"],
  ["GLM（智谱开放平台）", "生成 + 向量", "适合国内 API 接入的一体化配置"],
] as const;

export default function GuidePage() {
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-7">
          <Link href="/dashboard" className="flex items-center gap-3" aria-label="AI Project OS Dashboard">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-sm font-bold text-white">OS</span>
            <span>
              <span className="block text-sm font-semibold tracking-[0.16em]">AI PROJECT OS</span>
              <span className="block text-xs text-slate-500">使用指南 · V2.2</span>
            </span>
          </Link>
          <nav className="flex flex-wrap gap-2 text-xs font-semibold">
            <Link href="/dashboard" className="rounded-full border border-slate-200 bg-white px-4 py-2 text-slate-600 hover:border-indigo-200 hover:text-indigo-700">Dashboard</Link>
            <Link href="/profile" className="rounded-full border border-slate-200 bg-white px-4 py-2 text-slate-600 hover:border-indigo-200 hover:text-indigo-700">个人中心</Link>
            <Link href="/settings" className="rounded-full bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500">模型与系统设置</Link>
          </nav>
        </header>

        <section className="grid gap-8 pb-12 pt-14 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-indigo-600">Start to finish</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight tracking-[-0.04em] sm:text-6xl">从第一次配置，到可信的项目回答。</h1>
            <p className="mt-6 max-w-3xl text-base leading-8 text-slate-600">按推荐顺序完成模型连接、项目资料、智能记忆和只读调查。每一步都保留来源、审核状态和证据引用；只有你在页面明确确认后，相关内容才会发送给模型供应商。</p>
          </div>
          <div className="rounded-3xl bg-slate-950 p-6 text-white">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Before you start</p>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-300">
              <li>Docker 服务处于健康状态</li>
              <li>已准备至少一个模型 API Key</li>
              <li>仓库接入时准备只读 GitHub PAT</li>
              <li>不要在项目资料中录入密码或 Token</li>
            </ul>
          </div>
        </section>

        <nav aria-label="推荐使用顺序" className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {workflow.map((step) => (
            <a key={step.number} href={step.href} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200">
              <span className="text-xs font-bold text-indigo-600">{step.number}</span>
              <h2 className="mt-5 text-lg font-semibold">{step.title}</h2>
              <p className="mt-2 text-xs leading-5 text-slate-500">{step.detail}</p>
            </a>
          ))}
        </nav>

        <div className="mt-10 space-y-8">
          <GuideSection id="first-run" eyebrow="First run" title="首次启动与登录">
            <Step number="1" title="初始化本地管理员">首次打开应用会进入初始化页。用户名至少 3 位；密码至少 12 位并同时包含字母和数字。当前版本为本地单管理员模式。</Step>
            <Step number="2" title="理解凭据保存方式">模型 API Key 和 GitHub PAT 由服务端加密保存，页面不会回显明文。数据库之外的本地主密钥同样必须保留；不要删除 Compose 的 secrets 卷。</Step>
            <Step number="3" title="登录后的第一站">登录后会进入 Dashboard。先按“推荐下一步”完成至少一个生成模型和一个向量模型的连接测试，再创建正式项目。</Step>
          </GuideSection>

          <GuideSection id="dashboard" eyebrow="Command center" title="从 Dashboard 开始工作">
            <p className="text-sm leading-7 text-slate-600">Dashboard 不是静态欢迎页，而是每次打开系统后的工作入口。它会把跨项目状态压缩成当前最值得处理的一步，减少在不同页面之间来回查找。</p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <InfoCard title="先看推荐下一步">系统按模型连接、项目、三条 AI 路由和智能记忆索引依次判断缺口，并直接链接到需要处理的页面。</InfoCard>
              <InfoCard title="检查工作空间就绪度">四步进度用于判断基础能力是否真的可用；容器健康但模型或索引缺失时，不会显示为完整就绪。</InfoCard>
              <InfoCard title="继续最近任务">仓库扫描、同步、抽取、索引、问答、简报和智能体运行会显示持久化状态，可直接回到所属项目。</InfoCard>
              <InfoCard title="进入项目管理">项目搜索、创建和工作区入口位于独立“项目”页；Dashboard 只保留跨项目概览和任务状态。</InfoCard>
            </div>
            <div className="mt-5 flex flex-wrap gap-3"><Link href="/dashboard" className="inline-flex rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-500">打开 Dashboard</Link><Link href="/projects" className="inline-flex rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 hover:border-indigo-200 hover:text-indigo-700">打开项目</Link></div>
          </GuideSection>

          <GuideSection id="profile" eyebrow="Personal center" title="管理个人信息与登录安全">
            <Step number="1" title="查看账户状态">点击右上角头像，查看本地管理员角色、账户创建时间、最近活动、活动会话和最近活动会话的到期时间。</Step>
            <Step number="2" title="修改登录名">登录名为 3–64 位，只允许字母、数字、点、下划线和连字符；保存后下次登录使用新登录名。</Step>
            <Step number="3" title="安全轮换密码">在“登录与安全”中展开“修改密码”，再输入当前密码和新密码。新密码至少 12 位并包含字母和数字；成功后全部会话会被撤销，需要重新登录。</Step>
            <Callout tone="slate" title="凭据分开管理">模型 API Key 位于“模型设置”；GitHub PAT 位于具体项目的“智能控制台”。个人中心不会展示或导出这些凭据。</Callout>
          </GuideSection>

          <GuideSection id="providers" eyebrow="AI connections" title="配置模型供应商">
            <p className="text-sm leading-7 text-slate-600">在“模型与系统设置”中点击添加连接，选择供应商，填写连接名称、API Key、生成模型，并在支持时填写向量模型和维度。保存后必须执行连接测试；只有“已验证”的连接才能分配给项目。</p>
            <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-slate-950 text-white"><tr><th className="px-4 py-3 font-semibold">供应商</th><th className="px-4 py-3 font-semibold">可承担能力</th><th className="hidden px-4 py-3 font-semibold sm:table-cell">建议</th></tr></thead>
                <tbody className="divide-y divide-slate-100 bg-white">{providerRows.map(([name, capability, note]) => <tr key={name}><td className="px-4 py-4 font-semibold text-slate-800">{name}</td><td className="px-4 py-4 text-slate-600">{capability}</td><td className="hidden px-4 py-4 text-slate-500 sm:table-cell">{note}</td></tr>)}</tbody>
              </table>
            </div>
            <Callout tone="amber" title="模型与维度必须准确">向量模型 ID 和维度必须与供应商实际配置一致。更换向量供应商、模型或维度后，旧索引会被标记为不兼容，必须重新建立索引。</Callout>
            <div className="mt-5"><Link href="/settings" className="inline-flex rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-500">前往模型与系统设置</Link></div>
          </GuideSection>

          <GuideSection id="project-data" eyebrow="Project setup" title="创建项目并准备可信资料">
            <div className="grid gap-5 lg:grid-cols-2">
              <InfoCard title="手工资料与条目">
                <ol className="space-y-2">
                  <li>1. 在顶部“项目”页面创建项目并进入“资料与条目”。</li>
                  <li>2. 先录入原始资料和可选来源链接。</li>
                  <li>3. 创建条目时选择资料，并引用资料中的精确连续原文。</li>
                  <li>4. 将候选条目确认后，它才会成为项目事实。</li>
                  <li>5. 需要固定人工状态时，手动生成 Project Snapshot。</li>
                </ol>
              </InfoCard>
              <InfoCard title="GitHub 多仓库">
                <ol className="space-y-2">
                  <li>1. 进入项目“智能控制台”，连接一个或多个仓库。</li>
                  <li>2. PAT 只授予所选仓库和所需内容的读取权限。</li>
                  <li>3. 设置跟踪分支、仓库角色和代码扫描根目录。</li>
                  <li>4. 执行代码扫描；按需同步 README、Markdown、Issue、PR 和 Release。</li>
                  <li>5. 检查任务状态，确认扫描或同步已经成功发布。</li>
                </ol>
              </InfoCard>
            </div>
            <Callout tone="slate" title="资料不是事实">新接入的 Source、GitHub 内容和模型抽取结果都只是候选证据。只有经过人工确认的 ProjectItem 才应当被视为项目事实。</Callout>
          </GuideSection>

          <GuideSection id="routes" eyebrow="Project routing" title="为项目分配 AI 能力">
            <p className="text-sm leading-7 text-slate-600">每个项目都要在“智能控制台”分别配置三条路由。路由只能选择已经通过连接测试的供应商。</p>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <InfoCard title="语义向量">建立索引和处理检索问题。必须使用支持 embeddings 的供应商。</InfoCard>
              <InfoCard title="自动抽取">从所选原始资料中抽取 decision、progress、issue 和 risk 候选。</InfoCard>
              <InfoCard title="引用式问答">生成 RAG 回答、项目状态简报和智能体最终回答。</InfoCard>
            </div>
          </GuideSection>

          <GuideSection id="memory" eyebrow="AI memory" title="建立并使用智能记忆">
            <Step number="1" title="自动抽取候选">选择需要处理的资料，勾选本次传输确认，再运行抽取。系统会拒绝结构无效、原文摘录不存在或越界的模型输出。</Step>
            <Step number="2" title="逐条人工审核">检查候选标题、内容和原文引用；接受后进入已确认事实，驳回则保留审核记录但不会进入可信事实。</Step>
            <Step number="3" title="建立统一向量索引">确认当前路由后构建索引。索引覆盖人工资料、已发布仓库资料和代码快照；构建失败不会替换上一代完整索引。</Step>
            <Step number="4" title="检索和引用式问答">语义搜索返回原文片段、路径、冻结 commit 和分数。引用式问答只允许引用本次检索命中的证据。</Step>
            <Callout tone="amber" title="什么时候需要重建索引">新增或更新资料、重新扫描仓库、同步新仓库内容，或更换向量供应商/模型/维度后，都应重新建立索引。</Callout>
          </GuideSection>

          <GuideSection id="agent" eyebrow="Project intelligence" title="生成简报并运行只读智能体">
            <Step number="1" title="先检查就绪状态">页面必须同时显示生成模型路由、向量模型路由和兼容记忆索引已经就绪。缺少任意一项时，运行按钮保持禁用。</Step>
            <Step number="2" title="生成项目当前状态">勾选当次传输确认后生成简报。结果按进展、决策、问题、风险、关注事项和待确认问题组织，并保存证据快照。</Step>
            <Step number="3" title="提出一个可调查的问题">适合询问“当前最大风险是什么”“哪些决策仍缺少证据”“最近完成了什么”。问题越具体，检索计划越有效。</Step>
            <Step number="4" title="核对引用和轨迹">查看回答引用的证据、只读工具执行顺序、建议和不确定性。证据不足时应补资料，而不是把推测直接当作事实。</Step>
            <Callout tone="slate" title="智能体不会做什么">当前智能体没有 Shell、文件系统、代码修改、GitHub 写入、定时自主运行或部署权限。它只执行一次由你发起并确认的只读调查。</Callout>
          </GuideSection>

          <GuideSection id="routine" eyebrow="Operating rhythm" title="推荐的日常更新顺序">
            <div className="rounded-2xl bg-slate-950 p-6 text-sm leading-7 text-slate-200">
              新资料或代码变化 → 扫描/同步仓库 → 自动抽取 → 人工审核 → 重建语义索引 → 生成新简报或提问 → 核对引用与不确定性
            </div>
            <p className="mt-5 text-sm leading-7 text-slate-600">如果只更新了人工确认条目但没有重建索引，项目概览和已确认条目工具仍能读取最新状态，但语义记忆仍基于上一代索引。为了让检索和智能体结果一致，建议完成整条更新链路。</p>
          </GuideSection>

          <GuideSection id="troubleshooting" eyebrow="Troubleshooting" title="常见问题">
            <div className="grid gap-4 md:grid-cols-2">
              <InfoCard title="供应商不能选择">先到设置页执行连接测试。只有状态为“已验证”且能力匹配的供应商会出现在项目路由中。</InfoCard>
              <InfoCard title="索引需要重建">当前向量供应商、模型或维度与活动索引不一致。使用当前路由重新建立索引。</InfoCard>
              <InfoCard title="模型输出被拒绝">输出结构、证据摘录或引用 ID 未通过校验。原结果不会保存为可信内容；可重试或更换模型。</InfoCard>
              <InfoCard title="GitHub 无法读取">检查 PAT 是否覆盖目标仓库、所需读取权限是否开启、仓库身份和跟踪分支是否正确。</InfoCard>
              <InfoCard title="按钮保持禁用">确认前置配置是否就绪、必填内容是否完成，并勾选当前操作的传输确认复选框。</InfoCard>
              <InfoCard title="任务失败或状态变化">刷新页面查看持久化任务状态。失败不会替换上一代已发布仓库数据或索引。</InfoCard>
            </div>
          </GuideSection>

          <GuideSection id="maintenance" eyebrow="Local operations" title="本地部署、更新与备份">
            <InfoCard title="检查服务">
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-6">docker compose ps --all{"\n"}curl http://127.0.0.1:3000/api/health</pre>
            </InfoCard>
            <InfoCard title="更新应用">
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-6">docker compose up -d --build</pre>
              <p className="mt-2">Compose 会先执行数据库迁移，再启动应用。更新前建议先备份 PostgreSQL。</p>
            </InfoCard>
            <Callout tone="amber" title="不要删除持久化卷">不要执行 <code className="rounded bg-amber-100 px-1 py-0.5">docker compose down -v</code>。这会删除 PostgreSQL 数据卷和凭据主密钥卷，可能导致项目数据丢失或已保存凭据无法解密。</Callout>
            <p className="mt-5 text-sm leading-7 text-slate-600">完整的备份命令、升级检查、能力边界和错误处理见仓库文档 <code className="rounded bg-slate-100 px-1.5 py-0.5">docs/operation-manual.md</code>。</p>
          </GuideSection>
        </div>

        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 py-7 text-xs text-slate-400">
          <span>AI Project OS V2.2 · 页面操作指南</span>
          <Link href="/dashboard" className="font-semibold text-indigo-600 hover:text-indigo-700">返回 Dashboard</Link>
        </footer>
      </div>
    </main>
  );
}

function GuideSection({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return <section id={id} className="scroll-mt-6 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">{eyebrow}</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">{title}</h2><div className="mt-7">{children}</div></section>;
}

function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return <div className="mb-5 flex gap-4 last:mb-0"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{number}</span><div><h3 className="text-sm font-semibold text-slate-800">{title}</h3><p className="mt-1 text-sm leading-7 text-slate-600">{children}</p></div></div>;
}

function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><h3 className="text-sm font-semibold text-slate-800">{title}</h3><div className="mt-3 text-sm leading-7 text-slate-600">{children}</div></article>;
}

function Callout({ tone, title, children }: { tone: "amber" | "slate"; title: string; children: ReactNode }) {
  const style = tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-100 text-slate-700";
  return <aside className={`mt-6 rounded-2xl border p-5 ${style}`}><h3 className="text-sm font-semibold">{title}</h3><div className="mt-2 text-sm leading-7">{children}</div></aside>;
}
