import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { AppHeader } from "@/components/app-header";
import { AccessControlError, assertProjectAccess } from "@/lib/access-control";
import { requirePageSession } from "@/lib/auth";
import { getUploadPolicy } from "@/lib/project-assets/policy";
import { APP_VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: `普通用户操作指南 · AI Project OS ${APP_VERSION}`,
  description: "从账号、工作区和项目创建，到配置、资料、计划、AI 工作台、自动化和通知审核的当前能力指南。",
};

export const dynamic = "force-dynamic";

const sections = [
  ["account", "账号与工作区", "了解角色、邀请和工作区入口"],
  ["projects", "创建项目", "建立隔离的项目空间"],
  ["overview", "项目概览", "查看当前事实和项目状态"],
  ["configuration", "项目配置", "管理项目使用的 Git、MCP 和 AI 连接"],
  ["plan", "项目计划", "把目标和证据转成可推进的工作"],
  ["materials", "项目资料", "接入文件、网页和代码来源"],
  ["intelligence", "AI 工作台", "生成简报、检索和只读调查"],
  ["automation", "项目自动化", "按计划维护来源并接收提醒"],
  ["governance", "项目治理与用量", "在概览中核对任务、关系、审批和用量"],
  ["notifications", "通知与记忆确认", "处理待确认候选和任务结果"],
] as const;

export default async function GuidePage({ searchParams }: { searchParams: Promise<{ projectId?: string | string[] }> }) {
  const user = await requirePageSession();
  const uploadPolicy = getUploadPolicy();
  const rawProjectId = (await searchParams).projectId;
  const parsedProjectId = typeof rawProjectId === "string" ? z.string().uuid().safeParse(rawProjectId) : null;
  const projectId = parsedProjectId?.success ? parsedProjectId.data.toLowerCase() : undefined;
  if (rawProjectId !== undefined && projectId === undefined) notFound();
  if (projectId !== undefined) {
    try {
      await assertProjectAccess(user, projectId, "view");
    } catch (error) {
      if (error instanceof AccessControlError && ["ACCESS_FORBIDDEN", "ACCESS_PROJECT_NOT_FOUND"].includes(error.code)) notFound();
      throw error;
    }
  }

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={user.username} active="guide" isSystemAdmin={user.role === "admin"} projectId={projectId} projectSection={projectId ? "guide" : undefined} /><div className="mx-auto max-w-6xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
    <section className="grid gap-8 rounded-[2rem] bg-slate-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-12 lg:grid-cols-[1.2fr_.8fr] lg:items-end"><div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">User guide</p><h1 className="mt-4 text-4xl font-semibold leading-tight tracking-[-0.04em] sm:text-6xl">从账号进入，到可信的项目协作。</h1><p className="mt-5 max-w-3xl text-sm leading-7 text-slate-300">这份指南面向普通用户，覆盖当前已支持的六个项目一级入口；任务、资料和结果详情等必要子页从相应入口进入。平台默认托管模型由系统管理员维护；有效会员可配置个人模型，但必须经过连接所有者与项目 Owner 双确认委托，个人模型不会自动替代平台默认模型。个人 Git 与 MCP 连接可以在个人工作区配置；MCP 个人连接与工具发现、管理员净化快照审核、项目连接委托和只读工具授权控制面已开放，但远端动作调用、调用审批、派发和结果查看/导入仍未开放。项目页支持 Git 双确认后的一次性手动只读读取，自动化、写入/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准。</p>{user.role === "admin" ? <Link href="/admin/guide" className="mt-6 inline-flex rounded-xl border border-white/15 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/15">打开管理员指南 →</Link> : null}</div><div className="rounded-2xl border border-white/10 bg-white/[0.07] p-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-200">推荐顺序</p><p className="mt-3 text-sm leading-7 text-slate-300">账号 / 工作区 → 创建项目 → 项目配置 → 项目概览 → 项目计划 → 项目资料 → AI 工作台 → 项目自动化 → 通知与记忆确认</p></div></section>
    <nav aria-label="普通用户指南目录" className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{sections.map(([id, title, detail], index) => <a key={id} href={`#${id}`} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50/40"><span className="text-xs font-bold text-indigo-600">{String(index + 1).padStart(2, "0")}</span><h2 className="mt-2 text-sm font-semibold text-slate-800">{title}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p></a>)}</nav>
    <div className="mt-8 space-y-6"><GuideSection id="account" title="账号与工作区" eyebrow="01 · Account & workspace"><Step number="1" title="登录账号">使用管理员邀请的本地账号或已配置的企业登录方式。登录后先在 Dashboard 查看可访问项目；项目和资料权限由服务端按角色判断。</Step><Step number="2" title="理解角色">workspace Owner/Admin 只管理所属工作区成员、邀请和项目授权；Member/Viewer 按被授予的项目访问。系统管理员的管理工作台属于平台范围，不等同于工作区权限。</Step><Step number="3" title="接受邀请">邀请链接应通过安全渠道发送，并在有效期内由匹配邮箱的账号接受。相同邮箱不会自动合并不同登录身份。</Step></GuideSection>
      <GuideSection id="projects" title="创建项目空间" eyebrow="02 · Projects"><Step number="1" title="先确认创建权限">只有当前工作区 Owner/Admin 可以创建项目；系统管理员角色不会自动获得工作区权限。普通 Member/Viewer 需要由当前工作区 Owner/Admin 授权后再创建。</Step><Step number="2" title="从项目入口创建">有权限时点击 Dashboard 或顶部“项目”，选择“新建项目”，填写项目名称和可选描述。新项目会隔离自己的资料、计划、AI 能力使用方式、记忆和审计；项目内不维护独立模型路由。</Step><Step number="3" title="确认访问范围">只有被授予项目 Owner/Editor 的用户才能修改内容；Viewer 可以查看。项目归档后变为只读，恢复后才可继续操作。</Step><Callout title="项目数据边界">不要把密码、Token、私钥或其他凭据录入项目描述、资料或条目。项目导出也应按敏感业务数据保管。</Callout></GuideSection>
      <GuideSection id="overview" title="项目概览" eyebrow="03 · Overview"><Step number="1" title="读取当前状态">概览显示当前有效、已确认事实，以及问题、风险、关系和计划健康度计算出的项目状态。它不是模型猜测，也不会自动把候选变成事实。</Step><Step number="2" title="从状态进入下一步">查看项目关键指标、推荐下一步和当前状态后，可继续进入配置、计划、资料、AI 工作台或自动化。任务运行记录与 AI 用量也集中在概览中。</Step><Step number="3" title="查看历史依据">事实卡片可查看来源、修订和证据。来源退役、事实过期或被替代的内容会保留在历史中，但不参与当前状态。</Step></GuideSection>
      <GuideSection id="configuration" title="项目配置" eyebrow="04 · Configuration"><Step number="1" title="核对项目连接">查看当前项目已委托的 Git、MCP 与 AI 连接；个人连接仍由连接所有者维护。</Step><Step number="2" title="理解规则优先级">项目配置决定该项目可用的连接和能力，项目规则优先于个人工作区的默认规则。</Step><Step number="3" title="保持最小授权">连接委托和工具授权按项目保存；移除项目授权不会删除个人连接本身。</Step></GuideSection>
      <GuideSection id="plan" title="项目计划" eyebrow="04 · Plan"><Step number="1" title="建立工作项">为目标和工作项填写负责人、目标日期和验收标准。缺少必要信息时，工作项不能开始。</Step><Step number="2" title="关联证据">从已确认事实或活动来源选择完成证据；仓库变化只生成确定性变化清单，不会自动修改计划。</Step><Step number="3" title="人工推进状态">Editor/Owner 根据实际情况更新工作项。计划不会自动运行代码、创建 Git 分支、调用 Shell 或部署。</Step></GuideSection>
      <GuideSection id="materials" title="项目资料" eyebrow="05 · Materials"><Step number="1" title="接入来源">在“项目资料”添加文本、文件、文件夹和网页；已关联的代码仓库在仓库页查看。列表保持精简；点击资料进入详情查看完整正文和来源定位。</Step><Step number="2" title="处理识别结果">图片或扫描文件完成识别后，在资料区确认可用文本。来源同步、解析和识别失败会保留安全错误提示，不会写入不完整内容。</Step><Step number="3" title="进入记忆流程">资料准备好后进入 AI 工作台，明确确认外发范围，再运行自动抽取或索引；运行记录在项目概览查看。</Step><Callout title="外发确认">只有你在页面勾选当次确认，并且平台默认模型或个人双确认委托及权限检查通过时，资料片段才会发送给已配置的模型供应商；个人模型不会自动替代平台默认模型。所有待生成片段会发送给供应商；复用片段不会再次外发。</Callout><Callout title="上传边界">当前部署会限制单次选择 {uploadPolicy.maxFiles} 个文件，单文件最多 {Math.round(uploadPolicy.maxFileBytes / 1024 / 1024)} MiB；软删除但仍保留的文件继续计入容量预算。整套部署上限为 {Math.round(uploadPolicy.maxDeploymentBytes / 1024 / 1024 / 1024)} GiB。</Callout></GuideSection>
      <GuideSection id="intelligence" title="AI 工作台" eyebrow="06 · AI workbench"><Step number="1" title="生成项目简报">查看平台默认或已完成个人双确认委托的能力，确认传输范围后生成简报。简报会引用当前状态、事实和证据，不会覆盖确定性状态。</Step><Step number="2" title="检索与提问">语义检索返回原文片段、路径、版本和分数；引用式问答只能使用检索命中的证据。向量索引需要在资料或有效模型来源变化后重建。</Step><Step number="3" title="运行只读调查">智能体可整理证据、提出建议并显示不确定性，但没有 Shell、代码写入、Git 写入、MCP 写操作或部署权限。</Step></GuideSection>
      <GuideSection id="automation" title="项目自动化" eyebrow="07 · Automation"><Step number="1" title="先看影响预览">项目 Owner 可以在确认首次 UTC 时间、浏览器时区（仅展示）、间隔、作用范围和通知对象后，设置网页刷新、记忆质量和计划健康提醒；Git 自动化尚未开放。</Step><Step number="2" title="理解审批停点">索引和简报规则只创建 waitingConsent 通知，不选模型、不扣费、不发送项目内容；通知中会提供进入 AI 工作台的入口，由你逐次确认。</Step><Step number="3" title="查看运行与失败">规则显示最近结果、下次运行和连续失败次数。网页来源部分失败会标记整次运行失败，并保留成功/失败数量；先查看安全错误码和下一步建议，不要把未知结果当作成功。</Step></GuideSection>
      <GuideSection id="governance" title="项目治理与用量" eyebrow="08 · Governance"><Step number="1" title="审核记忆候选">进入项目资料的审核队列，逐条核对标题、内容和原文引用。确认后才会进入可信事实，驳回会保留审核记录。</Step><Step number="2" title="治理关系和状态">有权限的 Owner/Editor 可从项目概览进入高级状态治理，建立事实关系、处理冲突、替代旧事实和固化当前状态快照。关系固定当时的修订，不会静默跟随新版本。</Step><Step number="3" title="核对动作与用量">受控动作需要策略和审批；项目概览中的 AI 用量只表示审计到的调用与 Token，最终费用以供应商账单为准。MCP 工具必须由管理员审核精确工具后才能由项目 Owner 管理连接委托和只读工具授权；远端动作调用、调用审批、派发和结果查看/导入尚未开放，不能通过内部 API 绕过。</Step></GuideSection>
      <GuideSection id="notifications" title="通知与记忆确认" eyebrow="09 · Notifications & review"><Step number="1" title="查看通知">通知中心按任务、审批和候选审核提供入口。点击“查看详情”会自动将通知标为已读，已读消息从列表中消失。</Step><Step number="2" title="从任务详情返回">普通任务详情的返回按钮回到产生它的上一级项目页面；从通知进入时则返回通知中心。任务结果只显示安全摘要，不展示原始载荷。</Step><Step number="3" title="处理候选">自动抽取成功且有候选时，任务详情会提供“进入候选审核”。在候选区逐条或批量确认/驳回，页面会按服务器最新状态刷新。</Step><Callout title="个人连接与平台能力边界">个人 Git 与 MCP 连接请从个人工作区进入；页面只管理你自己的配置，不提供管理员工具认证或项目授权。项目 Git 当前支持完成双确认后的一次性手动只读读取；自动化、写入/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准。MCP 连接委托和只读工具授权控制面已开放；动作调用、调用审批、派发和结果导入未开放。平台模型与会员策略由系统管理员维护。</Callout></GuideSection>
      <GuideSection id="troubleshooting" title="常见问题" eyebrow="Troubleshooting"><div className="grid gap-4 md:grid-cols-2"><InfoCard title="按钮不可用">先检查项目角色、必填字段、平台默认模型或个人双确认委托及传输确认。Viewer 没有写入权限。</InfoCard><InfoCard title="任务没有结果">刷新任务详情，确认 Worker 状态和安全错误码。未知结果需要人工收口，不会自动改成成功。</InfoCard><InfoCard title="索引过期">资料、代码快照或有效向量模型来源变化后，按当前计划重新建立索引。</InfoCard><InfoCard title="没有收到通知">通知只发送给有对应项目权限的用户。打开通知详情后消息会自动标为已读并从未读列表移除。</InfoCard></div></GuideSection>
    </div><footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 py-7 text-xs text-slate-400"><span>AI Project OS {APP_VERSION} · 普通用户操作指南</span><Link href="/dashboard" className="font-semibold text-indigo-600 hover:text-indigo-700">返回 Dashboard</Link></footer>
  </div></main>;
}

function GuideSection({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return <section id={id} className="scroll-mt-6 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">{eyebrow}</p><h2 className="mt-3 text-2xl font-semibold tracking-tight">{title}</h2><div className="mt-6">{children}</div></section>;
}

function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return <div className="mb-5 flex gap-4 last:mb-0"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{number}</span><div><h3 className="text-sm font-semibold text-slate-800">{title}</h3><p className="mt-1 text-sm leading-7 text-slate-600">{children}</p></div></div>;
}

function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><h3 className="text-sm font-semibold text-slate-800">{title}</h3><p className="mt-2 text-sm leading-7 text-slate-600">{children}</p></article>;
}

function Callout({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-sm leading-7">{children}</p></aside>;
}
