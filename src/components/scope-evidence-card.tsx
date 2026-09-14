export type ScopeEvidence = Readonly<{
  scope: string;
  owner: string;
  payer?: string;
  affectedProjects: string;
  latestSuccess: string;
}>;

export function ScopeEvidenceCard({ title = "配置边界", evidence }: { title?: string; evidence: ScopeEvidence }) {
  const rows = [
    ["作用范围", evidence.scope],
    ["所有者", evidence.owner],
    ...(evidence.payer ? [["付费主体", evidence.payer]] : []),
    ["影响项目", evidence.affectedProjects],
    ["最近验证 / 成功", evidence.latestSuccess],
  ];
  return <section aria-label={title} className="rounded-2xl border border-slate-200 bg-white/80 p-4">
    <h3 className="text-xs font-semibold text-slate-700">{title}</h3>
    <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">{rows.map(([label, value]) => <div key={label}><dt className="text-slate-400">{label}</dt><dd className="mt-1 font-semibold leading-5 text-slate-700">{value}</dd></div>)}</dl>
  </section>;
}
