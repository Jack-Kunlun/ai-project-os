"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { TokenUsageView } from "@/components/token-usage";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { useAppearance, UiText } from "@/components/appearance-provider";
import { safeResponseError } from "@/lib/safe-error-presentation";
import type { TokenUsageSummary } from "@/lib/token-usage";
import styles from "./usage-client.module.css";

type UsageKind = "all" | "unifiedQuestion" | "personalQuestion" | "extraction" | "semantic" | "project";
type UsageStatus = "all" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
type UsageEntry = Readonly<{
  id: string;
  source: Exclude<UsageKind, "all">;
  occurredAt: string;
  status: Exclude<UsageStatus, "all">;
  modelId: string;
  operation: string;
  scope: string | null;
  project: Readonly<{ id: string; name: string }> | null;
  usage: TokenUsageSummary;
}>;
type UsagePage = Readonly<{
  summary: TokenUsageSummary;
  entries: readonly UsageEntry[];
  nextCursor: string | null;
}>;
type ProjectOption = Readonly<{ id: string; name: string; archivedAt: string | null }>;

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function readProjectId(values: readonly string[]): string {
  if (values.length !== 1 || !PROJECT_ID_PATTERN.test(values[0]!)) return "";
  return values[0]!.toLowerCase();
}

const kindOptions: readonly [UsageKind, string][] = [
  ["all", "全部类型"],
  ["unifiedQuestion", "统一问答"],
  ["personalQuestion", "个人知识问答"],
  ["extraction", "资料抽取"],
  ["semantic", "语义索引与搜索"],
  ["project", "项目模型调用"],
];
const statusOptions: readonly [UsageStatus, string][] = [
  ["all", "全部状态"],
  ["running", "运行中"],
  ["succeeded", "成功"],
  ["failed", "失败"],
  ["unknown", "结果未知"],
  ["cancelled", "已取消"],
];

function formatDate(value: string, language: "zh-CN" | "en"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatNumber(value: number | null, language: "zh-CN" | "en"): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN").format(value);
}

function sourceLabel(source: UsageEntry["source"], t: (text: string) => string): string {
  switch (source) {
    case "unifiedQuestion": return t("统一问答");
    case "personalQuestion": return t("个人知识问答");
    case "extraction": return t("资料抽取");
    case "semantic": return t("语义索引与搜索");
    case "project": return t("项目模型调用");
  }
}

function operationLabel(entry: UsageEntry, t: (text: string) => string): string {
  const operation = entry.operation.split(":").at(-1) ?? entry.operation;
  const labels: Readonly<Record<string, string>> = {
    unifiedQuestion: "引用式问答",
    personalKnowledgeQa: "个人知识问答",
    autoExtract: "自动抽取",
    visionExtract: "图片识别",
    embedding: "向量索引",
    search: "语义搜索",
    build: "向量索引",
    projectBrief: "项目简报",
    projectAgent: "项目调查",
    assetExtract: "项目资料",
    semanticSearch: "语义搜索",
    ragAnswer: "引用式问答",
  };
  return labels[operation] ? t(labels[operation]!) : t("模型调用");
}

function scopeLabel(scope: string | null, t: (text: string) => string): string | null {
  if (scope === null) return null;
  if (scope === "personal") return t("个人空间");
  if (scope === "project") return t("单个项目");
  if (scope === "all") return t("全量可访问内容");
  return t("未记录");
}

function statusClass(status: UsageEntry["status"]): string {
  if (status === "succeeded") return `${styles.pill} ${styles.statusSucceeded}`;
  if (status === "failed" || status === "cancelled") return `${styles.pill} ${styles.statusFailed}`;
  if (status === "unknown") return `${styles.pill} ${styles.statusUnknown}`;
  return styles.pill;
}

async function readPayload<T>(response: Response, fallback: string, t: (text: string) => string): Promise<T> {
  if (!response.ok) {
    const payload: unknown = await response.clone().json().catch(() => null);
    if (typeof payload === "object" && payload !== null && "error" in payload
      && typeof payload.error === "object" && payload.error !== null && "code" in payload.error
      && payload.error.code === "USAGE_SCOPE_TOO_BROAD") {
      throw new Error(t("当前筛选覆盖的项目较多，请缩短时间范围或选择单个项目后重试。"));
    }
    throw new Error((await safeResponseError(response, fallback)).message);
  }
  return response.json() as Promise<T>;
}

export function UsageClient({ initialFrom, initialTo }: Readonly<{ initialFrom: string; initialTo: string }>): React.JSX.Element {
  const { language, t } = useAppearance();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = readProjectId(searchParams.getAll("projectId"));
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [kind, setKind] = useState<UsageKind>("all");
  const [status, setStatus] = useState<UsageStatus>("all");
  const [projectSearch, setProjectSearch] = useState("");
  const [projects, setProjects] = useState<readonly ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState(false);
  const [usage, setUsage] = useState<UsagePage | null>(null);
  const [entries, setEntries] = useState<readonly UsageEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const [selected, setSelected] = useState<UsageEntry | null>(null);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const search = projectSearch.trim();
      void (async () => {
        setProjectsLoading(true);
        setProjectsError(false);
        try {
          const all: ProjectOption[] = [];
          for (const view of ["active", "archived"] as const) {
            let page = 1;
            let totalPages = 1;
            while (page <= totalPages && page <= 20 && !controller.signal.aborted) {
              const params = new URLSearchParams({ view, page: String(page), pageSize: "100" });
              if (search) params.set("search", search);
              const result = await readPayload<{ projects: ProjectOption[]; pagination: { totalPages: number } }>(
                await fetch(`/api/projects?${params.toString()}`, { cache: "no-store", signal: controller.signal }),
                t("项目列表暂不可用"),
                t,
              );
              all.push(...result.projects);
              totalPages = result.pagination.totalPages;
              page += 1;
            }
          }
          const byId = new Map(all.map((project) => [project.id, project]));
          if (!controller.signal.aborted) {
            setProjects([...byId.values()]);
            setProjectsError(false);
          }
        } catch {
          if (!controller.signal.aborted) setProjectsError(true);
        } finally {
          if (!controller.signal.aborted) setProjectsLoading(false);
        }
      })();
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [projectSearch, requestVersion, t]);

  const loadFirstPage = useCallback(async (signal: AbortSignal) => {
    const version = ++requestVersionRef.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setUsage(null);
    setEntries([]);
    const params = new URLSearchParams({ from, to, kind, status, pageSize: "20" });
    if (projectId) params.set("projectId", projectId);
    try {
      const payload = await readPayload<{ usage: UsagePage }>(
        await fetch(`/api/personal/usage?${params.toString()}`, { cache: "no-store", signal }),
        t("用量记录暂不可用"),
        t,
      );
      if (signal.aborted || requestVersionRef.current !== version) return;
      setUsage(payload.usage);
      setEntries(payload.usage.entries);
    } catch (cause) {
      if (!signal.aborted && requestVersionRef.current === version) setError(cause instanceof Error ? cause.message : t("用量记录暂不可用"));
    } finally {
      if (!signal.aborted && requestVersionRef.current === version) setLoading(false);
    }
  }, [from, kind, projectId, status, t, to]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadFirstPage(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [loadFirstPage, requestVersion]);

  const loadMore = useCallback(async () => {
    if (!usage?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    const params = new URLSearchParams({ from, to, kind, status, pageSize: "20", cursor: usage.nextCursor });
    if (projectId) params.set("projectId", projectId);
    const version = requestVersionRef.current;
    const controller = new AbortController();
    try {
      const payload = await readPayload<{ usage: UsagePage }>(
        await fetch(`/api/personal/usage?${params.toString()}`, { cache: "no-store", signal: controller.signal }),
        t("用量记录暂不可用"),
        t,
      );
      if (controller.signal.aborted || requestVersionRef.current !== version) return;
      setEntries((current) => [...current, ...payload.usage.entries]);
      setUsage(payload.usage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("用量记录暂不可用"));
    } finally {
      if (!controller.signal.aborted && requestVersionRef.current === version) setLoadingMore(false);
    }
  }, [from, kind, loadingMore, projectId, status, t, to, usage]);

  const selectProject = (nextProjectId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("projectId");
    if (nextProjectId) params.set("projectId", nextProjectId);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}><UiText text={"个人用量"} /></p>
          <h1 className={styles.title}>{t("模型 Token 用量")}</h1>
          <p className={styles.description}>{t("汇总查看由你的账号发起或承担计费的模型调用。")}</p>
        </div>
        <Link href="/credits" className={styles.creditLink}>{t("额度与账单")}</Link>
      </header>

      {error ? (
        <div className={styles.card} role="alert">
          <p className={styles.loadError}>{t(error)}<br />{t("读取失败时不会用旧数据替代。")}</p>
          <div className={styles.loadMore}>
            <span>{t("用量记录暂不可用")}</span>
            <button type="button" className={styles.retryButton} onClick={() => setRequestVersion((value) => value + 1)}>{t("重试")}</button>
          </div>
        </div>
      ) : null}

      <section className={`${styles.card} ${styles.summaryCard}`} aria-labelledby="usage-summary-heading">
        <div>
          <h2 id="usage-summary-heading" className={styles.sectionHeading}>{t("Token 消耗汇总")}</h2>
          <p className={styles.summaryHint}>{t("当前账号用量")}</p>
        </div>
        {loading && !usage ? <p className={styles.emptyState}>{t("正在读取用量…")}</p> : usage ? <TokenUsageView usage={usage.summary} /> : null}
      </section>

      <section className={`${styles.card} ${styles.filterCard}`} aria-labelledby="usage-filter-heading">
        <h2 id="usage-filter-heading" className={styles.sectionHeading}>{t("统计周期")}</h2>
        <div className={styles.filters}>
          <label className={styles.filterLabel}>{t("开始日期")}<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
          <label className={styles.filterLabel}>{t("结束日期")}<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
          <label className={styles.filterLabel}>{t("调用类型")}<select value={kind} onChange={(event) => setKind(event.target.value as UsageKind)}>{kindOptions.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
          <label className={styles.filterLabel}>{t("调用状态")}<select value={status} onChange={(event) => setStatus(event.target.value as UsageStatus)}>{statusOptions.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
          <label className={styles.filterLabel}>{t("项目筛选")}
            <select value={projectId} onChange={(event) => selectProject(event.target.value)} disabled={projectsLoading || projectsError}>
              <option value="">{t("全部项目")}</option>
              {projectId && !projects.some((project) => project.id === projectId) ? <option value={projectId}>{t("指定项目")} · {projectId.slice(0, 8)}…</option> : null}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.archivedAt ? ` · ${t("已归档")}` : ""}</option>)}
            </select>
          </label>
        </div>
        <label className={`${styles.filterLabel} ${styles.projectSearch}`}>
          {t("搜索项目名称")}
          <input type="search" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder={t("搜索项目名称")} aria-label={t("搜索项目名称")} />
        </label>
        {projectsLoading ? <p className={styles.summaryHint}>{t("正在加载项目…")}</p> : projectsError ? <p className={styles.summaryHint} role="status">{t("项目列表暂不可用")}</p> : projects.length === 0 && projectSearch.trim() ? <p className={styles.summaryHint}>{t("没有匹配的项目")}</p> : null}
      </section>

      <section className={`${styles.card} ${styles.recordsCard}`} aria-labelledby="usage-records-heading">
        <div className={styles.recordsHeader}>
          <div>
            <h2 id="usage-records-heading" className={styles.sectionHeading}>{t("模型调用历史")}</h2>
            <p className={styles.recordsMeta}>{t("仅展示你有权查看的项目调用。")}</p>
          </div>
          {entries.length ? <span className={styles.pill}>{t("已加载")} {formatNumber(entries.length, language)} {t("条记录")}</span> : null}
        </div>
        {loading && !entries.length ? <p className={styles.emptyState}>{t("正在读取用量…")}</p> : entries.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>{t("调用时间")}</th><th>{t("调用类型")}</th><th>{t("项目 / 范围")}</th><th>{t("模型标识")}</th><th>{t("状态")}</th><th>{t("用量")}</th></tr></thead>
              <tbody>{entries.map((entry) => {
                const scope = scopeLabel(entry.scope, t);
                return <tr key={`${entry.source}:${entry.id}`}>
                  <td>{formatDate(entry.occurredAt, language)}</td>
                  <td><button type="button" className={styles.rowButton} onClick={() => setSelected(entry)}>{sourceLabel(entry.source, t)}</button><span className={styles.mutedLine}>{operationLabel(entry, t)}</span></td>
                  <td>{entry.project?.name ?? (scope ?? (entry.source === "project" ? t("项目调用") : t("个人调用")))}</td>
                  <td>{entry.modelId}</td>
                  <td><span className={statusClass(entry.status)}>{t(statusOptions.find(([value]) => value === entry.status)?.[1] ?? "结果未知")}</span></td>
                  <td>{formatNumber(entry.usage.totalTokens, language)}<span className={styles.mutedLine}>{entry.usage.status === "known" ? t("Token 消耗") : t(entry.usage.status === "partial" ? "部分用量" : entry.usage.status === "unknown" ? "用量未知" : "暂无模型调用记录")}</span></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : !error ? <p className={styles.emptyState}>{t("当前筛选范围暂无调用记录。")}</p> : null}
        {usage?.nextCursor ? <div className={styles.loadMore}><span>{t("已加载")} {formatNumber(entries.length, language)} {t("条记录")}</span><button type="button" className={styles.loadButton} disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t("正在加载…") : t("加载更多")}</button></div> : entries.length > 0 ? <p className={styles.loadMore}>{t("已到末尾")}</p> : null}
      </section>

      <footer className={styles.footnote}>
        <p>{t("这里展示调用 Token，不等同于平台额度或账单；未知用量会明确标记，不按 0 计算。")}</p>
        <p>{t("项目调用仅在当前仍具备项目查看权限时显示。")}</p>
        <p>{t("来源记录不包含问题正文、回答正文或供应商请求内容。")}</p>
      </footer>

      <WorkspaceDialog title={t("用量详情")} open={selected !== null} drawer onClose={() => setSelected(null)}
        footer={<Link href="/credits" className={styles.creditsLink}>{t("查看额度与账单")}</Link>}>
        {selected ? <>
          <p className={styles.drawerSubtitle}>{sourceLabel(selected.source, t)} · {operationLabel(selected, t)}</p>
          <dl className={styles.detailGrid}>
            <Detail label={t("调用时间")} value={formatDate(selected.occurredAt, language)} />
            <Detail label={t("模型标识")} value={selected.modelId} />
            <Detail label={t("项目筛选")} value={selected.project?.name ?? (selected.source === "project" ? t("项目调用") : t("个人调用"))} />
            {selected.scope ? <Detail label={t("问答范围")} value={scopeLabel(selected.scope, t) ?? t("未记录")} /> : null}
            <Detail label={t("状态")} value={t(statusOptions.find(([value]) => value === selected.status)?.[1] ?? "结果未知")} />
          </dl>
          <TokenUsageView usage={selected.usage} />
        </> : null}
      </WorkspaceDialog>
    </div>
  );
}

function Detail({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return <div className={styles.detailCell}><dt className={styles.detailLabel}>{label}</dt><dd className={styles.detailValue}>{value}</dd></div>;
}
