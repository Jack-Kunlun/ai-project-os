import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { requirePageSession } from "@/lib/auth";
import { APP_VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: `使用指南 · AI Project OS V${APP_VERSION}`,
  description: `AI Project OS V${APP_VERSION} 从连接配置、资料接入到自动化、受控动作、团队治理与智能体的页面操作指南。`,
};

export const dynamic = "force-dynamic";

const workflow = [
  { number: "01", title: "配置模型", detail: "添加并测试生成、视觉与向量供应商。", href: "#providers" },
  { number: "02", title: "连接 Git", detail: "配置 GitHub、Gitee、自建 Git 等只读连接。", href: "#connections" },
  { number: "03", title: "连接 MCP", detail: "发现远程只读工具并为项目逐项授权。", href: "#mcp" },
  { number: "04", title: "接入资料", detail: "上传文件，添加网页和多个代码仓库。", href: "#project-data" },
  { number: "05", title: "建立记忆", detail: "审核 AI 候选，构建兼容的语义索引。", href: "#memory" },
  { number: "06", title: "维护质量", detail: "检查冲突、过期与低置信度记忆。", href: "#quality" },
  { number: "07", title: "设置自动化", detail: "定时同步来源、检查计划健康并接收通知。", href: "#automation" },
  { number: "08", title: "管理动作", detail: "设置项目策略，完成 Owner 审批并核对审计。", href: "#actions" },
  { number: "09", title: "运行智能体", detail: "生成状态简报，或开展一次只读调查。", href: "#agent" },
  { number: "10", title: "维护项目计划", detail: "落实负责人、期限、验收、证据和仓库变化核对。", href: "#plan" },
  { number: "11", title: "团队协作", detail: "管理角色、邀请和企业 OIDC 登录。", href: "#team" },
] as const;

const providerRows = [
  ["OpenAI", "生成 + 图片识别 + 向量", "可由一个连接承担全部 AI 能力"],
  ["DeepSeek", "生成 + 图片识别", "图片识别使用页面内置的视觉模型建议；仍需其他供应商承担向量"],
  ["Qwen（阿里云百炼）", "生成 + 图片识别 + 向量", "适合国内 API 接入的一体化配置"],
  ["GLM（智谱开放平台）", "生成 + 图片识别 + 向量", "适合国内 API 接入的一体化配置"],
] as const;

export default async function GuidePage() {
  const user = await requirePageSession();

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={user.username} active="guide" />
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <section className="grid gap-8 pb-12 pt-14 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-indigo-600">Start to finish</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight tracking-[-0.04em] sm:text-6xl">从第一次配置，到可信的项目回答。</h1>
            <p className="mt-6 max-w-3xl text-base leading-8 text-slate-600">按推荐顺序完成连接、资料、智能记忆、自动化、受控动作、项目计划和团队权限。每一步都保留来源、审核状态和证据引用；只有你在页面明确确认后，相关内容才会发送给模型供应商。</p>
          </div>
          <div className="rounded-3xl bg-slate-950 p-6 text-white">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Before you start</p>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-300">
              <li>Docker 服务处于健康状态</li>
              <li>已准备至少一个模型 API Key</li>
              <li>仓库接入时准备只读 Token 或专用 SSH Key</li>
              <li>MCP 接入时使用受信服务和只读 Bearer Token</li>
              <li>不要在项目资料中录入密码或 Token</li>
            </ul>
          </div>
        </section>

        <nav aria-label="推荐使用顺序" className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
            <Step number="1" title="初始化本地管理员">首次打开应用会进入初始化页。用户名至少 3 位；密码至少 12 位并同时包含字母和数字。首位管理员会成为默认工作区 Owner。</Step>
            <Step number="2" title="理解凭据保存方式">模型、Git 与 OIDC 凭据由服务端加密保存，页面不会回显明文。数据库之外的本地主密钥同样必须保留；不要删除 Compose 的 secrets 卷。</Step>
            <Step number="3" title="登录后的第一站">登录后会进入 Dashboard。先按“推荐下一步”完成至少一个生成模型和一个向量模型的连接测试，再创建正式项目。</Step>
          </GuideSection>

          <GuideSection id="dashboard" eyebrow="Command center" title="从 Dashboard 开始工作">
            <p className="text-sm leading-7 text-slate-600">Dashboard 不是静态欢迎页，而是每次打开系统后的工作入口。它会把跨项目状态压缩成当前最值得处理的一步，减少在不同页面之间来回查找。</p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <InfoCard title="先看推荐下一步">存在逾期或受阻计划时，系统优先链接到对应项目；否则再按模型连接、项目、四条 AI 路由、待确认文件和智能记忆索引判断下一步。</InfoCard>
              <InfoCard title="检查工作空间就绪度">四步进度用于判断基础能力是否真的可用；容器健康但模型或索引缺失时，不会显示为完整就绪。</InfoCard>
              <InfoCard title="继续最近任务">文件识别、仓库扫描、同步、抽取、索引、问答、简报和智能体运行会显示持久化状态，可直接回到所属项目。</InfoCard>
              <InfoCard title="处理项目运营提醒">Dashboard 汇总逾期、受阻、仓库变化待评估和动作待审批；项目搜索、创建和完整列表仍位于独立“项目”页。</InfoCard>
            </div>
            <div className="mt-5 flex flex-wrap gap-3"><Link href="/dashboard" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-500">打开 Dashboard</Link><Link href="/projects" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 hover:border-indigo-200 hover:text-indigo-700">打开项目</Link></div>
          </GuideSection>

          <GuideSection id="profile" eyebrow="Personal center" title="管理个人信息与登录安全">
            <Step number="1" title="查看账户状态">点击右上角头像，查看账户角色、工作区/项目授权、账户创建时间、最近活动和活动会话。</Step>
            <Step number="2" title="修改登录名">登录名为 3–64 位，只允许字母、数字、点、下划线和连字符；保存后下次登录使用新登录名。</Step>
            <Step number="3" title="安全轮换密码">在“登录与安全”中展开“修改密码”，再输入当前密码和新密码。新密码至少 12 位并包含字母和数字；成功后全部会话会被撤销，需要重新登录。</Step>
            <Callout tone="slate" title="凭据分开管理">模型 API Key 位于“模型设置”；Git 与 MCP 凭据位于“连接器”；OIDC Client Secret 位于“团队”。个人中心不会展示或导出这些凭据。</Callout>
          </GuideSection>

          <GuideSection id="mcp" eyebrow="Controlled MCP" title="连接并授权远程只读工具">
            <Step number="1" title="由管理员添加远程服务">进入“连接器 → MCP 只读工具”，填写 Streamable HTTP 端点和可选 Bearer Token。公网必须使用 HTTPS；公司内网需要明确开启内网访问。当前不运行 stdio、本地子进程或旧式 HTTP+SSE。</Step>
            <Step number="2" title="发现并固化工具定义">执行“发现并固化工具”。系统固定 DNS 地址，分页读取工具目录，并把名称、说明、输入/输出 Schema、annotations 和定义指纹保存为追加式快照。不兼容或过大的 Schema 会被拒绝。</Step>
            <Step number="3" title="由项目 Owner 逐项授权">进入项目“工具权限”。只有同时声明 <code>readOnlyHint=true</code> 和 <code>destructiveHint=false</code> 的当前定义可供授权；Owner 仍需确认远端服务和凭据本身可信且只读。</Step>
            <Step number="4" title="填写参数并创建动作">Editor 或 Owner 按固化的输入 Schema 填写 JSON 参数。系统把项目、授权、工具定义、参数、网络和凭据指纹一起固化为动作；不会立即访问远端。</Step>
            <Step number="5" title="逐次审批并核对结果">Owner 到“动作与审批”展开完整参数后批准。MCP 调用不允许“自动执行”；执行前再次核对全部快照，任何授权撤销、工具更新、DNS 变化或凭据轮换都会失败关闭。</Step>
            <Callout tone="amber" title="远端声明不是安全保证">MCP annotations 按协议属于未受信提示。系统的门禁可以阻止未授权、未审批或发生漂移的调用，但不能证明第三方服务实际只读。应使用你控制或充分信任的服务、最小权限 Token 和独立审计。</Callout>
            <Callout tone="slate" title="结果不会自动进入 AI">工具结果默认只保存在对应动作记录中，响应体有超时和大小限制；图片、音频与资源链接不会自动展开。成功结果可以在“动作与审批”中由 Editor 或 Owner 人工固化为未审核项目资料；仍需后续审核与索引重建，才会参与记忆、RAG 或项目智能体。</Callout>
            <div className="mt-5"><Link href="/connections/mcp" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700">前往 MCP 连接</Link></div>
          </GuideSection>

          <GuideSection id="providers" eyebrow="AI connections" title="配置模型供应商">
            <p className="text-sm leading-7 text-slate-600">在“模型与系统设置”中点击添加连接，选择供应商，填写连接名称、API Key、生成模型、图片识别模型，并在支持时填写向量模型和维度。保存后必须执行连接测试；只有“已验证”的连接才能分配给项目。连接测试验证密钥、生成能力和已配置向量能力；图片模型在第一次真实识别时再验证具体模型可用性。</p>
            <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-slate-950 text-white"><tr><th className="px-4 py-3 font-semibold">供应商</th><th className="px-4 py-3 font-semibold">可承担能力</th><th className="hidden px-4 py-3 font-semibold sm:table-cell">建议</th></tr></thead>
                <tbody className="divide-y divide-slate-100 bg-white">{providerRows.map(([name, capability, note]) => <tr key={name}><td className="px-4 py-4 font-semibold text-slate-800">{name}</td><td className="px-4 py-4 text-slate-600">{capability}</td><td className="hidden px-4 py-4 text-slate-500 sm:table-cell">{note}</td></tr>)}</tbody>
              </table>
            </div>
            <Callout tone="amber" title="模型与维度必须准确">向量模型 ID 和维度必须与供应商实际配置一致。更换向量供应商、模型或维度后，旧索引会被标记为不兼容，必须重新建立索引。</Callout>
            <div className="mt-5"><Link href="/settings" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-500">前往模型与系统设置</Link></div>
          </GuideSection>

          <GuideSection id="connections" eyebrow="Git connections" title="连接不同来源的 Git 服务">
            <p className="text-sm leading-7 text-slate-600">在顶部“连接器”集中配置 GitHub、Gitee、GitLab、自建 GitLab、Gitea、Forgejo 或通用 Git。项目页只选择已经验证的连接，不需要在每个项目重复录入凭据。</p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <InfoCard title="HTTPS">可使用只读 Token、Basic 或无认证连接。自签服务可以填写可信 CA；公司内网地址需要明确开启内网访问。</InfoCard>
              <InfoCard title="SSH">使用单独的只读 SSH Key，并从可信渠道填写精确 known_hosts。系统固定解析地址，同时以原主机名验证主机密钥。</InfoCard>
              <InfoCard title="网络变化">保存后会记录验证过的 DNS 地址。地址发生变化时读取会停止，需要管理员核对基础设施变更并重新确认。</InfoCard>
              <InfoCard title="最小权限">只授予需要的仓库读取权限。不要使用个人主 SSH Key，也不要把 Token 写进项目资料或仓库 URL。</InfoCard>
            </div>
            <Callout tone="slate" title="Git 连接器只读">通用 Git 连接器只读取受控目录中的代码和文本，不创建分支、提交、Issue 或 PR。GitHub 的 Issue、PR、Release 扩展同步仍使用既有 GitHub 专用入口。</Callout>
            <div className="mt-5"><Link href="/connections" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700">前往连接器</Link></div>
          </GuideSection>

          <GuideSection id="files" eyebrow="Files & vision" title="上传文件并核对图片识别">
            <Step number="1" title="选择文件">进入项目“文件资料”，一次最多选择 10 个文件。支持 TXT、Markdown、JSON、CSV、PDF、DOCX、PPTX、XLSX、PNG、JPEG 和 WebP；单文件最大 25 MiB，图片最大 10 MiB / 2000 万像素。</Step>
            <Step number="2" title="先完成本地解析">文本与 Office 文档优先在本机提取文字并保留段落、页码、幻灯片、工作表和单元格范围。可提取的文字不会发送给视觉模型；Office 文档中的嵌入图片当前不会单独识别。</Step>
            <Step number="3" title="按需识别图片或扫描页">原始图片和无足够本地文字的 PDF 扫描页会停在“等待图片识别”。页面会显示待发送片段数量；勾选当次传输确认后，系统才按项目视觉路由逐页调用第三方模型。单文件最多处理 20 个视觉片段。</Step>
            <Step number="4" title="逐片段人工确认">模型返回的文字和视觉描述只进入待审核区。可以编辑后接受，也可以驳回；全部片段处理完后，接受的内容才会一起发布到项目资料库并参与后续索引。</Step>
            <Step number="5" title="移除或恢复">移除文件会让其来源停止参与新的抽取、索引和智能体读取，旧索引会提示待重建。原文件和审计记录保留；重新上传完全相同的文件即可恢复原资产与来源。</Step>
            <Callout tone="amber" title="图片识别会使用供应商额度">视觉调用可能产生费用。只上传有权处理的文件，发送前核对供应商、模型、片段数量和敏感信息。供应商结果未知时系统不会自动重试或发布。</Callout>
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
              <InfoCard title="多 Git 仓库">
                <ol className="space-y-2">
                  <li>1. 先在顶部“连接器”验证 Git 服务。</li>
                  <li>2. 进入项目“代码仓库”，选择一个或多个连接。</li>
                  <li>3. 设置仓库路径、跟踪分支、角色和代码扫描根目录。</li>
                  <li>4. 执行首次扫描；GitHub 可继续按需同步 README、Issue、PR 和 Release。</li>
                  <li>5. 检查任务状态，确认扫描或同步已经成功发布。</li>
                </ol>
              </InfoCard>
              <InfoCard title="网页与本地文件夹">
                <ol className="space-y-2">
                  <li>1. 在“外部资料”添加公开网页或经授权的内网页面。</li>
                  <li>2. 网页抓取只提取静态文本，不执行脚本或页面登录。</li>
                  <li>3. 需要批量导入本地目录时，从“文件资料”选择文件夹。</li>
                  <li>4. 浏览器只上传你明确选择、格式受支持的文件。</li>
                </ol>
              </InfoCard>
            </div>
            <Callout tone="slate" title="资料不是事实">新接入的 Source、文件、网页、仓库内容和模型抽取结果都只是证据或候选。只有经过人工确认的 ProjectItem 才应当被视为项目事实。</Callout>
            <p className="mt-5 text-sm leading-7 text-slate-600">项目卡还提供受限 JSON 导出与软归档。归档前必须没有运行中或待人工收口任务；归档不删除数据，并可从“已归档”列表恢复。</p>
          </GuideSection>

          <GuideSection id="routes" eyebrow="Project routing" title="为项目分配 AI 能力">
            <p className="text-sm leading-7 text-slate-600">每个项目都要在“智能控制台”分别配置四条路由。路由只能选择已经通过连接测试且配置了对应模型的供应商。</p>
            <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <InfoCard title="图片与扫描件识别">处理原始图片和扫描 PDF，结果必须人工确认后发布。</InfoCard>
              <InfoCard title="语义向量">建立索引和处理检索问题。必须使用支持 embeddings 的供应商。</InfoCard>
              <InfoCard title="自动抽取">从所选原始资料中抽取 decision、progress、issue 和 risk 候选。</InfoCard>
              <InfoCard title="引用式问答">生成 RAG 回答、项目状态简报和智能体最终回答。</InfoCard>
            </div>
            <Callout tone="amber" title="切换模型前先看影响预览">切换图片识别、自动抽取或引用式问答模型只影响后续任务，已经确认的文件来源和历史结果保留原供应商与模型来源。切换向量供应商、模型或维度会暂停语义搜索、RAG 和项目智能体；页面要求明确确认，保存后必须前往智能记忆重建索引。</Callout>
          </GuideSection>

          <GuideSection id="memory" eyebrow="AI memory" title="建立并使用智能记忆">
            <Step number="1" title="自动抽取候选">选择需要处理的资料，勾选本次传输确认，再运行抽取。系统会拒绝结构无效、原文摘录不存在或越界的模型输出。</Step>
            <Step number="2" title="逐条人工审核">检查候选标题、内容和原文引用；接受后进入已确认事实，驳回则保留审核记录但不会进入可信事实。</Step>
            <Step number="3" title="建立统一向量索引">确认当前路由后构建索引。索引覆盖人工资料、已经本地解析或人工确认的文件片段、已发布仓库资料和代码快照；构建失败不会替换上一代完整索引。</Step>
            <Step number="4" title="检索和引用式问答">语义搜索返回原文片段、路径、冻结 commit 和分数。引用式问答只允许引用本次检索命中的证据。</Step>
            <Callout tone="amber" title="什么时候需要重建索引">新增或更新资料、重新扫描仓库、同步新仓库内容，或更换向量供应商/模型/维度后，都应重新建立索引。</Callout>
          </GuideSection>

          <GuideSection id="quality" eyebrow="Memory governance" title="检查记忆质量与生命周期">
            <p className="text-sm leading-7 text-slate-600">进入“记忆质量”运行确定性检查。该检查在本地识别可能重复、内容冲突、过期、证据不足和低置信度事实，不调用模型，也不会向外发送项目内容。</p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <InfoCard title="先核对问题">打开每条问题，比较主条目、关联条目、说明和证据；确认处理完成后标记“已处理”，误报则标记“不适用”。</InfoCard>
              <InfoCard title="维护生命周期">为事实设置置信度、重要性、有效截止和长期置顶；“保存并记录已复核”会留下新的人工修订。</InfoCard>
            </div>
            <Callout tone="amber" title="质量分不是事实真伪判断">分数用于排序治理工作，不会自动删除、合并或替代事实。冲突和重复仍需要人结合来源处理。</Callout>
          </GuideSection>

          <GuideSection id="automation" eyebrow="Persistent automation" title="让来源维护按计划运行">
            <Step number="1" title="选择可自动执行的任务">仓库同步、网页刷新和记忆质量检查可以由独立 Worker 自动运行并保存租约与结果。</Step>
            <Step number="2" title="理解模型任务的停点">记忆索引和项目简报到期时只产生待确认通知；进入对应页面核对供应商、模型和输入范围后再发送。</Step>
            <Step number="3" title="查看运行记录和通知">每条规则显示下次运行、最近结果和连续失败次数；连续失败三次会自动暂停，通知中心提供安全错误码和处理入口。</Step>
            <Step number="4" title="设置计划健康提醒">选择 1、3、7 或 14 天到期窗口，并决定是否提醒相关负责人。检查只读取本地计划、证据和审批状态，不调用模型；发送前会重新校验接收者权限。</Step>
            <Step number="5" title="归档前收口">项目归档会暂停活动规则，运行中的自动化会阻止归档；项目恢复后规则不会自动重启。</Step>
            <div className="mt-5"><Link href="/notifications" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:border-indigo-200 hover:text-indigo-700">打开通知中心</Link></div>
          </GuideSection>

          <GuideSection id="actions" eyebrow="Controlled action engine" title="用策略和审批控制项目动作">
            <Step number="1" title="为每项能力选择策略">项目 Owner 在“动作与审批”中管理仓库同步、网页刷新、记忆质量检查和 MCP 只读调用。前三项可选择“自动执行”“每次审批”或“禁止执行”；MCP 只允许“每次审批”或“禁止执行”。</Step>
            <Step number="2" title="由 Editor 或 Owner 创建动作">系统会固定能力、规范化输入、输入指纹、风险级别和策略快照。仓库同步与网页刷新默认等待审批；本地记忆质量检查默认直接排队；MCP 调用还固定授权、工具、网络和凭据指纹。</Step>
            <Step number="3" title="由 Owner 核对并决策">待审批动作会通知项目 Owner。批准或拒绝时，服务端会重新核对动作版本和输入指纹；24 小时内没有决策会自动过期。</Step>
            <Step number="4" title="查看执行和不可变审计">Worker 领取后显示运行状态、结果或安全错误码。申请、排队、审批、领取和终态均保留审计；租约过期会失败关闭，不会自动重复外部读取。</Step>
            <Callout tone="amber" title="动作中心不是任意执行平台">当前只开放三个内置动作和一个受控 MCP 只读调用能力。模型不能生成或批准动作；系统不提供 stdio MCP、MCP 写操作、Shell、代码写入、分支/PR、合并、部署或其他外部写操作。</Callout>
          </GuideSection>

          <GuideSection id="governance" eyebrow="Governance & review" title="审核事实、收口异常并管理项目数据">
            <Step number="1" title="逐条审核候选">进入项目“治理与审核”，同时检查网页抽取候选和已验证运行候选。页面不提供批量接受，确认或驳回后会重新读取服务器状态。</Step>
            <Step number="2" title="区分失败和未知结果">失败表示已有明确终态；未知表示外部结果无法确认。只有具备对应不可变证据的任务才显示“人工收口”，该动作不会自动重试或改写为成功。</Step>
            <Step number="3" title="查看模型用量">在 7、30、90 天之间切换，按供应商、模型和能力核对调用尝试与 Token。系统没有供应商价格快照，因此不会显示猜测费用。</Step>
            <Step number="4" title="归档、恢复或导出">从“项目”页归档没有活动任务的项目；归档后项目变为只读，恢复后可继续操作。进行中和已归档项目都可导出受限 JSON。</Step>
            <Callout tone="amber" title="JSON 导出不是备份">导出包含文件元数据、解析/识别文本和审核状态，但不包含上传文件二进制、服务端存储路径、模型/Git/OIDC 凭据、向量、原始任务载荷、供应商请求 ID、仓库代码正文或完整数据库状态。文件会原样包含项目正文；若曾把密码或 Token 错误录入资料，它们也会出现。请按敏感业务数据保管，灾难恢复必须同时备份 PostgreSQL、主密钥和 uploads 卷。</Callout>
          </GuideSection>

          <GuideSection id="agent" eyebrow="Project intelligence" title="生成简报并运行只读智能体">
            <Step number="1" title="先检查就绪状态">页面必须同时显示生成模型路由、向量模型路由和兼容记忆索引已经就绪。缺少任意一项时，运行按钮保持禁用。</Step>
            <Step number="2" title="生成项目当前状态">勾选当次传输确认后生成简报。结果按进展、决策、问题、风险、关注事项和待确认问题组织，并保存证据快照。</Step>
            <Step number="3" title="提出一个可调查的问题">适合询问“当前最大风险是什么”“哪些决策仍缺少证据”“最近完成了什么”。问题越具体，检索计划越有效。</Step>
            <Step number="4" title="核对引用和轨迹">查看回答引用的证据、只读工具执行顺序、建议和不确定性。证据不足时应补资料，而不是把推测直接当作事实。</Step>
            <Callout tone="slate" title="智能体不会做什么">当前智能体没有 Shell、任意文件系统、代码修改、Git 写入、MCP 工具调用或部署权限。它也不能自行创建或批准“动作与审批”中的动作。自动化可以提醒你生成简报，但每次模型外发仍需由你在页面确认。</Callout>
          </GuideSection>

          <GuideSection id="plan" eyebrow="Evidence-driven plan" title="把证据转成由人推进的项目计划">
            <Step number="1" title="先建立目标与工作项">进入项目“项目计划”。为工作项设置可编辑负责人、目标日期和独立验收标准；没有负责人和验收标准时不能开始。</Step>
            <Step number="2" title="核对智能体建议的证据">只读智能体产生建议后，页面会同时显示引用来源和输入清单指纹。选择“纳入计划”只会固化一条 <code>proposed</code> 工作项，不会自动接受或执行。</Step>
            <Step number="3" title="关联可验证完成证据">从已确认事实或活动项目来源中选择证据；系统固定内容快照和指纹。完成工作项前至少需要一条活动证据，来源变化后会提示重新核对。</Step>
            <Step number="4" title="核对仓库变化">点击“检查最新同步”只会生成确定性变化清单，不会推断影响。由人把相关信号关联到工作项，或核对后忽略。</Step>
            <Step number="5" title="由人决定是否推进">Editor 或 Owner 按实际进度更新状态。已完成和已取消是不可改写终态；被取消的前置依赖不会被当作已完成。</Step>
            <Step number="6" title="查看健康与审计">健康卡和 Dashboard 显示逾期、受阻、依赖和运营缺口。创建、状态、证据、变化决策与依赖调整都会进入追加式审计。</Step>
            <Callout tone="amber" title="项目计划不是自动执行器">计划项只表达经用户核对的目标、工作和依赖。系统不会根据建议自动修改代码、调用 MCP、创建 Git 分支或 PR、合并、运行 Shell 或部署；动作中心的审批边界也不会被项目计划绕过。</Callout>
            <div className="mt-5"><Link href="/projects" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-500">选择项目并打开项目计划</Link></div>
          </GuideSection>

          <GuideSection id="team" eyebrow="Team & identity" title="管理成员、邀请和企业登录">
            <div className="grid gap-4 md:grid-cols-2">
              <InfoCard title="工作区角色">Owner/Admin 可管理成员、邀请、OIDC 和全部项目；Member/Viewer 只访问单独授权项目。系统阻止删除或降级最后一位启用的 Owner。</InfoCard>
              <InfoCard title="项目角色">Owner 可管理并归档项目，Editor 可修改项目内容，Viewer 只读。低权限邀请不会降低成员已有授权。</InfoCard>
              <InfoCard title="邀请链接">建议限定邮箱。链接只在创建后显示一次，请立即复制并通过安全渠道发送；接受者邮箱必须匹配。</InfoCard>
              <InfoCard title="OIDC 登录">配置 Issuer、Client、Secret、Scopes 和 Token 认证方式。系统使用 Authorization Code + PKCE，并校验 issuer、audience、nonce、过期时间和 JWKS 签名。</InfoCard>
            </div>
            <Callout tone="amber" title="相同邮箱不会自动绑定">OIDC 未知身份若使用已有本地账户邮箱，登录会被拒绝。V{APP_VERSION} 尚未提供显式身份绑定页面，这一限制用于防止邮箱劫持。</Callout>
            <div className="mt-5"><Link href="/team" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700">前往团队</Link></div>
          </GuideSection>

          <GuideSection id="routine" eyebrow="Operating rhythm" title="推荐的日常更新顺序">
            <div className="rounded-2xl bg-slate-950 p-6 text-sm leading-7 text-slate-200">
              新文件、网页或代码变化 → 解析/刷新/扫描来源 → 自动抽取 → 人工审核 → 重建语义索引 → 核对仓库变化 → 更新工作项负责人/验收/证据 → 处理计划健康提醒 → 生成新简报或提问
            </div>
            <p className="mt-5 text-sm leading-7 text-slate-600">如果只更新了人工确认条目但没有重建索引，项目概览和已确认条目工具仍能读取最新状态，但语义记忆仍基于上一代索引。为了让检索和智能体结果一致，建议完成整条更新链路。</p>
          </GuideSection>

          <GuideSection id="troubleshooting" eyebrow="Troubleshooting" title="常见问题">
            <div className="grid gap-4 md:grid-cols-2">
              <InfoCard title="供应商不能选择">先到设置页执行连接测试。只有状态为“已验证”且能力匹配的供应商会出现在项目路由中。</InfoCard>
              <InfoCard title="文件停在等待图片识别">先在智能控制台配置图片识别路由，再回到文件资料核对待发送数量并勾选本次传输确认。</InfoCard>
              <InfoCard title="文件解析失败">检查真实格式是否与扩展名一致、Office 文件是否加密、图片像素/体积以及 PDF 页数。失败文件不会进入资料库。</InfoCard>
              <InfoCard title="索引需要重建">当前向量供应商、模型或维度与活动索引不一致。使用当前路由重新建立索引。</InfoCard>
              <InfoCard title="模型输出被拒绝">输出结构、证据摘录或引用 ID 未通过校验。原结果不会保存为可信内容；可重试或更换模型。</InfoCard>
              <InfoCard title="Git 仓库无法读取">检查连接状态、凭据权限、仓库路径、分支、CA 或 known_hosts。DNS 地址变化后需要管理员重新验证连接。</InfoCard>
              <InfoCard title="MCP 工具无法授权或调用">先确认连接已成功发现工具，定义明确声明只读且非破坏性。工具、DNS、凭据或授权发生变化后，先由管理员重新发现，再由项目 Owner 重新确认授权并创建新动作。</InfoCard>
              <InfoCard title="网页来源无法刷新">确认页面无需登录或 JavaScript 渲染。公司内网页面需要明确授权；云元数据地址始终无法放行。</InfoCard>
              <InfoCard title="OIDC 登录被拒绝">检查回调地址、Issuer、Client、Secret、Scopes 和 Token 认证方式；相同邮箱的本地账号不会自动合并。</InfoCard>
              <InfoCard title="自动化没有运行">确认 Worker 正在运行、规则已启用、项目未归档且执行时间已到。连续失败三次的规则会自动暂停。</InfoCard>
              <InfoCard title="工作项不能开始或完成">开始前补齐当前可编辑负责人和验收标准；完成前再关联至少一条活动证据。证据显示“需复核”时先核对来源变化。</InfoCard>
              <InfoCard title="动作一直等待或失败">等待审批时联系项目 Owner；超过 24 小时需要重新创建。排队后检查 Worker，失败后先查看安全错误码和审计；系统不会自动重试外部读取。</InfoCard>
              <InfoCard title="按钮保持禁用">确认前置配置是否就绪、必填内容是否完成，并勾选当前操作的传输确认复选框。</InfoCard>
              <InfoCard title="任务失败或状态变化">刷新页面查看持久化任务状态。失败不会替换上一代已发布仓库数据或索引。</InfoCard>
              <InfoCard title="项目无法归档">先到“治理与审核”确认没有排队中、等待确认、运行中或待人工收口任务；归档不会强制中断任务。</InfoCard>
              <InfoCard title="用量与账单不一致">页面统计受审计的调用尝试和 Token，不维护价格、折扣或缓存计费规则。最终金额以供应商账单为准。</InfoCard>
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
            <Callout tone="amber" title="不要删除持久化卷">不要执行 <code className="rounded bg-amber-100 px-1 py-0.5">docker compose down -v</code>。这会删除 PostgreSQL 数据卷、凭据主密钥卷和上传文件卷，可能导致项目数据丢失、已保存凭据无法解密或文件原件不可恢复。</Callout>
            <p className="mt-5 text-sm leading-7 text-slate-600">完整的备份命令、升级检查、能力边界和错误处理见仓库文档 <code className="rounded bg-slate-100 px-1.5 py-0.5">docs/operation-manual.md</code>。</p>
          </GuideSection>
        </div>

        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 py-7 text-xs text-slate-400">
          <span>AI Project OS V{APP_VERSION} · 页面操作指南</span>
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
