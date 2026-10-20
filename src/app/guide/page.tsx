import { UiText } from "@/components/appearance-provider";
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
import styles from "../support-pages.module.css";

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
  ["intelligence", "智能问答与 AI 工作台", "统一问答、检索、简报和只读调查"],
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

  return <main className={styles.page}><AppHeader username={user.username} active="guide" isSystemAdmin={user.role === "admin"} projectId={projectId} projectSection={projectId ? "guide" : undefined} /><div className={styles.content}>
    <section className={`${styles.pageHeader}`}><div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600"><UiText text={"User guide"} /></p><h1 className={`${styles.pageTitle} mt-2`}><UiText text={"普通用户操作指南"} /></h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600"><UiText text={"按下方入口完成项目协作、个人资源维护和账户管理。能力范围与权限边界以各页面当前状态为准。"} /></p>{user.role === "admin" ? <Link href="/admin/guide" className="mt-4 inline-flex rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"><UiText text={"打开管理员指南 →"} /></Link> : null}</div><div className={styles.asideNote}><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600"><UiText text={"推荐顺序"} /></p><p className="mt-2 text-sm leading-6 text-slate-600"><UiText text={"账号 / 工作区 → 创建项目 → 项目配置 → 项目概览 → 项目计划 → 项目资料 → 智能问答 → 项目自动化 → 通知与记忆确认"} /></p></div></section>
    <nav aria-labelledby="regular-user-guide-nav-label" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><span id="regular-user-guide-nav-label" className="sr-only"><UiText text="普通用户指南目录" /></span>{sections.map(([id, title, detail], index) => <a key={id} href={`#${id}`} className="rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-indigo-200 hover:bg-indigo-50/40"><span className="text-xs font-bold text-indigo-600">{String(index + 1).padStart(2, "0")}</span><h2 className="mt-2 text-sm font-semibold text-slate-800"><UiText text={title} /></h2><p className="mt-1 text-xs leading-5 text-slate-500"><UiText text={detail} /></p></a>)}</nav>
    <div className="mt-8 space-y-6"><GuideSection id="account" title="账号与工作区" eyebrow="01 · Account & workspace"><Step number="1" title="登录账号"><UiText text={"可使用已有账号登录；部署启用公开注册后，也可从登录页创建用户名密码账号。已配置 GitHub 登录时可通过该入口首次登录建号。登录后在 Dashboard 查看可访问项目；项目和资料权限由服务端按角色判断。"} /></Step><Step number="2" title="理解角色"><UiText text={"workspace Owner/Admin 只管理所属工作区成员、邀请和项目授权；Member/Viewer 按被授予的项目访问。系统管理员的管理工作台属于平台范围，不等同于工作区权限。"} /></Step><Step number="3" title="接受邀请"><UiText text={"邀请链接应通过安全渠道发送，并在有效期内由匹配邮箱的账号接受。用户名密码自注册不收集邮箱，不能直接接受邮箱邀请或通过邮箱自助找回密码；相同邮箱也不会自动合并不同登录身份。"} /></Step></GuideSection>
      <GuideSection id="projects" title="创建项目空间" eyebrow="02 · Projects"><Step number="1" title="先确认创建权限"><UiText text={"只有当前工作区 Owner/Admin 可以创建项目；系统管理员角色不会自动获得工作区权限。普通 Member/Viewer 需要由当前工作区 Owner/Admin 授权后再创建。"} /></Step><Step number="2" title="从项目入口创建"><UiText text={"有权限时点击 Dashboard 或顶部“项目”，选择“新建项目”，填写项目名称和可选描述。新项目会隔离自己的资料、计划、AI 能力使用方式、记忆和审计；项目内不维护独立模型路由。"} /></Step><Step number="3" title="确认访问范围"><UiText text={"只有被授予项目 Owner/Editor 的用户才能修改内容；Viewer 可以查看。项目归档后变为只读，恢复后才可继续操作。"} /></Step><Callout title="项目数据边界"><UiText text={"不要把密码、Token、私钥或其他凭据录入项目描述、资料或条目。项目导出也应按敏感业务数据保管。"} /></Callout></GuideSection>
      <GuideSection id="overview" title="项目概览" eyebrow="03 · Overview"><Step number="1" title="读取当前状态"><UiText text={"概览显示当前有效、已确认事实，以及问题、风险、关系和计划健康度计算出的项目状态。它不是模型猜测，也不会自动把候选变成事实。"} /></Step><Step number="2" title="从状态进入下一步"><UiText text={"查看项目关键指标、推荐下一步和当前状态后，可继续进入配置、计划、资料、AI 工作台或自动化。任务运行记录与 AI 用量也集中在概览中。"} /></Step><Step number="3" title="查看历史依据"><UiText text={"事实卡片可查看来源、修订和证据。来源退役、事实过期或被替代的内容会保留在历史中，但不参与当前状态。"} /></Step></GuideSection>
      <GuideSection id="configuration" title="项目配置" eyebrow="04 · Configuration"><Step number="1" title="核对项目连接"><UiText text={"查看当前项目的代码仓库、MCP 与 AI 连接。进入“代码仓库”选择已有授权或添加连接，先测试指定仓库和分支再保存；填写项目读取范围并提交后，仍需连接所有者与项目 Owner 分别确认。"} /></Step><Step number="2" title="理解规则优先级"><UiText text={"项目配置决定该项目可用的连接和能力，项目规则优先于个人默认规则。"} /></Step><Step number="3" title="保持最小授权"><UiText text={"连接委托和工具授权按项目保存；移除项目授权不会删除个人连接本身。"} /></Step></GuideSection>
      <GuideSection id="plan" title="项目计划" eyebrow="04 · Plan"><Step number="1" title="建立工作项"><UiText text={"为目标和工作项填写负责人、目标日期和验收标准。缺少必要信息时，工作项不能开始。"} /></Step><Step number="2" title="关联证据"><UiText text={"从已确认事实或活动来源选择完成证据；仓库变化只生成确定性变化清单，不会自动修改计划。"} /></Step><Step number="3" title="人工推进状态"><UiText text={"Editor/Owner 根据实际情况更新工作项。计划不会自动运行代码、创建 Git 分支、调用 Shell 或部署。"} /></Step></GuideSection>
      <GuideSection id="materials" title="项目资料" eyebrow="05 · Materials"><Step number="1" title="接入来源"><UiText text={"在“项目资料”添加文本、文件、文件夹和网页；已关联的代码仓库在仓库页查看。列表保持精简；点击资料进入详情查看完整正文和来源定位。"} /></Step><Step number="2" title="处理识别结果"><UiText text={"图片或扫描文件完成识别后，在资料区确认可用文本。来源同步、解析和识别失败会保留安全错误提示，不会写入不完整内容。"} /></Step><Step number="3" title="整理、提问与查看任务"><UiText text={"在导入窗口确认整理范围后提交后台，在“识别任务”查看进度和允许取消的任务；“整理结果”集中核对内容。提问统一从"} />{" "}<Link href="/ask" className="font-semibold text-indigo-700 underline underline-offset-2"><UiText text={"智能问答"} /></Link> {" "}<UiText text={"进入；同一会话可切换个人或项目范围，每轮提交前核对并确认本轮范围，历史记录保留当轮引用，"} /><Link href="/ask?history=1" className="font-semibold text-indigo-700 underline underline-offset-2"><UiText text={"查看问答历史"} /></Link><UiText text={"。服务端接入仍在开发验收，实际可用能力以页面状态为准。"} /></Step><Callout title="外发确认"><UiText text={"只有你在页面勾选当次确认，并且平台默认模型或个人双确认委托及权限检查通过时，资料片段才会发送给已配置的模型供应商；个人模型不会自动替代平台默认模型。所有待生成片段会发送给供应商；复用片段不会再次外发。"} /></Callout><Callout title="上传边界"><UiText text={"当前部署会限制单次选择"} />{" "}{uploadPolicy.maxFiles} {" "}<UiText text={"个文件，单文件最多"} />{" "}{Math.round(uploadPolicy.maxFileBytes / 1024 / 1024)} {" "}<UiText text={"MiB；软删除但仍保留的文件继续计入容量预算。整套部署上限为"} />{" "}{Math.round(uploadPolicy.maxDeploymentBytes / 1024 / 1024 / 1024)} {" "}<UiText text={"GiB。"} /></Callout></GuideSection>
      <GuideSection id="intelligence" title="智能问答与 AI 工作台" eyebrow="06 · Ask & AI workbench"><Step number="1" title="打开统一问答入口"><UiText text={"通过"} />{" "}<Link href="/ask" className="font-semibold text-indigo-700 underline underline-offset-2"><UiText text={"智能问答"} /></Link> {" "}<UiText text={"进入统一会话。同一会话可切换全量、个人或项目范围；每轮提交前需确认范围，历史记录会保留该轮引用来源。模型未配置或调用失败时，页面会说明原因。"} /></Step><Step number="2" title="查看检索与索引"><UiText text={"语义检索展示原文片段、路径、版本和分数。资料或有效模型来源变化后，可按页面入口重建向量索引。"} /></Step><Step number="3" title="生成简报并运行调查"><UiText text={"查看平台默认或已完成个人双确认委托的能力，确认传输范围后生成简报。简报会引用当前状态、事实和证据，不会覆盖确定性状态。智能体可整理证据、提出建议并显示不确定性，但没有 Shell、代码写入、Git 写入、MCP 写操作或部署权限。"} /></Step></GuideSection>
      <GuideSection id="automation" title="项目自动化" eyebrow="07 · Automation"><Step number="1" title="先看影响预览"><UiText text={"项目 Owner 可以在确认首次 UTC 时间、浏览器时区（仅展示）、间隔、作用范围和通知对象后，设置网页刷新、记忆质量和计划健康提醒。Git 计划只读在项目 Git 页面另行授权，需要连接所有者和项目 Owner 双确认。"} /></Step><Step number="2" title="理解审批停点"><UiText text={"索引和简报规则只创建 waitingConsent 通知，不选模型、不扣费、不发送项目内容；通知中会提供进入 AI 工作台的入口，由你逐次确认。"} /></Step><Step number="3" title="查看运行与失败"><UiText text={"规则显示最近结果、下次运行和连续失败次数。网页来源部分失败会标记整次运行失败，并保留成功/失败数量；先查看安全错误码和下一步建议，不要把未知结果当作成功。"} /></Step></GuideSection>
      <GuideSection id="governance" title="项目治理与用量" eyebrow="08 · Governance"><Step number="1" title="审核记忆候选"><UiText text={"进入项目资料的审核队列，逐条核对标题、内容和原文引用。确认后才会进入可信事实，驳回会保留审核记录。"} /></Step><Step number="2" title="治理关系和状态"><UiText text={"有权限的 Owner/Editor 可从项目概览进入高级状态治理，建立事实关系、处理冲突、替代旧事实和固化当前状态快照。关系固定当时的修订，不会静默跟随新版本。"} /></Step><Step number="3" title="核对动作与用量"><UiText text={"受控动作需要策略和审批；项目概览中的 AI 用量只表示审计到的调用与 Token，最终费用以供应商账单为准。MCP 工具须先由管理员审核精确定义，项目 Owner 再管理连接委托和只读工具授权；受控环境中只读动作逐次审批，结果经人工确认后才可导入。生产启用与真实外部服务仍需验收。"} /></Step></GuideSection>
      <GuideSection id="notifications" title="通知与记忆确认" eyebrow="09 · Notifications & review"><Step number="1" title="查看通知"><UiText text={"通知中心按任务、审批和候选审核提供入口。点击“查看详情”会自动将通知标为已读；历史记录仍可在“全部”中查看。"} /></Step><Step number="2" title="从任务详情返回"><UiText text={"普通任务详情的返回按钮回到产生它的上一级项目页面；从通知进入时则返回通知中心。任务结果只显示安全摘要，不展示原始载荷。"} /></Step><Step number="3" title="处理候选"><UiText text={"自动抽取成功且有候选时，任务详情会提供“进入候选审核”。在候选区逐条或批量确认/驳回，页面会按服务器最新状态刷新。"} /></Step><Callout title="个人连接与平台能力边界"><UiText text={"代码仓库接入和读取范围在“项目配置 → 代码仓库”管理；“我的空间 → 配置 → Git 授权管理”维护个人凭据、查看项目使用情况和撤权。MCP 个人连接从“我的空间”进入；个人配置页面不提供管理员工具认证或项目授权。项目 Git 支持双确认后的一次性手动只读读取，以及单独双确认后的计划只读读取；写入/提交和旧 PAT 路径保持关闭。MCP 连接委托与只读动作在受控环境支持逐次审批和结果人工导入，生产开放仍需验收。平台模型与会员策略由系统管理员维护。"} /></Callout></GuideSection>
      <GuideSection id="troubleshooting" title="常见问题" eyebrow="Troubleshooting"><div className="grid gap-4 md:grid-cols-2"><InfoCard title="按钮不可用"><UiText text={"先检查项目角色、必填字段、平台默认模型或个人双确认委托及传输确认。Viewer 没有写入权限。"} /></InfoCard><InfoCard title="任务没有结果"><UiText text={"刷新任务详情，确认 Worker 状态和安全错误码。未知结果需要人工收口，不会自动改成成功。"} /></InfoCard><InfoCard title="资料有更新"><Link href="/ask" className="font-semibold text-indigo-700 underline underline-offset-2"><UiText text={"打开智能问答"} /></Link><UiText text={"，选择本轮个人或项目范围并确认后提问。"} /></InfoCard><InfoCard title="没有收到通知"><UiText text={"通知只发送给有对应项目权限的用户。打开通知详情后会标为已读；在“全部”中仍可查看该记录。"} /></InfoCard></div></GuideSection>
    </div><footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 py-7 text-xs text-slate-400"><span><UiText text={"AI Project OS"} />{" "}{APP_VERSION} {" "}<UiText text={"· 普通用户操作指南"} /></span><div className="flex flex-wrap items-center gap-5"><Link href="/contact" className="font-semibold text-indigo-600 hover:text-indigo-700"><UiText text={"联系作者"} /></Link><Link href="/dashboard" className="font-semibold text-indigo-600 hover:text-indigo-700"><UiText text={"返回 Dashboard"} /></Link></div></footer>
  </div></main>;
}

function GuideSection({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return <section id={id} className="scroll-mt-6 rounded-3xl border border-slate-200 bg-white p-5 sm:p-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600"><UiText text={eyebrow} /></p><h2 className="mt-2 text-xl font-semibold tracking-tight"><UiText text={title} /></h2><div className="mt-5">{children}</div></section>;
}

function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return <div className="mb-5 flex gap-4 last:mb-0"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{number}</span><div><h3 className="text-sm font-semibold text-slate-800"><UiText text={title} /></h3><p className="mt-1 text-sm leading-7 text-slate-600">{children}</p></div></div>;
}

function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><h3 className="text-sm font-semibold text-slate-800"><UiText text={title} /></h3><p className="mt-2 text-sm leading-7 text-slate-600">{children}</p></article>;
}

function Callout({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950"><h3 className="text-sm font-semibold"><UiText text={title} /></h3><p className="mt-2 text-sm leading-7">{children}</p></aside>;
}
