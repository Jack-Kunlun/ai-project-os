"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";

type WorldStatus = "on_track" | "needs_attention" | "at_risk" | "insufficient_data";
type FactType = "decision" | "progress" | "issue" | "risk";
type FactLifecycle = "active" | "scheduled" | "expired" | "superseded" | "source_retired";
type RelationKind = "supports" | "contradicts" | "dependsOn" | "blocks" | "causedBy" | "resolves" | "relatesTo";
type WorldFact = {
  id: string;
  type: FactType;
  reviewStatus: string;
  lifecycle: FactLifecycle;
  title: string;
  content: string;
  occurredAt: string | null;
  confirmedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  updatedAt: string;
  revision: { id: string; number: number; evidenceManifestFingerprint: string; createdAt: string };
  source: { id: string; kind: string; externalRef: string | null; contentHash: string; retiredAt: string | null };
  workItems: Array<{ id: string; title: string; status: string; targetDate: string | null; assigneeId: string | null }>;
};
type WorldRelation = {
  id: string;
  kind: RelationKind;
  sourceItemId: string;
  targetItemId: string;
  sourceRevisionId: string;
  targetRevisionId: string;
  rationale: string;
  fingerprint: string;
  createdAt: string;
  stale: boolean;
  createdBy: { username: string; displayName: string | null };
};
type QualityIssue = {
  id: string;
  kind: string;
  score: number;
  explanation: string;
  primaryItemId: string;
  relatedItemId: string | null;
  detectedAt: string;
};
type WorldSnapshot = {
  id: string;
  asOf: string;
  status: WorldStatus;
  inputManifestFingerprint: string;
  snapshotFingerprint: string;
  createdAt: string;
  capturedBy: { username: string; displayName: string | null };
};
type WorldAudit = {
  id: string;
  event: "relationCreated" | "relationRetired" | "factSuperseded" | "stateCaptured";
  sourceItemId: string | null;
  targetItemId: string | null;
  createdAt: string;
  actor: { username: string; displayName: string | null };
};
type WorldPayload = {
  permission: "owner" | "edit" | "view";
  project: { id: string; name: string; slug: string; description: string | null };
  state: {
    asOf: string;
    status: WorldStatus;
    counts: {
      activeFacts: number;
      decisions: number;
      progress: number;
      issues: number;
      risks: number;
      scheduled: number;
      expired: number;
      superseded: number;
      sourceRetired: number;
      activeRelations: number;
      staleRelations: number;
      openQualityIssues: number;
      activeConflicts: number;
      linkedWorkItems: number;
    };
    inputManifestFingerprint: string;
    snapshotFingerprint: string;
    planHealth: { status: string; counts: { overdue: number; blocked: number; dueSoon: number; unassigned: number } };
  };
  facts: WorldFact[];
  relations: WorldRelation[];
  qualityIssues: QualityIssue[];
  snapshots: WorldSnapshot[];
  audits: WorldAudit[];
};

const statusMeta: Record<WorldStatus, { label: string; detail: string; tone: string; glow: string }> = {
  on_track: { label: "运行正常", detail: "当前事实、关系与计划未出现阻断信号", tone: "bg-emerald-400/15 text-emerald-200 ring-emerald-400/25", glow: "bg-emerald-400" },
  needs_attention: { label: "需要关注", detail: "存在风险、陈旧关系或需要处理的计划信号", tone: "bg-amber-400/15 text-amber-100 ring-amber-400/25", glow: "bg-amber-400" },
  at_risk: { label: "存在风险", detail: "存在问题、事实冲突或受阻计划", tone: "bg-rose-400/15 text-rose-100 ring-rose-400/25", glow: "bg-rose-400" },
  insufficient_data: { label: "资料不足", detail: "尚无当前有效、已确认的项目事实", tone: "bg-slate-400/15 text-slate-200 ring-slate-400/25", glow: "bg-slate-400" },
};
const factMeta: Record<FactType, { label: string; tone: string }> = {
  decision: { label: "决策", tone: "bg-indigo-50 text-indigo-700" },
  progress: { label: "进展", tone: "bg-emerald-50 text-emerald-700" },
  issue: { label: "问题", tone: "bg-rose-50 text-rose-700" },
  risk: { label: "风险", tone: "bg-amber-50 text-amber-700" },
};
const lifecycleLabels: Record<FactLifecycle, string> = {
  active: "当前有效",
  scheduled: "尚未生效",
  expired: "已过期",
  superseded: "已被替代",
  source_retired: "来源已退役",
};
const relationLabels: Record<RelationKind, string> = {
  supports: "支持",
  contradicts: "冲突",
  dependsOn: "依赖",
  blocks: "阻断",
  causedBy: "由此导致",
  resolves: "解决",
  relatesTo: "相关",
};
const auditLabels: Record<WorldAudit["event"], string> = {
  relationCreated: "建立事实关系",
  relationRetired: "退役事实关系",
  factSuperseded: "建立事实替代链",
  stateCaptured: "固化项目状态",
};

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function shortFingerprint(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function ProjectWorldClient({ username, projectId }: { username: string; projectId: string }) {
  const [world, setWorld] = useState<WorldPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceItemId, setSourceItemId] = useState("");
  const [targetItemId, setTargetItemId] = useState("");
  const [relationKind, setRelationKind] = useState<RelationKind>("supports");
  const [relationRationale, setRelationRationale] = useState("");
  const [retirementReason, setRetirementReason] = useState("");
  const [predecessorItemId, setPredecessorItemId] = useState("");
  const [successorItemId, setSuccessorItemId] = useState("");
  const [supersessionReason, setSupersessionReason] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/world`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "项目状态加载失败"));
      setWorld(await response.json() as WorldPayload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "项目状态加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const activeFacts = useMemo(() => world?.facts.filter((fact) => fact.lifecycle === "active") ?? [], [world]);
  const predecessor = activeFacts.find((fact) => fact.id === predecessorItemId);
  const successorOptions = predecessor ? activeFacts.filter((fact) => fact.type === predecessor.type && fact.id !== predecessor.id) : [];
  const factById = useMemo(() => new Map(world?.facts.map((fact) => [fact.id, fact]) ?? []), [world]);
  const canEdit = world !== null && world.permission !== "view";

  async function mutate(operation: object, key: string, success: string): Promise<boolean> {
    setPending(key); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/world`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(operation) });
      if (!response.ok) throw new Error(await responseError(response, "项目状态更新失败"));
      await reload();
      setMessage(success);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "项目状态更新失败");
      return false;
    } finally {
      setPending(null);
    }
  }

  async function createRelation() {
    if (await mutate({ operation: "createRelation", sourceItemId, targetItemId, kind: relationKind, rationale: relationRationale }, "create-relation", "事实关系已建立，并固定到双方当前证据版本。")) {
      setRelationRationale("");
    }
  }

  async function retireRelation(relation: WorldRelation) {
    if (await mutate({ operation: "retireRelation", relationId: relation.id, expectedFingerprint: relation.fingerprint, reason: retirementReason }, `retire-${relation.id}`, "事实关系已退役，历史记录仍然保留。")) {
      setRetirementReason("");
    }
  }

  async function supersede() {
    const oldFact = activeFacts.find((fact) => fact.id === predecessorItemId);
    const newFact = activeFacts.find((fact) => fact.id === successorItemId);
    if (!oldFact || !newFact) return;
    if (await mutate({ operation: "supersedeFact", predecessorItemId: oldFact.id, successorItemId: newFact.id, predecessorUpdatedAt: oldFact.updatedAt, successorUpdatedAt: newFact.updatedAt, reason: supersessionReason }, "supersede", "替代链已建立，旧事实已转为历史状态。")) {
      setPredecessorItemId(""); setSuccessorItemId(""); setSupersessionReason("");
    }
  }

  const meta = statusMeta[world?.state.status ?? "insufficient_data"];

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="world" />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
        <section className="relative overflow-hidden rounded-[2rem] bg-slate-950 px-7 py-8 text-white shadow-2xl shadow-slate-950/15 sm:px-10 sm:py-10">
          <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-violet-500/25 blur-3xl" />
          <div className="relative flex flex-wrap items-end justify-between gap-7">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">Temporal project world model</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">{world?.project.name ?? "项目状态"}</h1>
              <p className="mt-4 text-sm leading-7 text-slate-300">把已确认事实、证据版本、人工关系、冲突和计划健康度合成为可追溯的当前状态。系统不会自动确认事实，也不会自动执行代码、Git、Shell 或部署动作。</p>
            </div>
            <div className="min-w-64 rounded-2xl border border-white/10 bg-white/[0.06] p-5 backdrop-blur">
              <div className="flex items-center gap-3"><span className={`h-3 w-3 rounded-full ${meta.glow}`} /><span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${meta.tone}`}>{meta.label}</span></div>
              <p className="mt-3 max-w-xs text-sm leading-6 text-slate-300">{meta.detail}</p>
              <button type="button" onClick={() => void mutate({ operation: "captureState" }, "capture", "当前项目状态已固化；相同输入不会重复创建快照。")} disabled={!canEdit || pending !== null} className="mt-5 flex min-h-11 w-full items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-indigo-50 disabled:opacity-40">{pending === "capture" ? "固化中…" : "固化当前状态"}</button>
            </div>
          </div>
        </section>

        {world?.permission === "view" ? <div className="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-700">你当前拥有只读权限，可以查看状态、证据和历史，但不能建立关系、替代事实或固化快照。</div> : null}
        {error ? <div role="alert" className="mt-5 flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => void reload()} className="inline-flex min-h-9 items-center justify-center font-semibold underline underline-offset-4">重试</button></div> : null}
        {message ? <div role="status" className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700">{message}</div> : null}

        <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-6" aria-label="项目状态指标">
          <Metric label="当前事实" value={world?.state.counts.activeFacts ?? 0} detail={`关联工作项 ${world?.state.counts.linkedWorkItems ?? 0}`} loading={loading} />
          <Metric label="决策" value={world?.state.counts.decisions ?? 0} detail="当前有效" loading={loading} />
          <Metric label="问题与风险" value={(world?.state.counts.issues ?? 0) + (world?.state.counts.risks ?? 0)} detail={`问题 ${world?.state.counts.issues ?? 0} · 风险 ${world?.state.counts.risks ?? 0}`} loading={loading} />
          <Metric label="事实关系" value={world?.state.counts.activeRelations ?? 0} detail={`陈旧 ${world?.state.counts.staleRelations ?? 0}`} loading={loading} />
          <Metric label="当前冲突" value={world?.state.counts.activeConflicts ?? 0} detail={`质量问题 ${world?.state.counts.openQualityIssues ?? 0}`} loading={loading} />
          <Metric label="状态快照" value={world?.snapshots.length ?? 0} detail="不可变历史" loading={loading} />
        </section>

        <section className="mt-8 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <div>
            <SectionHeading eyebrow="Current facts" title="当前项目事实" detail="仅当前有效事实参与状态判断；尚未生效、已过期、被替代和来源退役的事实保留在历史中。" />
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {!loading && activeFacts.length === 0 ? <Empty title="尚无当前有效事实" detail="先在“资料与条目”中新增或确认带证据的项目事实。" href={`/projects/${projectId}`} action="管理项目事实" /> : activeFacts.map((fact) => <FactCard key={fact.id} fact={fact} />)}
            </div>
          </div>
          <aside className="space-y-6">
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <SectionHeading eyebrow="State manifest" title="状态指纹" detail="每次计算都固定实际输入，便于复现与核对。" compact />
              <dl className="mt-5 space-y-4 text-xs"><FingerprintRow label="输入清单" value={world?.state.inputManifestFingerprint} /><FingerprintRow label="当前状态" value={world?.state.snapshotFingerprint} /><div><dt className="text-slate-400">计算时点</dt><dd className="mt-1 font-medium text-slate-700">{formatDate(world?.state.asOf ?? null)}</dd></div></dl>
            </section>
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <SectionHeading eyebrow="Plan health" title="计划联动" detail="状态与项目计划使用同一套确定性健康度。" compact />
              <div className="mt-5 grid grid-cols-2 gap-3 text-center text-xs"><SmallMetric label="逾期" value={world?.state.planHealth.counts.overdue ?? 0} /><SmallMetric label="受阻" value={world?.state.planHealth.counts.blocked ?? 0} /><SmallMetric label="即将到期" value={world?.state.planHealth.counts.dueSoon ?? 0} /><SmallMetric label="未分配" value={world?.state.planHealth.counts.unassigned ?? 0} /></div>
              <Link href={`/projects/${projectId}/plan`} className="mt-5 flex min-h-11 items-center justify-center rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700">打开项目计划</Link>
            </section>
          </aside>
        </section>

        <section className="mt-10 grid gap-6 xl:grid-cols-2">
          <Workbench title="建立事实关系" eyebrow="Relation workbench" description="关系只连接已确认的当前事实，并固定双方当前证据版本；事实变化后旧关系会自动标记为陈旧。">
            <SelectField label="起点事实" value={sourceItemId} onChange={setSourceItemId} disabled={!canEdit}><option value="">选择事实</option>{activeFacts.map((fact) => <option key={fact.id} value={fact.id}>{factMeta[fact.type].label} · {fact.title}</option>)}</SelectField>
            <SelectField label="关系" value={relationKind} onChange={(value) => setRelationKind(value as RelationKind)} disabled={!canEdit}>{(Object.keys(relationLabels) as RelationKind[]).map((kind) => <option key={kind} value={kind}>{relationLabels[kind]}</option>)}</SelectField>
            <SelectField label="终点事实" value={targetItemId} onChange={setTargetItemId} disabled={!canEdit}><option value="">选择事实</option>{activeFacts.filter((fact) => fact.id !== sourceItemId).map((fact) => <option key={fact.id} value={fact.id}>{factMeta[fact.type].label} · {fact.title}</option>)}</SelectField>
            <TextField label="关系依据" value={relationRationale} onChange={setRelationRationale} placeholder="说明为何建立这条关系，便于后续人工复核。" disabled={!canEdit} />
            <button type="button" onClick={() => void createRelation()} disabled={!canEdit || pending !== null || !sourceItemId || !targetItemId || !relationRationale.trim()} className="flex min-h-11 w-full items-center justify-center rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40">{pending === "create-relation" ? "建立中…" : "建立关系"}</button>
          </Workbench>
          <Workbench title="建立事实替代链" eyebrow="Supersession workbench" description="选择同类型的新事实替代旧事实。旧事实会成为只读历史；该操作不能撤销或形成循环。">
            <SelectField label="被替代的旧事实" value={predecessorItemId} onChange={(value) => { setPredecessorItemId(value); setSuccessorItemId(""); }} disabled={!canEdit}><option value="">选择旧事实</option>{activeFacts.map((fact) => <option key={fact.id} value={fact.id}>{factMeta[fact.type].label} · {fact.title}</option>)}</SelectField>
            <SelectField label="作为当前版本的新事实" value={successorItemId} onChange={setSuccessorItemId} disabled={!canEdit || !predecessor}><option value="">选择同类型新事实</option>{successorOptions.map((fact) => <option key={fact.id} value={fact.id}>{factMeta[fact.type].label} · {fact.title}</option>)}</SelectField>
            <TextField label="替代理由" value={supersessionReason} onChange={setSupersessionReason} placeholder="说明变化原因和新事实适用范围。" disabled={!canEdit} />
            <button type="button" onClick={() => void supersede()} disabled={!canEdit || pending !== null || !predecessorItemId || !successorItemId || !supersessionReason.trim()} className="flex min-h-11 w-full items-center justify-center rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-40">{pending === "supersede" ? "建立中…" : "确认建立替代链"}</button>
          </Workbench>
        </section>

        <section className="mt-10">
          <SectionHeading eyebrow="Typed relations" title="事实关系" detail="陈旧关系不会进入当前状态，但仍保留原始端点版本和审计记录。" />
          <label className="mt-4 block max-w-xl text-xs font-semibold text-slate-600">退役理由<input value={retirementReason} onChange={(event) => setRetirementReason(event.target.value)} disabled={!canEdit} placeholder="退役关系前填写原因" className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-normal outline-none focus:border-indigo-400 disabled:bg-slate-100" /></label>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {!loading && (world?.relations.length ?? 0) === 0 ? <Empty title="尚未建立事实关系" detail="从上方工作台选择两条当前事实，建立可追溯关系。" /> : world?.relations.map((relation) => <article key={relation.id} className={`rounded-3xl border bg-white p-5 shadow-sm ${relation.stale ? "border-amber-200" : "border-slate-200"}`}><div className="flex flex-wrap items-center justify-between gap-3"><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">{relationLabels[relation.kind]}</span>{relation.stale ? <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">版本已变化</span> : <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">当前有效</span>}</div><div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-sm"><span className="rounded-xl bg-slate-50 p-3 font-medium text-slate-700">{factById.get(relation.sourceItemId)?.title ?? relation.sourceItemId}</span><span className="text-slate-300">→</span><span className="rounded-xl bg-slate-50 p-3 font-medium text-slate-700">{factById.get(relation.targetItemId)?.title ?? relation.targetItemId}</span></div><p className="mt-4 text-sm leading-6 text-slate-600">{relation.rationale}</p><div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 text-[11px] text-slate-400"><span>{relation.createdBy.displayName ?? relation.createdBy.username} · {formatDate(relation.createdAt)}</span><button type="button" onClick={() => void retireRelation(relation)} disabled={!canEdit || pending !== null || !retirementReason.trim()} className="inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-2 font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-40">{pending === `retire-${relation.id}` ? "退役中…" : "退役关系"}</button></div></article>)}
          </div>
        </section>

        <section className="mt-10 grid gap-6 xl:grid-cols-[0.85fr_1.15fr]">
          <div>
            <SectionHeading eyebrow="Open conflicts" title="当前冲突" detail="这里只展示同时指向当前有效事实的开放冲突；处置仍在记忆质量页面完成。" />
            <div className="mt-4 space-y-3">{(world?.qualityIssues.filter((issue) => issue.kind === "conflict") ?? []).length === 0 ? <Empty title="没有当前事实冲突" detail="状态计算未发现需要人工判断的有效事实冲突。" /> : world?.qualityIssues.filter((issue) => issue.kind === "conflict").map((issue) => <article key={issue.id} className="rounded-2xl border border-rose-200 bg-white p-5"><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold text-rose-600">冲突强度 {Math.round(issue.score * 100)}%</span><span className="text-[11px] text-slate-400">{formatDate(issue.detectedAt)}</span></div><p className="mt-3 text-sm leading-6 text-slate-600">{issue.explanation}</p></article>)}</div>
            <Link href={`/projects/${projectId}/memory-quality`} className="mt-4 flex min-h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-indigo-200 hover:text-indigo-700">进入记忆质量处置</Link>
          </div>
          <div>
            <SectionHeading eyebrow="Immutable history" title="状态快照与审计" detail="快照和审计只追加、不覆盖；每条记录都保留操作者与发生时点。" />
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <HistoryPanel title="状态快照">{world?.snapshots.length === 0 ? <HistoryEmpty>尚未固化状态</HistoryEmpty> : world?.snapshots.slice(0, 8).map((snapshot) => <HistoryRow key={snapshot.id} title={statusMeta[snapshot.status].label} detail={`${snapshot.capturedBy.displayName ?? snapshot.capturedBy.username} · ${formatDate(snapshot.createdAt)}`} fingerprint={snapshot.snapshotFingerprint} />)}</HistoryPanel>
              <HistoryPanel title="治理审计">{world?.audits.length === 0 ? <HistoryEmpty>尚无治理操作</HistoryEmpty> : world?.audits.slice(0, 10).map((audit) => <HistoryRow key={audit.id} title={auditLabels[audit.event]} detail={`${audit.actor.displayName ?? audit.actor.username} · ${formatDate(audit.createdAt)}`} />)}</HistoryPanel>
            </div>
          </div>
        </section>

        <section className="mt-10 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <SectionHeading eyebrow="Historical facts" title="非当前事实" detail="这些事实不会进入当前状态判断，但证据、版本和替代链仍可追溯。" compact />
          <div className="mt-5 flex flex-wrap gap-2">{world?.facts.filter((fact) => fact.lifecycle !== "active").map((fact) => <span key={fact.id} title={fact.title} className="rounded-full bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">{lifecycleLabels[fact.lifecycle]} · {fact.title}</span>)}{!loading && world?.facts.every((fact) => fact.lifecycle === "active") ? <span className="text-sm text-slate-400">当前没有非当前事实。</span> : null}</div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, detail, loading }: { label: string; value: number; detail: string; loading: boolean }) {
  return <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-500">{label}</p>{loading ? <div className="mt-3 h-8 w-14 animate-pulse rounded bg-slate-100" /> : <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>}<p className="mt-3 text-xs text-slate-400">{detail}</p></article>;
}

function SectionHeading({ eyebrow, title, detail, compact = false }: { eyebrow: string; title: string; detail: string; compact?: boolean }) {
  return <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-500">{eyebrow}</p><h2 className={`mt-2 font-semibold tracking-tight ${compact ? "text-xl" : "text-2xl"}`}>{title}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{detail}</p></div>;
}

function FactCard({ fact }: { fact: WorldFact }) {
  const meta = factMeta[fact.type];
  return <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${meta.tone}`}>{meta.label}</span><span className="text-[11px] text-slate-400">证据版本 #{fact.revision.number}</span></div><h3 className="mt-4 text-lg font-semibold text-slate-900">{fact.title}</h3><p className="mt-2 line-clamp-4 text-sm leading-6 text-slate-600">{fact.content}</p><div className="mt-4 rounded-2xl bg-slate-50 p-4 text-xs text-slate-500"><p>来源：{fact.source.kind}{fact.source.externalRef ? ` · ${fact.source.externalRef}` : ""}</p><p className="mt-2 font-mono" title={fact.revision.evidenceManifestFingerprint}>证据清单 {shortFingerprint(fact.revision.evidenceManifestFingerprint)}</p>{fact.workItems.length > 0 ? <p className="mt-2">工作项：{fact.workItems.map((item) => item.title).join("、")}</p> : null}</div></article>;
}

function Workbench({ title, eyebrow, description, children }: { title: string; eyebrow: string; description: string; children: React.ReactNode }) {
  return <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7"><SectionHeading eyebrow={eyebrow} title={title} detail={description} compact /><div className="mt-6 space-y-4">{children}</div></section>;
}

function SelectField({ label, value, onChange, disabled, children }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; children: React.ReactNode }) {
  return <label className="block text-xs font-semibold text-slate-600">{label}<select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-normal outline-none focus:border-indigo-400 disabled:bg-slate-100">{children}</select></label>;
}

function TextField({ label, value, onChange, placeholder, disabled }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; disabled: boolean }) {
  return <label className="block text-xs font-semibold text-slate-600">{label}<textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} rows={3} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-normal leading-6 outline-none focus:border-indigo-400 disabled:bg-slate-100" /></label>;
}

function Empty({ title, detail, href, action }: { title: string; detail: string; href?: string; action?: string }) {
  return <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center"><p className="font-semibold text-slate-700">{title}</p><p className="mt-2 text-sm leading-6 text-slate-500">{detail}</p>{href && action ? <Link href={href} className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white">{action}</Link> : null}</div>;
}

function FingerprintRow({ label, value }: { label: string; value?: string }) {
  return <div><dt className="text-slate-400">{label}</dt><dd className="mt-1 break-all font-mono text-[11px] font-medium text-slate-700" title={value}>{value ? shortFingerprint(value) : "—"}</dd></div>;
}

function SmallMetric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl bg-slate-50 p-3"><strong className="block text-xl text-slate-900">{value}</strong><span className="mt-1 block text-slate-400">{label}</span></div>;
}

function HistoryPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-sm font-semibold text-slate-800">{title}</h3><div className="mt-4 divide-y divide-slate-100">{children}</div></section>;
}

function HistoryRow({ title, detail, fingerprint }: { title: string; detail: string; fingerprint?: string }) {
  return <div className="py-3 first:pt-0 last:pb-0"><p className="text-sm font-semibold text-slate-700">{title}</p><p className="mt-1 text-xs text-slate-400">{detail}</p>{fingerprint ? <p className="mt-1 font-mono text-[10px] text-slate-300">{shortFingerprint(fingerprint)}</p> : null}</div>;
}

function HistoryEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-400">{children}</p>;
}
