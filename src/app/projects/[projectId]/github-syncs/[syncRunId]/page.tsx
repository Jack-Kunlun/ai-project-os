import Link from "next/link";
import { z } from "zod";
import { assertProjectAccess } from "@/lib/access-control";
import { requirePageSession } from "@/lib/auth";
import {
  getProjectGitHubSync,
  PROJECT_GITHUB_SYNC_CHANGE_PAGE_MAX,
  PROJECT_GITHUB_SYNC_CHANGE_PAGE_SIZE,
  type PublicProjectGitHubSyncRun,
} from "@/lib/github";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(PROJECT_GITHUB_SYNC_CHANGE_PAGE_MAX).default(PROJECT_GITHUB_SYNC_CHANGE_PAGE_SIZE),
}).strict();

const statusLabels: Record<PublicProjectGitHubSyncRun["status"], string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  rateLimited: "已限流",
  unknown: "结果未知",
  cancelled: "已取消",
};

const entryStatusLabels: Record<PublicProjectGitHubSyncRun["entries"][number]["status"], string> = {
  pending: "待执行",
  running: "执行中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  rateLimited: "已限流",
  unknown: "结果未知",
  skipped: "未执行",
};

function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function statusClass(status: PublicProjectGitHubSyncRun["status"]): string {
  if (status === "succeeded") return "bg-emerald-50 text-emerald-700";
  if (status === "partial" || status === "rateLimited") return "bg-amber-50 text-amber-700";
  if (status === "failed" || status === "cancelled") return "bg-rose-50 text-rose-700";
  if (status === "unknown") return "bg-orange-50 text-orange-700";
  return "bg-indigo-50 text-indigo-700";
}

export default async function ProjectGitHubSyncPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; syncRunId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageSession();
  const route = await params;
  const projectId = idSchema.parse(route.projectId);
  const syncRunId = idSchema.parse(route.syncRunId);
  await assertProjectAccess(user, projectId, "view");
  const query = await searchParams;
  const page = pageSchema.parse({
    offset: queryValue(query.offset),
    limit: queryValue(query.limit),
  });
  const sync = await getProjectGitHubSync({ projectId, syncRunId }, undefined, page);
  const repositoryByTargetKey = new Map(sync.entries.map((entry) => [entry.targetKey, entry.repositoryFullName]));
  const previousOffset = Math.max(0, sync.changeOffset - sync.changeLimit);
  const nextOffset = sync.changeOffset + sync.changes.length;

  return <main className="min-h-screen bg-slate-50 px-5 py-10 text-slate-950 sm:px-8">
    <div className="mx-auto max-w-6xl">
      <Link href={`/projects/${projectId}/control`} className="text-sm font-semibold text-indigo-700 hover:underline">← 返回项目控制台</Link>
      <section className="mt-5 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">GitHub project sync</p>
            <h1 className="mt-2 text-3xl font-semibold">一键同步详情</h1>
            <p className="mt-2 text-sm text-slate-500">同步范围和每个仓库目标在启动时冻结；本次流程不会调用模型，也不会自动重建索引。</p>
          </div>
          <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${statusClass(sync.status)}`}>{statusLabels[sync.status]}</span>
        </div>
        {sync.reconciliationRequired ? <p className="mt-5 rounded-xl bg-orange-50 px-4 py-3 text-sm leading-6 text-orange-800">外部读取结果未知，未确认是否发布；请通过上方“返回项目控制台”回到任务列表，执行“协调确认/关闭未知结果”。该操作不会重试，也不会调用 GitHub。</p> : null}
        {sync.status !== "unknown" && sync.status !== "queued" && sync.status !== "running" ? <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">同步完成后如需语义搜索或 RAG，请前往智能记忆页面手动检查并重建索引。</p> : null}
        <dl className="mt-7 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-slate-400">当前阶段</dt><dd className="mt-1 font-semibold">{sync.stage}</dd></div>
          <div><dt className="text-slate-400">冻结目标</dt><dd className="mt-1 font-semibold">代码 {sync.codeTargetCount} · 资料 {sync.materialTargetCount}</dd></div>
          <div><dt className="text-slate-400">变更统计</dt><dd className="mt-1 font-semibold">新增 {sync.counts.added} · 更新 {sync.counts.updated} · 删除 {sync.counts.deleted}</dd></div>
          <div><dt className="text-slate-400">manifest</dt><dd className="mt-1 break-all font-mono text-xs">{sync.manifestFingerprint ?? "未封存（结果未知或尚未完成）"}</dd></div>
        </dl>
        {sync.warnings.length > 0 ? <div className="mt-6 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-600"><span className="font-semibold">提示：</span>{sync.warnings.join(" · ")}</div> : null}
      </section>

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
        <h2 className="text-xl font-semibold">冻结目标执行状态</h2>
        <div className="mt-5 divide-y divide-slate-100">
          {sync.entries.map((entry) => <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"><div><p className="font-semibold">{entry.repositoryFullName} · {entry.targetKind === "code" ? "代码" : "资料"}</p><p className="mt-1 text-xs text-slate-500">{entry.trackedRef} · 配置 v{entry.configVersion} · 策略 v{entry.effectivePolicyVersion}{entry.warning ? ` · ${entry.warning}` : ""}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${entry.status === "succeeded" ? "bg-emerald-50 text-emerald-700" : entry.status === "unknown" ? "bg-orange-50 text-orange-700" : entry.status === "failed" || entry.status === "rateLimited" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{entryStatusLabels[entry.status]}{entry.failureCode ? ` · ${entry.failureCode}` : ""}</span></div>)}
        </div>
      </section>

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-semibold">变更 manifest 明细</h2><p className="mt-1 text-xs text-slate-500">仅展示安全身份、hash 和变更类型，不包含源代码、正文、PAT 或 provider payload。</p></div><p className="text-xs text-slate-400">{sync.changeTotal === 0 ? "暂无变更" : `${sync.changeOffset + 1}–${sync.changeOffset + sync.changes.length} / ${sync.changeTotal}`}</p></div>
        {sync.changes.length === 0 ? <p className="mt-6 text-sm text-slate-500">当前页没有变更记录。</p> : <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[820px] text-left text-xs"><thead className="border-b border-slate-100 text-slate-400"><tr><th className="pb-3 pr-4">仓库</th><th className="pb-3 pr-4">目标</th><th className="pb-3 pr-4">身份</th><th className="pb-3 pr-4">类型</th><th className="pb-3 pr-4">之前 hash</th><th className="pb-3">之后 hash</th></tr></thead><tbody className="divide-y divide-slate-100">{sync.changes.map((change) => <tr key={change.id}><td className="py-3 pr-4 font-medium">{repositoryByTargetKey.get(change.targetKey) ?? "未知仓库"}</td><td className="py-3 pr-4">{change.targetKind}</td><td className="max-w-[340px] truncate py-3 pr-4 font-mono" title={change.identity}>{change.identity}</td><td className="py-3 pr-4">{change.changeType}</td><td className="py-3 pr-4 font-mono text-slate-400">{change.beforeContentHash ?? change.beforeRevisionFingerprint ?? "—"}</td><td className="py-3 font-mono text-slate-400">{change.afterContentHash ?? change.afterRevisionFingerprint ?? "—"}</td></tr>)}</tbody></table></div>}
        {(sync.changeOffset > 0 || sync.hasMoreChanges) ? <div className="mt-6 flex justify-between gap-3"><Link href={`/projects/${projectId}/github-syncs/${syncRunId}?offset=${previousOffset}&limit=${sync.changeLimit}`} className={`rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold ${sync.changeOffset > 0 ? "text-slate-700" : "pointer-events-none opacity-40"}`}>上一页</Link><Link href={`/projects/${projectId}/github-syncs/${syncRunId}?offset=${nextOffset}&limit=${sync.changeLimit}`} className={`rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold ${sync.hasMoreChanges ? "text-slate-700" : "pointer-events-none opacity-40"}`}>下一页</Link></div> : null}
      </section>
    </div>
  </main>;
}
